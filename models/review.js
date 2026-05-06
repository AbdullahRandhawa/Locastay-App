/* 
   ══════════════════════════════════════════════════════════════════════════════
   DATABASE SCHEMA: REVIEWS
   ══════════════════════════════════════════════════════════════════════════════
   This file defines the 'Reviews' entity from the ER diagram.
   Handles the 1:N relationship between Listings and Reviews,
   storing ratings and comments.
*/
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const reviewSchema = new Schema(
    {
        comment: String,
        rating: {
            type: Number,
            min: 1,
            max: 5,
        },
        createdAt: {
            type: Date,
            default: Date.now,
        },
        author: {
            type: Schema.Types.ObjectId,
            ref: 'User'
        }
    });

const Review = mongoose.model("Review", reviewSchema);

module.exports = Review;


// const  reviewww = async () => {
//     const data = new Review({
//         comment : "must Visit",
//         rating: 4,
//     });

//     await data.save();
// }

// reviewww();