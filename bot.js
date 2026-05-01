const { Client, LocalAuth } = require('whatsapp-web.js');
const http = require('http');

const TELEGRAM_TOKEN = '8687121399:AAFfQZ9NSL00swk76DpMzxzd6jvUhIBvh4I';
const CHAT_ID = '-5025047503';
const GROUP_NAME = 'Барбосы';

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

client.on('qr', qr => {
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
  console.log('Открой эту ссылку и отсканируй QR:');
  console.log(qrUrl);
});

client.on('authenticated', () => {
  console.log('WhatsApp авторизация успешна');
});

client.on('ready', () => {
  console.log('WhatsApp подключен. Бот работает.');
});

client.on('disconnected', reason => {
  console.log('WhatsApp отключился:', reason);
});

async function sendTextToTelegram(text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text
    })
  });
}

async function sendMediaToTelegram(msg, caption) {
  const media = await msg.downloadMedia();

  if (!media) {
    await sendTextToTelegram(`${caption}\n\n[Не удалось скачать медиа]`);
    return;
  }

  const buffer = Buffer.from(media.data, 'base64');
  const blob = new Blob([buffer], { type: media.mimetype });
  const form = new FormData();

  form.append('chat_id', CHAT_ID);
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

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${endpoint}`, {
    method: 'POST',
    body: form
  });

  const result = await response.json();

  if (!result.ok) {
    console.log('Ошибка Telegram media:', result);
    await sendTextToTelegram(`${caption}\n\n[Медиа не отправилось: ${result.description}]`);
  } else {
    console.log('Медиа отправлено в Telegram');
  }
}

client.on('message_create', async msg => {
  try {
    const chat = await msg.getChat();

    if (!chat.isGroup || chat.name !== GROUP_NAME) return;

    const contact = await msg.getContact();
    const sender = contact.pushname || contact.number || 'Неизвестный';

    const caption = `📢 ${chat.name}\n👤 ${sender}`;

    if (msg.hasMedia) {
      const mediaCaption = msg.body
        ? `${caption}\n💬 ${msg.body}`
        : caption;

      await sendMediaToTelegram(msg, mediaCaption);
    } else {
      await sendTextToTelegram(`${caption}\n💬 ${msg.body}`);
      console.log('Текст отправлен в Telegram');
    }
  } catch (error) {
    console.error('Ошибка обработки сообщения:', error);
  }
});

client.initialize();

http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot is running');
}).listen(process.env.PORT || 3000, () => {
  console.log('Keep-alive server started');
});