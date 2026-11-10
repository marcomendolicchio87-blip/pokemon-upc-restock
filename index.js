
'use strict';

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) throw new Error('Variabile TELEGRAM_BOT_TOKEN mancante');

const INTERVAL = 60_000;
const MAX_PRICE = 300;
const TIMEOUT = 18_000;
const DATA_DIR = process.env.DATA_DIR || '.';

fs.mkdirSync(DATA_DIR, { recursive: true });

const SUBSCRIBERS_FILE = path.join(DATA_DIR, 'subscribers.json');
const STATE_FILE = path.join(DATA_DIR, 'offers.json');

const bot = new TelegramBot(TOKEN, { polling: true });

const sources = [
  {
    name: 'Pokémonitor',
    version: 'Giorno',
    kind: 'tracker',
    url: 'https://pokemonitoritalia.com/set/megaevoluzioni/30-anniversario/collezione-ultra-premium-giornata'
  },
  {
    name: 'Pokémonitor',
    version: 'Notte',
    kind: 'tracker',
    url: 'https://pokemonitoritalia.com/set/megaevoluzioni/30-anniversario/collezione-ultra-premium-serata'
  },
  {
    name: 'Card Restock Tracker',
    version: 'Giorno',
    kind: 'tracker',
    url: 'https://cardrestocktracker.com/it/30-anniversario-ultra-premium-collection-versione-giorno-1h6cvz1'
  },
  {
    name: 'Card Restock Tracker',
    version: 'Notte',
    kind: 'tracker',
    url: 'https://cardrestocktracker.com/it/30-anniversario-ultra-premium-collection-versione-notte-bqq9av'
  },
  {
    name: 'TakiCardz',
    version: 'Giorno',
    kind: 'shopify',
    url: 'https://takicardz.it/products/30-anniversario-espeon-ultra-premium-collection'
  },
  {
    name: 'TakiCardz',
    version: 'Notte',
    kind: 'shopify',
    url: 'https://takicardz.it/products/30-anniversario-notte-ultra-premium-collection'
  },
  {
    name: 'Amber Road',
    version: 'Notte',
    kind: 'generic',
    url: 'https://www.amberroadtcg.com/en/shop/collezione-speciale-ultra-premium-30-anniversario/umbreon'
  },
  {
    name: 'Pokechrono',
    version: 'Notte',
    kind: 'generic',
    url: 'https://pokechrono.com/it/negozio/collezione-ultra-premium-umbreon-ex-30-anniversario'
  }
];

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

let subscribers = new Set(readJson(SUBSCRIBERS_FILE, []));
let previousOffers = readJson(STATE_FILE, {});

function saveSubscribers() {
  writeJson(SUBSCRIBERS_FILE, [...subscribers]);
}

function saveOffers() {
  writeJson(STATE_FILE, previousOffers);
}

function normalizeText(value) {
  return String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&euro;|&#8364;/gi, '€')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function parsePrice(value) {
  if (value === undefined || value === null) return null;

  let s = String(value).trim().replace(/[^\d.,]/g, '');
  if (!s) return null;

  if (s.includes(',') && s.includes('.')) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }

  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function money(value) {
  return new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency: 'EUR'
  }).format(value);
}

function matchesVersion(text, version) {
  const t = String(text || '').toLowerCase();

  if (version === 'Giorno') {
    return /espeon|giorno|day|giornata/.test(t) &&
      !/umbreon/.test(t);
  }

  return /umbreon|notte|night|serata/.test(t) &&
    !/espeon/.test(t);
}

function availability(value) {
  const s = String(value || '').toLowerCase();

  if (/outofstock|sold.?out|esaurit|non disponibile/.test(s)) {
    return 'esaurito';
  }

  if (/pre.?order|pre.?sale|preordine|prenotabile/.test(s)) {
    return 'preordine';
  }

  if (/instock|disponibile|available|in stock/.test(s)) {
    return 'disponibile';
  }

  return null;
}

async function fetchPage(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
      'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8'
    },
    signal: AbortSignal.timeout(TIMEOUT),
    redirect: 'follow'
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.text();
}

