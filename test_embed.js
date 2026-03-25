require('dotenv').config();
const { generateEmbedding, cosineSimilarity } = require('./utils/embedding');

async function runTest() {
    try {
        console.log("Testing generateEmbedding (passage)...");
        const docVector = await generateEmbedding("This is a beautiful 2-bedroom apartment in London with a great view.", "passage");
        console.log(`Success! Embedding length: ${docVector.length}`);

        console.log("\nTesting generateEmbedding (query)...");
        const queryVector1 = await generateEmbedding("I want an apartment in London", "query");
        const queryVector2 = await generateEmbedding("Looking for a car to rent", "query");
        
        console.log("Success! Query embeddings generated.");

        console.log("\nTesting cosine similarity:");
        const sim1 = cosineSimilarity(queryVector1, docVector);
        const sim2 = cosineSimilarity(queryVector2, docVector);

        console.log(`Similarity (London apt query vs London apt doc): ${sim1.toFixed(4)}`);
        console.log(`Similarity (Car query vs London apt doc): ${sim2.toFixed(4)}`);
        
        if (sim1 > sim2) {
            console.log("\n✅ Semantic matching works! The relevant query scored higher.");
        } else {
            console.log("\n❌ Hmmm, semantic matching results are unexpected.");
        }
    } catch (err) {
        console.error("Test failed:", err);
    }
}

runTest();
