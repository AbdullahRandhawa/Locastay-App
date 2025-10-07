const express = require('express');
const router = express.Router({ mergeParams: true });
const asyncWrap = require('../utils/asyncWrap');
const { isLoggedIn, isOwner, validateListing } = require('../middleware.js');
const listingController = require('../controllers/listings.js')
const multer = require('multer');
const { storage } = require('../cloudConfig.js');
const upload = multer({ storage });


// Index route && Create Listing Route
router.route('/')
    .get(asyncWrap(listingController.index))
    .post(isLoggedIn, validateListing, upload.array('listing[image]'), asyncWrap(listingController.createListing));



// Render New Form Route
router.get('/new', isLoggedIn, listingController.renderNewForm);

router.get('/search', asyncWrap(listingController.searchListings));


//Show Listing Route && Edit Listing Route && Delete Listing Route
router.route('/:id')
    .get(asyncWrap(listingController.showListing))
    .put(isLoggedIn, isOwner, upload.array('listing[image]'), validateListing, asyncWrap(listingController.editListing))
    .delete(isLoggedIn, isOwner, asyncWrap(listingController.deleteListing));



// Render Edit Route
router.get('/:id/edit', isLoggedIn, isOwner, asyncWrap(listingController.renderEditForm));



module.exports = router; 