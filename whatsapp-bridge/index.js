/**
 * WhatsApp Web Bridge — Multi-tenant multi-session bridge connecting WhatsApp Web to FastAPI backend
 * Supports isolated sessions per business/client using whatsapp-web.js LocalAuth with clientId
 */

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const axios = require('axios');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3001;
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8000';
const BRIDGE_BOOT_TIME = Math.floor(Date.now() / 1000);

// ── Multi-Session Store ─────────────────────────────────────────────
// Map: businessId (number) -> SessionState
const sessions = new Map();

function getSession(businessId) {
    const id = parseInt(businessId) || 1;
    if (!sessions.has(id)) {
        sessions.set(id, {
            businessId: id,
            client: null,
            latestQR: null,
            isConnected: false,
            connectionState: 'disconnected', // 'starting' | 'qr_ready' | 'authenticating' | 'syncing' | 'connected' | 'auth_failure' | 'disconnected'
            connectionInfo: null,
            initError: null,
            loadingProgress: { percent: 0, message: '' },
            readyTimestamp: null,
            initializing: false,
        });
    }
    return sessions.get(id);
}

// ── Lockfile & Session Directory Cleanup ────────────────────────────
function cleanStaleLockfiles(businessId) {
    const id = parseInt(businessId) || 1;
    const authDir = path.join(__dirname, '.wwebjs_auth', `session-client_${id}`);
    const lockfiles = ['lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort'];
    for (const file of lockfiles) {
        try {
            const p = path.join(authDir, file);
            if (fs.existsSync(p)) {
                fs.unlinkSync(p);
                console.log(`[Bridge-Biz-${id}] Removed stale lockfile: ${file}`);
            }
        } catch (e) {
            console.warn(`[Bridge-Biz-${id}] Could not remove ${file}:`, e.message);
        }
    }
}

async function cleanAuthSessionAsync(businessId) {
    const id = parseInt(businessId) || 1;
    const authDir = path.join(__dirname, '.wwebjs_auth', `session-client_${id}`);
    for (let attempt = 0; attempt < 10; attempt++) {
        cleanStaleLockfiles(id);
        try {
            if (!fs.existsSync(authDir)) return true;
            fs.rmSync(authDir, { recursive: true, force: true });
            console.log(`[Bridge-Biz-${id}] Successfully cleaned auth directory`);
            return true;
        } catch (e) {
            console.warn(`[Bridge-Biz-${id}] Cleanup attempt ${attempt + 1}/10 waiting for file locks:`, e.message);
            await new Promise(r => setTimeout(r, 600));
        }
    }
    return false;
}

async function safelyTerminateClient(targetClient) {
    if (!targetClient) return;
    try {
        const proc = targetClient.pupBrowser?.process?.();
        const pid = proc?.pid;
        try {
            await targetClient.destroy();
        } catch (e) {
            console.warn('[Bridge] Client destroy warning:', e.message);
        }
        if (pid) {
            try {
                if (process.platform === 'win32') {
                    require('child_process').execSync(`taskkill /F /T /PID ${pid} 2>nul`);
                } else {
                    proc.kill('SIGKILL');
                }
            } catch (_) {}
        }
    } catch (err) {
        console.warn('[Bridge] safelyTerminateClient warning:', err.message);
    }
}

// ── AI Settings Cache per Business ─────────────────────────────────
const _settingsCache = new Map();
const SETTINGS_CACHE_TTL = 30000; // 30s

async function getCachedSettings(businessId) {
    const id = parseInt(businessId) || 1;
    const now = Date.now();
    const cached = _settingsCache.get(id);
    if (cached && (now - cached.time) < SETTINGS_CACHE_TTL) {
        return cached.data;
    }
    try {
        const res = await axios.get(`${BACKEND_URL}/api/ai-settings?business_id=${id}`, { timeout: 5000 });
        _settingsCache.set(id, { data: res.data, time: now });
        return res.data;
    } catch (err) {
        console.error(`[Bridge-Biz-${id}] Failed to fetch AI settings:`, err.message);
        return cached ? cached.data : null;
    }
}

