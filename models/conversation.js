const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const messageSchema = new Schema({
    role: {
        type: String,
        enum: ['user', 'agent'],
        required: true
    },
    content: {
        type: String,
        required: true
    },
    matchedListings: [{
        type: Schema.Types.ObjectId,
        ref: 'Listing'
    }],
    timestamp: {
        type: Date,
        default: Date.now
    }
});

const conversationSchema = new Schema({
    user: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    title: {
        type: String,
        default: 'New Conversation'
    },
    messages: [messageSchema],
    lastSummarizedIndex: {
        type: Number,
        default: 0
    }
}, {
    timestamps: true // auto createdAt & updatedAt
});

const Conversation = mongoose.model('Conversation', conversationSchema);
module.exports = Conversation;
