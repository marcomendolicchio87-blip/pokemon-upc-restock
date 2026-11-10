'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const TOKEN=process.env.TELEGRAM_BOT_TOKEN;
const ROOT=process.env.DATA_DIR||'.', STATE=path.join(ROOT,'pokemon-state.json');
const INTERVAL=Math.max(30000,Number(process.env.CHECK_INTERVAL_MS)||30000);
const CONCURRENCY=Math.max(1,Math.min(8,Number(process.env.SOURCE_CONCURRENCY)||4));
const REQUEST_TIMEOUT=Math.max(3000,Math.min(30000,Number(process.env.REQUEST_TIMEOUT_MS)||10000));
const MAX_BOX=Number(process.env.MAX_BOX_EUR)||300, MAX_PAIR=Number(process.env.MAX_PAIR_EUR)||600;
const SOURCES=JSON.parse(fs.readFileSync(path.join(__dirname,'sources.json'),'utf8'));
if(!Array.isArray(SOURCES)||!SOURCES.every(s=>s.name&&/^https:\/\//.test(s.url)&&['shop','tracker'].includes(s.type)&&['giorno','notte','pair'].includes(s.variant)))throw Error('sources.json non valido');
const SOURCE_ALERT_HOURS=Math.max(1,Number(process.env.SOURCE_ALERT_HOURS)||12);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const log=(...v)=>console.log(new Date().toISOString(),...v);
const empty=()=>({chats:[],offset:0,sent:{},health:{},last:null,failures:{},lastHealthAlert:0,missing:{}});
let state;try{state={...empty(),...JSON.parse(fs.readFileSync(STATE,'utf8'))}}catch{state=empty()}
function save(){try{fs.mkdirSync(ROOT,{recursive:true});const t=STATE+'.tmp';fs.writeFileSync(t,JSON.stringify(state));fs.renameSync(t,STATE)}catch(e){log('STATE SAVE FAILED',e.message)}}
function price(v){if(typeof v==='number')return Number.isFinite(v)?v:null;let s=String(v??'').replace(/[^\d.,]/g,'');if(!s)return null;if(s.includes('.')&&s.includes(','))s=s.lastIndexOf(',')>s.lastIndexOf('.')?s.replace(/\./g,'').replace(',','.'):s.replace(/,/g,'');else if(s.includes(','))s=s.replace(',','.');else if(/^\d{1,3}\.\d{3}$/.test(s))s=s.replace('.','');const n=Number(s);return Number.isFinite(n)?n:null}
function variant(t){t=String(t||'').toLowerCase();const day=/espeon|giorn(?:o|ata)|daytime/.test(t),night=/umbreon|nott(?:e|urna)|serata|night/.test(t);return day&&!night?'giorno':night&&!day?'notte':day&&night?'pair':null}
function relevant(t,v){return variant(t)===v&&/(ultra[\s-]*premium|\bupc\b)/i.test(t)&&/(30|anniversario|anniversary)/i.test(t)}
function availability(v){v=String(v||'').toLowerCase();if(/outofstock|soldout|discontinued|esaurit|non.disponib/.test(v))return 'out';if(/preorder|pre-order|preordine/.test(v))return 'preorder';if(/instock|in.stock|limitedavailability/.test(v))return 'available';return 'unknown'}
function url(h,b){try{const u=new URL(h,b);return ['http:','https:'].includes(u.protocol)?u.href:null}catch{return null}}
function jsonLd(html){const a=[];for(const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){try{const raw=JSON.parse(m[1]);function walk(x){if(!x||typeof x!=='object')return;if(Array.isArray(x))return x.forEach(walk);if([].concat(x['@type']||[]).some(t=>String(t).toLowerCase()==='product'))a.push(x);if(x['@graph'])walk(x['@graph']);if(x.mainEntity)walk(x.mainEntity)}walk(raw)}catch{}}return a}
function structured(html,s,base){const a=[];for(const p of jsonLd(html)){if(!relevant(p.name,s.variant))continue;for(const o of Array.isArray(p.offers)?p.offers:[p.offers]){if(!o||typeof o!=='object'||String(o['@type']||'').toLowerCase().includes('aggregateoffer'))continue;const n=price(o.price??o.lowPrice),st=availability(o.availability),cur=String(o.priceCurrency||'').toUpperCase();const direct=url(o.url||p.url||base,base);if(n>0&&cur==='EUR'&&st!=='unknown'&&st!=='out'&&direct&&!isSearch(direct))a.push({name:s.name,variant:s.variant,price:n,status:st,url:direct,proof:'JSON-LD',shipping:'non verificata'})}}return a}
async function fetchPage(u){const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),REQUEST_TIMEOUT);try{const r=await fetch(u,{headers:{'user-agent':'Mozilla/5.0 PokemonUPCMonitor/4.0','accept':'text/html,application/json'},signal:ac.signal});if(!r.ok)throw Error('HTTP '+r.status);if(Number(r.headers.get('content-length')||0)>3000000)throw Error('Pagina troppo grande');const body=await r.text();if(body.length>3000000)throw Error('Pagina troppo grande');return {body,url:r.url}}finally{clearTimeout(timer)}}
async function shopify(s,base){const u=new URL(base),m=u.pathname.match(/\/products\/([^/?#]+)/);if(!m)return [];let p;try{p=JSON.parse((await fetchPage(`${u.origin}/products/${m[1]}.js`)).body)}catch{return []}if(!relevant(p.title,s.variant)||!Array.isArray(p.variants))return [];const good=p.variants.filter(x=>x.available===true&&Number.isFinite(Number(x.price))&&Number(x.price)>0);if(!good.length)return [];return [{name:s.name,variant:s.variant,price:Math.min(...good.map(x=>Number(x.price)/100)),status:'available',url:base,proof:'Shopify available=true',shipping:'non verificata'}]}
function links(html,base){const out=[];for(const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){const label=m[2].replace(/<[^>]*>/g,' ').replace(/\s+/g,' '),u=url(m[1].replace(/&amp;/g,'&'),base);if(u&&/(ultra[\s-]*premium|espeon|umbreon|30.*anniversario)/i.test(label+' '+u))out.push({label,url:u})}return out}
function isSearch(u){try{const x=new URL(u);return /(^|\.)(amazon\.|ebay\.|cardmarket\.)/.test(x.hostname)&&(/\/sch\/|\/search|\/s\b/.test(x.pathname)||x.searchParams.has('k'))}catch{return true}}
async function inspect(s){const page=await fetchPage(s.url);if(s.type==='shop')return {offers:[...structured(page.body,s,page.url),...await shopify(s,page.url)],note:'scheda prodotto'};
// Tracker discovery only: tracker text never proves stock. Follow direct product pages only.
const candidates=links(page.body,page.url).filter(x=>{try{return new URL(x.url).hostname!==new URL(page.url).hostname&&!isSearch(x.url)&&variant(x.label+' '+x.url)===s.variant&&/\/products\/|\/prodotto\/|\/shop\//.test(new URL(x.url).pathname)}catch{return false}});
const offers=[];for(const c of candidates.slice(0,8)){try{const dest={...s,name:new URL(c.url).hostname};const p=await fetchPage(c.url);offers.push(...structured(p.body,dest,p.url),...await shopify(dest,p.url))}catch(e){log('TRACKER LINK FAILED',s.name,c.url,e.message)}}return {offers,note:`${candidates.length} link prodotto esterni (0 non significa copertura completa)`}}
function unique(offers){const map=new Map();for(const o of offers){if(o.price<=0||o.price>(o.variant==='pair'?MAX_PAIR:MAX_BOX))continue;const cleanUrl=new URL(o.url);cleanUrl.hash='';for(const q of [...cleanUrl.searchParams.keys()])if(/^(utm_|fbclid|gclid|mc_cid|mc_eid)/i.test(q))cleanUrl.searchParams.delete(q);const key=crypto.createHash('sha256').update([o.variant,cleanUrl.toString(),o.price,o.status].join('|')).digest('hex');map.set(key,{...o,key})}return [...map.values()]}
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
    state.health[s.name]={ok:true,note:r.note,offers:r.offers.length,at:new Date().toISOString()};
    offers.push(...r.offers);
    log('SOURCE OK',s.name,r.note,'offers='+r.offers.length);
  }catch(e){
    errors++;
    state.health[s.name]={ok:false,note:e.message,at:new Date().toISOString()};
    log('SOURCE FAILED',s.name,e.message);
  }
});
const failed=SOURCES.filter(s=>state.health[s.name]&&!state.health[s.name].ok);
const now=Date.now();
if(failed.length&&(!state.lastHealthAlert||now-state.lastHealthAlert>=SOURCE_ALERT_HOURS*3600000)){
  const text='⚠️ MONITORAGGIO PARZIALE: '+failed.length+' fonti non raggiungibili:\n'+failed.map(s=>'• '+s.name+': '+state.health[s.name].note).join('\n')+'\nAltre fonti continuano a essere controllate.';
  const recipients=process.env.TELEGRAM_CHAT_ID?[String(process.env.TELEGRAM_CHAT_ID)]:[];
  let ok=false;for(const chat of recipients)if(await send(chat,text))ok=true;
  if(ok)state.lastHealthAlert=now;
}
const valid=unique(offers);
if(errors===0){
  state.missing ||= {};
  const visible=new Set(valid.map(o=>o.key));
  for(const sentKey of Object.keys(state.sent)){
    const offerKey=sentKey.slice(0,64);
    if(visible.has(offerKey)){delete state.missing[sentKey];continue}
    state.missing[sentKey]=(state.missing[sentKey]||0)+1;
    if(state.missing[sentKey]>=2){delete state.sent[sentKey];delete state.missing[sentKey]}
  }
}
const chats=[...new Set([...state.chats,...(process.env.TELEGRAM_CHAT_ID?[String(process.env.TELEGRAM_CHAT_ID)]:[])])];let sent=0;for(const o of valid){const message=`🚨 Pokémon UPC 30° Anniversario\n📦 ${o.variant==='giorno'?'Giorno / Espeon':o.variant==='notte'?'Notte / Umbreon':'Coppia Giorno + Notte'}\n🏬 ${o.name}\n💶 ${o.price.toFixed(2)} €\n🟢 ${o.status==='preorder'?'Preordine':'Disponibile'}\n🚚 Spedizione in Italia: ${o.shipping}\n🔗 ${o.url}\n🔍 Fonte: ${o.proof}\n⚠️ Verifica al checkout.`;for(const chat of chats){const k=o.key+':'+chat;if(state.sent[k])continue;if(await send(chat,message)){state.sent[k]=Date.now();sent++;log('ALERT DELIVERED',o.name,o.variant,o.price,'chat='+chat);save()}}}state.last={at:new Date().toISOString(),sources:SOURCES.length,errors,offers:valid.length,sent};save();log('CHECK COMPLETE',JSON.stringify(state.last));return `${SOURCES.length} fonti, ${errors} errori, ${valid.length} offerte entro budget, ${sent} notifiche inviate`}finally{checking=false}}
async function handle(u){const m=u.message;if(!m?.chat?.id||typeof m.text!=='string')return;const chat=String(m.chat.id),cmd=m.text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();if(cmd==='/start'){if(!state.chats.includes(chat)){state.chats.push(chat);save()}await send(chat,'✅ Iscritto. Comandi: /test /testalert /check /status /sources /health /stop')}else if(cmd==='/test')await send(chat,'✅ Telegram operativo. Questo non prova il rilevamento dei restock.');else if(cmd==='/testalert')await send(chat,'🧪 SIMULAZIONE, NON È UN RESTOCK REALE\n🚨 Pokémon UPC Notte / Umbreon\n🏬 Negozio TEST\n💶 249,90 €\n🟢 Disponibile (simulazione)\n🚚 Italia: non verificata\n🔗 Nessun link di acquisto');else if(cmd==='/health'){const failed=SOURCES.filter(s=>state.health[s.name]&&!state.health[s.name].ok);await send(chat,failed.length?'⚠️ Fonti in errore:\n'+failed.map(s=>s.name+' — '+state.health[s.name].note).join('\n'):'✅ Nessuna fonte in errore nell’ultimo controllo. Questo non certifica la disponibilità.')}else if(cmd==='/check'){await send(chat,'🔎 Controllo avviato');void check().then(r=>send(chat,r)).catch(e=>log('CHECK COMMAND FAILED',e.message))}else if(cmd==='/status')await send(chat,`🤖 Attivo\n${JSON.stringify(state.last||'Nessun controllo')}\nBudget: ${MAX_BOX} € / scatola, ${MAX_PAIR} € / coppia`);else if(cmd==='/sources'){const lines=SOURCES.map(s=>{const h=state.health[s.name];return `${h?.ok?'✅':h?'❌':'⏳'} ${s.name}: ${h?.note||'non controllata'}`});await send(chat,lines.join('\n'))}else if(cmd==='/stop'){state.chats=state.chats.filter(x=>x!==chat);save();await send(chat,'Notifiche disattivate')}}
async function poll(){while(true){try{const updates=await api('getUpdates',{offset:state.offset,timeout:25,allowed_updates:['message']});for(const u of updates){try{await handle(u)}catch(e){log('COMMAND FAILED',e.message)}state.offset=u.update_id+1;save()}}catch(e){log('POLL ERROR',e.message);await sleep(5000)}}}
async function main(){if(!TOKEN)throw Error('Manca TELEGRAM_BOT_TOKEN');await api('deleteWebhook',{drop_pending_updates:false});const me=await api('getMe');log('TELEGRAM AUTH OK',me.username);log('MONITOR STARTED',SOURCES.length,'sources','interval='+INTERVAL,'concurrency='+CONCURRENCY);void poll();setInterval(()=>void check(),INTERVAL);await check()}
if(require.main===module)main().catch(e=>{log('FATAL',e.message);process.exitCode=1});
module.exports={price,variant,relevant,availability,structured,unique,links,isSearch};
