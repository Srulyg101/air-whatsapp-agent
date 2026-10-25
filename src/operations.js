'use strict';
// Air Agent operations integrations: scoped inbound API keys and outbound helpdesk tickets.
// No provider secrets or bearer tokens are ever returned after initial key creation.
const crypto = require('node:crypto');
const express = require('express');
const { db, logEvent } = require('./db');
const { encrypt, decrypt } = require('./secrets');
const { assertPublicUrl } = require('./netguard');

db.exec(`
CREATE TABLE IF NOT EXISTS ops_api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS ops_api_keys_session ON ops_api_keys(session_id);
CREATE TABLE IF NOT EXISTS ops_integrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  email TEXT,
  secret_enc TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ops_integrations_session ON ops_integrations(session_id);
CREATE TABLE IF NOT EXISTS ops_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  ticket_id INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, source, source_id)
);
CREATE TABLE IF NOT EXISTS ops_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  integration_id INTEGER,
  provider TEXT,
  external_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  requester_email TEXT,
  priority INTEGER NOT NULL DEFAULT 2,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(session_id, source, source_id)
);
CREATE INDEX IF NOT EXISTS ops_tickets_session ON ops_tickets(session_id, id);
``);

const now = () => Math.floor(Date.now() / 1000);
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const SCOPES = new Set(['events:write', 'tickets:read', 'tickets:write']);
const PROVIDERS = new Set(['freshdesk', 'zendesk', 'webhook']);
const fail = (message, status=400) => Object.assign(new Error(message), {status});
const clip = (v, max) => String(v || '').trim().slice(0, max);
const meta = r => ({ id:r.id, name:r.name, provider:r.provider, endpoint:r.endpoint, email:r.email, enabled:!!r.enabled, created_at:r.created_at });
const ticketView = t => t && ({
  id:t.id, provider:t.provider, external_id:t.external_id, integration_id:t.integration_id,
  title:t.title, description:t.description, requester_email:t.requester_email,
  priority:t.priority, source:t.source, source_id:t.source_id, status:t.status, error:t.error,
  created_at:t.created_at, updated_at:t.updated_at,
});
const getIntegration = (sid, id) => id ?
  db.prepare('SELECT * FROM ops_integrations WHERE session_id=? AND id=? AND enabled=1').get(sid,id) :
  db.prepare('SELECT * FROM ops_integrations WHERE session_id=? AND enabled=1 ORDER BY id LIMIT 1').get(sid);
const hasIntegration = sid => !!getIntegration(sid);
const getTicket = (sid,id) => ticketView(db.prepare('SELECT * FROM ops_tickets WHERE session_id=? AND id=?').get(sid,id));
const listTickets = (sid, limit=30) => db.prepare('SELECT * FROM ops_tickets WHERE session_id=? ORDER BY id DESC LIMIT ?').all(sid,Math.max(1,Math.min(100,Number(limit)||30))).map(ticketView);
const safeErr = msg => String(msg||'Upstream request failed').replace(/(Bearer |Basic |api[_-]?key[=:]\s*)\S+/ig,'[redacted]').slice(0,200);
function parseConfig(input) {
  const name=clip(input.name,80), provider=clip(input.provider,30).toLowerCase();
  const endpoint=clip(input.endpoint,400);
  const email=clip(input.email,160);
  const credential=String(input.api_key||'');
  if(!name || !PROVIDERS.has(provider) || credential.length<8 || credential.length>512) throw fail('Name, provider and API key are required');
  let u;
  try {u=new URL(endpoint);} catch {throw fail('A valid HTTPS endpoint is required');}
  if(u.protocol!=='https:' || u.username || u.password || u.search || u.hash || u.port && u.port!=='443')
    throw fail('Endpoint must use HTTPS with no credentials, query or nonstandard port');
  const host=u.hostname.toLowerCase();
  if(provider==='freshdesk' && (!host.endsWith('.freshdesk.com') || u.pathname!=='/')) throw fail('Freshdesk endpoint must be https://YOURDOMAIN.freshdesk.com/');
  if(provider==='zendesk' && (!host.endsWith('.zendesk.com') || u.pathname!=='/')) throw fail('Zendesk endpoint must be https://YOURDOMAIN.zendesk.com/');
  if(provider==='zendesk' && (!email.includes('@') || email.length>160)) throw fail('Zendesk requires the agent email');
  if(provider==='webhook' && (!host || u.pathname==='/')) throw fail('Webhook requires an explicit HTTPS receiver path');
  return {name,provider,endpoint:u.toString(),email,credential};
}
async function outbound(row, ticket) {
  await assertPublicUrl(row.endpoint);
  const url=new URL(row.endpoint);
  let path=url.toString(), headers={'Content-Type':'application/json'}, payload;
  const key=decrypt(row.secret_enc);
  if(!key) throw fail('Provider credential unavailable',503);
  if(row.provider==='freshdesk') {
    path=new URL('/api/v2/tickets',url).toString();
    headers.Authorization='Basic '+Buffer.from(key+':X').toString('base64');
    payload={subject:ticket.title,description:ticket.description,email:ticket.requester_email||undefined,priority:ticket.priority,status:2};
    if(!payload.email) throw fail('Freshdesk tickets require requester_email');
  } else if(row.provider==='zendesk') {
    path=new URL('/api/v2/tickets.json',url).toString();
    headers.Authorization='Basic '+Buffer.from(row.email+'/token:'+key).toString('base64');
    payload={ticket:{subject:ticket.title,comment:{body:ticket.description},priority:['','low','normal','high','urgent'][ticket.priority]||'normal',requester:ticket.requester_email?{email:ticket.requester_email}:undefined}};
  } else {
    headers.Authorization='Bearer '+key;
    payload={event:'ticket.create',ticket:{id:ticket.id,subject:ticket.title,description:ticket.description,priority:ticket.priority,requester_email:ticket.requester_email,source:ticket.source,source_id:ticket.source_id}};
  }
  // Disallow redirecting provider credentials; all providers are HTTPS with public hosts.
  await assertPublicUrl(path);
  let response;
  try {response=await fetch(path,{method:'POST',headers,body:JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(12000)});}
  catch{throw fail('Helpdesk connection failed',502);}
  if(!response.ok) throw fail('Helpdesk rejected request (HTTP '+response.status+')',502);
  let out;
  try {out=await response.json();}catch{throw fail('Helpdesk response was not JSON',502);}
  const id=row.provider==='zendesk'?out.ticket?.id:(row.provider==='freshdesk'?out.id:(out.id||out.ticket?.id));
  if(!id) throw fail('Helpdesk did not return a ticket ID; verify externally before retrying',502);
  return String(id).slice(0,100);
}
async function createTicket(sessionId, input) {
  const title=clip(input.title,160), description=clip(input.description,8000),
    requester_email=clip(input.requester_email,200), source=clip(input.source||'manual',32),
    source_id=clip(input.source_id,180);
  const priority=Number(input.priority||2);
  if(!title || !description || !source_id || !/^[a-z0-9_-]+$/i.test(source)) throw fail('title, description and source_id are required');
  if(![1,2,3,4].includes(priority)) throw fail('priority must be 1, 2, 3 or 4');
  if(requester_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(requester_email)) throw fail('Invalid requester_email');
  const prior=db.prepare('SELECT * FROM ops_tickets WHERE session_id=? AND source=? AND source_id=?').get(sessionId,source,source_id);
  if(prior) return ticketView(prior);
  const integration=getIntegration(sessionId,Number(input.integration_id)||undefined);
  if(input.integration_id && !integration) throw fail('Integration not found',404);
  const timestamp=now();
  try {
    db.prepare(`INSERT INTO ops_tickets (session_id,integration_id,provider,title,description,requester_email,priority,source,source_id,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(sessionId,integration?.id||null,integration?.provider||null,title,description,requester_email||null,priority,source,source_id,integration?'pending':'draft',timestamp,timestamp);
  } catch (e) {
    if(String(e.code||'').startsWith('SQLITE_CONSTRAINT')) return ticketView(db.prepare('SELECT * FROM ops_tickets WHERE session_id=? AND source=? AND source_id=?').get(sessionId,source,source_id));
    throw e;
  }
  const t=db.prepare('SELECT * FROM ops_tickets WHERE session_id=? AND source=? AND source_id=?').get(sessionId,source,source_id);
  if(integration){
    try{
      const remoteId=await outbound(integration,t);
      db.prepare("UPDATE ops_tickets SET external_id=?,status='sent',error=NULL,updated_at=? WHERE id=?").run(remoteId,now(),t.id);
    }catch(e){
      db.prepare("UPDATE ops_tickets SET status='needs_review',error=?,updated_at=? WHERE id=?").run(safeErr(e.message),now(),t.id);
    }
  }
  const result=getTicket(sessionId,t.id);
  logEvent(sessionId,'action',null,'Ops ticket #'+t.id+' status '+result.status);
  return result;
}
function createKey(sessionId, input){
  const name=clip(input.name,80), scopes=Array.isArray(input.scopes)?[...new Set(input.scopes)]:[];
  if(!name || !scopes.length || scopes.some(x=>!SCOPES.has(x))) throw fail('Provide a name and allowed scopes');
  const days=Number(input.expires_in_days||30);
  if(!Number.isInteger(days)||days<1||days>90) throw fail('API key expiry must be 1–90 days');
  const token='air_live_'+crypto.randomBytes(32).toString('base64url');
  const r=db.prepare('INSERT INTO ops_api_keys (session_id,name,token_hash,scopes,created_at,expires_at) VALUES (?,?,?,?,?,?)')
    .run(sessionId,name,hash(token),JSON.stringify(scopes),now(),now()+days*86400);
  return {id:r.lastInsertRowid,token,scopes,expires_at:now()+days*86400};
}
const usage=new Map();
function apiAuth(scope) {
 return (req,res,next)=>{
  const match=String(req.get('authorization')||'').match(/^Bearer (air_live_[a-zA-Z0-9_-]+)$/);
  if(!match) return res.status(401).json({error:'Bearer API key required'});
  const key=db.prepare('SELECT * FROM ops_api_keys WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?').get(hash(match[1]),now());
  if(!key) return res.status(401).json({error:'Invalid or expired key'});
  const scopes=JSON.parse(key.scopes);
  if(!scopes.includes(scope)) return res.status(403).json({error:'Insufficient key scope'});
  const interval=Math.floor(Date.now()/60000), u=usage.get(key.id)||{interval,count:0};
  if(u.interval!==interval){u.interval=interval;u.count=0;}
  if(++u.count>60) return res.status(429).json({error:'API rate limit exceeded'});
  usage.set(key.id,u);
  if(usage.size>10000) usage.clear();
  db.prepare('UPDATE ops_api_keys SET last_used_at=? WHERE id=?').run(now(),key.id);
  req.opsSessionId=key.session_id;
  next();
 };
}
function register(app,auth,sid,wrap) {
  const adminRouter=express.Router();
  adminRouter.use(auth);
  adminRouter.get('/keys',wrap((req,res)=>res.json(db.prepare('SELECT id,name,scopes,created_at,expires_at,revoked_at,last_used_at FROM ops_api_keys WHERE session_id=? ORDER BY id DESC').all(sid(req)).map(x=>({...x,scopes:JSON.parse(x.scopes)})))));
  adminRouter.post('/keys',wrap((req,res)=>res.status(201).json(createKey(sid(req),req.body||{}))));
  adminRouter.delete('/keys/:id',wrap((req,res)=>{
    const r=db.prepare('UPDATE ops_api_keys SET revoked_at=? WHERE session_id=? AND id=? AND revoked_at IS NULL').run(now(),sid(req),Number(req.params.id));
    res.status(r.changes?200:404).json({revoked:!!r.changes});
  }));
  adminRouter.get('/integrations',wrap((req,res)=>res.json(db.prepare('SELECT * FROM ops_integrations WHERE session_id=? ORDER BY id DESC').all(sid(req)).map(meta))));
  adminRouter.post('/integrations',wrap(async(req,res)=>{
    const cfg=parseConfig(req.body||{});
    await assertPublicUrl(cfg.endpoint);
    const r=db.prepare('INSERT INTO ops_integrations (session_id,name,provider,endpoint,email,secret_enc,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(sid(req),cfg.name,cfg.provider,cfg.endpoint,cfg.email||null,encrypt(cfg.credential),now());
    res.status(201).json(meta(getIntegration(sid(req),r.lastInsertRowid)));
  }));
  adminRouter.delete('/integrations/:id',wrap((req,res)=>{
    const r=db.prepare('UPDATE ops_integrations SET enabled=0,secret_enc=? WHERE session_id=? AND id=?').run('',sid(req),Number(req.params.id));
    res.status(r.changes?200:404).json({disabled:!!r.changes});
  }));
  adminRouter.get('/tickets',wrap((req,res)=>res.json(listTickets(sid(req)))));
  adminRouter.post('/tickets',wrap(async(req,res)=>res.status(201).json(await createTicket(sid(req),{...req.body,source:'dashboard',source_id:crypto.randomUUID()}))));
  app.use('/api/operations',adminRouter);

  const v1=express.Router();
  v1.post('/events',apiAuth('events:write'),wrap(async(req,res)=>{
    const b=req.body||{}, source=clip(b.source||'external',32),source_id=clip(b.source_id||req.get('idempotency-key'),180),
      type=clip(b.type||'message',50),message=clip(b.message,5000);
    if(!source_id||!message||!/^[a-z0-9_-]+$/i.test(source)) throw fail('source_id, message and a valid source are required');
    const s=req.opsSessionId;
    const open= b.open_ticket === true;
    if(open) {
      const token=db.prepare('SELECT scopes FROM ops_api_keys WHERE token_hash=?').get(hash(req.get('authorization').slice(7)));
      if(!JSON.parse(token.scopes).includes('tickets:write')) return res.status(403).json({error:'tickets:write required'});
    }
    const existing=db.prepare('SELECT * FROM ops_events WHERE session_id=? AND source=? AND source_id=?').get(s,source,source_id);
    if(existing) return res.json({id:existing.id,ticket_id:existing.ticket_id,duplicate:true});
    const time=now();
    const info=db.prepare('INSERT INTO ops_events (session_id,source,source_id,type,message,created_at) VALUES (?,?,?,?,?,?)').run(s,source,source_id,type,message,time);
    let ticket=null;
    if(open){
      ticket=await createTicket(s,{title:clip(b.title||message,160),description:message,priority:b.priority,requester_email:b.requester_email,source,source_id});
      db.prepare('UPDATE ops_events SET ticket_id=? WHERE id=?').run(ticket.id,info.lastInsertRowid);
    }
    res.status(202).json({id:info.lastInsertRowid,ticket,created:!!ticket});
  }));
  v1.post('/tickets',apiAuth('tickets:write'),wrap(async(req,res)=>{
    const idempotency=clip(req.get('idempotency-key'),180);
    if(idempotency.length<8) throw fail('Idempotency-Key header is required (at least 8 characters)');
    const ticket=await createTicket(req.opsSessionId,{...(req.body||{}),source:'api',source_id:idempotency});
    res.status(ticket.status==='sent'?201:202).json(ticket);
  }));
  v1.get('/tickets',apiAuth('tickets:read'),wrap((req,res)=>res.json(listTickets(req.opsSessionId,req.query.limit))));
  v1.get('/tickets/:id',apiAuth('tickets:read'),wrap((req,res)=>{
    const t=getTicket(req.opsSessionId,Number(req.params.id));
    if(!t) throw fail('Ticket not found',404);
    res.json(t);
  }));
  app.use('/api/v1',v1);
}
module.exports={register,createTicket,hasIntegration,getTicket,listTickets,createKey,parseConfig};
