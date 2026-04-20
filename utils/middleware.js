const Listing = require('../models/listing');
const User = require('../models/user');
const { listingSchema, reviewSchema } = require('../schema');
const ExpressError = require('./ExpressError');
const { admin } = require('../firebaseAdmin');

// ─── isLoggedIn ───────────────────────────────────────────────────────────────
// Checks if the user is authenticated. 
// (The global middleware in app.js now securely decodes the Firebase 
// session cookie and explicitly populates req.user for every request)
module.exports.isLoggedIn = async (req, res, next) => {
    if (req.user) {
        return next();
    }

    const wantsJson = req.xhr ||
        (req.headers.accept && req.headers.accept.includes('application/json')) ||
        req.headers['content-type'] === 'application/json';

    // Not authenticated
    if (wantsJson) {
        return res.status(401).json({ error: 'Please log in to use this feature.' });
    }
    if (req.method === 'GET') {
        req.session.returnTo = req.originalUrl;
    }
    req.flash("error", "You must be logged in first!");
    return res.redirect('/login');
}


// ─── isOwner ─────────────────────────────────────────────────────────────────
// Checks if the authenticated user owns the listing.
// ADMIN SKELETON KEY: If req.user.role === 'admin', bypass the owner check entirely.
module.exports.isOwner = async (req, res, next) => {
    let { id } = req.params;
    const listing = await Listing.findById(id);

    // Admins can edit/delete any listing
    if (req.user.role === 'admin') {
        return next();
    }

    if (!listing.owner.equals(req.user._id)) {
        req.flash("error", "You aren't the owner of this listing!");
        return res.redirect(`/explore/${id}`);
    }
    next();
}


// ─── Validation Middlewares ───────────────────────────────────────────────────
module.exports.validateListing = (req, res, next) => {
    let { error } = listingSchema.validate(req.body);
    if (error) {
        const errMsg = error.details.map((el) => el.message).join(",");
        throw new ExpressError(400, errMsg);
    } else {
        next();
    }
}

// ─── isAdmin ──────────────────────────────────────────────────────────────────
// Only allows admin role users through.
module.exports.isAdmin = (req, res, next) => {
    if (!req.user) {
        req.flash('error', 'You must be logged in.');
        return res.redirect('/login');
    }
    if (req.user.role !== 'admin') {
        req.flash('error', 'Access denied. Admins only.');
        return res.redirect('/explore');
    }
    next();
};

// ─── canCreateListing ─────────────────────────────────────────────────────────
// Blocks users whose listing creation has been restricted by an admin.
module.exports.canCreateListing = (req, res, next) => {
    if (req.user && req.user.listingRestricted) {
        req.flash('error', 'Your account has been restricted from creating listings. Please contact an admin.');
        return res.redirect('/explore');
    }
    next();
};

module.exports.validateReview = (req, res, next) => {
    let { error } = reviewSchema.validate(req.body);
    if (error) {
        const errMsg = error.details.map((el) => el.message).join(",");
        throw new ExpressError(400, errMsg);
    } else {
        next();
    }
}
