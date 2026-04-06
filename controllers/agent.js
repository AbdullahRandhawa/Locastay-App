const Conversation = require('../models/conversation');
const Profile = require('../models/profile');
const Listing = require('../models/listing');
const { generateEmbedding, cosineSimilarity } = require('../utils/embedding');
const openai = require('../utils/openai');

const LLM_MODEL = process.env.OPENROUTER_LLM_MODEL || 'meta-llama/llama-3.1-8b-instruct:free';

const SYSTEM_PROMPT = `You are "Rentlyst Agent" — an elite, highly articulate property and marketplace advisor on the Rentlyst platform.

Your personality:
- You speak with warmth, sophistication, and confidence — like a knowledgeable friend who happens to be an expert real estate and marketplace advisor.
- You are proactive. Don't just list things — RECOMMEND. Tell the user which option is the best deal and why.
- You are personalized. If you have any profile context about the user (budget, preferences, location, history), actively use it to tailor your suggestions.
- You are insightful. Comment on value for money, condition, location advantages, and highlight what makes a listing stand out.
- You use a natural, flowing writing style — avoid bullet-dump lists unless absolutely necessary to compare multiple items.
- Keep responses focused and conversational. Do not write essays, but do write with substance. Aim for 3-6 sentences for simple queries, more detail when recommending or comparing.
- Never just repeat raw data back to the user. Transform it into a helpful, human recommendation.
- If listings are available, always end with a clear recommendation or next step (e.g. "I'd suggest starting with...", "The Grandeur is your best bet because...").`;

// ==========================================
// HELPER FUNCTIONS
// ==========================================

// Per-user cooldown: prevents summarization from firing more than once per 30s per user
const summarizeCooldown = new Map(); // userId -> last run timestamp (ms)
const SUMMARIZE_COOLDOWN_MS = 30 * 1000; // 30 seconds

/**
 * Summarize unsummarized messages across ALL conversations for this user.
 * Only processes conversations that have 5+ new (unsummarized) messages.
 * Skips if called again within SUMMARIZE_COOLDOWN_MS for the same user.
 */
async function summarizeUnsummarizedChats(userId) {
    const userKey = userId.toString();
    const now = Date.now();
    const lastRun = summarizeCooldown.get(userKey) || 0;
    if (now - lastRun < SUMMARIZE_COOLDOWN_MS) return; // still in cooldown
    summarizeCooldown.set(userKey, now);
    try {
        const conversations = await Conversation.find({
            user: userId,
            'messages.0': { $exists: true }
        });

        if (!conversations || conversations.length === 0) return;

        const profile = await Profile.findOne({ user: userId });
        if (!profile) return;

        for (const conv of conversations) {
            const totalMsgs = conv.messages.length;
            const lastIdx = conv.lastSummarizedIndex || 0;
            const newMsgCount = totalMsgs - lastIdx;

            if (newMsgCount < 5) continue;

            const newMessages = conv.messages.slice(lastIdx);
            const chatText = newMessages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');

            const summaryPrompt = `Extract useful facts about this user from the messages below. 
Output ONLY labeled info like:
Name: ...
Budget: ...
Location: ...
Preference: ...
Searched: ...
Interest: ...

Skip greetings, filler, and anything useless. If nothing useful, reply exactly: "NO_NEW_INFO"

Messages:
${chatText}`;

            const result = await openai.chat.completions.create({
                model: LLM_MODEL,
                messages: [{ role: 'user', content: summaryPrompt }],
                max_tokens: 300
            });
            const summary = result.choices[0].message.content.trim();

            if (summary && !summary.includes('NO_NEW_INFO') && summary.length > 5) {
                if (!profile.agentContext || profile.agentContext === 'No specific context gathered yet.') {
                    profile.agentContext = summary;
                } else {
                    profile.agentContext += '\n' + summary;
                }

                // Consolidate if too long
                if (profile.agentContext.length > 2000) {
                    const consolidatePrompt = `Merge this user profile into a clean labeled list. Remove duplicates, keep all unique facts. Use format "Label: value" per line.\n\n${profile.agentContext}`;
                    const cResult = await openai.chat.completions.create({
                        model: LLM_MODEL,
                        messages: [{ role: 'user', content: consolidatePrompt }],
                        max_tokens: 400
                    });
                    const consolidated = cResult.choices[0].message.content.trim();
                    if (consolidated && consolidated.length > 5) {
                        profile.agentContext = consolidated;
                    }
                }
            }

            conv.lastSummarizedIndex = totalMsgs;
            await conv.save();
        }

        await profile.save();
    } catch (err) {
        console.error('Error summarizing conversations:', err.message || err);
    }
}

