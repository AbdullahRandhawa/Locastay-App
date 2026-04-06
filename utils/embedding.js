const openai = require('./openai');

const EMBED_MODEL = process.env.OPENROUTER_EMBED_MODEL || 'nvidia/llama-nemotron-embed-vl-1b-v2:free';

/**
 * Generate a vector embedding for a text string using OpenRouter.
 * @param {string} text - The input text to embed.
 * @param {string} inputType - 'passage' for indexing/documents, 'query' for search queries.
 * @returns {Promise<number[]>} The vector embedding array.
 */
async function generateEmbedding(text, inputType = 'passage') {
    if (!text || typeof text !== 'string') return null;

    try {
        const res = await openai.embeddings.create({
            model: EMBED_MODEL,
            input: text,
            encoding_format: 'float',
            extra_body: { input_type: inputType }
        });
        
        if (res.data && res.data.length > 0 && res.data[0].embedding) {
            return res.data[0].embedding;
        }
        throw new Error("No embedding returned from API.");
    } catch (err) {
        console.error(`Error generating embedding (${inputType}):`, err.message);
        // Return null so the caller skips vector search rather than using bad data
        return null;
    }
}

/**
 * Compute the cosine similarity between two vectors.
 * Range is roughly [-1, 1], where 1 is exactly identical.
 * @param {number[]} a - First vector
 * @param {number[]} b - Second vector
 * @returns {number} The cosine similarity score
 */
function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;

    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

module.exports = {
    generateEmbedding,
    cosineSimilarity
};
