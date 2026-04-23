// ==========================================================================
// Rentlyst Agent — Client-Side Chat Logic
// ==========================================================================

(function () {
    'use strict';

    // --- DOM Elements ---
    const chatMessages = document.getElementById('chatMessages');
    const chatInput = document.getElementById('chatInput');
    const sendBtn = document.getElementById('sendBtn');
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

    const MAX_MSG = 800;

    // --- Auto-grow textarea + character counter ---
    chatInput.addEventListener('input', () => {
        chatInput.style.height = 'auto';
        chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
        const len = chatInput.value.length;
        const overLimit = len > MAX_MSG;
        sendBtn.disabled = !chatInput.value.trim() || overLimit;

        // Show / update char counter
        let counter = document.getElementById('charCounter');
        if (!counter) {
            counter = document.createElement('span');
            counter.id = 'charCounter';
            counter.style.cssText = 'font-size:11px;position:absolute;bottom:14px;right:60px;opacity:0.5;pointer-events:none;';
            chatInput.parentElement.style.position = 'relative';
            chatInput.parentElement.appendChild(counter);
        }
        counter.textContent = `${len}/${MAX_MSG}`;
        counter.style.color = overLimit ? '#e74c3c' : '';
        counter.style.opacity = len > 600 ? '1' : '0.4';
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
    // TOAST HELPER
    // ==========================================


    function showToast(message, type = 'error') {
        const toast = document.createElement('div');
        toast.textContent = message;
        toast.style.cssText = `
            position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
            background:${type === 'error' ? '#e74c3c' : '#2ecc71'};
            color:#fff; padding:10px 20px; border-radius:8px; font-size:13px;
            z-index:9999; box-shadow:0 4px 12px rgba(0,0,0,0.2);
            animation: fadeInUp 0.3s ease;
        `;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3500);
    }

    // ==========================================
    // CORE FUNCTIONS
    // ==========================================

    async function sendMessage() {
        const message = chatInput.value.trim();
        if (!message) return;

        // Remove welcome screen if it exists
        const ws = document.getElementById('welcomeScreen');
        if (ws) ws.remove();

        appendMessage('user', message);

        chatInput.value = '';
        chatInput.style.height = 'auto';
        const counter = document.getElementById('charCounter');
        if (counter) counter.textContent = '';

        sendBtn.disabled = true;
        isLoading = true;

        const typing = showTyping();
        let agentBubble = null;

        try {
            const res = await fetch('/agent/message', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message, conversationId: currentConversationId })
            });

            // Handle non-streaming error responses (401, 503, 500 etc.)
            if (!res.ok || res.headers.get('Content-Type')?.includes('application/json')) {
                const errData = await res.json().catch(() => ({}));
                typing.remove();
                if (res.status === 401) {
                    appendMessage('agent', 'You need to be logged in to use the agent. Please log in first.');
                } else {
                    appendMessage('agent', errData.error || 'Sorry, I encountered an error. Please try again.');
                }
                return;
            }

            // --- Stream reading loop ---
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let rawText = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    let event;
                    try { event = JSON.parse(line.slice(6)); } catch { continue; }

                    if (event.type === 'meta') {
                        currentConversationId = event.conversationId;
                        updateHistory(event.conversationId, event.conversationTitle);
                        if (event.matchedListings && event.matchedListings.length > 0) {
                            updateListingsSidebar(event.matchedListings);
                        }

                    } else if (event.type === 'token') {
                        if (!agentBubble) {
                            typing.remove();
                            agentBubble = createStreamingBubble();
                        }
                        rawText += event.content;
                        agentBubble.textContent = rawText;
                        scrollToBottom();

                    } else if (event.type === 'done') {
                        if (agentBubble) {
                            agentBubble.classList.remove('streaming');
                            agentBubble.innerHTML = parseMarkdown(rawText);
                        } else {
                            typing.remove();
                            if (rawText.trim()) appendMessage('agent', rawText);
                        }
                        scrollToBottom();

                    } else if (event.type === 'error') {
                        if (agentBubble) {
                            agentBubble.textContent = event.message || 'Stream interrupted. Please try again.';
                        } else {
                            typing.remove();
                            appendMessage('agent', event.message || 'Stream interrupted. Please try again.');
                        }
                    }
                }
            }

            // Safety net: if 'done' event never fired
            if (!agentBubble && rawText.trim()) {
                typing.remove();
                appendMessage('agent', rawText);
            } else if (agentBubble) {
                agentBubble.classList.remove('streaming');
            }

        } catch (err) {
            if (!agentBubble) typing.remove();
            appendMessage('agent', 'Sorry, I encountered an error. Please try again.');
            console.error('Agent stream error:', err);
        }

        isLoading = false;
        sendBtn.disabled = !chatInput.value.trim();
    }


    function appendMessage(role, content) {
        const msgDiv = document.createElement('div');
        msgDiv.className = `message ${role}-message`;

        const bubble = document.createElement('div');
        bubble.className = 'message-bubble';

        if (role === 'agent') {
            bubble.innerHTML = parseMarkdown(content);
        } else {
            bubble.textContent = content;
        }

        msgDiv.appendChild(bubble);
        chatMessages.appendChild(msgDiv);
        scrollToBottom();
    }

    /**
     * Creates an empty agent message bubble in the DOM and returns a reference
     * to the inner bubble element so the stream loop can update it in real time.
     */
    function createStreamingBubble() {
        const msgDiv = document.createElement('div');
        msgDiv.className = 'message agent-message';

        // No avatar for agent — bubble only
        const bubble = document.createElement('div');
        bubble.className = 'message-bubble streaming';

        msgDiv.appendChild(bubble);
        chatMessages.appendChild(msgDiv);
        scrollToBottom();

        return bubble;
    }


    function showTyping() {
        const div = document.createElement('div');
        div.className = 'typing-indicator';
        div.innerHTML = `
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
    // Simple HTML escape to prevent XSS when injecting listing data into innerHTML
    function escHtml(str) {
        if (!str) return '';
        return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function updateListingsSidebar(listings) {

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
                <a href="/explore/${escHtml(String(l._id))}" class="sidebar-listing-card" target="_blank">
                    <div class="listing-card-inner">
                        <img class="listing-card-img" src="${escHtml(imgSrc)}" alt="${escHtml(l.title)}" loading="lazy"
                             onerror="this.src='https://images.pexels.com/photos/13305201/pexels-photo-13305201.jpeg'"/>
                        <div class="listing-card-info">
                            <div class="listing-card-title">${escHtml(l.title) || 'Untitled'}</div>
                            <div class="listing-card-meta">
                                <i class="fa-solid fa-location-dot"></i> ${escHtml(l.city) || 'N/A'} ${badge}
                            </div>
                            <div class="listing-card-price">Rs. ${escHtml(priceText)}</div>
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

            // Add new item at top — build via DOM to avoid XSS from user-supplied titles
            const item = document.createElement('div');
            item.className = 'history-item active';
            item.dataset.id = convId;

            const icon = document.createElement('i');
            icon.className = 'fa-regular fa-message';

            const titleSpan = document.createElement('span');
            titleSpan.className = 'history-title';
            titleSpan.textContent = title; // safe — no innerHTML

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'history-delete';
            deleteBtn.dataset.id = convId;
            deleteBtn.title = 'Delete';
            deleteBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i>';

            item.appendChild(icon);
            item.appendChild(titleSpan);
            item.appendChild(deleteBtn);
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
            showToast('Failed to load conversation. Please try again.');
        }
    }

    // --- Start New Chat ---
    function startNewChat() {
        currentConversationId = null;
        chatMessages.innerHTML = '';

        // Re-add welcome
        chatMessages.innerHTML = `
            <div class="welcome-screen" id="welcomeScreen">
                <h4>Hey! I'm your Rentlyst Assistant </h4>
                <p>I can help you find anything on the platform — from cars and electronics to apartments and services. Just ask!</p>
                <div class="quick-actions">
                    <button class="quick-btn" data-query="What vehicles are available for rent or sale?">
                        <i class="fa-solid fa-car"></i> Find Vehicles
                    </button>
                    <button class="quick-btn" data-query="Show me available properties and apartments">
                        <i class="fa-solid fa-building"></i> Browse Properties
                    </button>
                    <button class="quick-btn" data-query="What electronics or gadgets are listed for sale?">
                        <i class="fa-solid fa-mobile-screen"></i> Electronics &amp; Gadgets
                    </button>
                    <button class="quick-btn" data-query="What services are available on the platform?">
                        <i class="fa-solid fa-screwdriver-wrench"></i> Available Services
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
            showToast('Failed to delete conversation. Please try again.');
        }
    }

})();