// ── Global Error Handlers ───────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
    console.error('[Bridge] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('[Bridge] Uncaught Exception:', err.message);
});

// ── Track messages sent by bot / API to avoid duplicate processing in message_create ──
const outgoingBotMessageIds = new Set();
const recentBotSends = [];

function trackBotMessageId(msgId) {
    if (!msgId) return;
    outgoingBotMessageIds.add(msgId);
    setTimeout(() => {
        outgoingBotMessageIds.delete(msgId);
    }, 120000); // 2 min TTL
}

function trackBotSend(phone, text) {
    const item = {
        phone: String(phone || '').replace(/\D/g, ''),
        text: (text || '').trim(),
        time: Date.now(),
    };
    recentBotSends.push(item);
    setTimeout(() => {
        const idx = recentBotSends.indexOf(item);
        if (idx !== -1) recentBotSends.splice(idx, 1);
    }, 45000); // 45s TTL
}

function isRecentBotSend(phone, text) {
    const cleanP = String(phone || '').replace(/\D/g, '');
    const cleanT = (text || '').trim();
    const now = Date.now();
    const matchIdx = recentBotSends.findIndex(s => {
        const textMatches = (s.text && cleanT && (s.text === cleanT || cleanT.startsWith(s.text.substring(0, 30)) || s.text.startsWith(cleanT.substring(0, 30))));
        const timeValid = (now - s.time) < 40000;
        const phoneMatches = !cleanP || !s.phone || cleanP.includes(s.phone) || s.phone.includes(cleanP);
        return textMatches && timeValid && phoneMatches;
    });
    if (matchIdx !== -1) {
        recentBotSends.splice(matchIdx, 1);
        return true;
    }
    return false;
}

// ── Session Creation & Lifecycle ────────────────────────────────────
function createClient(businessId) {
    const id = parseInt(businessId) || 1;
    cleanStaleLockfiles(id);

    return new Client({
        authStrategy: new LocalAuth({
            clientId: `client_${id}`,
            dataPath: path.join(__dirname, '.wwebjs_auth'),
        }),
        authTimeoutMs: 60000,
        takeoverOnConflict: true,
        takeoverTimeoutMs: 10000,
        webVersionCache: {
            type: 'none',
        },
        puppeteer: {
            executablePath: puppeteer.executablePath(),
            headless: true,
            pipe: true,
            timeout: 120000,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-first-run',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-blink-features=AutomationControlled',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
            ],
        },
    });
}