function collectProducts(data, output = []) {
  if (!data || typeof data !== 'object') return output;

  if (Array.isArray(data)) {
    for (const item of data) collectProducts(item, output);
    return output;
  }

  const types = Array.isArray(data['@type'])
    ? data['@type']
    : [data['@type']];

  if (types.includes('Product')) output.push(data);

  for (const value of Object.values(data)) {
    if (value && typeof value === 'object') {
      collectProducts(value, output);
    }
  }

  return output;
}

function jsonLdOffers(html, source) {
  const products = [];
  const scripts = html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );

  for (const match of scripts) {
    try {
      collectProducts(JSON.parse(match[1]), products);
    } catch {
      // Ignora JSON-LD non valido
    }
  }

  const found = [];

  for (const product of products) {
    if (!matchesVersion(product.name, source.version)) continue;

    const offers = Array.isArray(product.offers)
      ? product.offers
      : [product.offers];

    for (const offer of offers) {
      if (!offer) continue;

      const currency = String(offer.priceCurrency || 'EUR').toUpperCase();
      if (currency !== 'EUR') continue;

      const price = parsePrice(offer.price || offer.lowPrice);
      const status = availability(offer.availability);

      if (!price || !status || status === 'esaurito') continue;

      found.push({
        shop: source.name,
        version: source.version,
        price,
        status,
        url: source.url,
        shipping: 'Da verificare al checkout'
      });
    }
  }

  return found;
}

async function shopifyOffers(source) {
  const parsed = new URL(source.url);
  const match = parsed.pathname.match(/\/products\/([^/]+)/);

  if (!match) return [];

  const endpoint =
    `${parsed.origin}/products/${match[1]}.js`;

  const response = await fetch(endpoint, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(TIMEOUT)
  });

  if (!response.ok) {
    throw new Error(`Shopify HTTP ${response.status}`);
  }

  const product = await response.json();

  if (!matchesVersion(product.title, source.version)) return [];

  const results = [];

  for (const variant of product.variants || []) {
    if (!variant.available) continue;

    const price = Number(variant.price) / 100;
    if (!Number.isFinite(price) || price <= 0) continue;

    results.push({
      shop: source.name,
      version: source.version,
      price,
      status: 'disponibile',
      url: source.url,
      shipping: 'Da verificare al checkout'
    });
  }

  return results;
}

/*
 * Tracker: lettura prudente.
 * Cerca link esterni accompagnati da prezzo e disponibilità
 * nel testo vicino al link. Se i dati non sono chiari,
 * non genera notifiche.
 */
function trackerOffers(html, source) {
  const results = [];
  const anchors = html.matchAll(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  );

  const plain = normalizeText(html);
  const pageAvailability = availability(plain);

  for (const match of anchors) {
    let productUrl;

    try {
      productUrl = new URL(match[1], source.url);
    } catch {
      continue;
    }

    if (!['http:', 'https:'].includes(productUrl.protocol)) continue;

    const trackerHost = new URL(source.url).hostname;
    if (productUrl.hostname === trackerHost) continue;

    const index = match.index || 0;
    const context = normalizeText(
      html.slice(Math.max(0, index - 700), index + 1400)
    );

    if (!matchesVersion(context, source.version)) continue;

    const priceMatches = [
      ...context.matchAll(/(?:€\s*)?(\d{1,4}(?:[.,]\d{2})?)\s*€/g)
    ];

    if (!priceMatches.length) continue;

    const price = parsePrice(priceMatches[0][1]);
    if (!price) continue;

    const status = availability(context) || pageAvailability;
    if (!status || status === 'esaurito') continue;

    results.push({
      shop: productUrl.hostname.replace(/^www\./, ''),
      version: source.version,
      price,
      status,
      url: productUrl.href,
      shipping: 'Da verificare al checkout'
    });
  }

  return results;
}

async function getOffers(source) {
  const html = await fetchPage(source.url);

  if (source.kind === 'shopify') {
    return shopifyOffers(source);
  }

  const structured = jsonLdOffers(html, source);

  if (structured.length) return structured;

  if (source.kind === 'tracker') {
    return trackerOffers(html, source);
  }

  return [];
}

