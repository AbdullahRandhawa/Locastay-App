const User = require('../models/user');
const Profile = require('../models/profile');
const Listing = require('../models/listing');
const { admin } = require('../firebaseAdmin');

module.exports.renderDashboard = async (req, res) => {
    // Fetch all users except the currently logged in admin to prevent self-lockout
    const users = await User.find({ _id: { $ne: req.user._id } }).sort({ createdAt: -1 });

    // Fetch their associated profiles for avatars/names
    const userIds = users.map(u => u._id);
    const profiles = await Profile.find({ user: { $in: userIds } });
    
    // Map profiles to users for easy rendering
    const profileMap = {};
    profiles.forEach(p => {
        profileMap[p.user.toString()] = p;
    });

    res.render('admin/dashboard.ejs', { users, profileMap });
};

module.exports.toggleUserStatus = async (req, res) => {
    const { id } = req.params;
    const { field, value } = req.body;

    // Validate the field being changed to prevent arbitrary updates
    if (!['isDisabled', 'listingRestricted'].includes(field)) {
        req.flash('error', 'Invalid update field');
        return res.redirect('/admin');
    }

    const user = await User.findById(id);
    if (!user) {
        req.flash('error', 'User not found');
        return res.redirect('/admin');
    }

    // Toggle the boolean value
    user[field] = value === 'true';
    await user.save();

    // If completely disabling the user, optionally clear their firebase sessions 
    // so they are logged out immediately.
    if (field === 'isDisabled' && user.isDisabled && user.firebaseUid) {
        try {
            await admin.auth().revokeRefreshTokens(user.firebaseUid);
        } catch (e) {
            console.error('Error revoking tokens:', e);
        }
    }

    req.flash('success', `User ${user.username} updated successfully.`);
    res.redirect('/admin');
};

module.exports.deleteUser = async (req, res) => {
    const { id } = req.params;
    const user = await User.findById(id);
    
    if (!user) {
        req.flash('error', 'User not found');
        return res.redirect('/admin');
    }

    // 1. Delete listings owned by user
    await Listing.deleteMany({ owner: user._id });

    // 2. Delete profile
    await Profile.findOneAndDelete({ user: user._id });

    // 3. Delete from Firebase Auth if applicable
    if (user.firebaseUid) {
        try {
            await admin.auth().deleteUser(user.firebaseUid);
            // Optionally delete from firestore users/userchats if needed
            await admin.firestore().collection("users").doc(user.firebaseUid).delete();
            await admin.firestore().collection("userchats").doc(user.firebaseUid).delete();
        } catch (e) {
            console.error('Error deleting from firebase:', e);
        }
    }

    // 4. Delete user record
    await User.findByIdAndDelete(id);

    req.flash('success', `User ${user.username} deleted.`);
    res.redirect('/admin');
};