function initSession(businessId) {
    const session = getSession(businessId);
    if (session.initializing || session.isConnected) {
        return session;
    }

    session.initializing = true;
    session.connectionState = 'starting';
    session.latestQR = null;
    session.isConnected = false;
    session.connectionInfo = null;
    session.initError = null;
    session.loadingProgress = { percent: 0, message: 'Initializing browser...' };

    console.log(`[Bridge-Biz-${session.businessId}] Initializing WhatsApp client...`);

    try {
        session.client = createClient(session.businessId);
    } catch (e) {
        console.error(`[Bridge-Biz-${session.businessId}] Error creating client:`, e);
        session.connectionState = 'auth_failure';
        session.initError = e.message;
        session.initializing = false;
        return session;
    }

    const client = session.client;

    client.on('loading_screen', (percent, message) => {
        console.log(`[Bridge-Biz-${session.businessId}] Loading: ${percent}% - ${message}`);
        session.connectionState = 'syncing';
        session.loadingProgress = { percent, message };
    });

    client.on('qr', async (qr) => {
        console.log(`[Bridge-Biz-${session.businessId}] QR code received`);
        session.connectionState = 'qr_ready';
        session.initializing = false;
        try {
            session.latestQR = await qrcode.toDataURL(qr, { width: 256, margin: 1 });
        } catch (err) {
            console.error(`[Bridge-Biz-${session.businessId}] QR encode error:`, err);
        }
    });

    client.on('authenticated', () => {
        console.log(`[Bridge-Biz-${session.businessId}] Authenticated successfully with WhatsApp!`);
        session.connectionState = 'authenticating';
        session.latestQR = null;
        session.loadingProgress = { percent: 50, message: 'Authenticated! Loading WhatsApp chats...' };

        // Watchdog: If WhatsApp Web finishes loading chats in DOM before ready event fires
        let readyCheckCount = 0;
        const readyWatchdog = setInterval(async () => {
            readyCheckCount++;
            if (session.isConnected) {
                clearInterval(readyWatchdog);
                return;
            }
            try {
                if (session.client && session.client.pupPage) {
                    const isChatListVisible = await session.client.pupPage.evaluate(() => {
                        return !!(document.querySelector('#pane-side') || document.querySelector('[data-testid="chat-list"]'));
                    }).catch(() => false);

                    if (isChatListVisible && !session.isConnected) {
                        console.log(`[Bridge-Biz-${session.businessId}] WhatsApp chat list detected in DOM! Transitioning to connected.`);
                        session.isConnected = true;
                        session.connectionState = 'connected';
                        session.loadingProgress = { percent: 100, message: 'Ready' };
                        session.readyTimestamp = Math.floor(Date.now() / 1000);
                        try {
                            session.connectionInfo = session.client.info || await session.client.pupPage.evaluate(() => {
                                const wid = window.Store?.User?.getMaybeMePnUser?.() || window.Store?.User?.getMaybeMeLidUser?.();
                                return {
                                    pushname: window.Store?.Conn?.pushname || 'WhatsApp User',
                                    platform: 'WhatsApp Web',
                                    wid: wid ? { user: wid.user, _serialized: wid._serialized } : null
                                };
                            });
                        } catch (e) {
                            session.connectionInfo = { pushname: 'WhatsApp User', platform: 'WhatsApp Web' };
                        }
                        clearInterval(readyWatchdog);
                    }
                }
            } catch (wErr) {
                console.warn(`[Bridge-Biz-${session.businessId}] Watchdog check error:`, wErr.message);
            }

            if (readyCheckCount > 25) {
                clearInterval(readyWatchdog);
            }
        }, 4000);
    });

    client.on('ready', async () => {
        console.log(`[Bridge-Biz-${session.businessId}] Client is ready! WhatsApp is fully connected.`);
        session.isConnected = true;
        session.connectionState = 'connected';
        session.latestQR = null;
        session.initError = null;
        session.initializing = false;
        session.loadingProgress = { percent: 100, message: 'Ready' };
        session.readyTimestamp = Math.floor(Date.now() / 1000);

        try {
            session.connectionInfo = client.info;
            console.log(`[Bridge-Biz-${session.businessId}] Connected as:`, session.connectionInfo?.pushname, session.connectionInfo?.wid?.user);
        } catch (err) {
            console.error(`[Bridge-Biz-${session.businessId}] Error getting info:`, err);
        }
    });

    client.on('auth_failure', (msg) => {
        console.error(`[Bridge-Biz-${session.businessId}] Auth failure:`, msg);
        session.isConnected = false;
        session.connectionState = 'auth_failure';
        session.initError = 'Authentication failed: ' + msg;
        session.initializing = false;
    });

    client.on('disconnected', (reason) => {
        console.log(`[Bridge-Biz-${session.businessId}] Disconnected:`, reason);
        session.isConnected = false;
        session.connectionState = 'disconnected';
        session.connectionInfo = null;
        session.latestQR = null;
        session.initializing = false;
    });

    client.on('message', async (msg) => {
        try {
            if (msg.fromMe) return;

            // Skip status updates, broadcasts, newsletters
            if (msg.from === 'status@broadcast' || msg.from.includes('@broadcast') || msg.from.includes('@newsletter')) return;
            if (msg.isStatus) return;

            // Ignore system/protocol events (e2e encryption notices, call logs, stub notifications)
            const IGNORED_TYPES = ['e2e_notification', 'notification', 'notification_template', 'protocol', 'call_log', 'gp2', 'ciphertext'];
            if (IGNORED_TYPES.includes(msg.type)) return;

            const bodyText = (msg.body || '').trim();
            // If message has neither text nor media, it is not a customer message (e.g. sync stub) — ignore completely
            if (!bodyText && !msg.hasMedia) return;

            const msgTime = msg.timestamp || Math.floor(Date.now() / 1000);
            if (msgTime < (BRIDGE_BOOT_TIME - 180)) return;

            // Live message check
            const readyTime = session.readyTimestamp || BRIDGE_BOOT_TIME;
            const isLiveMessage = Boolean(session.isConnected && (msgTime >= (readyTime - 10)));

            // Fetch AI settings for this specific business
            const settings = await getCachedSettings(session.businessId);

            const isGroup = msg.from.includes('@g.us');
            let name = 'Unknown';
            let isSavedContact = false;
            let phone = msg.from.replace(/@c\.us$/, '').replace(/@g\.us$/, '').replace(/@lid$/, '');

            try {
                const contact = await msg.getContact();
                if (contact) {
                    name = contact.pushname || contact.name || contact.verifiedName || contact.shortName || 'Unknown';
                    isSavedContact = Boolean(contact.isMyContact);
                    if (contact.number) {
                        phone = contact.number;
                    } else if (contact.id && contact.id.user && !contact.id._serialized.includes('@lid')) {
                        phone = contact.id.user;
                    }
                }
            } catch (cErr) {
                console.warn(`[Bridge-Biz-${session.businessId}] getContact error:`, cErr.message);
            }

            if (name === 'Unknown' || !name) {
                if (msg._data && msg._data.notifyName) {
                    name = msg._data.notifyName;
                }
            }

            if (isGroup) {
                try {
                    const chat = await msg.getChat();
                    if (chat && chat.name) {
                        name = chat.name;
                    }
                } catch (gErr) {
                    console.warn(`[Bridge-Biz-${session.businessId}] getChat error for group:`, gErr.message);
                }
            }

            const hasText = bodyText.length > 0;
            let shouldReply = isLiveMessage && hasText;

            // Group messages filter
            if (isGroup) {
                if (!settings || Number(settings.group_replies) !== 1) {
                    shouldReply = false;
                }
            }

            // Saved contacts filter
            if (!isGroup && isSavedContact) {
                if (!settings || Number(settings.reply_to_contacts) !== 1) {
                    shouldReply = false;
                }
            }

            const outgoingText = bodyText || `[${msg.type || 'media'} received]`;
            console.log(`[Bridge-Biz-${session.businessId}] ${isGroup ? 'Group' : isSavedContact ? 'Contact' : 'New'} message from ${name} (${phone}): "${outgoingText.substring(0, 45)}" | should_reply=${shouldReply} | isLive=${isLiveMessage}`);

            // Forward to backend with this session's business_id
            await axios.post(`${BACKEND_URL}/api/whatsapp/webhook`, {
                phone: isGroup ? msg.from : phone,
                message: outgoingText,
                name: name,
                business_id: session.businessId,
                is_group: isGroup,
                reply_to: msg.from,
                should_reply: shouldReply,
            }, { timeout: 30000 });
        } catch (err) {
            console.error(`[Bridge-Biz-${session.businessId}] Message handler error:`, err.message);
        }
    });

    client.on('message_create', async (msg) => {
        try {
            // Only process outgoing messages sent by the owner/phone here.
            // Incoming messages from other people are handled by client.on('message')
            if (!msg.fromMe) return;

            // If this message was sent by our bridge / bot, skip it (already saved in DB)
            if (msg.id?._serialized && outgoingBotMessageIds.has(msg.id._serialized)) {
                outgoingBotMessageIds.delete(msg.id._serialized);
                return;
            }

            const bodyText = (msg.body || '').trim();
            const recipient = msg.to || '';

            // Skip status broadcasts, newsletters
            if (!recipient || recipient === 'status@broadcast' || recipient.includes('@broadcast') || recipient.includes('@newsletter')) return;
            if (msg.isStatus) return;

            const IGNORED_TYPES = ['e2e_notification', 'notification', 'notification_template', 'protocol', 'call_log', 'gp2', 'ciphertext'];
            if (IGNORED_TYPES.includes(msg.type)) return;

            if (!bodyText && !msg.hasMedia) return;

            // Check if recently sent by bot
            if (isRecentBotSend(recipient, bodyText)) {
                return;
            }

            const msgTime = msg.timestamp || Math.floor(Date.now() / 1000);
            const readyTime = session.readyTimestamp || BRIDGE_BOOT_TIME;
            // Only capture messages sent after the bridge is ready or within the last 60 seconds
            if (msgTime < (readyTime - 15) && msgTime < (BRIDGE_BOOT_TIME - 60)) return;

            const isGroup = recipient.includes('@g.us');
            let phone = recipient.replace(/@c\.us$/, '').replace(/@g\.us$/, '').replace(/@lid$/, '');
            let name = 'Unknown';

            try {
                const contact = await msg.getContact();
                if (contact) {
                    name = contact.pushname || contact.name || contact.verifiedName || contact.shortName || 'Unknown';
                    if (contact.number) {
                        phone = contact.number;
                    } else if (contact.id?.user && !contact.id._serialized.includes('@lid')) {
                        phone = contact.id.user;
                    }
                }
            } catch (_) {}

            if (isGroup) {
                try {
                    const chat = await msg.getChat();
                    if (chat && chat.name) name = chat.name;
                } catch (_) {}
            }

            const outgoingText = bodyText || `[${msg.type || 'media'} sent]`;
            console.log(`[Bridge-Biz-${session.businessId}] Owner sent message from WhatsApp to ${name} (${phone}): "${outgoingText.substring(0, 45)}"`);

            // Forward to backend to save as 'human' message
            await axios.post(`${BACKEND_URL}/api/whatsapp/outgoing-webhook`, {
                phone: isGroup ? recipient : phone,
                message: outgoingText,
                name: name,
                business_id: session.businessId,
                is_group: isGroup,
            }, { timeout: 15000 });
        } catch (err) {
            console.error(`[Bridge-Biz-${session.businessId}] message_create error:`, err.message);
        }
    });

    client.initialize().catch(err => {
        console.error(`[Bridge-Biz-${session.businessId}] Init error:`, err.message);
        session.connectionState = 'auth_failure';
        session.initError = err.message;
        session.initializing = false;
    });

    return session;
}

