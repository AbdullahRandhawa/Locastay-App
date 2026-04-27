const Listing = require('../models/listing.js');
const User = require('../models/user');
const Profile = require('../models/profile');
const CATEGORIES = require('../utils/categories'); // Your master list

const mbxGeocoding = require('@mapbox/mapbox-sdk/services/geocoding');
const mapToken = process.env.MAP_TOKEN;
const geocodingClient = mbxGeocoding({ accessToken: mapToken });

const { generateEmbedding } = require('../utils/embedding');
const openai = require('../utils/openai');

const rawModels = process.env.OPENROUTER_FALLBACK_MODELS || "deepseek/deepseek-v4-flash";
const AI_MODEL = rawModels.split(',')[0].trim();

async function getCleanedDescription(rawText) {
    if (!rawText || rawText.trim() === '') return '';
    try {
        const prompt = `Extract only hard facts, specifications, colors, and condition details from this text. Remove all sales bias, adjectives, and fluff. Be extremely concise. Return only the extracted facts. Text: "${rawText}"`;
        const completion = await openai.chat.completions.create({
            model: AI_MODEL,
            messages: [{ role: 'user', content: prompt }]
        });
        return completion.choices[0].message.content.trim();
    } catch (e) {
        console.warn('LLM description cleaning failed:', e.message);
        return rawText;
    }
}

// Helper: Build a pure value-only search context string for LLM + vector embeddings
function buildSearchContext(listing, cleanedDescriptionText) {
    const parts = [];

    // Identity
    if (listing.mainCategory) parts.push(listing.mainCategory);
    if (listing.listingType) parts.push(listing.listingType);
    if (listing.subCategory) parts.push(listing.subCategory);
    if (listing.title) parts.push(listing.title);

    // Quality & Price
    if (listing.mainCategory !== 'Service' && listing.conditionGrade != null) {
        parts.push(`${listing.conditionGrade}/10`);
    }

    // Location
    if (listing.city) parts.push(listing.city);
    if (listing.country) parts.push(listing.country);

    // Specifications
    if (listing.specifications) {
        const specs = listing.specifications;
        if (specs.make) parts.push(specs.make);
        if (specs.model) parts.push(specs.model);
        if (specs.year) parts.push(specs.year);
        if (specs.area) parts.push(specs.area);
        if (specs.bedrooms != null) parts.push(`${specs.bedrooms} bed`);
        if (specs.bathrooms != null) parts.push(`${specs.bathrooms} bath`);
        if (specs.brand) parts.push(specs.brand);
        if (specs.experience) parts.push(`${specs.experience} yrs exp`);
        if (specs.serviceLocation) parts.push(specs.serviceLocation);
    }

    // Cleaned Description
    if (cleanedDescriptionText) {
        parts.push(cleanedDescriptionText);
    }

    return parts.join(', ');
}

// 1. INDEX ROUTE
module.exports.index = async (req, res) => {
    const allListings = await Listing.find({});
    res.render('explore/index.ejs', { allListings, CATEGORIES });
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

    res.render('explore/search.ejs', { allListings, q });
};

// 3. RENDER NEW FORM
module.exports.renderNewForm = (req, res) => {
    res.render('explore/new.ejs', { CATEGORIES });
};













