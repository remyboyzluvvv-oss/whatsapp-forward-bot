const { Client, LocalAuth } = require('whatsapp-web.js');
const http = require('http');
const fs = require('fs/promises');
const path = require('path');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const DEFAULT_TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID || '';
const PORT = process.env.PORT || 3000;
const ROUTES_FILE = path.join(__dirname, 'routes.json');

if (!TELEGRAM_TOKEN) {
  throw new Error('TELEGRAM_TOKEN is required');
}

const state = {
  sessionStatus: 'disconnected',
  phoneNumber: null,
  lastActivityAt: null,
  qrData: null,
  monitoredChats: new Map(),
  recentMessages: [],
  restartInProgress: false
};
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
            telegramChatId: String(item.telegramChatId)
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

function pushRecentMessage(entry) {
  state.recentMessages.unshift(entry);
  if (state.recentMessages.length > 50) {
    state.recentMessages.length = 50;
  }
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

const client = new Client({
  authStrategy: new LocalAuth(),
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
  state.qrData = qr;
  state.sessionStatus = 'disconnected';
  console.log('QR code generated');
});

client.on('authenticated', () => {
  state.sessionStatus = 'authenticated';
  state.qrData = null;
  console.log('WhatsApp authenticated');
});

client.on('ready', async () => {
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
        telegramChatId: DEFAULT_TELEGRAM_CHAT_ID
      });
      await saveRoutesToDisk();
      console.log(`Default route added for ${firstGroup.name}`);
    }
  }
});

client.on('disconnected', (reason) => {
  state.sessionStatus = 'disconnected';
  state.phoneNumber = null;
  console.log('WhatsApp disconnected:', reason);
});

async function handleIncomingMessage(msg) {
  try {
    const msgId = msg?.id?._serialized;
    if (msgId) {
      if (processedMessageIds.has(msgId)) return;
      processedMessageIds.add(msgId);
      if (processedMessageIds.size > 500) {
        const first = processedMessageIds.values().next().value;
        processedMessageIds.delete(first);
      }
    }

    const candidateChatIds = [msg.from, msg.to, msg.author]
      .filter(Boolean)
      .map((id) => normalizeChatId(id));
    const matchedChatId = candidateChatIds.find((id) => state.monitoredChats.has(id));
    const route = matchedChatId ? state.monitoredChats.get(matchedChatId) : null;
    if (!route) {
      return;
    }

    const chat = await msg.getChat();
    const sender = await resolveSenderName(msg);
    const chatName = resolveChatName(chat);
    const caption = `📢 ${chatName}\n👤 ${sender}`;

    if (msg.hasMedia) {
      const mediaCaption = msg.body ? `${caption}\n💬 ${msg.body}` : caption;
      await sendMediaToTelegram(route.telegramChatId, msg, mediaCaption);
    } else {
      await sendTextToTelegram(route.telegramChatId, `${caption}\n💬 ${msg.body || '[пустое сообщение]'}`);
    }

    state.lastActivityAt = new Date().toISOString();
    pushRecentMessage({
      at: state.lastActivityAt,
      sourceChatId: route.chatId,
      sourceChatName: route.chatName || chatName,
      telegramChatId: route.telegramChatId,
      sender,
      textPreview: msg.body || '[media]'
    });
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

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let pathname = url.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }

    if (req.method === 'GET' && pathname === '/api/status') {
      sendJson(res, 200, {
        sessionStatus: state.sessionStatus,
        phoneNumber: state.phoneNumber,
        lastActivityAt: state.lastActivityAt,
        restartInProgress: state.restartInProgress
      });
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
      const { chatId, telegramChatId, chatName: chatNameRaw } = body;
      console.log('POST /api/routes body:', { chatId, telegramChatId, chatName: chatNameRaw });

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
        telegramChatId: String(telegramChatId)
      });
      const saved = await saveRoutesToDisk();
      console.log('Route saved (fast path):', mapKey, fastName);

      sendJson(res, 200, {
        ok: true,
        persisted: saved,
        monitored: Array.from(state.monitoredChats.values())
      });

      setImmediate(async () => {
        const enrichMs = 5000;
        try {
          const chat = await Promise.race([
            client.getChatById(chatId),
            new Promise((_, reject) => {
              setTimeout(() => reject(new Error('getChatById timeout')), enrichMs);
            })
          ]);
          if (!chat) return;
          const key = normalizeChatId(chat.id._serialized);
          state.monitoredChats.set(key, {
            chatId: chat.id._serialized,
            chatName: resolveChatName(chat),
            telegramChatId: String(telegramChatId)
          });
          if (key !== mapKey) {
            state.monitoredChats.delete(mapKey);
          }
          await saveRoutesToDisk();
          console.log('Route enriched from WhatsApp:', key, resolveChatName(chat));
        } catch (e) {
          console.warn('Route enrich skipped:', e.message || e);
        }
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
      sendJson(res, 200, { items: state.recentMessages });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/session/restart') {
      if (state.restartInProgress) {
        sendJson(res, 200, { ok: true, restarting: true, message: 'Перезапуск уже выполняется' });
        return;
      }
      state.restartInProgress = true;
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
      const html = await fs.readFile(path.join(__dirname, 'public', 'index.html'), 'utf8');
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

loadRoutesFromDisk()
  .catch((error) => {
    console.error('Routes bootstrap error:', error);
  })
  .finally(() => {
    client.initialize();
  });