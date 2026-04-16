const mongoose = require('mongoose');
const Review = require('./review');
const Schema = mongoose.Schema;
const { cloudinary } = require('../cloudConfig');
const CATEGORIES = require('../utils/categories');

const allSubCats = Object.values(CATEGORIES).flat();

const listingSchema = new Schema({
    title: {
        type: String,
        required: true,
    },
    description: {
        type: String,
        required: true,
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
    price: {
        type: Number,
        required: true,
    },

    city: {
        type: String,
        required: true,
    },
    country: {
        type: String,
        required: true,
    },
    address: {
        type: String,
        required: true,
    },


    mainCategory: {
        type: String,
        required: true,
        enum: Object.keys(CATEGORIES)
    },
    subCategory: {
        type: String,
        required: true,
        enum: allSubCats
    },

    listingType: {
        type: String,
        required: true,
        enum: ['Sale', 'Rent'],
        default: 'Sale'
    },
    rentalPeriod: {
        type: String,
        enum: ['hour', 'day', 'week', 'month', 'flat', 'N/A'],
        default: 'N/A'
    },
    conditionGrade: {
        type: Number,
        min: 1,
        max: 10,
        default: 5
    },

    specifications: {
        make: String,
        model: String,
        year: Number,
        area: String,
        bedrooms: Number,
        bathrooms: Number,
        brand: String,
        experience: String,
        portfolioLink: String,
        serviceLocation: {
            type: String,
            enum: ['Online', 'On-site', 'On-site & Online']
        }
    },


    searchContext: {
        type: String
    },
    listingVector: {
        type: [Number]
    },

    // AI-generated review intelligence
    reviewSummary: {
        type: String,
        default: null
    },



    reviews: [
        {
            type: Schema.Types.ObjectId,
            ref: "Review",
        }
    ],
    owner: {
        type: Schema.Types.ObjectId,
        ref: "User"
    },
    geometry: {
        type: {
            type: String,
            enum: ['Point'],
            required: true
        },
        coordinates: {
            type: [Number],
            required: true
        }
    }
});

// --- ORIGINAL DELETE LOGIC ---
listingSchema.post('findOneAndDelete', async (listing) => {
    if (listing) {
        // Delete associated reviews
        await Review.deleteMany({ _id: { $in: listing.reviews } });

        // Delete images from Cloudinary
        if (listing.image && listing.image.length > 0) {
            for (let image of listing.image) {
                if (image.filename) {
                    await cloudinary.uploader.destroy(image.filename);
                }
            }
        }
    }
});

const Listing = mongoose.model("Listing", listingSchema);
module.exports = Listing;