// 4. CREATE LISTING (The Heavy Lifter)
module.exports.createListing = async (req, res) => {

    if (req.body.listing.mainCategory === 'Service') {
        delete req.body.listing.conditionGrade;
    }

    // --- PARALLEL EXECUTION: Mapbox & LLM De-fluffing ---
    const geocodePromise = geocodingClient.forwardGeocode({
        query: `${req.body.listing.city}, ${req.body.listing.country}`,
        limit: 1
    }).send();

    const cleanDescPromise = getCleanedDescription(req.body.listing.description);

    // Wait for BOTH to finish concurrently
    const [response, cleanedDescription] = await Promise.all([geocodePromise, cleanDescPromise]);

    const newListing = new Listing(req.body.listing);
    newListing.conditionGrade = newListing.mainCategory === 'Service' ? undefined : newListing.conditionGrade;

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

    if (response.body.features.length > 0) {
        newListing.geometry = response.body.features[0].geometry;
    } else {
        newListing.geometry = { type: "Point", coordinates: [0, 0] };
    }

    // Build the string using ONLY values and the AI-cleaned description
    newListing.searchContext = buildSearchContext(newListing, cleanedDescription);

    console.log("\n====== [CREATE] LISTING DATA ======");
    console.log("Original Description:", req.body.listing.description);
    console.log("LLM Cleaned Description:", cleanedDescription);
    console.log("Final Search Context:", newListing.searchContext);
    console.log("===================================\n");

    try {
        newListing.listingVector = await generateEmbedding(newListing.searchContext, 'passage');
        if (newListing.listingVector && newListing.listingVector.length > 0) {
            console.log(`✅ [SUCCESS] Generated Embedding Vector!`);
            console.log(`   -> Array Length: ${newListing.listingVector.length} dimensions`);
            console.log(`   -> Sample Data: [${newListing.listingVector[0].toFixed(4)}, ${newListing.listingVector[1].toFixed(4)}, ${newListing.listingVector[2].toFixed(4)} ...]\n`);
        }
    } catch (embErr) {
        console.warn('❌ Embedding generation failed (listing still saved):', embErr.message);
    }

    const newly = await newListing.save();
    req.flash("success", "New listing created successfully!");
    res.redirect(`/explore/${newly._id}`);
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
        return res.redirect('/explore');
    }

    // Fetch the host's profile
    const hostProfile = idListing.owner ? await Profile.findOne({ user: idListing.owner._id }).lean() : null;
    console.log("Host Profile:", JSON.stringify(hostProfile));

    // Fetch all reviewers' profiles
    const reviewerIds = idListing.reviews.map(r => r.author ? r.author._id : null).filter(id => id != null);
    const reviewerProfiles = await Profile.find({ user: { $in: reviewerIds } }).lean();
    
    // Create a map of userId -> profileImg url
    const profileImgMap = {};
    reviewerProfiles.forEach(p => {
        if (p.profileImg && p.profileImg.url) {
            profileImgMap[p.user.toString()] = p.profileImg.url;
        }
    });
    console.log("Profile Img Map:", profileImgMap);

    res.render('explore/show.ejs', { idListing, hostProfile, profileImgMap });
};

// 6. RENDER EDIT FORM (With your 150px Thumbnail logic)
module.exports.renderEditForm = async (req, res) => {
    let { id } = req.params;
    const listing = await Listing.findById(id);

    if (!listing) {
        req.flash("error", "Listing not found!");
        return res.redirect('/explore');
    }

    // Your original thumbnail replacement logic
    const duplicates = [];
    listing.image.forEach(image => {
        let originalimageUrl = image.url;
        let duplicate = originalimageUrl.replace('/upload', '/upload/w_150');
        duplicates.push(duplicate);
    });

    res.render('explore/edit.ejs', { listing, duplicates, CATEGORIES });
};

// 7. EDIT LISTING
module.exports.editListing = async (req, res) => {
    const { id } = req.params;

    if (req.body.listing.mainCategory === 'Service') {
        delete req.body.listing.conditionGrade;
    }

    // --- PARALLEL EXECUTION: Mapbox & LLM De-fluffing ---
    const geocodePromise = geocodingClient.forwardGeocode({
        query: `${req.body.listing.city}, ${req.body.listing.country}`,
        limit: 1
    }).send();

    const cleanDescPromise = getCleanedDescription(req.body.listing.description);

    const [response, cleanedDescription] = await Promise.all([geocodePromise, cleanDescPromise]);

    let listing = await Listing.findById(id);

    // Update all fields from the form
    listing.set({ ...req.body.listing });

    if (listing.mainCategory === 'Service') {
        listing.conditionGrade = undefined;
    }

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

    // Rebuild context using new values and newly cleaned description
    listing.searchContext = buildSearchContext(listing, cleanedDescription);

    console.log("\n====== [EDIT] LISTING DATA ======");
    console.log("Original Description:", req.body.listing.description);
    console.log("LLM Cleaned Description:", cleanedDescription);
    console.log("Final Search Context:", listing.searchContext);
    console.log("=================================\n");

    try {
        listing.listingVector = await generateEmbedding(listing.searchContext, 'passage');
        if (listing.listingVector && listing.listingVector.length > 0) {
            console.log(`✅ [SUCCESS] Re-generated Embedding Vector!`);
            console.log(`   -> Array Length: ${listing.listingVector.length} dimensions`);
            console.log(`   -> Sample Data: [${listing.listingVector[0].toFixed(4)}, ${listing.listingVector[1].toFixed(4)}, ${listing.listingVector[2].toFixed(4)} ...]\n`);
        }
    } catch (embErr) {
        console.warn('❌ Embedding generation failed (listing still saved):', embErr.message);
    }

    await listing.save();
    req.flash("success", "Listing edited successfully!");
    res.redirect(`/explore/${id}`);
};

// 8. DELETE LISTING
module.exports.deleteListing = async (req, res) => {
    let { id } = req.params;
    await Listing.findByIdAndDelete(id);
    req.flash("success", "Listing deleted successfully!");
    res.redirect('/explore');
};