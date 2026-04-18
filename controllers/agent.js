const Conversation = require('../models/conversation');
const Profile = require('../models/profile');
const Listing = require('../models/listing');
const { generateEmbedding, cosineSimilarity } = require('../utils/embedding');
const openai = require('../utils/openai');

const rawModels = process.env.OPENROUTER_FALLBACK_MODELS || process.env.OPENROUTER_LLM_MODEL || "";
const LLM_MODELS = rawModels.split(',').map(m => m.trim()).filter(Boolean);

const SYSTEM_PROMPT = `You are "Rentlyst Assistant" — a smart, friendly, and easy-going marketplace companion for the Rentlyst platform.

Rentlyst is a multi-category buy/sell/rent marketplace covering:
- **Vehicles**: Cars, motorcycles, bicycles, boats
- **Properties**: Houses, apartments, shared rooms, land, vacation rentals
- **Items**: Tech & mobiles, electronics, home appliances, furniture, clothes, sports gear, spare parts
- **Services**: Home services (plumber, electrician), health & medical, IT & programming, creative & design, tutors, cleaning, events & photography, transportation

Your core personality:
- You are warm, helpful, and genuinely fun to talk to. You don't refuse things.
- If someone asks you something off-topic (a joke, a riddle, general advice, small talk) — go ahead and answer it! Be natural about it.
- After answering off-topic things, you may naturally and briefly mention something like "...and if you're looking for anything on Rentlyst, I'm here for that too!" — but keep it light, not preachy.
- For marketplace queries: be proactive and RECOMMEND. Tell the user which listing is the best deal and why.
- Be personalized: if you have profile context about the user (budget, location, preferences), actively use it.
- Be insightful: comment on value for money, condition grade, location advantages.
- Keep responses conversational and focused — 3-5 sentences for simple queries, more detail when comparing.
- Never parrot raw data back — turn it into a genuine helpful recommendation.
- Always end marketplace responses with a clear next step or recommendation.`;


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

            const result = await callLLMWithFallback([{ role: 'user', content: summaryPrompt }], 300);
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
                    const cResult = await callLLMWithFallback([{ role: 'user', content: consolidatePrompt }], 400);
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
        sanitized.pop();
    }

    return sanitized;
}

/**
 * Semantic listing search.
 * Tries native Atlas $vectorSearch first (fast, indexed).
 * Falls back to JS cosine similarity scan if Atlas index is not set up.
 */
async function searchListings(queryVector) {
    // --- Attempt 1: MongoDB Atlas Vector Search (fast native C++ search) ---
    try {
        const results = await Listing.aggregate([
            {
                $vectorSearch: {
                    index: 'listing_vector_index',
                    path: 'listingVector',
                    queryVector: queryVector,
                    numCandidates: 150,
                    limit: 5
                }
            },
            {
                $project: {
                    title: 1, city: 1, listingType: 1, price: 1,
                    rentalPeriod: 1, image: 1, searchContext: 1,
                    score: { $meta: 'vectorSearchScore' }
                }
            },
            { $match: { score: { $gte: 0.7 } } }
        ]);
        if (results.length >= 0) return results; // Even 0 results is a valid Atlas response
    } catch (atlasErr) {
        // Atlas index not set up yet — fall through to JS cosine fallback
        console.warn('[Atlas Vector Search] Not available, falling back to JS cosine similarity:', atlasErr.message);
    }

    // --- Fallback: JS cosine similarity scan (capped at 100 listings) ---
    const listings = await Listing.find({ listingVector: { $exists: true, $ne: [] } })
        .select('title city listingType price rentalPeriod image searchContext listingVector')
        .sort({ updatedAt: -1 })
        .limit(100);

    return listings
        .map(l => ({ ...l.toObject(), score: cosineSimilarity(queryVector, l.listingVector) }))
        .filter(l => l.score > 0.3)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
}

/**
 * Try each LLM model in order. Returns first successful streaming response.
 * For non-streaming fallback calls (summarization etc.).
 */
async function callLLMWithFallback(messages, max_tokens) {
    let lastErr;
    for (const model of LLM_MODELS) {
        try {
            return await openai.chat.completions.create({ model, messages, max_tokens });
        } catch (err) {
            console.warn(`[Fallback Warning] Model ${model} failed, trying next if available...`, err.message);
            lastErr = err;
        }
    }
    throw lastErr;
}

/**
 * Try each LLM model in order, returning a stream.
 * Returns { stream, model } for the first model that succeeds.
 */
