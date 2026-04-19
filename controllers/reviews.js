const Review = require('../models/review.js');
const Listing = require("../models/listing.js");
const openai = require('../utils/openai');

const LLM_MODEL = process.env.OPENROUTER_LLM_MODEL || 'meta-llama/llama-3.1-8b-instruct:free';

/**
 * Runs in the background after EVERY new review.
 * Sends the NEW review + existing summary to the LLM to get an
 * updated summary paragraph and a 1-10 rating.
 */
async function generateReviewSummary(listingId, newReviewId) {
    try {
        const listing = await Listing.findById(listingId);
        if (!listing) return;

        const newReview = await Review.findById(newReviewId);
        if (!newReview) return;

        const reviewText = `[Rating: ${newReview.rating}/5] "${newReview.comment}"`;

        const isFirstReview = !listing.reviewSummary;

        const previousContext = listing.reviewSummary
            ? `Existing Summary (contains ALL unique points captured so far — do NOT lose any of them):\n"${listing.reviewSummary}"`
            : null;

        const prompt = isFirstReview
            ? `You are an expert summarizing guest reviews for a property listing.

A new review was just posted:
${reviewText}

Task: Write ONE concise summary paragraph (2-4 sentences) that captures every good and bad point mentioned in this review. End the paragraph by naturally stating your rating out of 10 (e.g. "Overall this listing earns a 7/10."). Output ONLY the paragraph. No prefixes, no markdown.`
            : `You are an expert maintaining a cumulative guest-review summary for a property listing.

${previousContext}

A new review was just posted:
${reviewText}

Your task — follow these rules strictly:
1. PRESERVATION (most important): Every unique good or bad point already in the Existing Summary MUST remain in your output. Do not drop, omit, or water down any existing point under any circumstances.
2. UNIQUENESS CHECK: Read the new review carefully. Identify any point (positive OR negative) that is NOT already covered by the Existing Summary — even approximately or by implication.
3. ADDITION: If you found a genuinely new point in step 2, add it to the summary. If the new review only repeats or rephrases points already in the summary, do not add anything new.
4. RATING: End the paragraph with a natural sentence giving an overall rating out of 10 based on all the information (e.g. "Overall this listing earns a 6/10.").
5. LENGTH: Keep the output to 2-6 sentences. Be concise but comprehensive — do not omit details to save space.
6. FORMAT: Output ONLY the summary paragraph. No prefixes like "Summary:", no bullet points, no markdown.`;

        const result = await openai.chat.completions.create({
            model: LLM_MODEL,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 1000
        });

        // Safety check for invalid API responses (e.g. rate limits, model offline)
        if (!result || !result.choices || result.choices.length === 0 || !result.choices[0].message) {
            console.error('[ReviewSummary] Model returned an empty or invalid response. Response:', JSON.stringify(result));
            return;
        }

        const rawContent = result.choices[0].message.content;
        
        if (!rawContent || rawContent.trim() === '') {
             console.error('[ReviewSummary] Model returned empty content.');
             return;
        }

        const summary = rawContent.trim();

        if (summary) {
            listing.reviewSummary = summary;

            // Inject review opinion into searchContext so the AI agent can quote it.
            // We strip any previously appended review block first to avoid duplication.
            const baseContext = (listing.searchContext || '')
                .replace(/\s*\|\s*Guest Review Summary:.*$/s, '').trim();
            listing.searchContext = baseContext
                ? `${baseContext} | Guest Review Summary: ${summary}`
                : `Guest Review Summary: ${summary}`;

            await listing.save();
            console.log(`[ReviewSummary] Updated for listing ${listingId}`);
        }

    } catch (err) {
        console.error('[ReviewSummary] Error generating summary:', err.message || err);
    }
}


// CREATE REVIEW
module.exports.createReview = async (req, res, next) => {
    // --- Server-side validation ---
    const { rating, comment } = req.body.review || {};
    const parsedRating = Number(rating);

    if (!rating || isNaN(parsedRating) || parsedRating < 1 || parsedRating > 5) {
        req.flash('error', 'Rating must be a number between 1 and 5.');
        return res.redirect(`/explore/${req.params.id}`);
    }
    if (!comment || typeof comment !== 'string' || comment.trim().length === 0) {
        req.flash('error', 'Review comment cannot be empty.');
        return res.redirect(`/explore/${req.params.id}`);
    }
    if (comment.trim().length > 1000) {
        req.flash('error', 'Review comment must be 1000 characters or fewer.');
        return res.redirect(`/explore/${req.params.id}`);
    }

    const listing = await Listing.findById(req.params.id);

    const newReview = new Review({
        rating: parsedRating,
        comment: comment.trim(),
    });
    newReview.author = req.user._id;

    listing.reviews.push(newReview._id);
    await newReview.save();
    await listing.save();

    // Trigger summary generation in background for EVERY new review
    generateReviewSummary(listing._id, newReview._id).catch(e =>
        console.error('[ReviewSummary] Background job failed:', e.message)
    );

    req.flash('success', 'Review added successfully!');
    res.redirect(`/explore/${req.params.id}`);
}


// DELETE REVIEW
module.exports.deleteReview = async (req, res, next) => {
    let { id, reviewId } = req.params;
    await Listing.findByIdAndUpdate(id, { $pull: { reviews: reviewId } });
    await Review.findByIdAndDelete(reviewId);
    req.flash("success", "Review deleted successfuly!");
    res.redirect(`/explore/${id}`);
}