// ── Auto-Start Saved Sessions at Boot ───────────────────────────────
function autoStartSavedSessions() {
    const authDir = path.join(__dirname, '.wwebjs_auth');
    try {
        if (!fs.existsSync(authDir)) return;

        // Migrate legacy un-prefixed session folder to session-client_1 if needed
        const legacyDir = path.join(authDir, 'session');
        const biz1Dir = path.join(authDir, 'session-client_1');
        if (fs.existsSync(legacyDir) && !fs.existsSync(biz1Dir)) {
            try {
                fs.renameSync(legacyDir, biz1Dir);
                console.log('[Bridge] Migrated legacy session to session-client_1');
            } catch (mErr) {
                console.warn('[Bridge] Could not migrate legacy session:', mErr.message);
            }
        }

        const entries = fs.readdirSync(authDir, { withFileTypes: true });
        let startedCount = 0;
        for (const entry of entries) {
            if (entry.isDirectory() && entry.name.startsWith('session-client_')) {
                const match = entry.name.match(/^session-client_(\d+)$/);
                if (match) {
                    const bid = parseInt(match[1]);
                    console.log(`[Bridge] Found saved session for Business ${bid}. Auto-starting...`);
                    initSession(bid);
                    startedCount++;
                }
            }
        }
        if (startedCount === 0) {
            console.log('[Bridge] No existing client sessions found. Initializing Business 1 by default...');
            initSession(1);
        }
    } catch (e) {
        console.warn('[Bridge] Error checking saved sessions:', e.message);
        initSession(1);
    }
}

