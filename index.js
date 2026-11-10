
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  throw new Error('Token Telegram mancante');
}

const bot = new TelegramBot(token, { polling: true });

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    '🐾 Pokemon UPC Restock Italia è attivo! Ti avviserò quando il monitoraggio sarà configurato.'
  );
});

bot.on('polling_error', (error) => {
  console.error('Errore Telegram:', error.message);
});

console.log('Bot Telegram avviato');