function makeKey(offer) {
  return [
    offer.version,
    offer.shop.toLowerCase(),
    offer.url
  ].join('|');
}

function offerSignature(offer) {
  return `${offer.status}|${offer.price.toFixed(2)}`;
}

async function sendOffer(offer) {
  const message = [
    '🎯 *POKÉMON UPC 30° ANNIVERSARIO*',
    '',
    `📦 Versione: *${offer.version}*`,
    `🏪 Negozio: *${offer.shop}*`,
    `💶 Prezzo: *${money(offer.price)}*`,
    `📌 Stato: *${offer.status}*`,
    `🚚 Spedizione Italia: ${offer.shipping}`,
    '',
    `🔗 ${offer.url}`,
    '',
    'Controlla subito disponibilità e condizioni sul sito.'
  ].join('\n');

  let delivered = 0;

  for (const chatId of subscribers) {
    try {
      await bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: false
      });
      delivered++;
    } catch (error) {
      console.error(`Invio Telegram fallito per ${chatId}:`, error.message);

      if (
        error.response &&
        [403, 400].includes(error.response.statusCode)
      ) {
        subscribers.delete(chatId);
        saveSubscribers();
      }
    }
  }

  return delivered > 0;
}

async function processOffer(offer) {
  if (!offer.price || offer.price > MAX_PRICE) return;
  if (!offer.url || !/^https?:\/\//i.test(offer.url)) return;
  if (!['disponibile', 'preordine'].includes(offer.status)) return;

  const key = makeKey(offer);
  const signature = offerSignature(offer);

  if (previousOffers[key] === signature) return;

  const delivered = await sendOffer(offer);

  if (delivered) {
    previousOffers[key] = signature;
    saveOffers();
    console.log('Notifica inviata:', key, signature);
  }
}

let running = false;

async function checkAll() {
  if (running) return;
  running = true;

  console.log('Controllo fonti:', new Date().toISOString());

  try {
    for (const source of sources) {
      try {
        const offers = await getOffers(source);

        console.log(
          `${source.name} ${source.version}: ${offers.length} offerte rilevate`
        );

        for (const offer of offers) {
          await processOffer(offer);
        }
      } catch (error) {
        console.error(
          `Errore ${source.name} ${source.version}:`,
          error.message
        );
      }
    }
  } finally {
    running = false;
  }
}

bot.onText(/^\/start$/, async msg => {
  const id = String(msg.chat.id);
  subscribers.add(id);
  saveSubscribers();

  await bot.sendMessage(
    id,
    '✅ *Bot Pokémon UPC attivato!*\n\n' +
    'Riceverai avvisi per Giorno (Espeon) e Notte (Umbreon), ' +
    'con prezzo massimo di 300 € per box.\n\n' +
    'Controllo automatico ogni 60 secondi.\n\n' +
    '/check - Controlla subito\n' +
    '/status - Stato del monitoraggio',
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/^\/status$/, async msg => {
  const id = String(msg.chat.id);

  await bot.sendMessage(
    id,
    `Monitoraggio attivo.\n` +
    `Fonti configurate: ${sources.length}\n` +
    `Intervallo: 60 secondi\n` +
    `Prezzo massimo: ${MAX_PRICE} €\n` +
    `Iscritti: ${subscribers.size}\n` +
    `Versioni: Giorno e Notte`
  );
});

bot.onText(/^\/check$/, async msg => {
  const id = String(msg.chat.id);

  await bot.sendMessage(id, '🔎 Avvio controllo manuale...');

  await checkAll();

  await bot.sendMessage(id, '✅ Controllo terminato. Se non sono arrivate offerte, non ne sono state rilevate di verificabili sotto 300 €.');
});

bot.on('polling_error', error => {
  console.error('Errore Telegram polling:', error.message);
});

bot.on('error', error => {
  console.error('Errore bot:', error.message);
});

console.log('Bot Pokémon UPC avviato.');
console.log(`Fonti configurate: ${sources.length}`);
console.log('Intervallo di controllo: 60 secondi.');

checkAll();

setInterval(() => {
  checkAll();
}, INTERVAL);
