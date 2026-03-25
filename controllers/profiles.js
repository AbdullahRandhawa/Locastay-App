const Listing = require('../models/listing');
const Profile = require('../models/profile');
const User = require('../models/user');
const { cloudinary } = require('../cloudConfig');
const { db } = require('../firebaseAdmin');

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

    try {
        let updatedProfile = await Profile.findOneAndUpdate(
            { user: userId },
            { ...req.body.profile },
            { new: true }
        );

        if (req.file) {
            if (updatedProfile && updatedProfile.profileImg && updatedProfile.profileImg.filename) {
                await cloudinary.uploader.destroy(updatedProfile.profileImg.filename);
            }
            updatedProfile.profileImg = {
                url: req.file.path,
                filename: req.file.filename
            };
            await updatedProfile.save();
        }

        // Firebase Sync logic
        const firebaseUid = userId.toString();
        const userRef = db.collection("users").doc(firebaseUid);

        await userRef.update({
            avatar: updatedProfile.profileImg.url,
            username: updatedProfile.username || req.user.username,
            bio: updatedProfile.bio || ""
        });

        console.log("Firebase Profile Synced successfully!");
        res.redirect('/profile');

    } catch (err) {
        console.error("Profile Update/Sync Error:", err.message);
        next(err);
    }
}