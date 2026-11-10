
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('Token Telegram mancante');

const bot = new TelegramBot(token, { polling: true });

const products = [
  {
    name: 'UPC Giorno - Card Restock Tracker',
    type: 'card',
    url: 'https://cardrestocktracker.com/it/30-anniversario-ultra-premium-collection-versione-giorno-1h6cvz1'
  },
  {
    name: 'UPC Notte - Card Restock Tracker',
    type: 'card',
    url: 'https://cardrestocktracker.com/it/30-anniversario-ultra-premium-collection-versione-notte-bqq9av'
  },
  {
    name: 'UPC Giorno - Pokemonitor',
    type: 'pokemonitor',
    url: 'https://pokemonitoritalia.com/set/megaevoluzioni/30-anniversario/collezione-ultra-premium-giornata'
  },
  {
    name: 'UPC Notte - Pokemonitor',
    type: 'pokemonitor',
    url: 'https://pokemonitoritalia.com/set/megaevoluzioni/30-anniversario/collezione-ultra-premium-serata'
  }
];

const subscribersFile = './subscribers.json';
const stateFile = './availability.json';

let subscribers = new Set();
let previous = {};

try {
  if (fs.existsSync(subscribersFile)) {
    subscribers = new Set(JSON.parse(fs.readFileSync(subscribersFile)));
  }
  if (fs.existsSync(stateFile)) {
    previous = JSON.parse(fs.readFileSync(stateFile));
  }
} catch (error) {
  console.log('Lettura dati iniziali:', error.message);
}

function saveData() {
  fs.writeFileSync(subscribersFile, JSON.stringify([...subscribers]));
  fs.writeFileSync(stateFile, JSON.stringify(previous));
}

async function notify(message) {
  for (const id of subscribers) {
    try {
      await bot.sendMessage(id, message);
    } catch (error) {
      console.log('Errore invio:', error.message);
    }
  }
}

async function checkProduct(product) {
  try {
    const response = await fetch(product.url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(20000)
    });

    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }

    const html = await response.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&egrave;/g, 'è')
      .replace(/&agrave;/g, 'à')
      .replace(/\s+/g, ' ');

    let available = null;
    let total = null;

    if (product.type === 'pokemonitor') {
      const match = text.match(
        /Negozi con prodotto disponibile:\s*(\d+)\s+su\s+(\d+)/i
      );

      if (match) {
        available = Number(match[1]);
        total = Number(match[2]);
      }
    } else {
      const match = text.match(
        /disponibile in\s+(\d+)\s+negozi?\s+su\s+(\d+)/i
      );

      if (match) {
        available = Number(match[1]);
        total = Number(match[2]);
      }
    }

    if (available === null) {
      console.log('Disponibilità non letta:', product.name);
      return;
    }

    console.log(
      product.name + ': ' + available + ' su ' + total
    );

    const old = previous[product.name];

    if (old === undefined) {
      previous[product.name] = available;
      saveData();

      if (available > 0) {
        await notify(
          '🔔 DISPONIBILITÀ RILEVATA\n\n' +
          product.name +
          '\nNegozi disponibili: ' + available + ' su ' + total +
          '\n\nControlla:\n' + product.url
        );
      }

      return;
    }

    if (available > old) {
      await notify(
        '🚨 POSSIBILE RESTOCK!\n\n' +
        product.name +
        '\nNegozi disponibili: ' + available + ' su ' + total +
        '\n\nCONTROLLA SUBITO:\n' + product.url
      );
    }

    previous[product.name] = available;
    saveData();

  } catch (error) {
    console.log('Errore ' + product.name + ':', error.message);
  }
}

let checking = false;

async function checkAll() {
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
  saveData();

  await bot.sendMessage(
    msg.chat.id,
    '🐾 Pokémon UPC Restock Italia attivo!\n\n' +
    'Monitoraggio di 4 pagine:\n' +
    '• Giorno e Notte\n' +
    '• Card Restock Tracker\n' +
    '• Pokemonitor Italia\n\n' +
    'Controllo ogni 5 minuti.\n\n' +
    '/status - stato del bot\n' +
    '/check - controllo immediato'
  );
});

bot.onText(/\/status/, async (msg) => {
  bot.sendMessage(
    msg.chat.id,
    '✅ Bot attivo.\n' +
    'Pagine monitorate: 4\n' +
    'Intervallo: 5 minuti.'
  );
});

bot.onText(/\/check/, async (msg) => {
  await bot.sendMessage(msg.chat.id, '🔎 Controllo in corso...');
  await checkAll();
  await bot.sendMessage(msg.chat.id, '✅ Controllo terminato.');
});

bot.on('polling_error', (error) => {
  console.log('Errore Telegram:', error.message);
});

console.log('🐾 Pokémon UPC Restock Italia avviato');

checkAll();
setInterval(checkAll, 5 * 60 * 1000);
