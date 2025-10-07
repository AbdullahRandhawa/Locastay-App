const Listing = require('../models/listing');
const Profile = require('../models/profile');
const User = require('../models/user');
const { cloudinary } = require('../cloudConfig');






module.exports.profile = async (req, res, next) => {

    const ownerId = req.user._id;
    const profile = await Profile.findOne({ user: ownerId });

    const allListings = await Listing.find({ owner: ownerId });

    res.render('users/profile.ejs', { allListings, profile });
}


module.exports.renderProfileEditForm = async (req, res, next) => {
    const userId = req.user._id;
    const profile = await Profile.findOne({ user: userId });
    res.render('users/editProfile.ejs', { profile });
}


module.exports.editProfile = async (req, res, next) => {
    const userId = req.user._id;
    await Profile.findOneAndUpdate({ user: userId }, { ...req.body.profile });

    if (req.file) {
        let profile = await Profile.findOne({ user: userId });
        if (profile && profile.profileImg && profile.profileImg.filename) {
            await cloudinary.uploader.destroy(profile.profileImg.filename);
        }
        profile.profileImg = {
            url: req.file.path,
            filename: req.file.filename
        };
        await profile.save();
    }

    res.redirect('/profile');
}


