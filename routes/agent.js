const express = require('express');
const router = express.Router();
const agentController = require('../controllers/agent');
const { isLoggedIn } = require('../utils/middleware');
const asyncWrap = require('../utils/asyncWrap');

// Render agent page
router.get('/', isLoggedIn, asyncWrap(agentController.renderAgent));

// Send message to agent
router.post('/message', isLoggedIn, asyncWrap(agentController.handleMessage));

// Get conversation history list
router.get('/conversations', isLoggedIn, asyncWrap(agentController.getConversations));

// Get single conversation
router.get('/conversation/:id', isLoggedIn, asyncWrap(agentController.getConversation));

// Delete conversation
router.delete('/conversation/:id', isLoggedIn, asyncWrap(agentController.deleteConversation));

module.exports = router;
