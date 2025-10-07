const Listing = require('../models/listing.js');
const User = require('../models/user');

const mbxGeocoding = require('@mapbox/mapbox-sdk/services/geocoding');
const mapToken = process.env.MAP_TOKEN;

const geocodingClient = mbxGeocoding({ accessToken: mapToken });


module.exports.index = async (req, res) => {
    const allListings = await Listing.find({});
    res.render('listings/index.ejs', { allListings });
}

module.exports.searchListings = async (req, res, next) => {
    let { q } = req.query;
    const searchQuery = new RegExp(q, "i");

    const matchingOwners = await User.find({ username: { $regex: searchQuery } });
    const ownerIds = matchingOwners.map(owner => owner._id);

    const allListings = await Listing.find({
        $or: [
            { title: { $regex: searchQuery } },
            { location: { $regex: searchQuery } },
            { country: { $regex: searchQuery } },
            { owner: { $in: ownerIds } }
        ]
    });

    res.render('listings/search.ejs', { allListings, q });
}

module.exports.renderNewForm = (req, res) => {
    res.render('listings/new.ejs');
}

module.exports.createListing = async (req, res) => {

    const response = await geocodingClient
        .forwardGeocode({
            query: `${req.body.listing.location}, ${req.body.listing.country}`,
            limit: 1
        })
        .send()

    const newListing = new Listing(req.body.listing);
    newListing.image = [];
    if (req.files) {
        req.files.forEach(file => {
            newListing.image.push({
                url: file.path,
                filename: file.filename
            })
        });
    } else {
        filename = undefined;
        url = undefined
    }




    newListing.owner = req.user._id;
    newListing.geometry = response.body.features[0].geometry;


    const newly = await newListing.save();
    req.flash("success", "New listting created successfully!");
    res.redirect(`/listings/${newly._id}`);

}



module.exports.showListing = async (req, res) => {
    let { id } = req.params;
    const idListing = await Listing.findById(id).populate({ path: "reviews", populate: { path: "author" }, }).populate('owner');

    if (!idListing) {
        req.flash("error", "Listing you requested for does not exist!");
        return res.redirect('/listings')
    }
    res.render('listings/show.ejs', { idListing });
}



module.exports.renderEditForm = async (req, res) => {
    let { id } = req.params;
    const listing = await Listing.findById(id);

    if (!listing) {
        req.flash("error", "Listing not found!");
        return res.redirect('/listings');
    }

    // let originalimageUrl = listing.image.url;
    // duplicate = originalimageUrl.replace('/upload', '/upload/w_200');

    const duplicates = [];
    listing.image.forEach(image => {
        let originalimageUrl = image.url;
        let duplicate = originalimageUrl.replace('/upload', '/upload/w_150');
        duplicates.push(duplicate);
    });


    res.render('listings/edit.ejs', { listing, duplicates });
}




module.exports.editListing = async (req, res) => {

    const response = await geocodingClient
        .forwardGeocode({
            query: `${req.body.listing.location}, ${req.body.listing.country}`,
            limit: 1
        })
        .send()

    let { id } = req.params;
    let listing = await Listing.findById(id);
    listing.set({ ...req.body.listing });
    listing.geometry = response.body.features[0].geometry;

    if (req.files && req.files.length > 0) {
        req.files.forEach(file => {
            listing.image.push({
                url: file.path,
                filename: file.filename
            });
        });
    }
    await listing.save();
    req.flash("success", "Listing edited successfully!");
    res.redirect(`/listings/${id}`);
};



module.exports.deleteListing = async (req, res) => {
    let { id } = req.params;
    await Listing.findByIdAndDelete(id);
    req.flash("success", "Listing deleted successfully!");
    res.redirect('/listings');
}