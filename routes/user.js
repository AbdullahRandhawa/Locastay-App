const express = require('express');
const router = express.Router();
const asyncWrap = require('../utils/asyncWrap');
const userController = require('../controllers/users');
const { isLoggedIn } = require('../utils/middleware');

// Signup Routes
router.route('/signup')
    .get(userController.renderSignupForm)
    .post(asyncWrap(userController.createSignup));

// Login Routes
router.route('/login')
    .get(asyncWrap(userController.renderloginForm))
    .post(asyncWrap(userController.login));

router.post('/login/resolve-email', asyncWrap(userController.resolveEmail));

// Logout Route
router.get('/logout', asyncWrap(userController.logout));

// Messages
router.get('/messages', isLoggedIn, asyncWrap(userController.renderMessages));

module.exports = router;