const express = require('express');
const router = express.Router({ mergeParams: true });
const asyncWrap = require('../utils/asyncWrap');
const { isLoggedIn, isOwner, validateListing } = require('../utils/middleware.js');
const exploreController = require('../controllers/explore.js')
const multer = require('multer');
const { storage } = require('../cloudConfig.js');
const upload = multer({ storage });


// Index route && Create Listing Route
router.route('/')
    .get(asyncWrap(exploreController.index))
    .post(isLoggedIn, upload.array('listing[image]'), validateListing, asyncWrap(exploreController.createListing));



// Render New Form Route
router.get('/new', isLoggedIn, exploreController.renderNewForm);

router.get('/search', asyncWrap(exploreController.searchListings));


//Show Listing Route && Edit Listing Route && Delete Listing Route
router.route('/:id')
    .get(asyncWrap(exploreController.showListing))
    .put(isLoggedIn, isOwner, upload.array('listing[image]'), validateListing, asyncWrap(exploreController.editListing))
    .delete(isLoggedIn, isOwner, asyncWrap(exploreController.deleteListing));



// Render Edit Route
router.get('/:id/edit', isLoggedIn, isOwner, asyncWrap(exploreController.renderEditForm));



module.exports = router; 