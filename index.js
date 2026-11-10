'use strict';
// Node.js 18+; no external packages required.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) { console.error('Missing TELEGRAM_BOT_TOKEN'); process.exit(1); }
const API = `https://api.telegram.org/bot${TOKEN}`;
const INTERVAL = Math.max(60000, Number(process.env.CHECK_INTERVAL_MS || 60000));
const MAX_BOX = Number(process.env.MAX_BOX_EUR || 300);
const MAX_PAIR = Number(process.env.MAX_PAIR_EUR || 600);
const DATA_DIR = process.env.DATA_DIR || '.';
const STATE_FILE = path.join(DATA_DIR, 'pokemon-bot-state.json');
const ADMIN_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '');
const LOCK_FILE = path.join(DATA_DIR, '.pokemon-bot.lock');
const USER_AGENT = 'Mozilla/5.0 (compatible; PokemonUPCMonitor/2.0; +personal-monitor)';
const SOURCES = [
  {name:'Pokémonitor Giorno',kind:'tracker',variant:'giorno',url:'https://pokemonitoritalia.com/set/megaevoluzioni/30-anniversario/collezione-ultra-premium-giornata'},
  {name:'Pokémonitor Notte',kind:'tracker',variant:'notte',url:'https://pokemonitoritalia.com/set/megaevoluzioni/30-anniversario/collezione-ultra-premium-serata'},
  {name:'Card Restock Tracker Giorno',kind:'tracker',variant:'giorno',url:'https://cardrestocktracker.com/it/30-anniversario-ultra-premium-collection-versione-giorno-1h6cvz1'},
  {name:'Card Restock Tracker Notte',kind:'tracker',variant:'notte',url:'https://cardrestocktracker.com/it/30-anniversario-ultra-premium-collection-versione-notte-bqq9av'},
  {name:'TakiCardz Giorno',kind:'shop',variant:'giorno',url:'https://takicardz.it/products/30-anniversario-espeon-ultra-premium-collection'},
  {name:'TakiCardz Notte',kind:'shop',variant:'notte',url:'https://takicardz.it/products/30-anniversario-notte-ultra-premium-collection'},
  {name:'Amber Road Notte',kind:'shop',variant:'notte',url:'https://www.amberroadtcg.com/en/shop/collezione-speciale-ultra-premium-30-anniversario/umbreon'},
  {name:'Pokechrono Notte',kind:'shop',variant:'notte',url:'https://pokechrono.com/it/negozio/collezione-ultra-premium-umbreon-ex-30-anniversario'}
];

