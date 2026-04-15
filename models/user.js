const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Passport-local-mongoose is completely removed.
// Firebase handles all passwords and authentication.
// We store only the Firebase UID and basic profile info here.

const userSchema = new Schema({
    firebaseUid: {
        type: String,
        required: true,
        unique: true,  // Links perfectly to Firebase Auth
    },
    email: {
        type: String,
        required: true,
        unique: true,
    },
    username: {
        type: String,
        required: true,
        unique: true,
    },
    role: {
        type: String,
        enum: ['user', 'admin'],
        default: 'user',  // All new users are regular users by default
    }
});

module.exports = mongoose.model("User", userSchema);