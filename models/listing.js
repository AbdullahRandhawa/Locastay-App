const mongoose = require('mongoose');
const Review = require('./review');
const Schema = mongoose.Schema;
const { cloudinary } = require('../cloudConfig');

const listingSchema = new Schema({
    title: {
        type: String,
        required: true,
    },
    description: {
        type: String,
    },
    image: [
        {
            filename: { type: String },
            url: {
                type: String,
                default: "https://images.pexels.com/photos/13305201/pexels-photo-13305201.jpeg"
            },
        },
    ],
    price: Number,
    location: String,
    country: String,
    reviews: [
        {
            type: Schema.Types.ObjectId,
            ref: "Review",
        }],
    owner: {
        type: Schema.Types.ObjectId,
        ref: "User"
    },
    geometry: {
        type: {
            type: String, // Don't do `{ location: { type: String } }`
            enum: ['Point'], // 'location.type' must be 'Point'
            required: true
        },
        coordinates: {
            type: [Number],
            required: true
        }
    }
});


listingSchema.post('findOneAndDelete', async (listing) => {
    if (listing) {
        await Review.deleteMany({ _id: { $in: listing.reviews } });
        // Delete all associated images from Cloudinary
        if (listing.image.length > 0) {
            for (let image of listing.image) {
                await cloudinary.uploader.destroy(image.filename);
            }
        }
    }
});


const Listing = mongoose.model("Listing", listingSchema);
module.exports = Listing; 