const Listing = require('./models/listing');
const { listingSchema, reviewSchema } = require('./schema');
const ExpressError = require('./utils/ExpressError');

module.exports.isLoggedIn = (req, res, next) => {
    if (!req.isAuthenticated()) {
        req.session.returnTo = req.originalUrl;
        if (req.method === 'POST' || req.method === 'DELETE') {
            req.session.returnTo = `/listings/${req.params.id}`;
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
    let { err } = listingSchema.validate(req.body);
    if (err) {
        const errMsg = err.details.map((el) => el.message).join(",");
        throw new ExpressError(400, errMsg);
    } else {
        next();
    }
}

module.exports.validateReview = (req, res, next) => {
    let { err } = reviewSchema.validate(req.body);
    if (err) {
        const errMsg = err.details.map((er) => el.message).join(",");
        throw new ExpressError(400, errMsg);
    } else {
        next();
    }
}

