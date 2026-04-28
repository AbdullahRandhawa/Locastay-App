const express = require('express');
const router = express.Router();
const homeController = require('../controllers/home.js');
const asyncWrap = require('../utils/asyncWrap.js');

// Render Landing/Home Page
router.get('/', asyncWrap(homeController.renderHome));

// Legal Pages
router.get('/terms', homeController.renderTerms);
router.get('/privacy', homeController.renderPrivacy);
router.get('/sitemap', homeController.renderSitemap);
router.get('/help', asyncWrap(homeController.renderHelp));

module.exports = router;
