'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const TOKEN=process.env.TELEGRAM_BOT_TOKEN;
const ROOT=process.env.DATA_DIR||'.', STATE=path.join(ROOT,'pokemon-state.json');
const INTERVAL=Math.max(30000,Number(process.env.CHECK_INTERVAL_MS)||60000);
const REARM_MISSING_CHECKS=Math.max(2,Number(process.env.REARM_MISSING_CHECKS)||3);
const CONCURRENCY=Math.max(1,Math.min(8,Number(process.env.SOURCE_CONCURRENCY)||4));
const REQUEST_TIMEOUT=Math.max(3000,Math.min(30000,Number(process.env.REQUEST_TIMEOUT_MS)||10000));
const MAX_BOX=Number(process.env.MAX_BOX_EUR)||300, MAX_PAIR=Number(process.env.MAX_PAIR_EUR)||600;
const SOURCES=JSON.parse(fs.readFileSync(path.join(__dirname,'sources.json'),'utf8'));
if(!Array.isArray(SOURCES)||!SOURCES.every(s=>s.name&&/^https:\/\//.test(s.url)&&['shop','tracker','ebay_api','manual'].includes(s.type)&&['giorno','notte','pair'].includes(s.variant)))throw Error('sources.json non valido');
const SOURCE_ALERT_HOURS=Math.max(1,Number(process.env.SOURCE_ALERT_HOURS)||12);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const log=(...v)=>console.log(new Date().toISOString(),...v);
const empty=()=>({chats:[],offset:0,sent:{},health:{},last:null,failures:{},lastHealthAlert:0,missing:{}});
let state;try{state={...empty(),...JSON.parse(fs.readFileSync(STATE,'utf8'))}}catch{state=empty()}
function save(){try{fs.mkdirSync(ROOT,{recursive:true});const t=STATE+'.tmp';fs.writeFileSync(t,JSON.stringify(state));fs.renameSync(t,STATE)}catch(e){log('STATE SAVE FAILED',e.message)}}
function price(v){if(typeof v==='number')return Number.isFinite(v)?v:null;let s=String(v??'').replace(/[^\d.,]/g,'');if(!s)return null;if(s.includes('.')&&s.includes(','))s=s.lastIndexOf(',')>s.lastIndexOf('.')?s.replace(/\./g,'').replace(',','.'):s.replace(/,/g,'');else if(s.includes(','))s=s.replace(',','.');else if(/^\d{1,3}\.\d{3}$/.test(s))s=s.replace('.','');const n=Number(s);return Number.isFinite(n)?n:null}
function variant(t){t=String(t||'').toLowerCase();const day=/espeon|giorn(?:o|ata)|daytime/.test(t),night=/umbreon|nott(?:e|urna)|serata|night/.test(t);return day&&!night?'giorno':night&&!day?'notte':day&&night?'pair':null}
function relevant(t,v){return variant(t)===v&&/(ultra[\s-]*premium|\bupc\b)/i.test(t)&&/(30|anniversario|anniversary)/i.test(t)}
function availability(v){v=String(v||'').toLowerCase();if(/outofstock|soldout|discontinued|esaurit|non.disponib|unavailable/.test(v))return 'out';if(/preorder|pre-order|preordine|presale/.test(v))return 'preorder';if(/instock|in.stock|limitedavailability/.test(v))return 'available';return 'unknown'}
function url(h,b){try{const u=new URL(h,b);if(u.protocol!=='https:')return null;if(u.username||u.password||u.port)return null;const host=u.hostname.toLowerCase();if(!host.includes('.')||host==='localhost'||/^(?:127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)||host.endsWith('.local'))return null;return u.href}catch{return null}}
function jsonLd(html){const a=[];for(const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){try{const raw=JSON.parse(m[1]);function walk(x){if(!x||typeof x!=='object')return;if(Array.isArray(x))return x.forEach(walk);if([].concat(x['@type']||[]).some(t=>String(t).toLowerCase()==='product'))a.push(x);if(x['@graph'])walk(x['@graph']);if(x.mainEntity)walk(x.mainEntity);if(x.itemListElement)walk(x.itemListElement)}walk(raw)}catch{}}return a}
function structured(html,s,base){const a=[];for(const p of jsonLd(html)){if(!relevant(p.name,s.variant))continue;for(const o of Array.isArray(p.offers)?p.offers:[p.offers]){if(!o||typeof o!=='object'||String(o['@type']||'').toLowerCase().includes('aggregateoffer'))continue;const n=price(o.price??o.lowPrice),st=availability(o.availability),cur=String(o.priceCurrency||'').toUpperCase();const direct=url(o.url||p.url||base,base);if(n>0&&cur==='EUR'&&st!=='unknown'&&st!=='out'&&direct&&!isSearch(direct))a.push({name:s.name,variant:s.variant,price:n,status:st,url:direct,proof:'JSON-LD',shipping:'non verificata'})}}return a}
async function fetchPage(u){const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),REQUEST_TIMEOUT);try{const r=await fetch(u,{headers:{'user-agent':'Mozilla/5.0 PokemonUPCMonitor/4.0','accept':'text/html,application/json'},signal:ac.signal});if(!r.ok)throw Error('HTTP '+r.status);if(Number(r.headers.get('content-length')||0)>3000000)throw Error('Pagina troppo grande');const body=await r.text();if(body.length>3000000)throw Error('Pagina troppo grande');return {body,url:r.url}}finally{clearTimeout(timer)}}
async function shopify(s,base){const u=new URL(base),m=u.pathname.match(/\/products\/([^/?#]+)/);if(!m)return [];let p;try{p=JSON.parse((await fetchPage(`${u.origin}/products/${m[1]}.js`)).body)}catch{return []}if(!relevant(p.title,s.variant)||!Array.isArray(p.variants))return [];const good=p.variants.filter(x=>x.available===true&&Number.isFinite(Number(x.price))&&Number(x.price)>0&&(!variant(x.title)||variant(x.title)===s.variant));if(!good.length)return [];return [{name:s.name,variant:s.variant,price:Math.min(...good.map(x=>Number(x.price)/100)),status:'available',url:base,proof:'Shopify available=true',shipping:'non verificata'}]}
function decodeHtml(t){return String(t||'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#(?:39|x27);/gi,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>')}
function links(html,base){
  const out=[],seen=new Set();
  const trackerHost=new URL(base).hostname.replace(/^www\./,'');
  for(const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){
    const label=decodeHtml(m[2].replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim());
    let target=url(decodeHtml(m[1]),base);if(!target)continue;
    // Follow ordinary redirect query parameters without accessing an unknown redirect service.
    for(let i=0;i<2;i++){
      try{const u=new URL(target);const wrapped=['url','target','redirect','redirect_url','dest','destination','to','u'].map(k=>u.searchParams.get(k)).find(v=>v&&/^https?:\/\//i.test(v));if(!wrapped)break;target=url(wrapped,base)||target}catch{break}
    }
    const u=new URL(target);if(u.hostname.replace(/^www\./,'')===trackerHost)continue;
    if(isSearch(target)||/(^|\.)(?:t\.me|wa\.me|facebook\.com|instagram\.com|youtube\.com|google\.com|twitter\.com|x\.com|discord\.com)$/i.test(u.hostname))continue;
    if(!seen.has(target)){seen.add(target);out.push({label,url:target})}
  }
  return out;
}
function isSearch(u){try{const x=new URL(u);return /(^|\.)(amazon\.|ebay\.|cardmarket\.)/.test(x.hostname)&&(/\/sch\/|\/search|\/s\b/.test(x.pathname)||x.searchParams.has('k'))}catch{return true}}
// Pokémonitor often displays store availability but locks the outgoing "Acquista ora"
// links behind authentication. Read its public overview for diagnostics only;
// NEVER turn a tracker price into a purchasable offer.
function pokemonitorOverview(html){
  const text=decodeHtml(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' '));
  const offersHeading=/Offerte dei negozi|Negozi con il prodotto/i.test(text);
  const count=(text.match(/Negozi con il prodotto\s*(\d+)\s*su\s*(\d+)/i)||[]);
  const min=(text.match(/Prezzo minimo disponibile\s*€\s*([\d.,]+)/i)||[]);
  const soldOut=/(?:Non disponibile|Negozi con il prodotto\s*0\s*su)/i.test(text);
  return {readable:offersHeading,availableCount:count[1]?Number(count[1]):null,totalCount:count[2]?Number(count[2]):null,minAvailablePrice:min[1]?price(min[1]):null,soldOut};
}
// Public store names are leads, not purchase links. Only match known direct
// product URLs already configured in sources.json; never guess a product slug.
const STORE_ALIASES={magicnerd:['magicnerd'],cardgameclub:['cardgameclub'],takicardz:['takicardz'],pokechrono:['pokechrono']};
function storeKey(name){const compact=String(name||'').toLowerCase().replace(/[^a-z0-9]/g,'');return Object.keys(STORE_ALIASES).find(k=>STORE_ALIASES[k].includes(compact))||null}
function pokemonitorLeads(html,which){
 const text=decodeHtml(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' '));
 const known=['MagicNerd','CardGameClub','TakiCardz','Pokechrono'];
 const leads=[];
 for(const store of known){
  const re=new RegExp('(?:^|\\s)'+store+'\\s+(Disponibile|Esaurito|Non disponibile)\\b','gi');
  let m;while((m=re.exec(text))){
   const window=text.slice(m.index,m.index+250);
   const eur=window.match(/€\s*([\d.,]+)/);
   leads.push({store,status:/^disponibile$/i.test(m[1])?'available':'out',price:eur?price(eur[1]):null,variant:which});
  }
 }
 return leads;
}
async function verifyPokemonitorLeads(html,tracker){
 const leads=pokemonitorLeads(html,tracker.variant);
 const eligible=leads.filter(l=>l.status==='available'&&l.price!==null&&l.price>0&&l.price<=(l.variant==='pair'?MAX_PAIR:MAX_BOX));
 const matched=[];for(const l of eligible){
  const direct=SOURCES.find(x=>x.type==='shop'&&x.variant===l.variant&&storeKey(x.name.split(' ')[0])===storeKey(l.store));
  if(direct&&!matched.some(x=>x.url===direct.url))matched.push(direct);
 }
 const offers=[];let checked=0,blocked=0;
 await parallel(matched,Math.min(3,CONCURRENCY),async direct=>{
  try{const page=await fetchPage(direct.url);checked++;offers.push(...structured(page.body,direct,page.url),...await shopify(direct,page.url))}
  catch(e){blocked++;log('POKEMONITOR SHOP VERIFY FAILED',direct.name,e.message)}
 });
 return {leads,eligible:eligible.length,matched:matched.length,checked,blocked,offers};
}
let ebayTokenCache={token:null,until:0};
async function ebayToken(){
 if(ebayTokenCache.token&&Date.now()<ebayTokenCache.until)return ebayTokenCache.token;
 const id=process.env.EBAY_CLIENT_ID,secret=process.env.EBAY_CLIENT_SECRET;
 if(!id||!secret)throw Error('API eBay non configurata: richiede EBAY_CLIENT_ID e EBAY_CLIENT_SECRET');
 const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),REQUEST_TIMEOUT);
 try{const r=await fetch('https://api.ebay.com/identity/v1/oauth2/token',{method:'POST',headers:{authorization:'Basic '+Buffer.from(id+':'+secret).toString('base64'),'content-type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',signal:ac.signal});if(!r.ok)throw Error('eBay OAuth HTTP '+r.status);const j=await r.json();if(!j.access_token)throw Error('eBay OAuth senza token');ebayTokenCache={token:j.access_token,until:Date.now()+Math.max(60000,(j.expires_in||7200)*1000-120000)};return j.access_token}finally{clearTimeout(timer)}
}
function ebayOffers(items,s){const out=[];for(const x of items||[]){
 const title=String(x.title||'');if(!relevant(title,s.variant))continue;
 if(/lotto vuoto|box vuot|empty|solo carta|single card|proxy|custom|digital|replica|riproduzion|apert[oa]|usato|loose|pack only|booster singol/i.test(title))continue;
 if(!/sigillat|sealed|nuov|new|preordin|pre-order|preorder/i.test(title))continue;
 if(x.buyingOptions&&!x.buyingOptions.includes('FIXED_PRICE'))continue;
 const n=price(x.price?.value),cur=x.price?.currency,link=url(x.itemWebUrl||'', 'https://www.ebay.it');
 if(!n||cur!=='EUR'||!link||!/^https:\/\/(?:www\.)?ebay\.(?:it|com)\//i.test(link))continue;
 if(x.conditionId&&String(x.conditionId)!=='1000'&&!/new|nuov/i.test(x.condition||''))continue;
 if(x.shippingOptions?.length){const costs=x.shippingOptions.map(z=>price(z.shippingCost?.value)).filter(z=>z!==null);if(costs.length&&n+Math.min(...costs)>(s.variant==='pair'?MAX_PAIR:MAX_BOX))continue}
 if(n>(s.variant==='pair'?MAX_PAIR:MAX_BOX))continue;
 out.push({name:s.name,variant:s.variant,price:n,status:/preordin|pre-order|preorder/i.test(title)?'preorder':'available',url:link,proof:'eBay Browse API: prezzo e annuncio attivo; verifica confezione e spedizione',shipping:'da verificare al checkout'});
 }return out}
async function ebayInspect(s){const token=await ebayToken();const q=s.variant==='giorno'?'pokemon 30 anniversario ultra premium espeon':s.variant==='notte'?'pokemon 30 anniversario ultra premium umbreon':'pokemon 30 anniversario ultra premium espeon umbreon';const endpoint=new URL('https://api.ebay.com/buy/browse/v1/item_summary/search');endpoint.searchParams.set('q',q);endpoint.searchParams.set('limit','50');endpoint.searchParams.set('filter','buyingOptions:{FIXED_PRICE},priceCurrency:EUR');const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),REQUEST_TIMEOUT);try{const r=await fetch(endpoint,{headers:{authorization:'Bearer '+token,'x-ebay-c-marketplace-id':'EBAY_IT','accept-language':'it-IT','accept':'application/json'},signal:ac.signal});if(!r.ok)throw Error('eBay Browse API HTTP '+r.status);const j=await r.json();const offers=ebayOffers(j.itemSummaries||[],s);return {offers,note:`eBay API: ${(j.itemSummaries||[]).length} annunci esaminati, ${offers.length} candidati entro budget (spese da verificare)`}}finally{clearTimeout(timer)}}
async function inspect(s){if(s.type==='manual')return {offers:[],coverage:'manual',note:'solo ricerca manuale: monitoraggio automatico non disponibile'};if(s.type==='ebay_api')return ebayInspect(s);const page=await fetchPage(s.url);if(s.type==='shop')return {offers:[...structured(page.body,s,page.url),...await shopify(s,page.url)],note:'pagina prodotto raggiungibile (stock da verificare)'};
if(new URL(s.url).hostname.replace(/^www\./,'')==='pokemonitoritalia.com'){
 const overview=pokemonitorOverview(page.body);
 const recovery=await verifyPokemonitorLeads(page.body,s);
 const note=`elenco pubblico: ${overview.readable?'letto':'non interpretabile'}; ${recovery.leads.length} negozi noti riconosciuti, ${recovery.eligible} segnalazioni entro budget e disponibili, ${recovery.matched} URL diretti già noti, ${recovery.checked} negozi verificati, ${recovery.blocked} bloccati; ${recovery.offers.length} offerte confermate sul negozio`;
 return {offers:recovery.offers,candidates:recovery.matched,verified:recovery.offers.length,inspected:recovery.checked,blocked:recovery.blocked,overview,coverage:recovery.offers.length?'verified-offers':'tracker-data-only',note};
}

// Tracker discovery only: tracker text never proves stock. Follow direct product pages only.
const candidates=links(page.body,page.url).filter(x=>{
  try{const u=new URL(x.url);return u.protocol==='https:'&&!isSearch(x.url)}catch{return false}
}).sort((a,b)=>{const score=x=>(/compra|acquista|buy|shop|negozio/i.test(x.label)?10:0)+(/\/products?\/|\/prodotto\/|\/shop\//i.test(x.url)?5:0);return score(b)-score(a)});
const offers=[];let verified=0,blocked=0,inspected=0;
await parallel(candidates.slice(0,24),Math.min(CONCURRENCY,4),async c=>{
  try{
    const dest={...s,name:new URL(c.url).hostname,type:'shop'};
    const p=await fetchPage(c.url);inspected++;
    const found=[...structured(p.body,dest,p.url),...await shopify(dest,p.url)];
    if(found.length)verified++;
    offers.push(...found);
  }catch(e){blocked++;log('TRACKER LINK FAILED',s.name,c.url,e.message)}
});
return {offers,candidates:candidates.length,verified,inspected,blocked,note:`${candidates.length} link esterni, ${inspected} pagine lette, ${verified} offerte verificate, ${blocked} bloccate${candidates.length>24?' (max 24 per ciclo)':''}`}


}
function unique(offers){const map=new Map();for(const o of offers){if(o.price<=0||o.price>(o.variant==='pair'?MAX_PAIR:MAX_BOX))continue;const cleanUrl=new URL(o.url);cleanUrl.hash='';if(cleanUrl.pathname.length>1)cleanUrl.pathname=cleanUrl.pathname.replace(/\/$/,'');for(const q of [...cleanUrl.searchParams.keys()])if(/^(utm_|fbclid|gclid|mc_cid|mc_eid)/i.test(q))cleanUrl.searchParams.delete(q);const key=crypto.createHash('sha256').update([o.variant,cleanUrl.toString(),o.status].join('|')).digest('hex');map.set(key,{...o,key})}return [...map.values()]}
async function api(method,data={}){const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),35000);try{const r=await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data),signal:ac.signal});const j=await r.json();if(!j.ok)throw Error(`${j.error_code}: ${j.description}`);return j.result}finally{clearTimeout(timer)}}
async function send(chat,msg){
  for(let attempt=0;attempt<3;attempt++){
    try{await api('sendMessage',{chat_id:chat,text:msg,disable_web_page_preview:true});return true}
    catch(e){
      log('TELEGRAM SEND ERROR',chat,`attempt=${attempt+1}`,e.message);
      if(attempt===2||!/429|500|502|503|504|fetch failed|abort|timeout/i.test(e.message))return false;
      await sleep((attempt+1)*1200);
    }
  }
  return false;
}
let checking=false;
async function parallel(items,limit,fn){
  let next=0;const results=new Array(items.length);
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    while(next<items.length){const i=next++;results[i]=await fn(items[i],i)}
  }));
  return results;
}
async function check(){if(checking)return 'Controllo già in corso';checking=true;const offers=[];let errors=0;try{await parallel(SOURCES,CONCURRENCY,async s=>{
  try{
    const r=await inspect(s);
    state.health[s.name]={ok:true,coverage:s.type==='manual'?'manual':s.type==='ebay_api'?'api':s.type==='tracker'?(r.coverage||(r.verified>0?'verified-offers':r.candidates>0?'links-unverified':'no-links')):'shop',note:r.note,offers:r.offers.length,at:new Date().toISOString()};
    offers.push(...r.offers);
    log('SOURCE OK',s.name,r.note,'offers='+r.offers.length);
  }catch(e){
    errors++;
    state.health[s.name]={ok:false,note:e.message,at:new Date().toISOString()};
    log('SOURCE FAILED',s.name,e.message);
  }
});
const failed=SOURCES.filter(s=>state.health[s.name]&&s.type!=='manual'&&(!state.health[s.name].ok||['no-links','links-unverified','tracker-data-only'].includes(state.health[s.name].coverage)));
const now=Date.now();
if(failed.length&&(!state.lastHealthAlert||now-state.lastHealthAlert>=SOURCE_ALERT_HOURS*3600000)){
  const text='⚠️ MONITORAGGIO PARZIALE: '+failed.length+' fonti senza verifica completa:\n'+failed.map(s=>'• '+s.name+': '+state.health[s.name].note).join('\n')+'\nAltre fonti continuano a essere controllate.';
  const recipients=[...new Set([...state.chats,...(process.env.TELEGRAM_CHAT_ID?[String(process.env.TELEGRAM_CHAT_ID)]:[])])];
  let ok=false;for(const chat of recipients)if(await send(chat,text))ok=true;
  if(ok)state.lastHealthAlert=now;
}
const valid=unique(offers);
// Re-arm only when a directly monitored shop was checked successfully and its
// specific product has been absent for several checks. Never infer absence
// from inaccessible tracker pages or from other unrelated sources.
state.missing ||= {};
const visible=new Set(valid.map(o=>o.key));
for(const sentKey of Object.keys(state.sent)){
  const offerKey=sentKey.slice(0,64);
  if(visible.has(offerKey)){delete state.missing[sentKey];continue}
  const sourceName=state.sentSource?.[sentKey];
  const source=SOURCES.find(x=>x.name===sourceName&&x.type==='shop');
  if(!source||state.health[source.name]?.ok!==true)continue;
  state.missing[sentKey]=(state.missing[sentKey]||0)+1;
  if(state.missing[sentKey]>=REARM_MISSING_CHECKS){delete state.sent[sentKey];delete state.missing[sentKey];delete state.sentSource?.[sentKey]}
}
const chats=[...new Set([...state.chats,...(process.env.TELEGRAM_CHAT_ID?[String(process.env.TELEGRAM_CHAT_ID)]:[])])];let sent=0;for(const o of valid){const message=`🚨 Pokémon UPC 30° Anniversario\n📦 ${o.variant==='giorno'?'Giorno / Espeon':o.variant==='notte'?'Notte / Umbreon':'Coppia Giorno + Notte'}\n🏬 ${o.name}\n💶 ${o.price.toFixed(2)} €\n🟢 ${o.status==='preorder'?'Preordine':'Disponibile'}\n🚚 Spedizione in Italia: ${o.shipping}\n🔗 ${o.url}\n🔍 Fonte: ${o.proof}\n⚠️ Verifica al checkout.`;for(const chat of chats){const k=o.key+':'+chat;if(state.sent[k])continue;if(await send(chat,message)){state.sent[k]=Date.now();state.sentSource ||= {};state.sentSource[k]=o.name;sent++;log('ALERT DELIVERED',o.name,o.variant,o.price,'chat='+chat);save()}}}state.last={at:new Date().toISOString(),sources:SOURCES.length,errors,offers:valid.length,sent};save();log('CHECK COMPLETE',JSON.stringify(state.last));return `${SOURCES.length} fonti configurate (${SOURCES.filter(s=>s.type!=='manual').length} automatiche), ${errors} errori,  ${SOURCES.filter(s=>['no-links','links-unverified','tracker-data-only'].includes(state.health[s.name]?.coverage)).length} tracker senza link d'acquisto verificabile, ${valid.length} offerte VERIFICATE entro budget, ${sent} notifiche inviate`}finally{checking=false}}
async function handle(u){const m=u.message;if(!m?.chat?.id||typeof m.text!=='string')return;const chat=String(m.chat.id),cmd=m.text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();if(cmd==='/start'){if(!state.chats.includes(chat)){state.chats.push(chat);save()}await send(chat,'✅ Iscritto. Comandi: /test /testalert /check /status /sources /health /stop')}else if(cmd==='/test')await send(chat,'✅ Telegram operativo. Questo non prova il rilevamento dei restock.');else if(cmd==='/testalert')await send(chat,'🧪 SIMULAZIONE, NON È UN RESTOCK REALE\n🚨 Pokémon UPC Notte / Umbreon\n🏬 Negozio TEST\n💶 249,90 €\n🟢 Disponibile (simulazione)\n🚚 Italia: non verificata\n🔗 Nessun link di acquisto');else if(cmd==='/health'){const failed=SOURCES.filter(s=>state.health[s.name]&&s.type!=='manual'&&(!state.health[s.name].ok||['no-links','links-unverified','tracker-data-only'].includes(state.health[s.name].coverage)));await send(chat,failed.length?'⚠️ Fonti con copertura limitata o errori:\n'+failed.map(s=>s.name+' — '+state.health[s.name].note).join('\n'):'✅ Nessuna fonte in errore nell’ultimo controllo. Questo non certifica la disponibilità.')}else if(cmd==='/check'){await send(chat,'🔎 Controllo avviato');void check().then(r=>send(chat,r)).catch(e=>log('CHECK COMMAND FAILED',e.message))}else if(cmd==='/status')await send(chat,`🤖 Attivo\n${JSON.stringify(state.last||'Nessun controllo')}\nBudget: ${MAX_BOX} € / scatola, ${MAX_PAIR} € / coppia`);else if(cmd==='/sources'){const lines=SOURCES.map(s=>{const h=state.health[s.name];return `${h?.coverage==='manual'?'🔎':['no-links','links-unverified','tracker-data-only'].includes(h?.coverage)?'⚠️':h?.ok?'✅':h?'❌':'⏳'} ${s.name}: ${h?.note||'non controllata'}\n🔗 ${s.url}`});await send(chat,lines.join('\n'))}else if(cmd==='/stop'){state.chats=state.chats.filter(x=>x!==chat);save();await send(chat,'Notifiche disattivate')}}
async function poll(){while(true){try{const updates=await api('getUpdates',{offset:state.offset,timeout:25,allowed_updates:['message']});for(const u of updates){try{await handle(u)}catch(e){log('COMMAND FAILED',e.message)}state.offset=u.update_id+1;save()}}catch(e){log('POLL ERROR',e.message);await sleep(5000)}}}
async function main(){if(!TOKEN)throw Error('Manca TELEGRAM_BOT_TOKEN');if(!process.env.DATA_DIR)log('WARNING: DATA_DIR non impostato: lo storico potrebbe perdersi dopo un deploy Railway. Configura volume /data e DATA_DIR=/data');await api('deleteWebhook',{drop_pending_updates:false});const me=await api('getMe');log('TELEGRAM AUTH OK',me.username);log('MONITOR STARTED',SOURCES.length,'sources','interval='+INTERVAL,'concurrency='+CONCURRENCY);void poll();setInterval(()=>void check(),INTERVAL);await check()}
if(require.main===module)main().catch(e=>{log('FATAL',e.message);process.exitCode=1});
module.exports={price,variant,relevant,availability,structured,unique,links,isSearch,url,shopify,inspect,pokemonitorOverview,pokemonitorLeads,storeKey,ebayOffers};
