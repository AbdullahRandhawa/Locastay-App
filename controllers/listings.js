const Listing = require('../models/listing.js');
const User = require('../models/user');
const CATEGORIES = require('../utils/categories'); // Your master list

const mbxGeocoding = require('@mapbox/mapbox-sdk/services/geocoding');
const mapToken = process.env.MAP_TOKEN;
const geocodingClient = mbxGeocoding({ accessToken: mapToken });

const { generateEmbedding } = require('../utils/embedding');

// Helper: Build a labeled search context string for LLM + vector embeddings
function buildSearchContext(listing) {
    const parts = [];

    // Identity
    if (listing.mainCategory) parts.push(`Main Category: ${listing.mainCategory}`);
    if (listing.listingType) parts.push(`Listing Type: ${listing.listingType}`);
    if (listing.subCategory) parts.push(`Sub Category: ${listing.subCategory}`);
    if (listing.title) parts.push(`Title: ${listing.title}`);

    // Quality & Price
    if (listing.conditionGrade != null) parts.push(`Condition: ${listing.conditionGrade}/10`);
    if (listing.price != null) parts.push(`Price: ${listing.price} ${listing.rentalPeriod !== 'N/A' ? 'per ' + listing.rentalPeriod : ''}`);

    // Location
    if (listing.city) parts.push(`City: ${listing.city}`);
    if (listing.country) parts.push(`Country: ${listing.country}`);
    if (listing.address) parts.push(`Address: ${listing.address}`);



    // Specifications
    if (listing.specifications) {
        const specs = listing.specifications;
        if (specs.make) parts.push(`Make: ${specs.make}`);
        if (specs.model) parts.push(`Model: ${specs.model}`);
        if (specs.year) parts.push(`Year: ${specs.year}`);
        if (specs.area) parts.push(`Area: ${specs.area}`);
        if (specs.bedrooms != null) parts.push(`Bedrooms: ${specs.bedrooms}`);
        if (specs.bathrooms != null) parts.push(`Bathrooms: ${specs.bathrooms}`);
        if (specs.brand) parts.push(`Brand: ${specs.brand}`);
        if (specs.experience) parts.push(`Experience: ${specs.experience}`);
    }



    // Description (last, truncated)
    if (listing.description) {
        const desc = listing.description.length > 500
            ? listing.description.substring(0, 500) + '...'
            : listing.description;
        parts.push(`Description: ${desc}`);
    }

    return parts.join(' | ');
}

// 1. INDEX ROUTE
module.exports.index = async (req, res) => {
    const allListings = await Listing.find({});
    res.render('listings/index.ejs', { allListings });
};

// 2. SEARCH ROUTE (Updated to include new categories)
module.exports.searchListings = async (req, res, next) => {
    let { q } = req.query;
    const searchQuery = new RegExp(q, "i");

    const matchingOwners = await User.find({ username: { $regex: searchQuery } });
    const ownerIds = matchingOwners.map(owner => owner._id);

    const allListings = await Listing.find({
        $or: [
            { title: { $regex: searchQuery } },
            { city: { $regex: searchQuery } },
            { country: { $regex: searchQuery } },
            { mainCategory: { $regex: searchQuery } },
            { subCategory: { $regex: searchQuery } },
            { searchContext: { $regex: searchQuery } },
            { owner: { $in: ownerIds } }
        ]
    });

    res.render('listings/search.ejs', { allListings, q });
};

// 3. RENDER NEW FORM
module.exports.renderNewForm = (req, res) => {
    res.render('listings/new.ejs', { CATEGORIES });
};













// 4. CREATE LISTING (The Heavy Lifter)
module.exports.createListing = async (req, res) => {

    const response = await geocodingClient
        .forwardGeocode({
            query: `${req.body.listing.city}, ${req.body.listing.country}`,
            limit: 1
        })
        .send();



    const newListing = new Listing(req.body.listing);




    // Handle Images Array from Multer
    newListing.image = [];
    if (req.files && req.files.length > 0) {
        req.files.forEach(file => {
            newListing.image.push({
                url: file.path,
                filename: file.filename
            });
        });
    }

    newListing.owner = req.user._id;



    // Safety check for Mapbox response
    if (response.body.features.length > 0) {
        newListing.geometry = response.body.features[0].geometry;
    } else {
        newListing.geometry = { type: "Point", coordinates: [0, 0] };
    }




    newListing.searchContext = buildSearchContext(newListing);

    // Generate and store embedding for semantic search (non-blocking)
    try {
        newListing.listingVector = await generateEmbedding(newListing.searchContext, 'passage');
    } catch (embErr) {
        console.warn('Embedding generation failed (listing still saved):', embErr.message);
    }

    const newly = await newListing.save();
    req.flash("success", "New listing created successfully!");
    res.redirect(`/listings/${newly._id}`);
};
















// 5. SHOW LISTING
module.exports.showListing = async (req, res) => {
    let { id } = req.params;
    const idListing = await Listing.findById(id)
        .populate({
            path: "reviews",
            populate: { path: "author" }
        })
        .populate('owner');

    if (!idListing) {
        req.flash("error", "Listing you requested for does not exist!");
        return res.redirect('/listings');
    }
    res.render('listings/show.ejs', { idListing });
};

// 6. RENDER EDIT FORM (With your 150px Thumbnail logic)
module.exports.renderEditForm = async (req, res) => {
    let { id } = req.params;
    const listing = await Listing.findById(id);

    if (!listing) {
        req.flash("error", "Listing not found!");
        return res.redirect('/listings');
    }

    // Your original thumbnail replacement logic
    const duplicates = [];
    listing.image.forEach(image => {
        let originalimageUrl = image.url;
        let duplicate = originalimageUrl.replace('/upload', '/upload/w_150');
        duplicates.push(duplicate);
    });

    res.render('listings/edit.ejs', { listing, duplicates, CATEGORIES });
};

// 7. EDIT LISTING
module.exports.editListing = async (req, res) => {
    const { id } = req.params;

    const response = await geocodingClient
        .forwardGeocode({
            query: `${req.body.listing.city}, ${req.body.listing.country}`,
            limit: 1
        })
        .send();

    let listing = await Listing.findById(id);

    // Update all fields from the form
    listing.set({ ...req.body.listing });

    // Update geometry
    if (response.body.features.length > 0) {
        listing.geometry = response.body.features[0].geometry;
    }

    // Handle new images being added
    if (req.files && req.files.length > 0) {
        req.files.forEach(file => {
            listing.image.push({
                url: file.path,
                filename: file.filename
            });
        });
    }

    listing.searchContext = buildSearchContext(listing);

    // Re-generate embedding after edit (non-blocking)
    try {
        listing.listingVector = await generateEmbedding(listing.searchContext, 'passage');
    } catch (embErr) {
        console.warn('Embedding generation failed (listing still saved):', embErr.message);
    }

    await listing.save();
    req.flash("success", "Listing edited successfully!");
    res.redirect(`/listings/${id}`);
};

// 8. DELETE LISTING
module.exports.deleteListing = async (req, res) => {
    let { id } = req.params;
    await Listing.findByIdAndDelete(id);
    req.flash("success", "Listing deleted successfully!");
    res.redirect('/listings');
};