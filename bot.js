const { Client, LocalAuth } = require('whatsapp-web.js');
const http = require('http');

const TELEGRAM_TOKEN = '8687121399:AAFfQZ9NSL00swk76DpMzxzd6jvUhIBvh4I';
const CHAT_ID = '-5025047503'; // 👈 твоя Telegram группа
const GROUP_NAME = 'Барбосы'; // 👈 WhatsApp группа

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

// QR через ссылку (чтобы нормально открыть)
client.on('qr', qr => {
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
  console.log('Открой эту ссылку и отсканируй QR:');
  console.log(qrUrl);
});

// Статусы
client.on('ready', () => {
  console.log('WhatsApp подключен. Бот работает.');
});

client.on('authenticated', () => {
  console.log('WhatsApp авторизация успешна');
});

client.on('disconnected', reason => {
  console.log('WhatsApp отключился:', reason);
});

// 🔥 ОСНОВНАЯ ЛОГИКА
client.on('message_create', async msg => {
  try {
    const chat = await msg.getChat();

    // только нужная группа
    if (!chat.isGroup || chat.name !== GROUP_NAME) return;

    const contact = await msg.getContact();
    const sender = contact.pushname || contact.number || 'Неизвестный';

    const text = `📢 ${chat.name}\n👤 ${sender}\n💬 ${msg.body || '[медиа]'}`;

    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text
      })
    });

    const data = await res.json();

    if (data.ok) {
      console.log('Отправлено в Telegram');
    } else {
      console.log('Ошибка Telegram:', data);
    }

  } catch (err) {
    console.log('Ошибка:', err);
  }
});

client.initialize();

// чтобы Railway не убивал процесс
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot is running');
}).listen(process.env.PORT || 3000);