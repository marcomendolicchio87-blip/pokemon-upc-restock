
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  throw new Error('Token Telegram mancante');
}

const bot = new TelegramBot(token, { polling: true });

// Pagine da controllare
const products = [
  {
    name: 'Pokémon UPC 30° Anniversario - Giorno',
    url: 'https://cardrestocktracker.com/it/30-anniversario-ultra-premium-collection-versione-giorno-1h6cvz1'
  },
  {
    name: 'Pokémon UPC 30° Anniversario - Notte',
    url: 'https://cardrestocktracker.com/it/30-anniversario-ultra-premium-collection-versione-notte-bqq9av'
  }
];

const subscribersFile = './subscribers.json';
let subscribers = new Set();

try {
  if (fs.existsSync(subscribersFile)) {
    subscribers = new Set(JSON.parse(fs.readFileSync(subscribersFile)));
  }
} catch (error) {
  console.error('Errore lettura iscritti:', error.message);
}

function saveSubscribers() {
  fs.writeFileSync(
    subscribersFile,
    JSON.stringify([...subscribers])
  );
}

const previousAvailability = {};
let checking = false;

async function checkProduct(product) {
  try {
    const response = await fetch(product.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0'
      },
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      throw new Error('Risposta del sito: ' + response.status);
    }

    const html = await response.text();
    const page = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&egrave;/g, 'è')
      .replace(/&agrave;/g, 'à')
      .replace(/\s+/g, ' ');

    const match = page.match(
      /è disponibile in\s+(\d+)\s+negozi?\s+su\s+(\d+)/i
    );

    if (!match) {
      console.log('Disponibilità non leggibile:', product.name);
      return;
    }

    const available = Number(match[1]);
    const total = Number(match[2]);
    const previous = previousAvailability[product.name];

    console.log(
      product.name + ': ' + available + ' negozi disponibili su ' + total
    );

    previousAvailability[product.name] = available;

    // Primo controllo: avvisa se il prodotto è già disponibile
    if (previous === undefined && available > 0) {
      await sendAlert(
        '🔔 DISPONIBILITÀ RILEVATA!\n\n' +
        product.name +
        '\nNegozi disponibili: ' + available +
        '\n\nControlla qui:\n' + product.url
      );
    }

    // Controlli successivi: avvisa quando torna disponibile
    if (previous !== undefined && previous === 0 && available > 0) {
      await sendAlert(
        '🚨 RESTOCK RILEVATO!\n\n' +
        product.name +
        '\nNegozi disponibili: ' + available +
        '\n\nCONTROLLA SUBITO:\n' + product.url
      );
    }

  } catch (error) {
    console.error('Errore controllo ' + product.name + ':', error.message);
  }
}

async function sendAlert(message) {
  for (const chatId of subscribers) {
    try {
      await bot.sendMessage(chatId, message);
    } catch (error) {
      console.error('Errore invio Telegram:', error.message);
    }
  }
}

async function checkAllProducts() {
  if (checking) return;

  checking = true;

  try {
    for (const product of products) {
      await checkProduct(product);
    }
  } finally {
    checking = false;
  }
}

bot.onText(/\/start/, async (msg) => {
  subscribers.add(msg.chat.id);
  saveSubscribers();

  await bot.sendMessage(
    msg.chat.id,
    '🐾 Pokémon UPC Restock Italia attivo!\n\n' +
    'Ti avviserò quando rileverò un ritorno di disponibilità.\n\n' +
    'Controllo automatico ogni 5 minuti.\n\n' +
    'Comandi disponibili:\n' +
    '/status - stato del monitoraggio\n' +
    '/check - controllo immediato'
  );
});

bot.onText(/\/status/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    '✅ Bot attivo.\n' +
    'Prodotti monitorati: 2\n' +
    'Intervallo: 5 minuti.'
  );
});

bot.onText(/\/check/, async (msg) => {
  await bot.sendMessage(msg.chat.id, '🔎 Controllo le disponibilità...');

  for (const product of products) {
    await checkProduct(product);
  }

  await bot.sendMessage(msg.chat.id, 'Controllo terminato.');
});

bot.on('polling_error', (error) => {
  console.error('Errore Telegram:', error.message);
});

console.log('🐾 Bot Pokémon UPC avviato!');

// Primo controllo immediato
checkAllProducts();

// Controllo automatico ogni 5 minuti
setInterval(checkAllProducts, 5 * 60 * 1000);
