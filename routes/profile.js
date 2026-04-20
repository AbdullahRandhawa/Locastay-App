const express = require('express');
const router = express.Router({ mergeParams: true });
const asyncWrap = require('../utils/asyncWrap');
const profileController = require('../controllers/profiles');
const { isLoggedIn } = require('../utils/middleware');

const multer = require('multer');
const { storage } = require('../cloudConfig.js');
const upload = multer({ storage });




// Public Profile Route (does not require login)
router.get('/public/:id', asyncWrap(profileController.publicProfile));

// Profile Route (Private)
router.get('/', isLoggedIn, asyncWrap(profileController.profile));


// Render profile Route
router.get('/edit', isLoggedIn, asyncWrap(profileController.renderProfileEditForm));



// Edit Profile  Route
router.put('/', isLoggedIn, upload.single('profile[profileImg]'), asyncWrap(profileController.editProfile));

// Delete Account Route
router.delete('/delete-account', isLoggedIn, asyncWrap(profileController.deleteAccount));

module.exports = router;