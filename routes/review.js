const express = require('express');
const router = express.Router({ mergeParams: true });
const asyncWrap = require('../utils/asyncWrap');
const { isLoggedIn, validateReview } = require('../middleware.js');
const reviewController = require('../controllers/reviews.js');




//Reviews
// Post Reviews route-----------------------------------
router.post('/', isLoggedIn, validateReview, asyncWrap(reviewController.createReview));

//Delete review---------------------------
router.delete('/:reviewId', isLoggedIn, asyncWrap(reviewController.deleteReview));


module.exports = router; 