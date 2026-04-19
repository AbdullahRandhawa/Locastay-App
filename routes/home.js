const express = require('express');
const router = express.Router();
const homeController = require('../controllers/home.js');
const asyncWrap = require('../utils/asyncWrap.js');

// Render Landing/Home Page
router.get('/', asyncWrap(homeController.renderHome));

module.exports = router;
