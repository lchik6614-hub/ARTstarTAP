import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const app=express();
const port=Number(process.env.PORT||3000);
const token=process.env.TELEGRAM_BOT_TOKEN||'';
const demo=process.env.DEMO_MODE==='true' || process.env.NODE_ENV!=='production';
const admins=new Set((process.env.ADMIN_TELEGRAM_ID||'').split(',').map(x=>x.trim()).filter(Boolean));
const stateFile=path.join(root,'data','state.json');
const collectionsFile=path.join(root,'data','collections.json');
app.use(express.json({limit:'1mb'}));
app.use(express.static(root));

const read=(file,fallback)=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fallback;}};
const save=(value)=>{const tmp=stateFile+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2));fs.renameSync(tmp,stateFile);};
const collections=()=>read(collectionsFile,[]).map((c,i)=>({...c,address:c.address||process.env['TON_COLLECTION_'+(i+1)]||''}));

function viewer(req){
  const init=req.get('x-telegram-init-data')||'';
  if(!init && demo)return {id:Number(process.env.DEV_ADMIN_ID||1),username:'demo_user',first_name:'Demo'};
  if(!init||!token)return null;
  const p=new URLSearchParams(init);const hash=p.get('hash');if(!hash)return null;p.delete('hash');
  const check=[...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([a,b])=>a+'='+b).join('\\n');
  const secret=crypto.createHmac('sha256','WebAppData').update(token).digest();
  const calc=crypto.createHmac('sha256',secret).update(check).digest('hex');
  if(calc!==hash)return null;
  try{return JSON.parse(p.get('user')||'{}');}catch{return null;}
}
function admin(req){const u=viewer(req);return u && (admins.has(String(u.id)) || demo);}
function guard(req,res,next){const u=viewer(req);if(!u)return res.status(401).json({error:'Откройте Mini App из Telegram'});req.user=u;next();}
function guardAdmin(req,res,next){if(!admin(req))return res.status(403).json({error:'Нет доступа'});req.user=viewer(req);next();}
async function tg(method,body){
  if(!token)throw Error('TELEGRAM_BOT_TOKEN пока не добавлен');
  const r=await fetch('https://api.telegram.org/bot'+token+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const d=await r.json();if(!r.ok||!d.ok)throw Error(d.description||'Telegram API error');return d.result;
}
function image(value){return String(value||'').startsWith('ipfs://')?'https://ipfs.io/ipfs/'+value.slice(7):value||'';}
async function tonNfts(address){
  const list=collections();const allowed=new Map(list.filter(x=>x.address).map(x=>[x.address,x]));
  if(!process.env.TONAPI_KEY||!allowed.size)return [];
  const r=await fetch('https://tonapi.io/v2/accounts/'+encodeURIComponent(address)+'/nfts?limit=100',{headers:{Authorization:'Bearer '+process.env.TONAPI_KEY}});
  if(!r.ok)throw Error('TON API не ответил');const d=await r.json();
  return (d.nft_items||[]).map(x=>{const ca=x.collection?.address||'';const c=allowed.get(ca);if(!c)return null;const m=x.metadata||{};return {id:x.address,address:x.address,collectionId:c.id,name:m.name||'NFT',number:String(x.index||''),image:image(m.image),dailyStars:Number(m.dailyStars||2),status:'available'};}).filter(Boolean);
}

app.get('/api/health',(_q,r)=>r.json({ok:true,botConfigured:!!token,tonConfigured:!!process.env.TONAPI_KEY}));
app.get('/api/config',(q,r)=>{const u=viewer(q),s=read(stateFile,{inventory:[],orders:[],wallets:[]}),cs=collections();r.json({currency:'XTR',viewer:u?{id:u.id,username:u.username||'',isAdmin:admin(q)}:null,collections:cs,stats:{available:s.inventory.filter(x=>x.status==='available').length,rented:s.inventory.filter(x=>['rented','delivered'].includes(x.status)).length}});});
app.get('/api/inventory',(q,r)=>{const s=read(stateFile,{inventory:[]});r.json({items:s.inventory.filter(x=>x.status==='available'&&(!q.query.collectionId||x.collectionId===q.query.collectionId))});});
app.post('/api/wallet/inspect',guardAdmin,async(req,res)=>{const address=String(req.body.walletAddress||'').trim();if(!/^(EQ|UQ)[A-Za-z0-9_-]{46}$/.test(address))return res.status(400).json({error:'Вставьте корректный TON-адрес из Fragment'});try{const items=await tonNfts(address);const s=read(stateFile,{inventory:[],orders:[],wallets:[]});const used=new Set(s.inventory.map(x=>x.address).filter(Boolean));res.json({items:items.filter(x=>!used.has(x.address)),message:items.length?'NFT найдены':'NFT не найдены. Проверьте TON API и адреса 4 коллекций.'});}catch(e){res.status(502).json({error:e.message});}});
app.post('/api/admin/inventory',guardAdmin,(req,res)=>{const address=String(req.body.walletAddress||'');const items=Array.isArray(req.body.items)?req.body.items:[];if(!address||!items.length)return res.status(400).json({error:'Выберите NFT'});const s=read(stateFile,{inventory:[],orders:[],wallets:[]});const used=new Set(s.inventory.map(x=>x.address).filter(Boolean));let added=0;for(const x of items){if(x.address&&used.has(x.address))continue;s.inventory.push({...x,ownerWallet:address,status:'available',addedAt:new Date().toISOString()});if(x.address)used.add(x.address);added++;}save(s);res.json({ok:true,added});});
app.post('/api/rentals/invoice',guard,async(req,res)=>{const id=String(req.body.itemId||'');const days=Math.min(180,Math.max(1,Number(req.body.days||1)));const s=read(stateFile,{inventory:[],orders:[],wallets:[]});const item=s.inventory.find(x=>x.id===id&&x.status==='available');if(!item)return res.status(404).json({error:'NFT уже арендован'});const order={id:'order_'+Date.now()+'_'+crypto.randomBytes(2).toString('hex'),itemId:id,userId:String(req.user.id),days,totalStars:Math.max(1,Math.ceil(Number(item.dailyStars||1)*days)),status:'created',createdAt:new Date().toISOString()};try{order.invoiceLink=await tg('createInvoiceLink',{title:'Аренда '+item.name,description:'Срок аренды: '+days+' дн.',payload:JSON.stringify({orderId:order.id}),currency:'XTR',prices:[{label:'NFT аренда',amount:order.totalStars}],provider_token:''});s.orders.push(order);save(s);res.json({invoiceLink:order.invoiceLink,totalStars:order.totalStars,orderId:order.id});}catch(e){res.status(503).json({error:e.message});}});
app.post('/api/webhook',async(req,res)=>{try{const u=req.body||{};if(u.pre_checkout_query)await tg('answerPreCheckoutQuery',{pre_checkout_query_id:u.pre_checkout_query.id,ok:true});const m=u.message;if(m?.successful_payment){let p={};try{p=JSON.parse(m.successful_payment.invoice_payload||'{}');}catch{}const s=read(stateFile,{inventory:[],orders:[],wallets:[]});const o=s.orders.find(x=>x.id===p.orderId);if(o){o.status='paid';o.paidAt=new Date().toISOString();const item=s.inventory.find(x=>x.id===o.itemId);if(item){item.status='rented';item.renterId=o.userId;item.rentedUntil=new Date(Date.now()+o.days*86400000).toISOString();}save(s);await tg('sendMessage',{chat_id:m.chat.id,text:'Оплата получена. NFT забронирован на '+o.days+' дн. Передача выполняется администратором.'});}}if(m?.text==='/start'||m?.text==='/rent'){await tg('sendMessage',{chat_id:m.chat.id,text:'Откройте каталог NFT и оплатите аренду Stars.',reply_markup:{inline_keyboard:[[{text:'Открыть Mini App',web_app:{url:process.env.MINI_APP_URL||'https://your-domain.example'}}]]}});}res.json({ok:true});}catch(e){console.error(e.message);res.status(500).json({ok:false});}});
app.get('*',(_q,r)=>r.sendFile(path.join(root,'index.html')));
app.listen(port,()=>console.log('StarRent NFT on '+port));
