const Conversation = require('../models/conversation');
const Profile = require('../models/profile');
const Listing = require('../models/listing');
const { generateEmbedding, cosineSimilarity } = require('../utils/embedding');
const openai = require('../utils/openai');
const CATEGORIES = require('../utils/categories');

const rawModels = process.env.OPENROUTER_FALLBACK_MODELS || process.env.OPENROUTER_LLM_MODEL || "";
const LLM_MODELS = rawModels.split(',').map(m => m.trim()).filter(Boolean);

// Per-user message rate limiter — max 1 message per 2 seconds
const messageCooldown = new Map();
const MESSAGE_COOLDOWN_MS = 2000;

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

            if (newMsgCount < 3) continue;

            const newMessages = conv.messages.slice(lastIdx);
            const chatText = newMessages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');

            const summaryPrompt = `Analyze the chat to update the "Manager's Dossier" for this client.
Focus ONLY on:
- Buying/Renting Triggers: (What makes them say yes? Low price? Aesthetic? Location?)
- Hard Objections: (What have they explicitly rejected? "Too far from city", "Too expensive".)
- Personality Vibe: (Are they decisive, or do they need a push? Are they looking for luxury or a bargain?)

Rules:
1. Write this as a short, punchy briefing for a replacement manager.
2. If the user changed their mind (e.g. from Cars to Houses), note the pivot.
3. If no new psychological insights are found, reply: "NO_NEW_INFO"

Messages:
${chatText}`;

            const result = await callLLMWithFallback([{ role: 'user', content: summaryPrompt }], 300);
            const summary = (result?.choices?.[0]?.message?.content || '').trim();

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
                    const consolidated = (cResult?.choices?.[0]?.message?.content || '').trim();
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
 * Strict-to-Relaxed Vector Search.
 * Attempt 1: Atlas $vectorSearch with all extracted filters applied (category + city + specs).
 * Attempt 2: If zero results, relax spec filters but keep mainCategory + city + listingType locked.
 * Fallback:  Pure JS cosine scan if Atlas index not available.
 * Returns docs + a `isRelaxed` boolean flag so the agent knows to mention it.
 */
