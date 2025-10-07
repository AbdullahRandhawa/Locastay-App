const Review = require('../models/review.js');
const Listing = require("../models/listing.js")


module.exports.createReview = async (req, res, next) => {
    const listing = await Listing.findById(req.params.id);

    const newReview = new Review(req.body.review);
    newReview.author = req.user._id;

    listing.reviews.push(newReview._id);

    await newReview.save();
    await listing.save();
    req.flash("success", "Review added successfuly!");
    res.redirect(`/listings/${req.params.id}`);
}


module.exports.deleteReview = async (req, res, next) => {
    let { id, reviewId } = req.params;
    await Listing.findByIdAndUpdate(id, { $pull: { reviews: reviewId } });
    await Review.findByIdAndDelete(reviewId);
    req.flash("success", "Review deleted successfuly!");
    res.redirect(`/listings/${id}`);
}