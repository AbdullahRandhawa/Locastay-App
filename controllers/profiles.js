const Listing = require('../models/listing');
const Profile = require('../models/profile');
const User = require('../models/user');
const Conversation = require('../models/conversation');
const Review = require('../models/review');
const { cloudinary } = require('../cloudConfig');
const { admin, db } = require('../firebaseAdmin');

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
        const firebaseUid = req.user.firebaseUid;
        
        if (firebaseUid) {
            const userRef = db.collection("users").doc(firebaseUid);
            await userRef.set({
                avatar: (updatedProfile.profileImg && updatedProfile.profileImg.url) ? updatedProfile.profileImg.url : "",
                username: updatedProfile.username || req.user.username,
                fullName: updatedProfile.fullName || "",
                bio: updatedProfile.bio || ""
            }, { merge: true });
            
            console.log("Firebase Profile Synced successfully!");
        }

        console.log("Firebase Profile Synced successfully!");
        res.redirect('/profile');

    } catch (err) {
        console.error("Profile Update/Sync Error:", err.message);
        next(err);
    }
}

module.exports.deleteAccount = async (req, res, next) => {
    const userId = req.user._id;
    const firebaseUid = req.user.firebaseUid;

    console.log(`Initiating cascading deletion for user ${userId} (FB: ${firebaseUid})`);

    try {
        // --- 1. FIRESTORE NOCAP-CHAT CLEANUP ---
        if (firebaseUid) {
            const userchatsRef = db.collection("userchats").doc(firebaseUid);
            const userchatsDoc = await userchatsRef.get();

            if (userchatsDoc.exists) {
                const chats = userchatsDoc.data().chats || [];

                for (let chat of chats) {
                    const chatId = chat.chatId;
                    const receiverId = chat.receiverId;

                    // Delete the actual chat history document
                    if (chatId) {
                        await db.collection("chats").doc(chatId).delete().catch(e => console.error("Chat delete err:", e));
                    }

                    // Remove this chat reference from the OTHER user's userchats array
                    if (receiverId) {
                        const receiverRef = db.collection("userchats").doc(receiverId);
                        const receiverDoc = await receiverRef.get();
                        if (receiverDoc.exists) {
                            const receiverChats = receiverDoc.data().chats || [];
                            const updatedChats = receiverChats.filter(c => c.chatId !== chatId);
                            await receiverRef.update({ chats: updatedChats }).catch(e => console.error("Receiver update err:", e));
                        }
                    }
                }
                // Delete current user's userchats document
                await userchatsRef.delete();
            }

            // Delete current user's entry in users collection
            await db.collection("users").doc(firebaseUid).delete().catch(e => console.error("User doc delete err:", e));
            
            // Delete from Firebase Authentication
            await admin.auth().deleteUser(firebaseUid).catch(e => console.error("Auth delete err:", e));
        }

        // --- 2. MONGODB RENTLYST CLEANUP ---
        // A) Delete all conversations belonging to the user
        await Conversation.deleteMany({ user: userId });

        // B) Delete all listings owned by the user
        // We iterate and use findOneAndDelete so the Mongoose middleware fires to delete their Reviews and Cloudinary images too
        const listings = await Listing.find({ owner: userId });
        for (let listing of listings) {
            await Listing.findOneAndDelete({ _id: listing._id });
        }

        // C) Set all reviews left by this user on OTHER listings to Anonymous
        await Review.updateMany({ author: userId }, { $unset: { author: 1 } });

        // D) Delete Profile 
        await Profile.findOneAndDelete({ user: userId });

        // E) Delete User 
        await User.findByIdAndDelete(userId);

        // --- 3. SESSION TERMINATION ---
        res.clearCookie('__session');
        res.clearCookie('fbToken');
        req.flash('success', 'Your account and all associated data have been completely deleted.');
        res.redirect('/explore');

    } catch (err) {
        console.error("Account Deletion Error:", err);
        req.flash('error', 'There was a problem deleting your account. Please try again.');
        res.redirect('/profile');
    }
}