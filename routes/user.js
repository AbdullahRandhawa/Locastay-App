const express = require('express');
const router = express.Router();
const asyncWrap = require('../utils/asyncWrap');
const passport = require('passport')
const userController = require('../controllers/users');
const { isLoggedIn, isOwner } = require('../middleware');




// Signup Rputes
router.route('/signup')
    .get(userController.renderSignupForm)
    .post(asyncWrap(userController.createSignup))


// Login routes
router.route('/login')
    .get(asyncWrap(userController.renderloginForm))
    .post(passport.authenticate("local", { failureRedirect: "/login", failureFlash: true, keepSessionInfo: true }), userController.login);



// Logout route
router.get('/logout', userController.logout);





module.exports = router;