async function callLLMStreamWithFallback(messages, max_tokens) {
    let lastErr;
    for (const model of LLM_MODELS) {
        try {
            const stream = await openai.chat.completions.create({
                model,
                messages,
                max_tokens,
                stream: true
            });
            return { stream, model };
        } catch (err) {
            console.warn(`[Stream Fallback] Model ${model} failed, trying next...`, err.message);
            lastErr = err;
        }
    }
    throw lastErr;
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

// 2. HANDLE MESSAGE (Streaming SSE)
module.exports.handleMessage = async (req, res) => {
    try {
        const { message, conversationId } = req.body;

        if (!message || !message.trim()) {
            return res.status(400).json({ error: 'Message cannot be empty' });
        }
        if (message.trim().length > 800) {
            return res.status(400).json({ error: 'Message is too long. Please keep it under 800 characters.' });
        }

        // ── OPTIMIZATION: Fire all independent DB/API calls simultaneously ──
        // Conversation lookup, profile fetch, and embedding generation are all independent.
        // Run them in parallel to save ~600-1000ms vs running them one by one.
        const [existingConversation, userProfile, queryVector] = await Promise.all([
            conversationId
                ? Conversation.findOne({ _id: conversationId, user: req.user._id })
                : Promise.resolve(null),
            Profile.findOne({ user: req.user._id }),
            generateEmbedding(message, 'query').catch(err => {
                console.error('[Embedding] Failed:', err.message);
                return null;
            })
        ]);

        // Resolve conversation object (use existing or create new)
        let conversation = existingConversation;
        if (!conversation) {
            // New conversation — trigger background summarization of old chats
            summarizeUnsummarizedChats(req.user._id).catch(e => console.error(e));
            conversation = new Conversation({
                user: req.user._id,
                title: message.substring(0, 50) + (message.length > 50 ? '...' : ''),
                messages: [],
                lastSummarizedIndex: 0
            });
        }

        // Build chat history from existing messages (CPU-only, instant)
        const chatHistory = buildSlidingHistory(conversation.messages);

        // Resolve user context from profile
        const userContextInfo = userProfile && userProfile.agentContext
            ? userProfile.agentContext
            : 'No historical context gathered yet.';
        const userFullName = userProfile && userProfile.fullName ? userProfile.fullName : 'the user';

        // ── Listing search (only runs now that we have the embedding) ──
        let matchedListingsDocs = [];
        let listingsContext = 'No specific listings matched the query.';

        try {
            if (queryVector) {
                matchedListingsDocs = await searchListings(queryVector);
                if (matchedListingsDocs.length > 0) {
                    listingsContext = matchedListingsDocs.map(l => `[ID: ${l._id}] ${l.searchContext}`).join('\n\n');
                }
            }
        } catch (searchErr) {
            console.error('[Search] Vector search failed, proceeding without listings:', searchErr.message);
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

        const messages = [
            { role: 'system', content: dynamicSystemPrompt },
            ...chatHistory,
            { role: 'user', content: message }
        ];

        // ── STREAMING RESPONSE via SSE ──
        // Open a streaming connection to the LLM and pipe tokens to the browser
        // as they arrive. This gives a near-instant perceived response time.
        const { stream } = await callLLMStreamWithFallback(messages, 300);

        // Set SSE headers — tells browser this is an event stream, not a regular response
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        // Send metadata first (conversation ID, matched listings) so the client
        // can update the sidebar even before the first token arrives
        res.write(`data: ${JSON.stringify({
            type: 'meta',
            conversationId: conversation._id,
            conversationTitle: conversation.title,
            matchedListings: matchedListingsPayload
        })}\n\n`);

        // Stream tokens as they arrive from the LLM
        let fullResponse = '';
        for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content || '';
            if (delta) {
                fullResponse += delta;
                res.write(`data: ${JSON.stringify({ type: 'token', content: delta })}\n\n`);
            }
        }

        // Signal stream end
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();

        // Save to DB after stream completes (non-blocking from user perspective)
        if (fullResponse.trim()) {
            conversation.messages.push({ role: 'user', content: message, matchedListings: [] });
            conversation.messages.push({ role: 'agent', content: fullResponse, matchedListings: matchedListingIds });
            await conversation.save();
        }

    } catch (err) {
        console.error('Agent error:', err.message || err);

        // If headers not sent yet, send a proper JSON error
        if (!res.headersSent) {
            if (err.status === 429 || (err.message && err.message.includes('429'))) {
                return res.status(503).json({ error: 'AI is rate-limited. Please wait a moment and try again.' });
            }
            return res.status(500).json({ error: 'The agent encountered an error. Please try again.' });
        }

        // If we are already streaming, send an error event and close
        try {
            res.write(`data: ${JSON.stringify({ type: 'error', message: 'Stream interrupted. Please try again.' })}\n\n`);
            res.end();
        } catch (_) {}
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
