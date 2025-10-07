const express = require('express');
const router = express.Router({ mergeParams: true });
const asyncWrap = require('../utils/asyncWrap');
const profileController = require('../controllers/profiles');
const { isLoggedIn } = require('../middleware');

const multer = require('multer');
const { storage } = require('../cloudConfig.js');
const upload = multer({ storage });




// Profile Route
router.get('/', isLoggedIn, asyncWrap(profileController.profile));


// Render profile Route
router.get('/edit', isLoggedIn, asyncWrap(profileController.renderProfileEditForm));



// Edit Profile  Route
router.put('/', isLoggedIn, upload.single('profile[profileImg]'), asyncWrap(profileController.editProfile));




module.exports = router;