// ── API Routes ───────────────────────────────────────────────────────

app.get('/health', (req, res) => {
    const activeSessions = [];
    for (const [id, s] of sessions.entries()) {
        activeSessions.push({ business_id: id, state: s.connectionState, connected: s.isConnected });
    }
    res.json({
        status: 'healthy',
        activeSessions,
        uptime: process.uptime()
    });
});

app.get('/status', (req, res) => {
    const bid = parseInt(req.query.business_id) || 1;
    const session = getSession(bid);

    res.json({
        business_id: bid,
        connected: session.isConnected,
        state: session.connectionState,
        hasQR: Boolean(session.latestQR),
        qr: session.latestQR,
        loading: session.loadingProgress,
        info: session.connectionInfo ? {
            pushname: session.connectionInfo.pushname || 'WhatsApp User',
            platform: session.connectionInfo.platform || 'WhatsApp Web',
            phone: session.connectionInfo.wid ? session.connectionInfo.wid.user : '',
            wid: session.connectionInfo.wid ? session.connectionInfo.wid._serialized : '',
        } : null,
        error: session.initError,
    });
});

app.get('/qr', (req, res) => {
    const bid = parseInt(req.query.business_id) || 1;
    const session = getSession(bid);
    if (!session.client && !session.initializing) {
        initSession(bid);
    }
    res.json({
        business_id: bid,
        qr: session.latestQR,
        state: session.connectionState
    });
});

