const express = require('express');
const router = express.Router({ mergeParams: true });
const asyncWrap = require('../utils/asyncWrap');
const { isLoggedIn, isAdmin } = require('../utils/middleware');
const adminController = require('../controllers/admin');

// Ensure all routes require the user to be logged in and be an admin
router.use(isLoggedIn, isAdmin);

// Render the admin dashboard
router.get('/', asyncWrap(adminController.renderDashboard));

// Toggle a user's status (isDisabled or listingRestricted)
router.patch('/users/:id/toggle', asyncWrap(adminController.toggleUserStatus));

// Delete a user entirely
router.delete('/users/:id', asyncWrap(adminController.deleteUser));

module.exports = router;
