const Conversation = require('../models/conversation');
const Profile = require('../models/profile');
const Listing = require('../models/listing');
const { generateEmbedding, cosineSimilarity } = require('../utils/embedding');
const openai = require('../utils/openai');
const CATEGORIES = require('../utils/categories');

const rawModels = process.env.OPENROUTER_FALLBACK_MODELS || "";
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
 * Summarize unsummarized messages and perform a "Smart Merge" into the Manager's Dossier.
 */
async function summarizeUnsummarizedChats(userId) {
    const userKey = userId.toString();
    const now = Date.now();
    const lastRun = summarizeCooldown.get(userKey) || 0;

    if (now - lastRun < SUMMARIZE_COOLDOWN_MS) return;
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

            // Only process if there are at least 3 new messages
            if (newMsgCount < 3) continue;

            const newMessages = conv.messages.slice(lastIdx);
            const chatText = newMessages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');

            // STEP 1: Extract fresh insights from the current conversation
            const summaryPrompt = `Analyze the chat to update the "Manager's Dossier" for this client. 
Focus ONLY on:
- Active Focus & Pivots: (What are they looking for RIGHT NOW? Did they switch from Cars to Items?)
- Buying/Renting Triggers: (Low price? Performance? Prestige? Reliability?)
- Hard Objections: (Specific things they rejected: "No Karachi listings", "Too expensive".)
- Identity & Facts: (Any mention of Name, School, Job, or Age.)

Rules:
1. Write this as a short, punchy briefing.
2. If no new psychological or strategic insights are found, reply: "NO_NEW_INFO"

Messages:
${chatText}`;

            const result = await callLLMWithFallback([{ role: 'user', content: summaryPrompt }], 400);
            const newInsights = (result?.choices?.[0]?.message?.content || '').trim();

            if (newInsights && !newInsights.includes('NO_NEW_INFO') && newInsights.length > 5) {

                // STEP 2: The "Smart Merge" - Refine the existing Dossier with new info
                const mergePrompt = `
You are a Senior Data Manager. Your task is to update the current "Manager's Dossier" with new insights.

CURRENT DOSSIER:
${profile.agentContext || "No context gathered yet."}

NEW INSIGHTS:
${newInsights}

STRICT INSTRUCTIONS:
1. Integrate new insights into the dossier.
2. DELETE/FLUSH outdated information (e.g., if the user moved from Cars to Houses, remove the specific car models they were looking at).
3. PROTECT Identity facts (Name, University, Profession).
4. Keep the output clean, organized by labels (Triggers, Objections, Vibe), and under 1000 characters.
5. Output the UPDATED DOSSIER only.`;

                const mergeResult = await callLLMWithFallback([{ role: 'user', content: mergePrompt }], 600);
                const updatedDossier = (mergeResult?.choices?.[0]?.message?.content || '').trim();

                if (updatedDossier && updatedDossier.length > 5) {
                    // This replaces the old messy text with the clean, pruned version
                    profile.agentContext = updatedDossier;
                }
            }

            // Mark these messages as processed
            conv.lastSummarizedIndex = totalMsgs;
            await conv.save();
        }

        // Save the cleaned-up profile context
        await profile.save();

    } catch (err) {
        console.error('Error during smart summarization:', err.message || err);
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

        if (filters.mainCategory && filters.mainCategory !== null) andClauses.push({ mainCategory: { $eq: filters.mainCategory } });
        if (filters.subCategory && filters.subCategory !== null) andClauses.push({ subCategory: { $eq: filters.subCategory } });
        if (filters.city && filters.city !== null) andClauses.push({ city: { $eq: filters.city } });
        if (filters.listingType && filters.listingType !== null) andClauses.push({ listingType: { $eq: filters.listingType } });

        if (includeSpecs && filters.specifications) {
            const specs = filters.specifications;
            if (specs.make && specs.make !== null) andClauses.push({ 'specifications.make': { $eq: specs.make } });
            if (specs.year && specs.year !== null) andClauses.push({ 'specifications.year': { $eq: specs.year } });
            if (specs.bedrooms && specs.bedrooms !== null) andClauses.push({ 'specifications.bedrooms': { $eq: specs.bedrooms } });
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
                    title: 1,
                    city: 1,
                    listingType: 1,
                    price: 1,
                    rentalPeriod: 1,
                    image: 1,
                    searchContext: 1,
                    mainCategory: 1,
                    subCategory: 1,
                    specifications: 1,
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
    try {
        const conversations = await Conversation.find({ user: req.user._id })
            .sort({ updatedAt: -1 })
            .select('title updatedAt')
            .lean();

        const profile = await Profile.findOne({ user: req.user._id }).lean();
        const profileImg = profile && profile.profileImg && profile.profileImg.url
            ? profile.profileImg.url
            : 'https://images.pexels.com/photos/13305201/pexels-photo-13305201.jpeg';

        // TRIGGER ON LOAD: This cleans up the Dossier the moment you open the app.
        // It processes any messages sent right before you last closed the browser.
        summarizeUnsummarizedChats(req.user._id).catch(e =>
            console.error("[Summarizer Initial Load Error]:", e.message || e)
        );

        res.render('agent/agent.ejs', { conversations, profileImg });
    } catch (err) {
        console.error('Error rendering agent page:', err);
        res.status(500).send('Internal Server Error');
    }
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
        const userDisplayName = userProfile && userProfile.fullName
            ? userProfile.fullName
            : (userProfile && userProfile.username ? userProfile.username : 'the user');

        // ── Step 2: Intent Extraction ──
        // Runs on every message — LLM decides whether a vector search is needed.
        const catsJSON = JSON.stringify(CATEGORIES);
        const intentExtractorPrompt = `You are the "Rentlyst Logic Engine". Extract search parameters into JSON.

**SEARCH STRATEGY:**
1. **The Data Packer Rule**: Your 'searchQuery' is used for Vector Search. Since our listings are embedded with full details, you MUST generate a descriptive 'searchQuery' that includes every piece of info you extracted (e.g., name of the item, main category, listing type, sub category,city, country make, model, year, color, location, price, category, sub-category) whatevr info is available to add.
2. **Minimal Filter Rule**: If even one piece of information is found (e.g., just a city or just a category), you MUST generate the JSON. Do not wait for a "complete" request.
3. **Null Handling**: Set any missing fields to null. Never hallucinate data.

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
- Set to TRUE only for finding new items or changing search or if the user mentions ANY searchable item, category, or location.
- Set to FALSE for greetings, general chitchat, or follow-up questions about already-displayed listings or non-search statements.

Valid Categories: ${catsJSON}

Output ONLY JSON:
{
  "searchQuery": "A rich, descriptive sentence combining all extracted filters and keywords for high-accuracy vector matching",
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

        // ── Step 4: Final AI Response Generation (Smart Advisor) ──
        // We send the FULL listing data as a JSON block to the LLM.
        // This ensures the agent sees Price, Specs, and Reviews, even though
        // those were excluded from the Vector Embedding to reduce noise.
        const listingsContext = matchedListingsDocs.length > 0
            ? JSON.stringify(matchedListingsDocs.map(l => {
                const obj = (typeof l.toObject === 'function') ? l.toObject() : l;
                delete obj.listingVector; // Don't waste tokens on the math array
                return obj;
            }), null, 2)
            : "NO CURRENT STOCK AVAILABLE";

        if (matchedListingsDocs.length > 0) {
            console.log("\n[AGENT DEBUG] Sending JSON Context to LLM. First item sample:");
            const firstItem = (typeof matchedListingsDocs[0].toObject === 'function') ? matchedListingsDocs[0].toObject() : matchedListingsDocs[0];
            const debugObj = { ...firstItem };
            delete debugObj.listingVector;
            console.log(JSON.stringify(debugObj, null, 2));
            console.log("-----------------------------------------------\n");
        }
        const dynamicSystemPrompt = `You are "Rentlyst Executive Lead" — a high-performing, bold, and expert marketplace manager. You move fast, speak with authority, and act as a professional closer for our clients.

**USER DOSSIER:**
User Name: ${userDisplayName || "Valued Client"}
Identity/Preferences: ${userContextInfo}

**CURRENT MARKET DATA:**
Query: "${queryAnalysis.searchQuery}"
Inventory Status: ${searchWasRelaxed ? "Relaxed Match (Inventory filtered to best available)" : "Exact Match Found"}

LISTINGS (JSON format):
${listingsContext || "NO CURRENT STOCK AVAILABLE"}

**THE PROFESSIONAL SELLER'S RULES:**
1. **JSON Intelligence**: You must parse the provided JSON data to see the full details (Price, Specs, and Review Summaries). Even though the search was performed via vector matching, you have the full raw data in front of you. Use it to be precise.
2. **Inventory Integrity**: Discuss ONLY the listings provided or engage in professional dialogue. If an item is not in the stock list, it does not exist on our floor. Do not hallucinate outside inventory.
3. **Handle Scarcity**: If the LISTINGS block is empty or says 'NO CURRENT STOCK,' you MUST NOT invent, imagine, or suggest any specific items, prices, or names. Instead, ask the user for more details to start a proper search.
4. **The "Pitch" Style**: Be decisive and confident. Use phrases like "This is the ideal match for you" or "Based on market trends, this is a move-fast deal." Prove your expertise by linking listings to the client's known standards.
4. **Information Protocol**: If the user asks for personal details (like their name or background), check the User Dossier and answer accurately and professionally. If they ask for outside data, offer to pull it for them but stay focused on the partnership.
5. **Tone Discipline**: Maintain a high-status, efficient, and professional tone. You are an expert partner, not a service bot. 
6. **Adaptive Communication**: Be personable. If the user asks for a joke or a specific non-business answer, provide it appropriately, but always bridge the conversation back to your role as their executive manager.

**RESPONSE STRUCTURE (Concise & Professional):**
- **NO HEADINGS. NO BULLET POINTS (except for listing the items).**
- For listings: Use conversational style and talk about main details in the format "#N | Name, price and Location . As of  Market Verdict (Expert opinion on the value)." 
- List items in the EXACT sequential order provided in the data.
- Use past history to build trust: "Previously, we discussed [Detail]. This [Listing] addresses that requirement perfectly."
- **Closing**: End with a directive statement  (e.g., "Should I lock this in?" or "Which one are we viewing first? or something betetr a ccording to situation"). Avoid corporate filler.`;
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

            // Trigger only if the new messages since last summary are 3 or more
            const unsummarizedCount = conversation.messages.length - (conversation.lastSummarizedIndex || 0);
            if (unsummarizedCount >= 3) {
                summarizeUnsummarizedChats(req.user._id).catch(e => console.error("[Summarizer Error]:", e));
            }

            console.log(`[Agent DB] Saved conversation ${conversation._id}`);
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
    try {
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

        // TRIGGER ON SWITCH: When you move to this chat, we summarize any 
        // pending data from other chats to ensure the Dossier is fresh.
        summarizeUnsummarizedChats(req.user._id).catch(e =>
            console.error("[Summarizer Background Error]:", e.message || e)
        );

        // Map the most recent agent listings to the sidebar payload
        let matchedListings = [];
        for (let i = conversation.messages.length - 1; i >= 0; i--) {
            const msg = conversation.messages[i];
            if (msg.role === 'agent' && msg.matchedListings && msg.matchedListings.length > 0) {
                matchedListings = msg.matchedListings.map(l => ({
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
    } catch (err) {
        console.error('Error fetching conversation:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// 5. DELETE CONVERSATION
module.exports.deleteConversation = async (req, res) => {
    await Conversation.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    res.json({ success: true });
};
