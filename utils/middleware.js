const Listing = require('../models/listing');
const { listingSchema, reviewSchema } = require('../schema');
const ExpressError = require('./ExpressError');

module.exports.isLoggedIn = (req, res, next) => {
    if (!req.isAuthenticated()) {
        // JSON API requests (fetch) — return 401 JSON, not an HTML redirect
        const wantsJson = req.xhr ||
            (req.headers.accept && req.headers.accept.includes('application/json')) ||
            req.headers['content-type'] === 'application/json';

        if (wantsJson) {
            return res.status(401).json({ error: 'Please log in to use this feature.' });
        }

        // Only set returnTo for GET requests so login redirects back sensibly
        if (req.method === 'GET') {
            req.session.returnTo = req.originalUrl;
        }
        req.flash("error", "User must be logged in first!");
        return res.redirect('/login');
    }
    next();
}


module.exports.isOwner = async (req, res, next) => {
    let { id } = req.params;
    const listing = await Listing.findById(id);

    if (!listing.owner.equals(req.user._id)) {
        req.flash("error", "You aren't owner of this listing!");
        return res.redirect(`/listings/${id}`);
    }
    next();
}


module.exports.validateListing = (req, res, next) => {
    let { error } = listingSchema.validate(req.body);
    if (error) {
        const errMsg = error.details.map((el) => el.message).join(",");
        throw new ExpressError(400, errMsg);
    } else {
        next();
    }
}

module.exports.validateReview = (req, res, next) => {
    let { error } = reviewSchema.validate(req.body);
    if (error) {
        const errMsg = error.details.map((el) => el.message).join(",");
        throw new ExpressError(400, errMsg);
    } else {
        next();
    }
}

