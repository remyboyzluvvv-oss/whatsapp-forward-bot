const { Client, LocalAuth } = require('whatsapp-web.js');
const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const {
  isHermesConfigured,
  hermesHealth,
  askHermes,
  extractHermesPrompt
} = require('./hermes');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const DEFAULT_TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID || '';
const PORT = process.env.PORT || 3000;
const PERSIST_DIR = process.env.PERSIST_DIR ? path.resolve(process.env.PERSIST_DIR) : '';

const ROUTES_FILE = PERSIST_DIR
  ? path.join(PERSIST_DIR, 'routes.json')
  : path.join(__dirname, 'routes.json');

const WHATSAPP_AUTH_DATA_PATH = process.env.WHATSAPP_AUTH_PATH
  ? path.resolve(process.env.WHATSAPP_AUTH_PATH)
  : PERSIST_DIR
    ? path.join(PERSIST_DIR, 'whatsapp-web-auth')
    : path.join(__dirname, '.wwebjs_auth');

const SETTINGS_FILE = PERSIST_DIR
  ? path.join(PERSIST_DIR, 'admin-settings.json')
  : path.join(__dirname, 'admin-settings.json');

const MESSAGES_DB_FILE = process.env.MESSAGES_DB_PATH
  ? path.resolve(process.env.MESSAGES_DB_PATH)
  : PERSIST_DIR
    ? path.join(PERSIST_DIR, 'messages.sqlite')
    : path.join(__dirname, 'messages.sqlite');

let adminPassword = process.env.ADMIN_PASSWORD || '1111';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const sessions = new Map();

if (!TELEGRAM_TOKEN) {
  throw new Error('TELEGRAM_TOKEN is required');
}

const state = {
  sessionStatus: 'disconnected',
  phoneNumber: null,
  lastActivityAt: null,
  qrData: null,
  monitoredChats: new Map(),
  restartInProgress: false
};

let messagesDb = null;
const processedMessageIds = new Set();

function normalizeChatId(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return '';
  const atIndex = id.indexOf('@');
  if (atIndex === -1) return id;
  const local = id.slice(0, atIndex).split(':')[0];
  const domain = id.slice(atIndex);
  return `${local}${domain}`;
}

async function loadRoutesFromDisk() {
  try {
    const content = await fs.readFile(ROUTES_FILE, 'utf8');
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item.chatId && item.telegramChatId) {
          const normalized = normalizeChatId(item.chatId);
          state.monitoredChats.set(normalized, {
            chatId: item.chatId,
            chatName: item.chatName || item.chatId,
            telegramChatId: String(item.telegramChatId),
            aiEnabled: Boolean(item.aiEnabled)
          });
        }
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Failed to load routes file:', error);
    }
  }
}

