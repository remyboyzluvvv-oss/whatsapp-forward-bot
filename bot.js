const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// ❗ ВСТАВЛЯЕШЬ СВОИ ДАННЫЕ ЗДЕСЬ
const TELEGRAM_TOKEN = '8687121399:AAFfQZ9NSL00swk76DpMzxzd6jvUhIBvh4I';
const CHAT_ID = '632786488';

const GROUP_NAME = 'Барбосы';

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', qr => {
    console.log('Сканируй QR:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('Бот запущен!');
});

client.on('message_create', async msg => {
    try {
        const chat = await msg.getChat();

        if (chat.isGroup && chat.name === GROUP_NAME) {
            const contact = await msg.getContact();
            const sender = contact.pushname || contact.number;

            await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    chat_id: CHAT_ID,
                    text: `📢 ${chat.name}\n👤 ${sender}\n💬 ${msg.body}`
                })
            });
        }
    } catch (e) {
        console.log(e);
    }
});

client.initialize();