app.post('/init', (req, res) => {
    const bid = parseInt(req.body?.business_id || req.query.business_id) || 1;
    const session = initSession(bid);
    res.json({ success: true, business_id: bid, state: session.connectionState });
});

app.get('/chats', async (req, res) => {
    const bid = parseInt(req.query.business_id) || 1;
    const session = getSession(bid);
    if (!session.client || !session.isConnected) {
        return res.json({ success: false, connected: false, chats: [], business_id: bid });
    }
    try {
        const chats = await session.client.getChats();
        const formatted = chats.slice(0, 60).map(c => {
            const lastMsg = c.lastMessage;
            return {
                id: c.id._serialized,
                name: c.name || c.id.user || 'Unknown',
                phone: c.id.user || '',
                isGroup: c.isGroup,
                unreadCount: c.unreadCount || 0,
                timestamp: c.timestamp ? c.timestamp * 1000 : (lastMsg?.timestamp ? lastMsg.timestamp * 1000 : null),
                lastMessage: lastMsg ? {
                    body: lastMsg.body || (lastMsg.type !== 'chat' ? `[${lastMsg.type}]` : ''),
                    timestamp: lastMsg.timestamp ? lastMsg.timestamp * 1000 : null,
                    fromMe: lastMsg.fromMe,
                } : null,
            };
        });
        res.json({ success: true, connected: true, chats: formatted, business_id: bid });
    } catch (err) {
        console.error(`[Bridge-Biz-${bid}] Failed to fetch chats:`, err.message);
        res.status(500).json({ success: false, error: err.message, chats: [], business_id: bid });
    }
});

