
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_BOT_TOKEN mancante');

const bot = new TelegramBot(token, { polling: true });

const INTERVAL = 2 * 60 * 1000;
const MAX_PRICE = 300;
const TIMEOUT = 18000;

const retailers = [
  {
    shop: 'TakiCardz',
    version: 'Giorno',
    url: 'https://takicardz.it/products/30-anniversario-espeon-ultra-premium-collection',
    shippingToItaly: true
  },
  {
    shop: 'TakiCardz',
    version: 'Notte',
    url: 'https://takicardz.it/products/30-anniversario-notte-ultra-premium-collection',
    shippingToItaly: true
  },
  {
    shop: 'Amber Road',
    version: 'Notte',
    url: 'https://www.amberroadtcg.com/en/shop/collezione-speciale-ultra-premium-30-anniversario/umbreon',
    shippingToItaly: true
  },
  {
    shop: 'Pokechrono',
    version: 'Notte',
    url: 'https://pokechrono.com/it/negozio/collezione-ultra-premium-umbreon-ex-30-anniversario',
    shippingToItaly: true
  }
];

// Questi tracker aiutano a scoprire disponibilità.
// Non sono negozi: non generano da soli notifiche di acquisto.
const trackers = [
  {
    name: 'Pokémonitor Giorno',
    url: 'https://pokemonitoritalia.com/set/megaevoluzioni/30-anniversario/collezione-ultra-premium-giornata'
  },
  {
    name: 'Pokémonitor Notte',
    url: 'https://pokemonitoritalia.com/set/megaevoluzioni/30-anniversario/collezione-ultra-premium-serata'
  },
  {
    name: 'Card Restock Giorno',
    url: 'https://cardrestocktracker.com/it/30-anniversario-ultra-premium-collection-versione-giorno-1h6cvz1'
  },
  {
    name: 'Card Restock Notte',
    url: 'https://cardrestocktracker.com/it/30-anniversario-ultra-premium-collection-versione-notte-bqq9av'
  }
];

const subscribersFile = './subscribers.json';
const stateFile = './offers.json';

let subscribers = new Set();
let sentOffers = new Set();

try {
  if (fs.existsSync(subscribersFile)) {
    subscribers = new Set(
      JSON.parse(fs.readFileSync(subscribersFile, 'utf8'))
    );
  }

  if (fs.existsSync(stateFile)) {
    sentOffers = new Set(
      JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    );
  }
} catch (error) {
  console.log('Errore lettura archivio:', error.message);
}

function saveData() {
  fs.writeFileSync(
    subscribersFile,
    JSON.stringify([...subscribers])
  );

  fs.writeFileSync(
    stateFile,
    JSON.stringify([...sentOffers])
  );
}

async function notify(message) {
  for (const id of subscribers) {
    try {
      await bot.sendMessage(id, message, {
        disable_web_page_preview: false
      });
    } catch (error) {
      console.log('Errore Telegram:', error.message);
    }
  }
}

async function getHtml(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36',
      'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8'
    },
    signal: AbortSignal.timeout(TIMEOUT)
  });

  if (!response.ok) {
    throw new Error('HTTP ' + response.status);
  }

  return await response.text();
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function collectProducts(data, result = []) {
  if (!data) return result;

  if (Array.isArray(data)) {
    for (const item of data) {
      collectProducts(item, result);
    }
    return result;
  }

  if (typeof data !== 'object') return result;

  const type = data['@type'];

  if (
    type === 'Product' ||
    (Array.isArray(type) && type.includes('Product'))
  ) {
    result.push(data);
  }

  if (data['@graph']) {
    collectProducts(data['@graph'], result);
  }

  for (const [key, value] of Object.entries(data)) {
    if (key !== '@graph') {
      if (value && typeof value === 'object') {
        collectProducts(value, result);
      }
    }
  }

  return result;
}

function getAvailability(offer) {
  const value = String(offer.availability || '').toLowerCase();

  return (
    value.includes('instock') ||
    value.includes('preorder') ||
    value.includes('presale')
  );
}

function getOffers(product) {
  let offers = product.offers || [];

  if (!Array.isArray(offers)) {
    offers = [offers];
  }

  return offers.map(offer => {
    const price = Number(
      String(offer.price || offer.lowPrice || '')
        .replace(',', '.')
    );

    return {
      price,
      available: getAvailability(offer),
      currency: offer.priceCurrency || 'EUR'
    };
  }).filter(offer =>
    Number.isFinite(offer.price) &&
    offer.price > 0
  );
}

function getShopifyProductUrl(url) {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/\/products\/([^/]+)/);

  if (!match) return null;

  return (
    parsed.origin +
    '/products/' +
    match[1] +
    '.js'
  );
}

