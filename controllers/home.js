const Listing = require('../models/listing.js');
const CATEGORIES = require('../utils/categories');
const User = require('../models/user');
const Profile = require('../models/profile');

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

// LEGAL PAGES
module.exports.renderTerms = (req, res) => res.render('legal/terms.ejs');
module.exports.renderPrivacy = (req, res) => res.render('legal/privacy.ejs');
module.exports.renderSitemap = (req, res) => res.render('legal/sitemap.ejs');

module.exports.renderHelp = async (req, res) => {
    try {
        const ADMIN_PRIORITY = ['useradmin1', 'useradmin2', 'useradmin3'];

        const adminUsers = await User.find({ username: { $in: ADMIN_PRIORITY } }).lean();
        const adminIds = adminUsers.map(u => u._id);
        const adminProfiles = await Profile.find({ user: { $in: adminIds } }).lean();

        const profileMap = {};
        adminProfiles.forEach(p => { profileMap[String(p.user)] = p; });

        const admins = ADMIN_PRIORITY
            .map(uname => adminUsers.find(u => u.username === uname))
            .filter(Boolean)
            .map(u => ({
                mongoId: u._id,
                username: u.username,
                avatar: profileMap[String(u._id)]?.profileImg?.url || null,
                fullName: profileMap[String(u._id)]?.fullName || null,
            }));

        res.render('legal/help.ejs', { admins });
    } catch (err) {
        console.error('Help page error:', err);
        res.render('legal/help.ejs', { admins: [] });
    }
};