app.get('/chats/:chatId/messages', async (req, res) => {
    const bid = parseInt(req.query.business_id) || 1;
    const session = getSession(bid);
    if (!session.client || !session.isConnected) {
        return res.status(503).json({ success: false, error: 'Not connected' });
    }
    try {
        const { chatId } = req.params;
        const chat = await session.client.getChatById(chatId);
        const limit = parseInt(req.query.limit) || 40;
        const messages = await chat.fetchMessages({ limit });
        const formatted = messages.map(m => ({
            id: m.id._serialized,
            body: m.body,
            fromMe: m.fromMe,
            sender: m.author || m.from,
            timestamp: m.timestamp * 1000,
            hasMedia: m.hasMedia,
            type: m.type,
        }));
        res.json({ success: true, messages: formatted });
    } catch (err) {
        console.error(`[Bridge-Biz-${bid}] Failed to fetch messages:`, err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/send', async (req, res) => {
    const { business_id, phone, message } = req.body || {};
    if (!phone || !message) {
        return res.status(400).json({ success: false, error: 'Missing phone or message' });
    }
    const bid = parseInt(business_id) || 1;
    const session = getSession(bid);
    if (!session.client || !session.isConnected) {
        return res.status(503).json({ success: false, error: `WhatsApp not connected for business ${bid}` });
    }

    try {
        let chatId = String(phone).trim();
        trackBotSend(chatId, message);

        // 1. If it already has domain (@c.us, @g.us, or @lid), send directly
        if (chatId.includes('@')) {
            const sentMsg = await session.client.sendMessage(chatId, message);
            if (sentMsg?.id?._serialized) trackBotMessageId(sentMsg.id._serialized);
            console.log(`[Bridge-Biz-${bid}] Sent directly to ${chatId}`);
            return res.json({ success: true, target: chatId });
        }

        // 2. Pure phone number
        const cleanPhone = chatId.replace(/\D/g, '');
        if (!cleanPhone) {
            return res.status(400).json({ success: false, error: 'Invalid phone number format' });
        }
        trackBotSend(cleanPhone, message);

        // 3. Resolve registered WhatsApp ID via getNumberId
        try {
            const numberDetails = await session.client.getNumberId(cleanPhone);
            if (numberDetails && numberDetails._serialized) {
                chatId = numberDetails._serialized;
            } else {
                chatId = `${cleanPhone}@c.us`;
            }
        } catch (lookupErr) {
            chatId = `${cleanPhone}@c.us`;
        }

        const sentMsg = await session.client.sendMessage(chatId, message);
        if (sentMsg?.id?._serialized) trackBotMessageId(sentMsg.id._serialized);
        console.log(`[Bridge-Biz-${bid}] Successfully sent to ${chatId}`);
        res.json({ success: true, target: chatId });
    } catch (err) {
        console.error(`[Bridge-Biz-${bid}] Send error:`, err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/send-media', async (req, res) => {
    const { business_id, phone, mediaUrl, filename, caption } = req.body || {};
    if (!phone || !mediaUrl) return res.status(400).json({ success: false, error: 'Missing phone or mediaUrl' });
    const bid = parseInt(business_id) || 1;
    const session = getSession(bid);
    if (!session.client || !session.isConnected) {
        return res.status(503).json({ success: false, error: `Not connected for business ${bid}` });
    }

    try {
        const response = await axios.get(mediaUrl, { responseType: 'arraybuffer', timeout: 30000 });
        const base64 = Buffer.from(response.data).toString('base64');

        const ext = (filename || '').split('.').pop().toLowerCase();
        const mimeMap = {
            jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
            pdf: 'application/pdf',
            mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo', webm: 'video/webm',
        };
        const mimetype = mimeMap[ext] || 'application/octet-stream';

        const media = new MessageMedia(mimetype, base64, filename || 'file');
        let chatId = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@c.us`;
        trackBotSend(chatId, caption || filename || '');
        const sentMsg = await session.client.sendMessage(chatId, media, { caption: caption || '' });
        if (sentMsg?.id?._serialized) trackBotMessageId(sentMsg.id._serialized);
        console.log(`[Bridge-Biz-${bid}] Sent media to ${chatId}: ${filename}`);
        res.json({ success: true });
    } catch (err) {
        console.error(`[Bridge-Biz-${bid}] Send media error:`, err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/typing', async (req, res) => {
    const { business_id, phone } = req.body || {};
    if (!phone) return res.status(400).json({ success: false, error: 'Missing phone' });
    const bid = parseInt(business_id) || 1;
    const session = getSession(bid);
    if (!session.client || !session.isConnected) {
        return res.status(503).json({ success: false, error: `Not connected for business ${bid}` });
    }

    try {
        let chatId = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@c.us`;
        const chat = await session.client.getChatById(chatId);
        await chat.sendStateTyping();
        res.json({ success: true });
    } catch (err) {
        console.error(`[Bridge-Biz-${bid}] Typing error:`, err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/logout', async (req, res) => {
    const bid = parseInt(req.body?.business_id || req.query.business_id) || 1;
    const session = getSession(bid);

    try {
        const oldClient = session.client;
        session.client = null;
        session.isConnected = false;
        session.connectionState = 'disconnected';
        session.connectionInfo = null;
        session.latestQR = null;
        session.initError = null;
        session.initializing = false;

        if (oldClient) {
            try {
                await oldClient.logout();
            } catch (e) {
                console.warn(`[Bridge-Biz-${bid}] Logout warning:`, e.message);
            }
            await safelyTerminateClient(oldClient);
        }

        res.json({ success: true, business_id: bid });

        // Clean auth files for this business and reinitialize with a fresh QR code
        setTimeout(async () => {
            await cleanAuthSessionAsync(bid);
            initSession(bid);
        }, 1200);
    } catch (err) {
        console.error(`[Bridge-Biz-${bid}] Logout endpoint error:`, err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/restart', async (req, res) => {
    const bid = parseInt(req.body?.business_id || req.query.business_id) || 1;
    const session = getSession(bid);

    try {
        const oldClient = session.client;
        session.client = null;
        session.isConnected = false;
        session.connectionState = 'starting';
        session.connectionInfo = null;
        session.latestQR = null;
        session.initError = null;
        session.initializing = false;

        if (oldClient) {
            await safelyTerminateClient(oldClient);
        }

        res.json({ success: true, message: 'Restarting...', business_id: bid });

        setTimeout(async () => {
            cleanStaleLockfiles(bid);
            initSession(bid);
        }, 1200);
    } catch (err) {
        console.error(`[Bridge-Biz-${bid}] Restart error:`, err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Clean up completely when a client is deleted
app.delete('/session/:businessId', async (req, res) => {
    const bid = parseInt(req.params.businessId);
    if (!bid) return res.status(400).json({ success: false, error: 'Invalid business ID' });

    console.log(`[Bridge] Deleting session storage and client for Business ${bid}...`);
    if (sessions.has(bid)) {
        const session = sessions.get(bid);
        if (session.client) {
            await safelyTerminateClient(session.client);
        }
        sessions.delete(bid);
    }

    await cleanAuthSessionAsync(bid);
    res.json({ success: true, message: `Session for business ${bid} deleted` });
});

// ── Graceful Shutdown ────────────────────────────────────────────────
async function shutdown(signal) {
    console.log(`[Bridge] Received ${signal}, shutting down all client sessions gracefully...`);
    for (const [id, session] of sessions.entries()) {
        try {
            if (session.client) {
                await safelyTerminateClient(session.client);
                console.log(`[Bridge-Biz-${id}] Client terminated`);
            }
        } catch (e) {
            console.error(`[Bridge-Biz-${id}] Error during shutdown:`, e.message);
        }
        cleanStaleLockfiles(id);
    }
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── Start Server ─────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[Bridge] Multi-session bridge running on port ${PORT}`);
    autoStartSavedSessions();
});
