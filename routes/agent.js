const express = require('express');
const router = express.Router();
const agentController = require('../controllers/agent');
const { isLoggedIn } = require('../utils/middleware');
const asyncWrap = require('../utils/asyncWrap');
const rateLimit = require('express-rate-limit');

// Limit each user  to 15 messages per minute on the chat endpoint
const messageLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 15,
    keyGenerator: (req) => req.user?._id?.toString() || 'unauthenticated',
    handler: (req, res) => {
        res.status(429).json({ error: 'You\'re sending messages too fast. Please wait a moment and try again.' });
    },
    standardHeaders: true,
    legacyHeaders: false
});

// Render agent page
router.get('/', isLoggedIn, asyncWrap(agentController.renderAgent));

// Send message to agent
router.post('/message', isLoggedIn, messageLimiter, asyncWrap(agentController.handleMessage));

// Get conversation history list
router.get('/conversations', isLoggedIn, asyncWrap(agentController.getConversations));

// Get single conversation
router.get('/conversation/:id', isLoggedIn, asyncWrap(agentController.getConversation));

// Delete conversation
router.delete('/conversation/:id', isLoggedIn, asyncWrap(agentController.deleteConversation));

module.exports = router;

