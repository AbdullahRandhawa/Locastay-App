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
            default: "https://images.pexels.com/photos/13305201/pexels-photo-13305201.jpeg"
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
    user: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true
    }
});

const Profile = mongoose.model("Profile", profileSchema);

module.exports = Profile;