const sleep = ms => new Promise(r => setTimeout(r,ms));
const log = (...args) => console.log(new Date().toISOString(),...args);
function loadState(){try { const s=JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); return {chats:s.chats||[],sent:s.sent||{},offset:s.offset||0,seen:s.seen||{}}; }catch{return {chats:[],sent:{},offset:0,seen:{}};}}
let state=loadState();
function saveState(){try{fs.mkdirSync(DATA_DIR,{recursive:true});const tmp=STATE_FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(state,null,2));fs.renameSync(tmp,STATE_FILE);}catch(e){log('WARN: state not persisted:',e.message);}}
function htmlDecode(s){return String(s||'').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');}
function stripHtml(s){return htmlDecode(String(s||'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim());}
function parsePrice(value){if(typeof value==='number')return Number.isFinite(value)?value:null;if(value==null)return null;let s=String(value).replace(/[^\d.,]/g,'');if(!s)return null; if(s.includes(',')&&s.includes('.'))s=s.lastIndexOf(',')>s.lastIndexOf('.')?s.replace(/\./g,'').replace(',','.'):s.replace(/,/g,'');else if(s.includes(','))s=s.replace(',','.');else if(/^\d{1,3}\.\d{3}$/.test(s))s=s.replace('.','');const n=Number(s);return Number.isFinite(n)?n:null;}
function normalizeVariant(title){const t=String(title||'').toLowerCase();if(/espeon|giorn(?:o|ata)|day(?:time)?/.test(t))return 'giorno';if(/umbreon|nott(?:e|urna)|serata|night/.test(t))return 'notte';return null;}
function relevant(title,variant){const t=String(title||'').toLowerCase();return normalizeVariant(t)===variant && /(ultra.premium|upc|30.anniversario|30th)/i.test(t);}
function absoluteUrl(href,base){try{const u=new URL(htmlDecode(href),base);return /^https?:$/.test(u.protocol)?u.href:null;}catch{return null;}}
async function fetchText(url){const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),12000);try{const res=await fetch(url,{headers:{'User-Agent':USER_AGENT,'Accept':'text/html,application/json'},signal:ctrl.signal,redirect:'follow'});if(!res.ok)throw Error(`HTTP ${res.status}`);const text=await res.text();if(text.length>3_000_000)throw Error('Response too large');return {text,url:res.url,type:res.headers.get('content-type')||''};}finally{clearTimeout(timer);}}
async function telegram(method,params={}){const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),35000);try{const res=await fetch(`${API}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(params),signal:ctrl.signal});const data=await res.json();if(!data.ok)throw Error(`${data.error_code||res.status}: ${data.description||'Telegram error'}`);return data.result;}finally{clearTimeout(timer);}}
async function send(chat,text){try{await telegram('sendMessage',{chat_id:chat,text,disable_web_page_preview:true});return true;}catch(e){log('TELEGRAM SEND FAILED',chat,e.message);return false;}}
function collectJsonLd(html){const items=[];for(const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){try{const raw=JSON.parse(htmlDecode(m[1]));const walk=(o)=>{if(!o||typeof o!=='object')return;if(Array.isArray(o)){o.forEach(walk);return;}if(o['@type']&&(String(o['@type']).toLowerCase().includes('product')))items.push(o);if(o['@graph'])walk(o['@graph']);};walk(raw);}catch{}}return items;}
function availabilityStatus(raw){const t=String(raw||'').toLowerCase();if(/outofstock|soldout|discontinued|esaurit|non.disponib/.test(t))return 'out';if(/preorder|pre-order|preordine|pre.order/.test(t))return 'preorder';if(/instock|in.stock|limitedavailability|disponibil/.test(t))return 'available';return 'unknown';}
function extractJsonLdOffers(html,source,finalUrl){const result=[];for(const p of collectJsonLd(html)){const title=String(p.name||'');if(!relevant(title,source.variant))continue;const offers=Array.isArray(p.offers)?p.offers:[p.offers];for(const o of offers){if(!o||typeof o!=='object')continue;const price=parsePrice(o.price??o.lowPrice);const currency=String(o.priceCurrency||'EUR').toUpperCase();const status=availabilityStatus(o.availability);if(price===null||currency!=='EUR'||status==='unknown'||status==='out')continue;const direct=absoluteUrl(o.url||p.url||finalUrl,finalUrl);if(!direct)continue;result.push({source:source.name,variant:source.variant,title,price,status,url:direct,shipping:'Da verificare al checkout',evidence:'JSON-LD'});}}return result;}
async function extractShopify(source,finalUrl){let u;try{u=new URL(finalUrl);}catch{return [];}const m=u.pathname.match(/\/products\/([^/?#]+)/);if(!m)return [];const endpoint=`${u.origin}/products/${m[1]}.js`;let data;try{const r=await fetchText(endpoint);data=JSON.parse(r.text);}catch{return [];}if(!relevant(data.title,source.variant))return [];if(!Array.isArray(data.variants))return [];const available=data.variants.filter(v=>v.available===true&&Number.isFinite(Number(v.price)));if(!available.length)return [];const price=Math.min(...available.map(v=>Number(v.price)/100));return [{source:source.name,variant:source.variant,title:data.title,price,status:'available',url:finalUrl,shipping:'Da verificare al checkout',evidence:'Shopify variant available=true'}];}
function discoverTrackerLinks(html,base){const found=[];for(const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){const label=stripHtml(m[2]);const url=absoluteUrl(m[1],base);if(!url||!/^https?:/.test(url))continue;if(/ultra.premium|30.anniversario|espeon|umbreon/i.test(label+' '+url))found.push({label,url});}return found.slice(0,25);}
async function inspectSource(source){const page=await fetchText(source.url);if(source.kind==='tracker'){
  // Tracker links are discovery hints only. Never convert generic tracker text into availability.
  const links=discoverTrackerLinks(page.text,page.url);
  const candidates=links.filter(l=>{try{return new URL(l.url).hostname!==new URL(page.url).hostname;}catch{return false;}}).filter(l=>normalizeVariant(l.label+' '+l.url)===source.variant);
  const offers=[];
  for(const link of candidates.slice(0,5)){
    try{const target={name:`${source.name} → ${new URL(link.url).hostname}`,kind:'shop',variant:source.variant,url:link.url};const page2=await fetchText(link.url);offers.push(...extractJsonLdOffers(page2.text,target,page2.url),...await extractShopify(target,page2.url));}catch(e){log('Tracker candidate error',link.url,e.message);}
  }
  return {offers,details:`${links.length} link trovati, ${candidates.length} candidati esterni`};
}
const offers=[...extractJsonLdOffers(page.text,source,page.url),...await extractShopify(source,page.url)];return {offers,details:`${offers.length} offerte strutturate`};}
function offerKey(o){return crypto.createHash('sha256').update([o.variant,o.url,o.price,o.status].join('|')).digest('hex');}
let checking=false;let lastCheck='mai';let lastSummary='nessun controllo';
async function checkAll({notify=true}={}){if(checking)return 'Controllo già in corso';checking=true;lastCheck=new Date().toISOString();let offers=[],errors=0;try{for(const source of SOURCES){try{const r=await inspectSource(source);log(source.name,r.details,`valide=${r.offers.length}`);offers.push(...r.offers);}catch(e){errors++;log('SOURCE ERROR',source.name,e.message);}}
const dedup=new Map();for(const o of offers){if(o.price<=MAX_BOX&&o.price>0){const key=offerKey(o);dedup.set(key,o);}}
let delivered=0;for(const [key,o] of dedup){const previous=state.sent[key];if(previous)continue;const msg=`🚨 Pokémon UPC 30° anniversario\n📦 ${o.variant==='giorno'?'Giorno / Espeon':'Notte / Umbreon'}\n🏬 ${o.source}\n💶 ${o.price.toFixed(2)} € (limite ${MAX_BOX} €)\n🟢 ${o.status==='preorder'?'Preordine':'Disponibile'}\n🚚 Spedizione in Italia: ${o.shipping}\n🔗 ${o.url}\n🔎 Verifica: ${o.evidence}\n⚠️ Controlla disponibilità e spedizione prima di acquistare.`;
const chats=[...new Set([...state.chats,...(ADMIN_CHAT_ID?[ADMIN_CHAT_ID]:[])])];if(!chats.length){log('NO SUBSCRIBERS: send /start to bot or set TELEGRAM_CHAT_ID');continue;}let allSent=true;for(const chat of chats){if(await send(chat,msg))delivered++;else allSent=false;}if(allSent){state.sent[key]=new Date().toISOString();saveState();}}
lastSummary=`${SOURCES.length} fonti, ${errors} errori, ${dedup.size} offerte entro ${MAX_BOX} €, ${delivered} messaggi inviati`;
log('CHECK COMPLETE',lastSummary);return lastSummary;
}finally{checking=false;}}
async function handleUpdate(update){const msg=update.message;if(!msg?.chat?.id||typeof msg.text!=='string')return;const chat=String(msg.chat.id);const cmd=msg.text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();if(cmd==='/start'){if(!state.chats.includes(chat)){state.chats.push(chat);saveState();}await send(chat,'✅ Iscritto agli avvisi Pokémon UPC. Controllo ogni 60 secondi. Comandi: /test /status /check /stop.');}else if(cmd==='/test'){await send(chat,'✅ Messaggio di prova Telegram ricevuto. Questo verifica Telegram, non la disponibilità dei prodotti.');}else if(cmd==='/status'){await send(chat,`🤖 Bot attivo\nUltimo controllo: ${lastCheck}\n${lastSummary}\nLimite: ${MAX_BOX} € a scatola; ${MAX_PAIR} € per coppia.\nIscritti: ${state.chats.length}`);}else if(cmd==='/check'){await send(chat,'🔎 Controllo avviato.');const result=await checkAll();await send(chat,`Controllo concluso: ${result}`);}else if(cmd==='/stop'){state.chats=state.chats.filter(x=>x!==chat);saveState();await send(chat,'Notifiche disattivate. /start per riattivarle.');}}
async function pollingLoop(){while(true){try{const updates=await telegram('getUpdates',{offset:state.offset,timeout:25,allowed_updates:['message']});for(const update of updates){try{await handleUpdate(update);}catch(e){log('UPDATE ERROR',e.message);}state.offset=update.update_id+1;saveState();}}catch(e){log('TELEGRAM POLLING ERROR',e.message);if(/409/.test(e.message))log('CONFLICT 409: another instance is polling this token. Stop the other instance; deleteWebhook cannot fix concurrent polling.');await sleep(5000);}}}
async function main(){try{fs.mkdirSync(DATA_DIR,{recursive:true});}catch{};if(ADMIN_CHAT_ID&&!state.chats.includes(ADMIN_CHAT_ID)){state.chats.push(ADMIN_CHAT_ID);saveState();}try{await telegram('deleteWebhook',{drop_pending_updates:false});log('Webhook cleared');}catch(e){log('Webhook warning',e.message);}try{const me=await telegram('getMe');log('TELEGRAM AUTH OK',me.username);}catch(e){log('TELEGRAM AUTH FAILED',e.message);process.exit(1);}log(`MONITOR STARTED: ${SOURCES.length} sources, interval=${INTERVAL}ms, max=${MAX_BOX}€`);void pollingLoop();await checkAll();setInterval(()=>{void checkAll();},INTERVAL);}
main().catch(e=>{log('FATAL',e.stack||e.message);process.exit(1);});