async function saveRoutesToDisk() {
  const routes = Array.from(state.monitoredChats.values());
  try {
    await fs.writeFile(ROUTES_FILE, JSON.stringify(routes, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Failed to save routes file:', error.message);
    return false;
  }
}

function initMessagesDb() {
  if (messagesDb) return;
  messagesDb = new Database(MESSAGES_DB_FILE);
  messagesDb.pragma('journal_mode = WAL');
  messagesDb.exec(`
    CREATE TABLE IF NOT EXISTS forwarded_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      source_chat_id TEXT NOT NULL,
      source_chat_name TEXT NOT NULL,
      telegram_chat_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      text_preview TEXT NOT NULL
    );
  `);
}

function insertRecentMessage(entry) {
  if (!messagesDb) return;
  messagesDb
    .prepare(
      `INSERT INTO forwarded_messages (at, source_chat_id, source_chat_name, telegram_chat_id, sender, text_preview)
       VALUES (@at, @sourceChatId, @sourceChatName, @telegramChatId, @sender, @textPreview)`
    )
    .run({
      at: entry.at,
      sourceChatId: entry.sourceChatId,
      sourceChatName: entry.sourceChatName,
      telegramChatId: entry.telegramChatId,
      sender: entry.sender,
      textPreview: entry.textPreview
    });
  messagesDb.prepare(
    `DELETE FROM forwarded_messages WHERE id NOT IN (
       SELECT id FROM forwarded_messages ORDER BY id DESC LIMIT 50
     )`
  ).run();
}

function getRecentMessages() {
  if (!messagesDb) return [];
  return messagesDb
    .prepare(
      `SELECT at,
              source_chat_id AS sourceChatId,
              source_chat_name AS sourceChatName,
              telegram_chat_id AS telegramChatId,
              sender,
              text_preview AS textPreview
       FROM forwarded_messages
       ORDER BY id DESC
       LIMIT 50`
    )
    .all();
}

async function sendTelegramMessage(endpoint, body) {
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${endpoint}`, body);
  const result = await response.json();
  if (!result.ok) {
    throw new Error(result.description || 'Telegram API error');
  }
}

async function sendTextToTelegram(chatId, text) {
  await sendTelegramMessage('sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

async function sendMediaToTelegram(chatId, msg, caption) {
  const media = await msg.downloadMedia();
  if (!media) {
    await sendTextToTelegram(chatId, `${caption}\n\n[Не удалось скачать медиа]`);
    return;
  }

  const buffer = Buffer.from(media.data, 'base64');
  const blob = new Blob([buffer], { type: media.mimetype });
  const form = new FormData();

  form.append('chat_id', chatId);
  form.append('caption', caption);

  let endpoint = 'sendDocument';
  let fieldName = 'document';
  let filename = media.filename || 'file';

  if (media.mimetype.startsWith('image/')) {
    endpoint = 'sendPhoto';
    fieldName = 'photo';
    filename = 'photo.jpg';
  } else if (media.mimetype.startsWith('video/')) {
    endpoint = 'sendVideo';
    fieldName = 'video';
    filename = 'video.mp4';
  } else if (media.mimetype.startsWith('audio/')) {
    endpoint = msg.type === 'ptt' ? 'sendVoice' : 'sendAudio';
    fieldName = msg.type === 'ptt' ? 'voice' : 'audio';
    filename = msg.type === 'ptt' ? 'voice.ogg' : 'audio.mp3';
  }

  form.append(fieldName, blob, filename);
  await sendTelegramMessage(endpoint, {
    method: 'POST',
    body: form
  });
}

async function resolveSenderName(msg) {
  const fallback =
    msg?._data?.notifyName ||
    msg?._data?.sender?.pushname ||
    msg?._data?.sender?.formattedName ||
    msg?.author ||
    msg?.from ||
    'Неизвестный';

  try {
    const contact = await msg.getContact();
    return (
      contact?.pushname ||
      contact?.name ||
      contact?.number ||
      fallback
    );
  } catch (error) {
    console.warn('getContact failed, using fallback sender:', error.message);
    return fallback;
  }
}

function resolveChatName(chat) {
  return (
    chat?.name ||
    chat?.formattedTitle ||
    chat?.contact?.pushname ||
    chat?.contact?.name ||
    chat?.id?._serialized ||
    'Без названия'
  );
}

let disconnectUiTimer = null;

function cancelDisconnectUiGrace() {
  if (disconnectUiTimer) {
    clearTimeout(disconnectUiTimer);
    disconnectUiTimer = null;
  }
}

function scheduleDisconnectUi() {
  cancelDisconnectUiGrace();
  disconnectUiTimer = setTimeout(() => {
    disconnectUiTimer = null;
    try {
      const wid = client.info?.wid?.user;
      if (wid) {
        state.sessionStatus = 'connected';
        state.phoneNumber = wid;
        return;
      }
    } catch {
      /* client может быть в процессе перезапуска */
    }
    state.sessionStatus = 'disconnected';
    state.phoneNumber = null;
  }, 1200);
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: WHATSAPP_AUTH_DATA_PATH }),
  takeoverOnConflict: true,
  takeoverTimeoutMs: 6000,
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote'
    ]
  }
});

client.on('qr', (qr) => {
  cancelDisconnectUiGrace();
  state.qrData = qr;
  state.sessionStatus = 'disconnected';
  console.log('QR code generated');
});

client.on('authenticated', () => {
  cancelDisconnectUiGrace();
  state.sessionStatus = 'authenticated';
  state.qrData = null;
  console.log('WhatsApp authenticated');
});

client.on('ready', async () => {
  cancelDisconnectUiGrace();
  state.sessionStatus = 'connected';
  state.qrData = null;
  const info = client.info;
  state.phoneNumber = info?.wid?.user || null;
  console.log('WhatsApp is ready');

  if (DEFAULT_TELEGRAM_CHAT_ID && state.monitoredChats.size === 0) {
    const chats = await client.getChats();
    const firstGroup = chats.find((chat) => chat.isGroup);
    if (firstGroup) {
      const groupId = firstGroup.id._serialized;
      state.monitoredChats.set(normalizeChatId(groupId), {
        chatId: groupId,
        chatName: firstGroup.name,
        telegramChatId: DEFAULT_TELEGRAM_CHAT_ID,
        aiEnabled: false
      });
      await saveRoutesToDisk();
      console.log(`Default route added for ${firstGroup.name}`);
    }
  }
});

client.on('disconnected', (reason) => {
  console.log('WhatsApp disconnected:', reason);
  scheduleDisconnectUi();
});

client.on('change_state', (waState) => {
  console.log('WhatsApp change_state:', waState);
});

let reconnectInFlight = false;

function isRecoverableBrowserError(msg, err) {
  if (err && String(err.name || '').includes('Protocol')) return true;
  const m = String(msg || '').toLowerCase();
  return (
    m.includes('execution context was destroyed') ||
    m.includes('protocol error') ||
    m.includes('target closed') ||
    m.includes('session closed') ||
    m.includes('navigation failed')
  );
}

async function softReconnectWhatsApp(reason) {
  if (reconnectInFlight || state.restartInProgress) {
    console.warn('Reconnect skipped:', reason);
    return;
  }
  reconnectInFlight = true;
  console.warn('WhatsApp soft reconnect:', reason);
  cancelDisconnectUiGrace();
  await new Promise((r) => setTimeout(r, 2500));
  try {
    await client.destroy();
  } catch (e) {
    console.warn('client.destroy during soft reconnect:', e.message || e);
  }
  try {
    await client.initialize();
  } catch (e) {
    console.error('client.initialize after soft reconnect failed:', e.message || e);
    reconnectInFlight = false;
    setTimeout(() => {
      softReconnectWhatsApp('retry-after-failed-init').catch(() => {});
    }, 12000);
    return;
  }
  reconnectInFlight = false;
}

process.on('uncaughtException', (err) => {
  const msg = err && err.message ? err.message : String(err);
  if (isRecoverableBrowserError(msg, err)) {
    console.warn('Recoverable browser error (uncaught):', msg);
    reconnectInFlight = false;
    softReconnectWhatsApp(msg).catch(() => {
      reconnectInFlight = false;
    });
    return;
  }
  console.error('Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason);
  if (isRecoverableBrowserError(msg, reason)) {
    console.warn('Recoverable browser error (rejection):', msg);
    reconnectInFlight = false;
    softReconnectWhatsApp(msg).catch(() => {
      reconnectInFlight = false;
    });
    return;
  }
  console.error('Unhandled rejection:', reason);
});

async function handleIncomingMessage(msg) {
  try {
    if (msg.broadcast) {
      return;
    }

    const msgId = msg?.id?._serialized;
    if (msgId) {
      if (processedMessageIds.has(msgId)) return;
      processedMessageIds.add(msgId);
      if (processedMessageIds.size > 500) {
        const first = processedMessageIds.values().next().value;
        processedMessageIds.delete(first);
      }
    }

    const orderedIds = msg.fromMe ? [msg.to, msg.from, msg.author] : [msg.from, msg.to, msg.author];
    const candidateChatIds = orderedIds
      .filter(Boolean)
      .map((id) => normalizeChatId(id));
    const matchedChatId = candidateChatIds.find((id) => state.monitoredChats.has(id));
    const route = matchedChatId ? state.monitoredChats.get(matchedChatId) : null;
    if (!route) {
      return;
    }

    const hermesPrompt = route.aiEnabled && isHermesConfigured()
      ? extractHermesPrompt(msg.body)
      : null;

    const chat = await msg.getChat();
    const sender = msg.fromMe ? 'Я (номер бота)' : await resolveSenderName(msg);
    const chatName = resolveChatName(chat);
    const caption = `📢 ${chatName}\n👤 ${sender}`;

    if (msg.hasMedia) {
      const mediaCaption = msg.body ? `${caption}\n💬 ${msg.body}` : caption;
      await sendMediaToTelegram(route.telegramChatId, msg, mediaCaption);
    } else {
      await sendTextToTelegram(route.telegramChatId, `${caption}\n💬 ${msg.body || '[пустое сообщение]'}`);
    }

    state.lastActivityAt = new Date().toISOString();
    insertRecentMessage({
      at: state.lastActivityAt,
      sourceChatId: route.chatId,
      sourceChatName: route.chatName || chatName,
      telegramChatId: route.telegramChatId,
      sender,
      textPreview: msg.body || '[media]'
    });

    if (hermesPrompt !== null && !msg.fromMe) {
      try {
        const replyTarget = chat.id._serialized || route.chatId;
        await client.sendMessage(replyTarget, '🤖 Hermes думает…');
        const answer = await askHermes(hermesPrompt || 'Привет', {
          chatName: route.chatName || chatName,
          sender
        });
        const trimmed = answer.length > 4000 ? `${answer.slice(0, 3990)}…` : answer;
        await client.sendMessage(replyTarget, trimmed);
        console.log('Hermes reply sent to', replyTarget);
      } catch (aiErr) {
        console.error('Hermes error:', aiErr.message || aiErr);
        try {
          await client.sendMessage(chat.id._serialized || route.chatId, `❌ Hermes: ${aiErr.message || aiErr}`);
        } catch {
          /* ignore */
        }
      }
    }
  } catch (error) {
    console.error('Message processing error:', error);
  }
}

client.on('message', handleIncomingMessage);
client.on('message_create', handleIncomingMessage);

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJsonSetCookie(res, statusCode, payload, setCookie) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (setCookie) headers['Set-Cookie'] = setCookie;
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(payload));
}

function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    let v = part.slice(idx + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch {
      /* ignore */
    }
    out[k] = v;
  });
  return out;
}

function getSessionToken(req) {
  return parseCookies(req.headers.cookie).wa_panel || '';
}

function isAuthenticated(req) {
  const t = getSessionToken(req);
  if (!t || !sessions.has(t)) return false;
  const exp = sessions.get(t);
  if (Date.now() > exp) {
    sessions.delete(t);
    return false;
  }
  return true;
}

async function loadAdminSettings() {
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf8');
    const j = JSON.parse(raw);
    if (j.adminPassword && typeof j.adminPassword === 'string') {
      adminPassword = j.adminPassword;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error('admin-settings load:', e);
    }
  }
}

async function saveAdminPassword(newPass) {
  adminPassword = newPass;
  await fs.writeFile(SETTINGS_FILE, JSON.stringify({ adminPassword: newPass }, null, 2), 'utf8');
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let pathname = url.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }

    if (req.method === 'GET' && pathname === '/api/auth/status') {
      sendJson(res, 200, { authenticated: isAuthenticated(req) });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/auth/login') {
      const body = await readRequestBody(req);
      const pwd = body.password != null ? String(body.password) : '';
      if (pwd !== adminPassword) {
        sendJson(res, 401, { error: 'Неверный пароль' });
        return;
      }
      const token = crypto.randomBytes(24).toString('hex');
      sessions.set(token, Date.now() + SESSION_MS);
      const maxAge = Math.floor(SESSION_MS / 1000);
      sendJsonSetCookie(
        res,
        200,
        { ok: true },
        `wa_panel=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`
      );
      return;
    }

    if (
      pathname.startsWith('/api/') &&
      pathname !== '/api/auth/login' &&
      pathname !== '/api/auth/status'
    ) {
      if (!isAuthenticated(req)) {
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }
    }

    if (req.method === 'POST' && pathname === '/api/auth/logout') {
      const t = getSessionToken(req);
      if (t) sessions.delete(t);
      sendJsonSetCookie(res, 200, { ok: true }, 'wa_panel=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
      return;
    }

    if (req.method === 'POST' && pathname === '/api/auth/password') {
      const body = await readRequestBody(req);
      const oldP = body.oldPassword != null ? String(body.oldPassword) : '';
      const newP = body.newPassword != null ? String(body.newPassword) : '';
      if (oldP !== adminPassword) {
        sendJson(res, 403, { error: 'Неверный текущий пароль' });
        return;
      }
      if (!newP || newP.length < 4) {
        sendJson(res, 400, { error: 'Новый пароль не короче 4 символов' });
        return;
      }
      await saveAdminPassword(newP);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/status') {
      if (!state.restartInProgress && !state.qrData) {
        try {
          const wid = client.info?.wid?.user;
          if (wid) {
            state.sessionStatus = 'connected';
            state.phoneNumber = wid;
          }
        } catch {
          /* во время destroy/reinit client.info может быть недоступен */
        }
      }
      sendJson(res, 200, {
        sessionStatus: state.sessionStatus,
        phoneNumber: state.phoneNumber,
        lastActivityAt: state.lastActivityAt,
        restartInProgress: state.restartInProgress
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/config') {
      sendJson(res, 200, {
        defaultTelegramChatId: DEFAULT_TELEGRAM_CHAT_ID || '-5025047503',
        hermesConfigured: isHermesConfigured()
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/hermes/status') {
      if (!isHermesConfigured()) {
        sendJson(res, 200, { configured: false, ok: false, hint: 'Задайте HERMES_API_URL в Railway' });
        return;
      }
      const health = await hermesHealth();
      sendJson(res, 200, { configured: true, ...health });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/qr') {
      if (!state.qrData) {
        sendJson(res, 200, { qr: null });
        return;
      }
      const qr = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(state.qrData)}`;
      sendJson(res, 200, { qr });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/chats') {
      try {
        const chats = await client.getChats();
        const allChats = chats
          .filter((chat) => !chat.isStatus)
          .map((chat) => ({
            id: chat.id._serialized,
            name: resolveChatName(chat),
            isGroup: chat.isGroup,
            type: chat.isGroup ? 'group' : 'private'
          }))
          .sort((a, b) => a.name.localeCompare(b.name));

        sendJson(res, 200, {
          allChats,
          monitored: Array.from(state.monitoredChats.values()),
          whatsappReady: true
        });
      } catch (error) {
        sendJson(res, 200, {
          allChats: [],
          monitored: Array.from(state.monitoredChats.values()),
          whatsappReady: false,
          error: 'WhatsApp is not ready yet'
        });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/routes') {
      sendJson(res, 200, { monitored: Array.from(state.monitoredChats.values()) });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/routes') {
      const body = await readRequestBody(req);
      const { chatId, telegramChatId, chatName: chatNameRaw, aiEnabled } = body;
      console.log('POST /api/routes body:', { chatId, telegramChatId, chatName: chatNameRaw, aiEnabled });

      if (!chatId || !telegramChatId) {
        sendJson(res, 400, { error: 'chatId and telegramChatId are required' });
        return;
      }

      const hint = (chatNameRaw && String(chatNameRaw).trim()) || '';
      const mapKey = normalizeChatId(chatId);
      const fastName = hint || `Чат ${String(chatId).split('@')[0]}`;

      state.monitoredChats.set(mapKey, {
        chatId,
        chatName: fastName,
        telegramChatId: String(telegramChatId),
        aiEnabled: Boolean(aiEnabled)
      });
      const saved = await saveRoutesToDisk();
      console.log('Route saved (fast path):', mapKey, fastName);

      sendJson(res, 200, {
        ok: true,
        persisted: saved,
        monitored: Array.from(state.monitoredChats.values())
      });

      return;
    }

    if (req.method === 'DELETE' && pathname.startsWith('/api/routes/')) {
      const chatId = decodeURIComponent(pathname.replace('/api/routes/', ''));
      state.monitoredChats.delete(normalizeChatId(chatId));
      const saved = await saveRoutesToDisk();
      sendJson(res, 200, {
        ok: true,
        persisted: saved,
        monitored: Array.from(state.monitoredChats.values())
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/messages') {
      sendJson(res, 200, { items: getRecentMessages() });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/session/restart') {
      if (state.restartInProgress) {
        sendJson(res, 200, { ok: true, restarting: true, message: 'Перезапуск уже выполняется' });
        return;
      }
      state.restartInProgress = true;
      cancelDisconnectUiGrace();
      state.sessionStatus = 'disconnected';
      state.qrData = null;
      state.phoneNumber = null;
      sendJson(res, 200, { ok: true, restarting: true });

      setImmediate(async () => {
        const safetyMs = 180_000;
        const safety = setTimeout(() => {
          if (state.restartInProgress) {
            state.restartInProgress = false;
            console.warn('WhatsApp restart: safety timeout cleared restartInProgress');
          }
        }, safetyMs);
        try {
          try {
            await client.destroy();
          } catch (destroyErr) {
            console.warn('client.destroy during restart:', destroyErr.message || destroyErr);
          }
          await client.initialize();
        } catch (error) {
          console.error('WhatsApp session restart failed:', error);
          state.sessionStatus = 'disconnected';
        } finally {
          clearTimeout(safety);
          state.restartInProgress = false;
        }
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/') {
      const htmlFile = isAuthenticated(req) ? 'index.html' : 'login.html';
      const html = await fs.readFile(path.join(__dirname, 'public', htmlFile), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (error) {
    sendJson(res, 500, { error: error.message || 'Server error' });
  }
}).listen(PORT, () => {
  console.log(`Control panel started on port ${PORT}`);
});

async function bootstrap() {
  try {
    if (PERSIST_DIR) {
      await fs.mkdir(PERSIST_DIR, { recursive: true });
    }
    await fs.mkdir(WHATSAPP_AUTH_DATA_PATH, { recursive: true });
    const dbDir = path.dirname(MESSAGES_DB_FILE);
    if (dbDir && dbDir !== '.') {
      await fs.mkdir(dbDir, { recursive: true });
    }
    try {
      initMessagesDb();
    } catch (e) {
      console.error('Messages DB init failed:', e.message || e);
      messagesDb = null;
    }
    await loadRoutesFromDisk();
    await loadAdminSettings();
  } catch (error) {
    console.error('Bootstrap error:', error);
  }
  console.log('WhatsApp auth data path:', WHATSAPP_AUTH_DATA_PATH);
  console.log('Routes file:', ROUTES_FILE);
  console.log('Messages DB:', MESSAGES_DB_FILE);
  try {
    await client.initialize();
  } catch (e) {
    console.error('Initial client.initialize failed:', e.message || e);
    softReconnectWhatsApp('bootstrap-initialize').catch(() => {});
  }
}

bootstrap().catch((e) => console.error('bootstrap():', e));