async function readShopify(url) {
  const endpoint = getShopifyProductUrl(url);
  if (!endpoint) return [];

  const response = await fetch(endpoint, {
    headers: {
      'User-Agent': 'Mozilla/5.0'
    },
    signal: AbortSignal.timeout(TIMEOUT)
  });

  if (!response.ok) return [];

  const product = await response.json();

  return (product.variants || [])
    .filter(variant => variant.available)
    .map(variant => ({
      name: product.title,
      price: Number(variant.price) / 100,
      available: true,
      currency: 'EUR',
      url: url
    }));
}

function readJsonLd(html, source) {
  const scripts = [
    ...html.matchAll(
      /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    )
  ];

  const products = [];

  for (const match of scripts) {
    const parsed = parseJson(match[1]);
    if (parsed) collectProducts(parsed, products);
  }

  const results = [];

  for (const product of products) {
    const productName = String(product.name || '');

    const correctVersion =
      source.version === 'Giorno'
        ? /espeon|day|giorno|giornata/i.test(productName)
        : /umbreon|night|notte|serata/i.test(productName);

    if (!correctVersion) continue;

    for (const offer of getOffers(product)) {
      results.push({
        name: productName,
        price: offer.price,
        available: offer.available,
        currency: offer.currency,
        url: source.url
      });
    }
  }

  return results;
}

function euro(value) {
  return value.toFixed(2).replace('.', ',') + ' €';
}

function makeKey(source, offer) {
  return [
    source.shop,
    source.version,
    offer.price.toFixed(2)
  ].join('|');
}

async function checkRetailer(source) {
  try {
    const html = await getHtml(source.url);

    let offers = readJsonLd(html, source);

    // Shopify: secondo metodo di lettura.
    if (offers.length === 0) {
      offers = await readShopify(source.url);
    }

    if (offers.length === 0) {
      console.log(
        'Offerta non interpretata:',
        source.shop,
        source.version
      );
      return;
    }

    for (const offer of offers) {
      console.log(
        source.shop,
        source.version,
        euro(offer.price),
        'disponibile:',
        offer.available
      );

      if (!offer.available) continue;
      if (offer.currency !== 'EUR') continue;
      if (!source.shippingToItaly) continue;
      if (offer.price > MAX_PRICE) continue;

      const key = makeKey(source, offer);

      if (sentOffers.has(key)) continue;

      const message =
        '🚨 POKÉMON UPC TROVATA!\n\n' +
        '📦 Versione: ' + source.version + '\n' +
        '🏪 Negozio: ' + source.shop + '\n' +
        '💶 Prezzo: ' + euro(offer.price) + '\n' +
        '🚚 Spedizione in Italia: dichiarata dal negozio\n\n' +
        '🛒 LINK DIRETTO:\n' + source.url + '\n\n' +
        'Limite impostato: 300 €';

      await notify(message);

      sentOffers.add(key);
      saveData();

      console.log('NOTIFICA INVIATA:', key);
    }

  } catch (error) {
    console.log(
      'Errore ' + source.shop + ' ' + source.version + ':',
      error.message
    );
  }
}

async function checkTracker(tracker) {
  try {
    const html = await getHtml(tracker.url);
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ');

    console.log(
      'Tracker letto:',
      tracker.name,
      text.match(/disponibile.{0,100}/i)?.[0] || 'pagina letta'
    );

  } catch (error) {
    console.log(
      'Errore tracker ' + tracker.name + ':',
      error.message
    );
  }
}

let checking = false;

async function checkAll() {
  if (checking) return;

  checking = true;

  try {
    for (const retailer of retailers) {
      await checkRetailer(retailer);
    }

    for (const tracker of trackers) {
      await checkTracker(tracker);
    }
  } finally {
    checking = false;
  }
}

bot.onText(/\/start/, async msg => {
  subscribers.add(msg.chat.id);
  saveData();

  await bot.sendMessage(
    msg.chat.id,
    '🐾 Pokémon UPC Restock Italia attivo!\n\n' +
    'Controllo ogni 2 minuti.\n' +
    'Giorno ed Espeon: massimo 300 €.\n' +
    'Notte e Umbreon: massimo 300 €.\n' +
    'Notifiche con negozio, prezzo e link diretto.\n\n' +
    '/status - stato\n' +
    '/check - controllo immediato'
  );
});

bot.onText(/\/status/, async msg => {
  await bot.sendMessage(
    msg.chat.id,
    '✅ Bot attivo\n' +
    'Negozi controllati: ' + retailers.length + '\n' +
    'Tracker controllati: ' + trackers.length + '\n' +
    'Intervallo: 2 minuti\n' +
    'Prezzo massimo: 300 € per confezione'
  );
});

bot.onText(/\/check/, async msg => {
  await bot.sendMessage(msg.chat.id, '🔎 Controllo in corso...');
  await checkAll();
  await bot.sendMessage(
    msg.chat.id,
    '✅ Controllo terminato. Per i dettagli guarda i log Railway.'
  );
});

bot.on('polling_error', error => {
  console.log('Errore Telegram:', error.message);
});

console.log('🐾 Pokémon UPC Restock Italia avviato');
console.log('Controllo ogni 2 minuti');

checkAll();
setInterval(checkAll, INTERVAL);
