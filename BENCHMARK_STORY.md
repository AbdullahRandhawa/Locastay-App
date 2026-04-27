RENTLYST AI AGENT: THE BENCHMARK STORY

This document outlines the evolution of our search performance testing, from initial validation to the final production-ready metrics.

PHASE 1: THE FOUNDATION (V1)
Goal: Verify that the AI could distinguish between "Search" intent and "General Chat" intent.
Outcome: Successfully established the Intent Extraction pipeline using Gemini Flash, achieving high accuracy in detecting when a user actually wants to look for a listing.

PHASE 2: ADVANCED LOGIC AND FALLBACKS (V2)
Goal: Test the "Hard/Soft Fallback" pipeline on a fixed set of 50 positive and negative prompts.
Challenge: We discovered that rigid search (Regex) failed on natural language, but our Vector search sometimes lacked precision when specific categories were missing.
Solution: Refined the search controller to prioritize "Hard" matches (Category + Specs) before falling back to "Soft" matches (Category only).

PHASE 3: FINAL PRODUCTION BENCHMARK (V3)
Goal: A rigorous, real-world test conducted on 50 live listings from the production database.
Methodology: 
1. For every listing, the AI generated a unique, natural language search query as a real user would write.
2. These queries were passed through the final Hard/Soft Fallback pipeline.
3. Performance was measured against a baseline Rigid Regex Search.
Final Result: The AI pipeline achieved a 76% success rate, outperforming the rigid search (34%) by a massive 42% margin.

ARTIFACTS
- agent-test-v1.js: Initial intent validation.
- agent-test-v2.js: Advanced specification testing.
- agent-test-v3.js: The final benchmarking engine.
- benchmark-v3-results.csv: Detailed per-query results for data visualization.
