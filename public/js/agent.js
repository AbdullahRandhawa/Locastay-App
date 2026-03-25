// ==========================================================================
// Rentlyst Agent — Client-Side Chat Logic
// ==========================================================================

(function () {
    'use strict';

    // --- DOM Elements ---
    const chatMessages = document.getElementById('chatMessages');
    const chatInput = document.getElementById('chatInput');
    const sendBtn = document.getElementById('sendBtn');
    const welcomeScreen = document.getElementById('welcomeScreen');
    const historyList = document.getElementById('historyList');
    const listingsPanel = document.getElementById('listingsPanel');
    const listingsEmpty = document.getElementById('listingsEmpty');
    const matchCount = document.getElementById('matchCount');
    const newChatBtn = document.getElementById('newChatBtn');

    // Mobile toggles
    const historyToggle = document.getElementById('historyToggle');
    const listingsToggle = document.getElementById('listingsToggle');
    const agentHistory = document.getElementById('agentHistory');
    const agentListings = document.getElementById('agentListings');
    const sidebarOverlay = document.getElementById('sidebarOverlay');

    // --- State ---
    let currentConversationId = null;
    let isLoading = false;

    // --- Auto-grow textarea ---
    chatInput.addEventListener('input', () => {
        chatInput.style.height = 'auto';
        chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
        sendBtn.disabled = !chatInput.value.trim();
    });

    // --- Send on Enter (Shift+Enter for new line) ---
    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (!sendBtn.disabled && !isLoading) sendMessage();
        }
    });

    sendBtn.addEventListener('click', () => {
        if (!isLoading) sendMessage();
    });

    // --- Quick Action Buttons ---
    document.querySelectorAll('.quick-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            chatInput.value = btn.dataset.query;
            chatInput.dispatchEvent(new Event('input'));
            sendMessage();
        });
    });

    // --- New Chat ---
    newChatBtn.addEventListener('click', () => {
        startNewChat();
    });

    // --- History Item Click ---
    historyList.addEventListener('click', (e) => {
        const deleteBtn = e.target.closest('.history-delete');
        if (deleteBtn) {
            e.stopPropagation();
            deleteConversation(deleteBtn.dataset.id);
            return;
        }

        const item = e.target.closest('.history-item');
        if (item) loadConversation(item.dataset.id);
    });

    // --- Mobile Sidebar Toggles ---
    if (historyToggle) {
        historyToggle.addEventListener('click', () => {
            agentHistory.classList.toggle('open');
            agentListings.classList.remove('open');
            sidebarOverlay.classList.toggle('active', agentHistory.classList.contains('open'));
        });
    }

    if (listingsToggle) {
        listingsToggle.addEventListener('click', () => {
            agentListings.classList.toggle('open');
            agentHistory.classList.remove('open');
            sidebarOverlay.classList.toggle('active', agentListings.classList.contains('open'));
        });
    }

    if (sidebarOverlay) {
        sidebarOverlay.addEventListener('click', () => {
            agentHistory.classList.remove('open');
            agentListings.classList.remove('open');
            sidebarOverlay.classList.remove('active');
        });
    }

    // ==========================================
    // CORE FUNCTIONS
    // ==========================================

    async function sendMessage() {
        const message = chatInput.value.trim();
        if (!message) return;

        // Hide welcome
        if (welcomeScreen) welcomeScreen.style.display = 'none';

        // Show user message
        appendMessage('user', message);

        // Clear input
        chatInput.value = '';
        chatInput.style.height = 'auto';
        sendBtn.disabled = true;
        isLoading = true;

        // Show typing indicator
        const typing = showTyping();

        try {
            const res = await fetch('/agent/message', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message,
                    conversationId: currentConversationId
                })
            });

            if (res.status === 401) {
                typing.remove();
                appendMessage('agent', 'You need to be logged in to use the agent. Please [log in](/login).');
                isLoading = false;
                return;
            }

            if (res.status === 503) {
                typing.remove();
                const errData = await res.json().catch(() => ({}));
                appendMessage('agent', errData.error || 'The AI is currently rate-limited. Please wait a moment and try again.');
                isLoading = false;
                return;
            }

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.error || 'Server error');
            }

            const data = await res.json();

            // Remove typing
            typing.remove();

            // Update conversation ID
            currentConversationId = data.conversationId;

            // Show agent response
            appendMessage('agent', data.response);

            // Update listings sidebar — only replace if new matches came in
            if (data.matchedListings && data.matchedListings.length > 0) {
                updateListingsSidebar(data.matchedListings);
            }

            // Update history sidebar
            updateHistory(data.conversationId, data.conversationTitle);

        } catch (err) {
            typing.remove();
            appendMessage('agent', 'Sorry, I encountered an error. Please try again.');
            console.error('Agent error:', err);
        }

        isLoading = false;
    }

    function appendMessage(role, content) {
        const msgDiv = document.createElement('div');
        msgDiv.className = `message ${role}-message`;

        const avatar = document.createElement('div');
        avatar.className = 'message-avatar';
        if (role === 'agent') {
            avatar.innerHTML = 'R';
        } else {
            const img = document.createElement('img');
            img.src = window.__USER_PROFILE_IMG__ || '';
            img.alt = 'You';
            avatar.appendChild(img);
        }

        const bubble = document.createElement('div');
        bubble.className = 'message-bubble';

        if (role === 'agent') {
            bubble.innerHTML = parseMarkdown(content);
        } else {
            bubble.textContent = content;
        }

        msgDiv.appendChild(avatar);
        msgDiv.appendChild(bubble);
        chatMessages.appendChild(msgDiv);
        scrollToBottom();
    }

    function showTyping() {
        const div = document.createElement('div');
        div.className = 'typing-indicator';
        div.innerHTML = `
            <div class="message-avatar" style="background: var(--primary); color: #fff; font-weight: bold; justify-content: center; align-items: center; display: flex;">
                R
            </div>
            <div class="typing-dots">
                <span></span><span></span><span></span>
            </div>
        `;
        chatMessages.appendChild(div);
        scrollToBottom();
        return div;
    }

    function scrollToBottom() {
        requestAnimationFrame(() => {
            chatMessages.scrollTop = chatMessages.scrollHeight;
        });
    }

    // --- Simple Markdown Parser ---
    function parseMarkdown(text) {
        let html = text
            // Escape HTML first
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            // Bold
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            // Italic
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            // Inline code
            .replace(/`(.+?)`/g, '<code>$1</code>')
            // Headers
            .replace(/^### (.+)$/gm, '<h5>$1</h5>')
            .replace(/^## (.+)$/gm, '<h4>$1</h4>')
            .replace(/^# (.+)$/gm, '<h3>$1</h3>')
            // Unordered list items
            .replace(/^[-•] (.+)$/gm, '<li>$1</li>')
            // Numbered list items
            .replace(/^\d+\.\s(.+)$/gm, '<li>$1</li>')
            // Horizontal rule
            .replace(/^---$/gm, '<hr>')
            // Line breaks  
            .replace(/\n/g, '<br>');

        // Wrap consecutive <li> in <ul>
        html = html.replace(/((?:<li>.*?<\/li><br>?)+)/g, '<ul>$1</ul>');
        // Clean up <br> inside <ul>
        html = html.replace(/<ul>(.*?)<\/ul>/gs, (match, inner) => {
            return '<ul>' + inner.replace(/<br>/g, '') + '</ul>';
        });

        return html;
    }

    // --- Listings Sidebar ---
    function updateListingsSidebar(listings) {
        console.log('[Sidebar] updateListingsSidebar called with', listings ? listings.length : 0, 'listings', listings);

        if (!listings || listings.length === 0) {
            matchCount.textContent = '0 found';
            listingsPanel.innerHTML = `
                <div class="listings-empty" id="listingsEmpty">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    <p>Listings matching your query will appear here</p>
                </div>
            `;
            return;
        }

        matchCount.textContent = `${listings.length} found`;

        // Build cards
        const cards = listings.map(l => {
            const imgSrc = l.image || 'https://images.pexels.com/photos/13305201/pexels-photo-13305201.jpeg';
            const badge = l.listingType === 'Rent'
                ? '<span class="listing-card-badge badge-rent">Rent</span>'
                : '<span class="listing-card-badge badge-sale">Sale</span>';

            const price = l.price != null ? Number(l.price) : 0;
            const priceText = l.listingType === 'Rent' && l.rentalPeriod && l.rentalPeriod !== 'N/A'
                ? `${price.toLocaleString()} / ${l.rentalPeriod}`
                : price.toLocaleString();

            return `
                <a href="/listings/${l._id}" class="sidebar-listing-card" target="_blank">
                    <div class="listing-card-inner">
                        <img class="listing-card-img" src="${imgSrc}" alt="${l.title || ''}" loading="lazy"
                             onerror="this.src='https://images.pexels.com/photos/13305201/pexels-photo-13305201.jpeg'"/>
                        <div class="listing-card-info">
                            <div class="listing-card-title">${l.title || 'Untitled'}</div>
                            <div class="listing-card-meta">
                                <i class="fa-solid fa-location-dot"></i> ${l.city || 'N/A'} ${badge}
                            </div>
                            <div class="listing-card-price">Rs. ${priceText}</div>
                        </div>
                    </div>
                </a>
            `;
        }).join('');

        listingsPanel.innerHTML = cards;
    }

    // --- History Sidebar ---
    function updateHistory(convId, title) {
        // Check if already exists
        let existing = historyList.querySelector(`[data-id="${convId}"]`);

        if (!existing) {
            // Remove empty state
            const emptyEl = historyList.querySelector('.history-empty');
            if (emptyEl) emptyEl.remove();

            // Add new item at top
            const item = document.createElement('div');
            item.className = 'history-item active';
            item.dataset.id = convId;
            item.innerHTML = `
                <i class="fa-regular fa-message"></i>
                <span class="history-title">${title}</span>
                <button class="history-delete" data-id="${convId}" title="Delete">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            `;
            historyList.prepend(item);
        }

        // Mark active
        historyList.querySelectorAll('.history-item').forEach(el => {
            el.classList.toggle('active', el.dataset.id === convId);
        });
    }

    // --- Load Conversation ---
    async function loadConversation(convId) {
        try {
            const res = await fetch(`/agent/conversation/${convId}`);
            if (!res.ok) throw new Error('Failed to load');

            const data = await res.json();
            const conv = data.conversation;

            currentConversationId = conv._id;

            // Clear chat
            chatMessages.innerHTML = '';
            if (welcomeScreen) welcomeScreen.style.display = 'none';

            // Render messages
            conv.messages.forEach(msg => appendMessage(msg.role, msg.content));

            // Populate sidebar listings from this conversation
            updateListingsSidebar(data.matchedListings || []);

            // Mark active in history
            historyList.querySelectorAll('.history-item').forEach(el => {
                el.classList.toggle('active', el.dataset.id === convId);
            });

            // Close mobile sidebar
            agentHistory.classList.remove('open');
            sidebarOverlay.classList.remove('active');

        } catch (err) {
            console.error('Load error:', err);
        }
    }

    // --- Start New Chat ---
    function startNewChat() {
        currentConversationId = null;
        chatMessages.innerHTML = '';

        // Re-add welcome
        chatMessages.innerHTML = `
            <div class="welcome-screen" id="welcomeScreen">
                <h4>Hey there! I'm your Rentlyst Agent</h4>
                <p>I know every listing on the platform. Ask me anything — I can help you find deals, compare options, and discover what you need.</p>
                <div class="quick-actions">
                    <button class="quick-btn" data-query="Show me the best cars available">
                        <i class="fa-solid fa-car"></i> Best cars
                    </button>
                    <button class="quick-btn" data-query="What apartments are available for rent?">
                        <i class="fa-solid fa-building"></i> Apartments for rent
                    </button>
                    <button class="quick-btn" data-query="Find me cheap electronics under 5000">
                        <i class="fa-solid fa-laptop"></i> Cheap electronics
                    </button>
                    <button class="quick-btn" data-query="What services are available?">
                        <i class="fa-solid fa-wrench"></i> Services
                    </button>
                </div>
            </div>
        `;

        // Re-bind quick buttons
        document.querySelectorAll('.quick-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                chatInput.value = btn.dataset.query;
                chatInput.dispatchEvent(new Event('input'));
                sendMessage();
            });
        });

        // Clear listings sidebar
        updateListingsSidebar([]);

        // Deselect history
        historyList.querySelectorAll('.history-item').forEach(el => {
            el.classList.remove('active');
        });

        // Close mobile sidebar
        agentHistory.classList.remove('open');
        sidebarOverlay.classList.remove('active');
    }

    // --- Delete Conversation ---
    async function deleteConversation(convId) {
        try {
            const res = await fetch(`/agent/conversation/${convId}`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' }
            });

            if (!res.ok) throw new Error('Delete failed');

            // Remove from DOM
            const item = historyList.querySelector(`[data-id="${convId}"]`);
            if (item) item.remove();

            // If we deleted the active conversation, start new
            if (currentConversationId === convId) {
                startNewChat();
            }

            // Show empty state if no more conversations
            if (!historyList.querySelector('.history-item')) {
                historyList.innerHTML = `
                    <div class="history-empty">
                        <i class="fa-regular fa-comment-dots"></i>
                        <p>No conversations yet</p>
                    </div>
                `;
            }
        } catch (err) {
            console.error('Delete error:', err);
        }
    }

})();
