/* 
   ══════════════════════════════════════════════════════════════════════════════
   DATABASE SCHEMA: RENTLYST USER
   ══════════════════════════════════════════════════════════════════════════════
   This file defines the 'Rentlyst User' entity from the ER diagram.
   Serves as the central link between local MongoDB records and 
   external Firebase Authentication (via firebaseUid).
*/
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
        default: 'user',
    },
    isDisabled: {
        type: Boolean,
        default: false,  // Admin can block this user from logging in
    },
    listingRestricted: {
        type: Boolean,
        default: false,  // Admin can block this user from creating listings
    }
});

module.exports = mongoose.model("User", userSchema);