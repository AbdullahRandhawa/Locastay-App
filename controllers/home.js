const Listing = require('../models/listing.js');
const CATEGORIES = require('../utils/categories');

// RENDER HOME (LANDING PAGE)
module.exports.renderHome = async (req, res) => {
    // Fetch recent items from each category for sliders
    const recentItems = await Listing.find({ mainCategory: 'Item' }).populate('owner').limit(15).sort({ _id: -1 });
    const recentVehicles = await Listing.find({ mainCategory: 'Vehicle' }).populate('owner').limit(15).sort({ _id: -1 });
    const recentProperties = await Listing.find({ mainCategory: 'Property' }).populate('owner').limit(15).sort({ _id: -1 });
    const recentServices = await Listing.find({ mainCategory: 'Service' }).populate('owner').limit(15).sort({ _id: -1 });

    res.render('home.ejs', { 
        CATEGORIES, 
        recentItems, 
        recentVehicles, 
        recentProperties, 
        recentServices 
    });
};