async function performSearch(queryVector, filters = {}) {
    const buildAtlasFilter = (includeSpecs) => {
        const andClauses = [];
        if (filters.mainCategory) andClauses.push({ mainCategory: { $eq: filters.mainCategory } });
        if (filters.subCategory) andClauses.push({ subCategory: { $eq: filters.subCategory } });
        if (filters.city) andClauses.push({ city: { $eq: filters.city } });
        if (filters.listingType) andClauses.push({ listingType: { $eq: filters.listingType } });
        if (includeSpecs && filters.specifications) {
            const specs = filters.specifications;
            if (specs.make) andClauses.push({ 'specifications.make': { $eq: specs.make } });
            if (specs.year) andClauses.push({ 'specifications.year': { $eq: specs.year } });
            if (specs.bedrooms) andClauses.push({ 'specifications.bedrooms': { $eq: specs.bedrooms } });
        }
        return andClauses.length > 0 ? { $and: andClauses } : undefined;
    };

    const runAtlasSearch = async (filter) => {
        const pipeline = [
            {
                $vectorSearch: {
                    index: 'listing_vector_index',
                    path: 'listingVector',
                    queryVector,
                    numCandidates: 200,
                    limit: 10,
                    ...(filter ? { filter } : {})
                }
            },
            {
                $project: {
                    title: 1, city: 1, listingType: 1, price: 1,
                    rentalPeriod: 1, image: 1, searchContext: 1, mainCategory: 1,
                    score: { $meta: 'vectorSearchScore' }
                }
            }
        ];
        return await Listing.aggregate(pipeline);
    };

    // --- Attempt 1: Atlas strict search (with specs) ---
    try {
        const strictFilter = buildAtlasFilter(true);

        // NEW SAFETY GATE: 
        // If the LLM failed to find a category AND there are no specs, 
        // don't let Atlas return the whole database.
        const isQueryEmpty = !filters.mainCategory && !filters.subCategory && !filters.city;

        if (isQueryEmpty && (!queryVector || queryVector.length === 0)) {
            console.log("[Search] Query is too vague, skipping search to prevent random results.");
            const emptyResults = [];
            emptyResults.isRelaxed = false;
            return emptyResults;
        }

        const strictResults = await runAtlasSearch(strictFilter);
        console.log(`[Search] Strict Atlas: ${strictResults.length} results`);
        if (strictResults.length > 0) {
            strictResults.isRelaxed = false;
            return strictResults;
        }

        // --- Attempt 2: Relaxed (drop specs, keep category+city+type) ---
        const relaxedFilter = buildAtlasFilter(false);
        const relaxedResults = await runAtlasSearch(relaxedFilter);
        console.log(`[Search] Relaxed Atlas: ${relaxedResults.length} results`);
        relaxedResults.isRelaxed = relaxedResults.length > 0;
        return relaxedResults;

    } catch (atlasErr) {
        console.warn('[Atlas Vector Search] Not available, falling back to JS cosine scan:', atlasErr.message);
    }

    // --- JS cosine fallback (no Atlas index) ---
    const fallbackQuery = {
        listingVector: { $exists: true, $ne: [] }
    };
    // Add these to make the fallback smarter
    if (filters.mainCategory) fallbackQuery.mainCategory = filters.mainCategory;
    if (filters.city) fallbackQuery.city = filters.city;

    const listings = await Listing.find(fallbackQuery).limit(500);

    const scored = listings
        .map(l => ({ ...l.toObject(), score: cosineSimilarity(queryVector, l.listingVector) }))
        .filter(l => l.score > 0.3)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
    scored.isRelaxed = false;
    return scored;
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

        // ── Rate Limit: 1 message per 2 seconds per user ──
        const userId = req.user._id.toString();
        const now = Date.now();
        const lastMsg = messageCooldown.get(userId) || 0;
        if (now - lastMsg < MESSAGE_COOLDOWN_MS) {
            return res.status(429).json({ error: 'Slow down! Wait a moment before sending another message.' });
        }
        messageCooldown.set(userId, now);

        // ── Step 1: Rapid Local DB Fetches ──
        const [existingConversation, userProfile] = await Promise.all([
            conversationId
                ? Conversation.findOne({ _id: conversationId, user: req.user._id })
                : Promise.resolve(null),
            Profile.findOne({ user: req.user._id })
        ]);

        let conversation = existingConversation;
        if (!conversation) {
            summarizeUnsummarizedChats(req.user._id).catch(e => console.error(e));
            conversation = new Conversation({
                user: req.user._id,
                title: message.substring(0, 50) + (message.length > 50 ? '...' : ''),
                messages: [],
                lastSummarizedIndex: 0
            });
        }
        const chatHistory = buildSlidingHistory(conversation.messages);

        // Resolve user context from profile
        const userContextInfo = userProfile && userProfile.agentContext
            ? userProfile.agentContext
            : 'No historical context gathered yet.';
        const userFullName = userProfile && userProfile.fullName ? userProfile.fullName : 'the user';

        // ── Step 2: Intent Extraction ──
        // Runs on every message — LLM decides whether a vector search is needed.
        const catsJSON = JSON.stringify(CATEGORIES);
        const intentExtractorPrompt = `You are the "Rentlyst Logic Engine". Extract search parameters into JSON.

**CATEGORY MAPPING RULES:**
1. **Strict Mapping**: You MUST map user slang to these exact Category/Sub-Category strings from the provided list:
   - "Heavy Bike", "70cc", "Scooty", "Hayabusa", "Bike" -> mainCategory: "Vehicle", subCategory: "Motorcycles"
   - "Flat", "Penthouse", "Studio", "1BHK" -> mainCategory: "Property", subCategory: "Apartments & Flats"
   - "iPhone", "Macbook", "Tab", "Phone", "Laptop" -> mainCategory: "Item", subCategory: "Tech (Mobiles, Tablets, Laptops)"
   - "Plot", "File", "Commercial Land", "DHA Phase 6 plot" -> mainCategory: "Property", subCategory: "Land & Plots"
   - "AC Repair", "Wiring", "Electrician" -> mainCategory: "Service", subCategory: "Home Services (Plumber, Electrician, HVAC)"

2. **Multi-Turn Priority**: Prioritize the LATEST message. If the user previously searched for Vehicles but now says "Show me houses," discard the Vehicle filters and switch to Property.
3. **Sticky Context**: Keep the City, Country, or Budget from earlier in this specific chat history unless the user explicitly changes them.

**DATA STANDARDIZATION:**
- Fix typos: "Colorla" -> "Corolla", "Civicc" -> "Civic", "Mehraan" -> "Mehran".
- Locations: Map "LHR" -> "Lahore", "KHI" -> "Karachi", "ISB" -> "Islamabad", "Pindi" -> "Rawalpindi".

**needsSearch RULES:**
- Set to TRUE only for finding new items or changing search criteria.
- Set to FALSE for greetings, general chitchat, or follow-up questions about already-displayed listings.

Valid Categories: ${catsJSON}

Output ONLY JSON:
{
  "searchQuery": "Standardized keywords for vector search",
  "filters": {
    "mainCategory": "Item | Vehicle | Property | Service | null",
    "subCategory": "Use the EXACT string from Valid Categories list | null",
    "listingType": "Sale | Rent | null",
    "city": "Standardized City Name | null",
    "country": "Standardized Country Name | null",
    "specifications": { "make": "string | null", "year": "number | null", "bedrooms": "number | null" }
  },
  "needsSearch": boolean
}`;

        let queryAnalysis = { needsSearch: false, searchQuery: message, filters: {} };
        try {
            const analysisMessages = [
                { role: 'system', content: intentExtractorPrompt },
                ...chatHistory,
                { role: 'user', content: message }
            ];
            const analysisResult = await callLLMWithFallback(analysisMessages, 2000);
            let content = analysisResult?.choices?.[0]?.message?.content;
            // Some reasoning models (Nemotron etc.) return content as an array of blocks
            if (Array.isArray(content)) {
                content = content.filter(b => b.type === 'text').map(b => b.text || '').join('');
            }
            if (!content) throw new Error('Intent extractor returned null content.');
            const cleaned = content.trim().replace(/```json/gi, '').replace(/```/g, '').trim();
            const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error('No JSON found in intent extractor response.');
            const parsed = JSON.parse(jsonMatch[0]);
            console.log('[Intent Extractor] needsSearch:', parsed.needsSearch, '| query:', parsed.searchQuery);
            console.log('[Intent Extractor] filters:', JSON.stringify(parsed.filters));
            queryAnalysis = {
                needsSearch: !!parsed.needsSearch,
                searchQuery: parsed.searchQuery || message,
                filters: parsed.filters || {}
            };
        } catch (analyzerErr) {
            console.log('[Intent Extractor] Failed. Setting search to false. Reason:', analyzerErr.message);
            queryAnalysis = { searchQuery: message, filters: {}, needsSearch: false };
        }

        // ── Step 3: Embed & Search (if needed) ──
        let matchedListingsDocs = [];
        let listingsContext = '';
        let searchWasRelaxed = false;

        if (queryAnalysis.needsSearch) {
            try {
                // Embed the clean searchQuery (not the raw message)
                const queryVector = await generateEmbedding(queryAnalysis.searchQuery, 'query');
                if (queryVector) {
                    matchedListingsDocs = await performSearch(queryVector, queryAnalysis.filters);
                    searchWasRelaxed = matchedListingsDocs.isRelaxed === true;
                }
            } catch (searchErr) {
                console.error('[Search] Vector search failed:', searchErr.message);
            }
        } else {
            // Retrieve previous listings from the conversation state
            let previousIds = [];
            for (let i = conversation.messages.length - 1; i >= 0; i--) {
                if (conversation.messages[i].role === 'agent' && conversation.messages[i].matchedListings?.length > 0) {
                    previousIds = conversation.messages[i].matchedListings;
                    break;
                }
            }
            if (previousIds.length > 0) {
                matchedListingsDocs = await Listing.find({ _id: { $in: previousIds } });
            }
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

        if (queryAnalysis.needsSearch) {
            if (matchedListingsDocs.length > 0) {
                listingsContext = "CURRENT INVENTORY MATCHES:\n" + matchedListingsDocs.map((l, index) =>
                    `[#${index + 1}] Title: ${l.title} | Price: ${l.price} | Context: ${l.searchContext}`
                ).join('\n\n');
            } else {
                listingsContext = "STATUS: Out of stock for this specific request.";
            }
        } else {
            if (matchedListingsDocs.length > 0) {
                listingsContext = "PREVIOUS INVENTORY MATCHES (Do not pitch unless relevant):\n" + matchedListingsDocs.map((l, index) =>
                    `[#${index + 1}] Title: ${l.title} | Price: ${l.price} | Context: ${l.searchContext}`
                ).join('\n\n');
            } else {
                listingsContext = "STATUS: No search requested. User is just engaging in conversation.";
            }
        }

        // ── Step 4: Final AI Response Generation (Smart Advisor) ──
        const dynamicSystemPrompt = `You are "Rentlyst Executive Lead" — a high-performing, bold, and expert marketplace manager. You move fast, speak with authority, and have the sharp wit of a professional closer.

**USER DOSSIER:**
Client Name: ${userFullName}
Intelligence/Preferences: ${userContextInfo}

**CURRENT MARKET DATA:**
Query: "${queryAnalysis.searchQuery}"
Inventory Status: ${searchWasRelaxed ? "Relaxed Match (Inventory filtered to best available)" : "Exact Match Found"}

LISTINGS:
${listingsContext || "NO CURRENT STOCK AVAILABLE"}

**THE PROFESSIONAL SELLER'S RULES:**
1. **Inventory Integrity**: Talk ONLY about the listings provided. If it's not in the stock list, it doesn't exist on our floor. Do not hallucinate outside options.
2. **Handle Scarcity**: If results are zero, don't apologize. Be a manager: "I’ve scanned our current inventory and we’re clear on that specific request. However, based on your history, I’ve got something else you need to see."
3. **The "Pitch" Style**: Be bold. Don't say "I think you might like." Say "This is the one for you." Use the "Secret Notes" to prove you’re the expert (e.g., "I know you've been tracking market prices, so you'll recognize this is a move-fast deal").
4. **Internet Protocol**: If a user asks for general market data or outside info, stay professional: "That's outside our current stock, but as your manager, I can pull global data if you want the full picture. Give me the word."
5. **Tone Discipline**: Maintain a high-status, efficient, and decisive tone. Never sound like a customer service bot. You are the partner, not the servant.

**RESPONSE STRUCTURE (Concise & Bold):**
- **NO HEADINGS. NO BULLET POINTS (except for listing the items).**
- Start with a strong opening line reflecting your personality.
- For listings: Use the format "#N | Name | Price | Market Verdict (Expert opinion on the value)."
- Deep dive only if they ask for details. Give a "Steal" or "Fair Value" rating.
- Use past history to build trust: "Last time we spoke, you mentioned [Detail]. This [Listing] addresses that perfectly."
- **Closing**: Always end with a directive (e.g., "Should I lock this in?" or "Which one are we viewing first?"). Avoid corporate filler.`;
        const messages = [
            { role: 'system', content: dynamicSystemPrompt },
            ...chatHistory,
            { role: 'user', content: message }
        ];

        // ── STREAMING RESPONSE via SSE ──
        // Open a streaming connection to the LLM and pipe tokens to the browser
        // as they arrive. This gives a near-instant perceived response time.
        const { stream } = await callLLMStreamWithFallback(messages, 2000);
        // Pre-save new conversations before streaming so the meta event _id is
        // immediately loadable from history (no race condition).
        if (conversation.isNew) await conversation.save();

        // Set SSE headers
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
            const rawDelta = chunk.choices[0]?.delta;
            let delta = '';
            if (typeof rawDelta?.content === 'string') {
                // Standard models: content is a plain string
                delta = rawDelta.content;
            } else if (Array.isArray(rawDelta?.content)) {
                // Claude thinking models: content is an array — extract text blocks only
                delta = rawDelta.content.filter(b => b.type === 'text').map(b => b.text || '').join('');
            }
            // Ignore thinking/reasoning chunks — they have no visible content
            if (delta) {
                fullResponse += delta;
                res.write(`data: ${JSON.stringify({ type: 'token', content: delta })}\n\n`);
            }
        }

        // Signal stream end
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();

        // Log the full response to terminal for debugging
        console.log(`[Agent Response] Length: ${fullResponse.length} chars`);
        console.log(`[Agent Response] Preview: ${fullResponse.substring(0, 300)}${fullResponse.length > 300 ? '...' : ''}`);

        // Save to DB after stream completes.
        if (fullResponse.trim()) {
            conversation.messages.push({ role: 'user', content: message, matchedListings: [] });
            conversation.messages.push({ role: 'agent', content: fullResponse, matchedListings: matchedListingIds });
            await conversation.save();
            console.log(`[Agent DB] Saved conversation ${conversation._id} (${conversation.messages.length} messages total)`);
        } else {
            console.log('[Agent DB] fullResponse was empty — skipping save.');
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
        } catch (_) { }
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