/**
 * Build a sliding window of chat history for OpenAI messages format.
 * Takes the last few messages and merges consecutive identical roles to prevent API errors.
 */
function buildSlidingHistory(messages) {
    if (!messages || messages.length === 0) return [];
    
    // Take the last 6 messages to keep context short and sweet
    const recent = messages.slice(-6).map(m => ({ 
        role: m.role === 'agent' ? 'assistant' : 'user', 
        content: m.content 
    }));
    
    // Sanitize: OpenAI strictly forbids consecutive 'user' or 'assistant' messages.
    // If a previous error caused two user messages in a row, merge them into one.
    const sanitized = [];
    for (const msg of recent) {
        if (sanitized.length > 0 && sanitized[sanitized.length - 1].role === msg.role) {
            sanitized[sanitized.length - 1].content += "\n\n" + msg.content;
        } else {
            sanitized.push({ role: msg.role, content: msg.content });
        }
    }
    
    // Ensure the last message in history isn't user (the new query handles that)
    if (sanitized.length > 0 && sanitized[sanitized.length - 1].role === 'user') {
        sanitized.pop(); // Remove it so we don't send consecutive user messages
    }

    return sanitized;
}

// ==========================================
// CONTROLLER FUNCTIONS
// ==========================================

// 1. RENDER AGENT PAGE
module.exports.renderAgent = async (req, res) => {
    const conversations = await Conversation.find({ user: req.user._id })
        .sort({ updatedAt: -1 })
        .select('title updatedAt')
        .lean();

    const profile = await Profile.findOne({ user: req.user._id }).lean();
    const profileImg = profile && profile.profileImg && profile.profileImg.url
        ? profile.profileImg.url
        : 'https://images.pexels.com/photos/13305201/pexels-photo-13305201.jpeg';

    res.render('agent/agent.ejs', { conversations, profileImg });
};

