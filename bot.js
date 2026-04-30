const { Client, LocalAuth } = require('whatsapp-web.js');

const TELEGRAM_TOKEN = '8687121399:AAFfQZ9NSL00swk76DpMzxzd6jvUhIBvh4I';
const CHAT_ID = '632786488';
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

client.on('ready', () => {
  console.log('WhatsApp подключен. Бот работает.');
});

client.on('message_create', async msg => {
  try {
    const chat = await msg.getChat();

    if (!chat.isGroup || chat.name !== GROUP_NAME) return;

    const contact = await msg.getContact();
    const sender = contact.pushname || contact.number || 'Неизвестный';

    const text = `📢 ${chat.name}\n👤 ${sender}\n💬 ${msg.body || '[медиа/пустое сообщение]'}`;

    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text
        })
      }
    );

    const result = await response.json();

    if (result.ok) {
      console.log('Сообщение отправлено в Telegram');
    } else {
      console.log('Telegram error:', result);
    }
  } catch (error) {
    console.error('Ошибка обработки сообщения:', error);
  }
});

client.on('auth_failure', msg => {
  console.error('Ошибка авторизации:', msg);
});

client.on('disconnected', reason => {
  console.log('WhatsApp отключился:', reason);
});

client.initialize();