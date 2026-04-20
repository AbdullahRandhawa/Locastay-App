const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const profileSchema = new Schema({
    fullName: {
        type: String,
    },
    username: String,
    profileImg: {
        url: {
            type: String,
            default: "https://res.cloudinary.com/dlvbwgybn/raw/upload/v1776667501/xtxev1yntpsjl42mhjlx.jpg"
        },
        filename: String
    },
    email: {
        type: String,
    },
    country: {
        type: String,
    },
    bio: String,
    phoneNumber: String,
    agentContext: {
        type: String,
        default: 'No specific context gathered yet.'
    },
    user: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true
    }
});

const Profile = mongoose.model("Profile", profileSchema);

module.exports = Profile;