// 2. HANDLE MESSAGE
module.exports.handleMessage = async (req, res) => {
    try {
        const { message, conversationId } = req.body;

        if (!message || !message.trim()) {
            return res.status(400).json({ error: 'Message cannot be empty' });
        }
        if (message.trim().length > 800) {
            return res.status(400).json({ error: 'Message is too long. Please keep it under 800 characters.' });
        }

        let conversation;
        if (conversationId) {
            conversation = await Conversation.findOne({
                _id: conversationId,
                user: req.user._id
            });
        }

        if (!conversation) {
            // New conversation — trigger summarization in background
            summarizeUnsummarizedChats(req.user._id).catch(e => console.error(e));

            conversation = new Conversation({
                user: req.user._id,
                title: message.substring(0, 50) + (message.length > 50 ? '...' : ''),
                messages: [],
                lastSummarizedIndex: 0
            });
        }

        // Build sliding window history (last 5 user + last 2 agent)
        const chatHistory = buildSlidingHistory(conversation.messages);

        // Fetch User Profile for context
        const userProfile = await Profile.findOne({ user: req.user._id });
        const userContextInfo = userProfile && userProfile.agentContext
            ? userProfile.agentContext
            : 'No historical context gathered yet.';
        const userFullName = userProfile && userProfile.fullName ? userProfile.fullName : 'the user';

        // --- LISTING SEARCH (Vector Semantic Search) ---
        let matchedListingsDocs = [];
        let listingsContext = 'No specific listings matched the query.';
        
        try {
            // Embed the user's current message as a search query
            const queryVector = await generateEmbedding(message, 'query');
            
            if (queryVector) {
                // Fetch all listings that have embeddings generated
                const allListings = await Listing.find({ listingVector: { $exists: true, $ne: [] } })
                    .select('title city listingType price rentalPeriod image searchContext listingVector');
                
                // Score listings by cosine similarity
                const scoredListings = allListings.map(listing => {
                    const score = cosineSimilarity(queryVector, listing.listingVector);
                    return { listing, score };
                });
                
                // Sort by highest similarity, filter by a reasonable threshold, take top 5
                // Threshold of 0.3 is a starting point, adjust later if too strict/loose
                matchedListingsDocs = scoredListings
                    .filter(item => item.score > 0.3)
                    .sort((a, b) => b.score - a.score)
                    .slice(0, 5)
                    .map(item => item.listing);
                
                if (matchedListingsDocs.length > 0) {
                    listingsContext = matchedListingsDocs.map(l => `[ID: ${l._id}] ${l.searchContext}`).join('\n\n');
                }
            }
        } catch (searchErr) {
            console.error('Vector search failed, proceeding without listings:', searchErr.message);
        }
        
        const matchedListingIds = matchedListingsDocs.map(l => l._id);
        const matchedListingsPayload = matchedListingsDocs.map(l => ({
            _id: l._id,
            title: l.title,
            city: l.city,
            listingType: l.listingType,
            price: l.price,
            rentalPeriod: l.rentalPeriod,
            image: l.image && l.image.length > 0 ? l.image[0].url : ''
        }));

        const dynamicSystemPrompt = `${SYSTEM_PROMPT}

You are talking to ${userFullName}.
User profile:
${userContextInfo}

Relevant Database Listings (Use these to recommend to the user):
${listingsContext}

If the user asks for a recommendation, refer to these listings. Mention details like price, city, or condition.`;

        // Build messages array: system + history + current user message
        const messages = [
            { role: 'system', content: dynamicSystemPrompt },
            ...chatHistory,
            { role: 'user', content: message }
        ];

        // Call OpenRouter
        const result = await openai.chat.completions.create({
            model: LLM_MODEL,
            messages,
            max_tokens: 500
        });

        const agentResponse = (result.choices && result.choices.length > 0 && result.choices[0].message && result.choices[0].message.content)
            ? result.choices[0].message.content
            : "I'm sorry, I couldn't generate a response from the AI provider. Please try again.";

        // Only persist messages after a successful AI response (prevents orphaned user messages)
        conversation.messages.push({ role: 'user', content: message, matchedListings: [] });
        conversation.messages.push({ role: 'agent', content: agentResponse, matchedListings: matchedListingIds });
        await conversation.save();

        res.json({
            response: agentResponse,
            conversationId: conversation._id,
            conversationTitle: conversation.title,
            matchedListings: matchedListingsPayload
        });

    } catch (err) {
        console.error('Agent error:', err.message || err);
        if (err.status === 429 || (err.message && err.message.includes('429'))) {
            return res.status(503).json({ error: 'AI is rate-limited. Please wait a moment and try again.' });
        }
        res.status(500).json({ error: 'The agent encountered an error. Please try again.' });
    }
};

// 3. GET ALL CONVERSATIONS
module.exports.getConversations = async (req, res) => {
    const conversations = await Conversation.find({ user: req.user._id })
        .sort({ updatedAt: -1 })
        .select('title updatedAt')
        .lean();

    res.json({ conversations });
};

// 4. GET SINGLE CONVERSATION (also triggers summarization on chat switch)
module.exports.getConversation = async (req, res) => {
    const conversation = await Conversation.findOne({
        _id: req.params.id,
        user: req.user._id
    }).populate({
        path: 'messages.matchedListings',
        select: 'title city listingType price rentalPeriod image'
    }).lean();

    if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
    }

    // Trigger summarization in background when switching chats
    summarizeUnsummarizedChats(req.user._id).catch(e => console.error(e));

    // Map the most recent agent listings to the sidebar payload
    let matchedListings = [];
    for (let i = conversation.messages.length - 1; i >= 0; i--) {
        if (conversation.messages[i].role === 'agent' && conversation.messages[i].matchedListings && conversation.messages[i].matchedListings.length > 0) {
            matchedListings = conversation.messages[i].matchedListings.map(l => ({
                _id: l._id,
                title: l.title,
                city: l.city,
                listingType: l.listingType,
                price: l.price,
                rentalPeriod: l.rentalPeriod,
                image: l.image && l.image.length > 0 ? l.image[0].url : ''
            }));
            break;
        }
    }

    res.json({ conversation, matchedListings });
};

// 5. DELETE CONVERSATION
module.exports.deleteConversation = async (req, res) => {
    await Conversation.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    res.json({ success: true });
};
