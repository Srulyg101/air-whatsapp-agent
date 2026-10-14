const path = require('path');
const crypto = require('crypto');
const os = require('os');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const config = require('./config');
const db = require('./db');
const { q, getSettings, saveSettings, maskedSecrets, getApp, setApp, setAppSecret, getAppSecret, logEvent } = db;
const ai = require('./ai');
const kb = require('./knowledge');
const voice = require('./voice');
const actions = require('./actions');
const { think } = require('./agent');
const wa = require('./wa');
const { mask } = require('./secrets');
const email = require('./email');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback, uniquelocal');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  next();
});
const jsonSmall = express.json({ limit: '1mb' });
const jsonMail = express.json({ limit: '6mb' });
app.use((req, res, next) => (req.path === '/api/inbound/email' ? jsonMail : jsonSmall)(req, res, next));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 } });
const started = Date.now();
const sessionIdFor = (user) => `u${user.id}`;
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(e.status || 500).json({ error: e.message }));
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// ---------- auth ----------
function auth(req, res, next) {
  const user = req.cookies.token && q.userByToken.get(req.cookies.token);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  req.user = user;
  next();
}
const admin = (req, res, next) => (req.user.is_admin ? next() : res.status(403).json({ error: 'Admins only' }));

function login(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  q.insertToken.run(token, userId);
  const secure = config.cookieSecure === 'auto' ? req.secure : config.cookieSecure === 'true';
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', secure, maxAge: 1000 * 60 * 60 * 24 * 90 });
}

const tries = new Map();
function slowDown(req, res, next) {
  const k = req.ip; const now = Date.now();
  const arr = (tries.get(k) || []).filter((t) => now - t < 15 * 60_000);
  if (arr.length >= 20) return res.status(429).json({ error: 'Too many attempts, try again in 15 minutes' });
  arr.push(now); tries.set(k, arr); next();
}
// Blocks other websites from making logged-in requests on your behalf.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET') return next();
  const origin = req.get('origin');
  let host = null;
  try { host = origin ? new URL(origin).host : null; } catch (_) { host = 'invalid'; }
  if (origin && host !== req.get('host')) return res.status(403).json({ error: 'Cross-site request blocked' });
  next();
});

const signupOpen = () => config.forceOpenSignup || getApp('signup_open') === '1';

app.get('/api/public', (req, res) => res.json({ botName: config.botName, signupOpen: signupOpen() || q.userCount.get().c === 0, firstUser: q.userCount.get().c === 0 }));

app.post('/api/signup', slowDown, wrap((req, res) => {
  const { email, password, name } = req.body || {};
  const first = q.userCount.get().c === 0;
  if (!first && !signupOpen()) throw bad('Sign-ups are closed. Ask the admin for an account.', 403);
  const user = createUser(email, password, name, first);
  login(req, res, user);
  res.json({ ok: true, admin: first });
}));

function createUser(email, password, name, isAdmin) {
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) throw bad('Valid email required');
  if (!password || String(password).length < 8) throw bad('Password must be at least 8 characters');
  if (q.userByEmail.get(String(email).toLowerCase())) throw bad('Email already registered', 409);
  return q.insertUser.run(String(email).toLowerCase(), String(name || '').slice(0, 80), bcrypt.hashSync(String(password), 10), isAdmin ? 1 : 0).lastInsertRowid;
}

app.post('/api/login', slowDown, (req, res) => {
  const { email, password } = req.body || {};
  const u = email && q.userByEmail.get(String(email).toLowerCase());
  if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash)) return res.status(401).json({ error: 'Wrong email or password' });
  login(req, res, u.id);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  if (req.cookies.token) q.deleteToken.run(req.cookies.token);
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  const house = wa.get('house');
  res.json({ user: req.user, botName: config.botName, version: config.version, houseNumber: house.status === 'open' ? house.me?.phone : null, allowCustomAi: getApp('allow_custom_ai') === '1' });
});

app.post('/api/account/password', auth, slowDown, wrap((req, res) => {
  const { current, next: nw } = req.body || {};
  const u = q.userByEmail.get(req.user.email);
  if (!bcrypt.compareSync(String(current || ''), u.password_hash)) throw bad('Current password is wrong', 401);
  if (!nw || String(nw).length < 8) throw bad('New password must be at least 8 characters');
  q.setPassword.run(bcrypt.hashSync(String(nw), 10), u.id);
  q.deleteUserTokens.run(u.id);
  login(req, res, u.id);
  res.json({ ok: true });
}));

app.post('/api/account/delete-data', auth, wrap(async (req, res) => {
  const s = wa.get(sessionIdFor(req.user));
  await s.logout();
  db.wipeSession(s.id);
  res.json({ ok: true });
}));

// ---------- which number are we editing ----------
function sessionFor(req) {
  const id = req.query.target === 'house' && req.user.is_admin ? 'house' : sessionIdFor(req.user);
  return wa.get(id);
}
const sid = (req) => sessionFor(req).id;

// ---------- WhatsApp linking ----------
app.post('/api/wa/connect', auth, wrap(async (req, res) => {
  const s = sessionFor(req);
  s.retries = 0;
  await s.start();
  res.json(s.info());
}));
app.get('/api/wa/status', auth, (req, res) => res.json(sessionFor(req).info()));
app.post('/api/wa/logout', auth, wrap(async (req, res) => {
  const s = sessionFor(req);
  await s.logout();
  logEvent(s.id, 'info', null, 'Unlinked from the dashboard');
  res.json(s.info());
}));
app.get('/api/wa/groups', auth, wrap(async (req, res) => res.json(await sessionFor(req).listGroups())));

// ---------- settings ----------
function settingsPayload(id) {
  const st = getSettings(id);
  return { ...st, secrets: maskedSecrets(id) };
}
app.get('/api/settings', auth, (req, res) => res.json(settingsPayload(sid(req))));
app.post('/api/settings', auth, wrap((req, res) => {
  const id = sid(req);
  const before = getSettings(id).options;
  saveSettings(id, req.body || {});
  const after = getSettings(id).options;
  if (before.reply_mode !== after.reply_mode) logEvent(id, 'info', null, `Who it answers changed: ${before.reply_mode} → ${after.reply_mode}`);
  if (before.group_mode !== after.group_mode) logEvent(id, 'info', null, `Groups changed: ${before.group_mode} → ${after.group_mode}`);
  res.json(settingsPayload(id));
}));

// ---------- knowledge ----------
app.get('/api/kb', auth, (req, res) => res.json(q.docs.all(sid(req))));
app.post('/api/kb/upload', auth, upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw bad('No file');
  const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const text = await kb.extractText(req.file.buffer, name);
  res.json(kb.addDocument(sid(req), name, text, { size: req.file.size }));
}));
app.post('/api/kb/text', auth, wrap((req, res) => {
  const { title, text } = req.body || {};
  if (!String(text || '').trim()) throw bad('Text is empty');
  res.json(kb.addDocument(sid(req), String(title || 'Note').slice(0, 200), String(text).slice(0, 200000), { kind: 'text', size: String(text).length }));
}));
app.get('/api/kb/:id', auth, (req, res) => {
  const d = q.doc.get(Number(req.params.id), sid(req));
  if (!d) return res.status(404).json({ error: 'Not found' });
  res.json({ ...d, text: kb.documentText(sid(req), d.id).slice(0, 50000) });
});
app.delete('/api/kb/:id', auth, (req, res) => { kb.deleteDocument(sid(req), Number(req.params.id)); res.json({ ok: true }); });
app.post('/api/kb/search', auth, (req, res) => res.json(kb.search(sid(req), String(req.body?.q || ''), 5)));

// ---------- AI model ----------
app.post('/api/ai/test', auth, wrap(async (req, res) => {
  const id = sid(req);
  const b = req.body || {};
  let p;
  if (b.mode === 'custom') {
    if (getApp('allow_custom_ai') !== '1') throw bad('The admin has disabled custom AI providers', 403);
    if (!/^https?:\/\//.test(b.base_url || '')) throw bad('Enter the API base URL');
    const key = b.api_key && !String(b.api_key).startsWith('••••') ? b.api_key : db.getSecret(id, 'ai_key');
    p = { base: b.base_url.replace(/\/$/, ''), model: b.model, key, label: 'custom' };
  } else p = ai.resolveProvider(null);
  const t0 = Date.now();
  let models = [];
  try { models = await ai.listModels(p); } catch (_) {}
  const r = await ai.chat([{ role: 'user', content: 'Reply with exactly: OK, connected.' }], { provider: p, timeoutMs: 60_000 });
  res.json({ ok: true, reply: r.content, ms: Date.now() - t0, model: p.model, models: models.slice(0, 100) });
}));

// ---------- playground (full brain, actions in test mode) ----------
app.post('/api/playground', auth, wrap(async (req, res) => {
  const id = sid(req);
  const s = wa.get(id);
  const b = req.body || {};
  const text = String(b.text || '').trim().slice(0, 4000);
  if (!text) throw bad('Type a message');
  const history = (Array.isArray(b.history) ? b.history : []).slice(-20)
    .filter((m) => m && ['user', 'assistant'].includes(m.role)).map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));
  const isOwner = b.as === 'owner';
  const t0 = Date.now();
  const r = await think({
    sessionId: id, settings: getSettings(id), jid: 'playground', isOwner, isHouse: s.isHouse,
    contact: isOwner ? null : 'Test Customer', ownerName: s.me?.name || req.user.name, text, history, dryRun: true,
  });
  res.json({ ...r, ms: Date.now() - t0 });
}));

// ---------- voice ----------
app.get('/api/voice/status', auth, (req, res) => res.json({ local: voice.whisperStatus(), model: config.whisperModel, serverApi: !!getApp('voice_api_base') }));
app.post('/api/voice/test', auth, upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw bad('No audio file');
  const t0 = Date.now();
  const text = await voice.transcribe(req.file.buffer, req.file.mimetype, getSettings(sid(req)));
  res.json({ text, ms: Date.now() - t0 });
}));

// ---------- conversations & activity ----------
app.get('/api/chats', auth, (req, res) => {
  const now = Date.now() / 1000;
  res.json(q.listChats.all(sid(req)).map((c) => ({ ...c, paused: c.paused_until === -1 || c.paused_until > now })));
});
app.get('/api/chats/messages', auth, (req, res) => res.json(q.chatMessages.all(sid(req), String(req.query.jid || '')).reverse()));
app.post('/api/chats/pause', auth, (req, res) => {
  const { jid, minutes } = req.body || {};
  const min = Number(minutes);
  const until = min === 0 ? 0 : min > 0 ? Math.floor(Date.now() / 1000) + min * 60 : -1;
  q.pauseChat.run(sid(req), String(jid), until);
  res.json({ ok: true });
});
app.post('/api/chats/clear', auth, (req, res) => { q.clearChat.run(sid(req), String(req.body?.jid || '')); res.json({ ok: true }); });

app.get('/api/activity', auth, (req, res) => {
  const id = sid(req);
  const counts = Object.fromEntries(q.eventCounts.all(id).map((r) => [r.type, r.n]));
  res.json({ events: q.events.all(id, Math.min(200, Number(req.query.limit) || 50)), counts });
});

// ---------- actions ----------
app.get('/api/reminders', auth, (req, res) => res.json(q.listReminders.all(sid(req))));
app.delete('/api/reminders/:id', auth, (req, res) => { q.cancelReminder.run(Number(req.params.id), sid(req)); res.json({ ok: true }); });
app.get('/api/notes', auth, (req, res) => res.json(q.listNotes.all(sid(req))));
app.delete('/api/notes/:id', auth, (req, res) => { q.delNote.run(Number(req.params.id), sid(req)); res.json({ ok: true }); });
app.post('/api/actions/test', auth, wrap(async (req, res) => {
  const id = sid(req);
  const s = wa.get(id);
  const { kind, target } = req.body || {};
  const ctx = { sessionId: id, settings: getSettings(id), jid: 'dashboard', isOwner: true, contact: 'Dashboard test', sock: s.sock };
  // tests always run (ignoring the per-action on/off switch) but only for the owner
  ctx.settings.options = { ...ctx.settings.options, act_email: 'me', act_call: 'me', act_webhook: 'me' };
  res.json({ result: await actions.testConnector(kind, ctx, target) });
}));

// ---------- bot email ----------
app.get('/api/email', auth, (req, res) => {
  const id = sid(req);
  res.json({ ...email.status(id), emails: q.listEmails.all(id, 50) });
});
app.get('/api/email/:id', auth, (req, res) => {
  const m = q.email.get(Number(req.params.id), sid(req));
  if (!m) return res.status(404).json({ error: 'Not found' });
  res.json(m);
});
app.post('/api/email/claim', auth, wrap((req, res) => {
  const id = sid(req);
  if (!getApp('mail_domain')) throw bad('Bot email addresses are not set up on this server yet (Admin → Bot email domain).');
  const local = String(req.body?.local || '').toLowerCase().trim();
  if (!/^[a-z0-9][a-z0-9._-]{2,30}$/.test(local)) throw bad('Use 3–31 letters, numbers, dots, dashes or underscores.');
  if (['admin', 'postmaster', 'abuse', 'root', 'support', 'noreply', 'no-reply', 'info', 'security', 'webmaster', 'hostmaster', 'mailer-daemon'].includes(local)) throw bad('That name is reserved.');
  const taken = q.sessionOfEmail.get(local);
  if (taken && taken.session_id !== id) throw bad('That address is taken. Try another.', 409);
  q.releaseEmail.run(id);
  q.claimEmail.run(local, id);
  logEvent(id, 'info', null, `Bot email address set: ${local}@${getApp('mail_domain')}`);
  res.json(email.status(id));
}));
app.post('/api/email/release', auth, (req, res) => { q.releaseEmail.run(sid(req)); res.json(email.status(sid(req))); });
app.post('/api/email/check', auth, wrap(async (req, res) => {
  const n = await email.checkImap(sid(req), wa);
  res.json({ ok: true, added: n, ...email.status(sid(req)) });
}));

// Incoming mail for bot addresses (name@MAIL_DOMAIN). Called by your mail provider / Cloudflare Email Worker.
app.post('/api/inbound/email', wrap(async (req, res) => {
  const secret = req.get('x-inbound-secret') || req.query.secret;
  const want = email.inboundSecret();
  if (!secret || secret.length !== want.length || !crypto.timingSafeEqual(Buffer.from(String(secret)), Buffer.from(want))) throw bad('Forbidden', 403);
  const b = { ...(req.body || {}) };
  if (b.raw) { // raw RFC 822 message (e.g. from a Cloudflare Email Worker)
    const { simpleParser } = require('mailparser');
    const p = await simpleParser(String(b.raw).slice(0, 6_000_000));
    b.from = b.from || p.from?.text; b.subject = b.subject ?? p.subject; b.text = b.text || p.text || ''; b.html = b.html || (p.html || '');
    b.message_id = b.message_id || p.messageId; b.to = b.to || p.to?.text;
  }
  const domain = (getApp('mail_domain') || '').toLowerCase();
  const tos = (Array.isArray(b.to) ? b.to : String(b.to || '').split(',')).map((x) => String(x).match(/[^<\s]+@[^>\s]+/)?.[0]?.toLowerCase()).filter(Boolean);
  let delivered = 0;
  for (const to of tos) {
    const [local, dom] = to.split('@');
    if (dom !== domain) continue;
    const owner = q.sessionOfEmail.get(local);
    if (!owner) continue;
    const from = String(b.from || '');
    const fromAddr = from.match(/[^<\s]+@[^>\s]+/)?.[0] || from;
    const fromName = from.includes('<') ? from.split('<')[0].replace(/"/g, '').trim() : '';
    const id = await email.receive(owner.session_id, {
      source: 'inbound', uid: b.message_id || crypto.createHash('sha1').update(JSON.stringify([b.from, b.subject, b.text, b.date])).digest('hex'),
      from_addr: fromAddr, from_name: fromName, to_addr: to, subject: b.subject, message_id: b.message_id,
      text: b.text || (b.html ? String(b.html).replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ') : ''),
    }, wa);
    if (id) delivered++;
  }
  res.json({ ok: true, delivered });
}));

// ---------- one-click AI sign-in (OpenRouter OAuth, PKCE) ----------
const oauthPending = new Map(); // nonce -> { sessionId, verifier, at }
app.get('/api/ai/openrouter/start', auth, (req, res) => {
  if (getApp('allow_custom_ai') !== '1') return res.status(403).json({ error: 'The admin has disabled custom AI providers' });
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const nonce = crypto.randomBytes(16).toString('hex');
  for (const [k, v] of oauthPending) if (Date.now() - v.at > 15 * 60_000) oauthPending.delete(k);
  oauthPending.set(nonce, { sessionId: sid(req), userId: req.user.id, verifier, at: Date.now() });
  let host = '';
  try { host = new URL(`${req.protocol}://${req.get('host')}`).hostname.toLowerCase(); } catch {}
  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(host);
  if (req.protocol !== 'https' && !isLoopback) {
    oauthPending.delete(nonce);
    return res.status(400).json({ error: 'OpenRouter sign-in requires HTTPS. Open Air Agent through your HTTPS domain, then try again.' });
  }
  const callback = `${req.protocol}://${req.get('host')}/ai/openrouter/callback`;
  const authUrl = new URL('https://openrouter.ai/auth');
  authUrl.searchParams.set('callback_url', callback);
  authUrl.searchParams.set('state', nonce);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('key_label', 'Air Agent');
  res.json({ url: authUrl.toString() });
});
app.get('/ai/openrouter/callback', auth, async (req, res) => {
  const state = String(req.query.state || '');
  const p = oauthPending.get(state);
  oauthPending.delete(state);
  const back = (msg) => res.redirect(`/#/model?${msg}`);
  if (!p || p.userId !== req.user.id || p.sessionId !== sid(req) || !req.query.code) return back('signin=failed');
  try {
    const r = await fetch('https://openrouter.ai/api/v1/auth/keys', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: String(req.query.code), code_verifier: p.verifier, code_challenge_method: 'S256' }),
      signal: AbortSignal.timeout(20_000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.key) throw new Error(d.error?.message || `HTTP ${r.status}`);
    const cur = getSettings(p.sessionId).options;
    saveSettings(p.sessionId, {
      options: { ai_mode: 'custom', ai_base_url: 'https://openrouter.ai/api/v1', ai_model: cur.ai_base_url === 'https://openrouter.ai/api/v1' && cur.ai_model ? cur.ai_model : 'openai/gpt-4o-mini' },
      secrets: { ai_key: d.key },
    });
    logEvent(p.sessionId, 'info', null, 'Signed in to OpenRouter — smarter AI connected');
    back('signin=ok');
  } catch (e) {
    console.error('OpenRouter sign-in failed:', e.message);
    back('signin=failed');
  }
});

// ---------- admin ----------
async function snapshot() {
  const mem = process.memoryUsage();
  const totals = q.msgTotals.get();
  return {
    version: config.version,
    uptimeSec: Math.round((Date.now() - started) / 1000),
    model: getApp('ai_model') || config.model,
    ollama: await ai.health(),
    ai: ai.getStats(),
    sessions: wa.summary(),
    messages: { total: totals.total || 0, last24h: totals.last24h || 0 },
    users: q.userCount.get().c,
    host: {
      load: os.loadavg().map((n) => n.toFixed(2)), cpus: os.cpus().length,
      memFreeMb: Math.round(os.freemem() / 1048576), memTotalMb: Math.round(os.totalmem() / 1048576),
      appRssMb: Math.round(mem.rss / 1048576),
    },
  };
}
app.get('/api/admin/stats', auth, admin, wrap(async (req, res) => {
  const users = q.listUsers.all().map((u) => ({ ...u, wa: wa.get(`u${u.id}`).status, phone: wa.get(`u${u.id}`).me?.phone || null }));
  res.json({ ...(await snapshot()), userList: users });
}));
app.get('/api/admin/settings', auth, admin, (req, res) => res.json({
  signup_open: getApp('signup_open') === '1', allow_custom_ai: getApp('allow_custom_ai') === '1',
  ai_base_url: getApp('ai_base_url'), ai_model: getApp('ai_model') || config.model, ai_key: mask(getAppSecret('ai_key')),
  voice_api_base: getApp('voice_api_base'), voice_api_model: getApp('voice_api_model'), voice_api_key: mask(getAppSecret('voice_api_key')),
  local_default_model: config.model, ollama_url: config.ollamaUrl, pulls: ai.pulls,
  mail_domain: getApp('mail_domain'), bot_smtp_host: getApp('bot_smtp_host'), bot_smtp_port: getApp('bot_smtp_port'), bot_smtp_user: getApp('bot_smtp_user'),
  bot_smtp_pass: mask(getAppSecret('bot_smtp_pass')), inbound_secret: email.inboundSecret(),
  inbound_url: `${req.protocol}://${req.get('host')}/api/inbound/email`,
}));
app.post('/api/admin/settings', auth, admin, wrap((req, res) => {
  const b = req.body || {};
  if ('signup_open' in b) setApp('signup_open', b.signup_open ? '1' : '0');
  if ('allow_custom_ai' in b) setApp('allow_custom_ai', b.allow_custom_ai ? '1' : '0');
  for (const k of ['ai_base_url', 'voice_api_base']) if (k in b) {
    const v = String(b[k] || '').trim();
    if (v && !/^https?:\/\//.test(v)) throw bad(`${k} must start with http(s)://`);
    setApp(k, v.replace(/\/$/, ''));
  }
  for (const k of ['ai_model', 'voice_api_model', 'bot_smtp_host', 'bot_smtp_user']) if (k in b) setApp(k, String(b[k] || '').trim().slice(0, 200));
  if ('bot_smtp_port' in b) setApp('bot_smtp_port', String(Number(b.bot_smtp_port) || 587));
  if ('mail_domain' in b) {
    const d = String(b.mail_domain || '').trim().toLowerCase();
    if (d && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) throw bad('Mail domain looks wrong (e.g. bots.yourdomain.com)');
    setApp('mail_domain', d);
  }
  for (const k of ['ai_key', 'voice_api_key', 'bot_smtp_pass']) if (k in b && !String(b[k]).startsWith('••••')) setAppSecret(k, String(b[k] || '').trim());
  res.json({ ok: true });
}));
app.post('/api/admin/pull', auth, admin, (req, res) => {
  const name = String(req.body?.model || '').trim();
  if (!/^[\w.\-/:]+$/.test(name)) return res.status(400).json({ error: 'Invalid model name' });
  res.json(ai.pullModel(name));
});
app.post('/api/admin/users', auth, admin, wrap((req, res) => {
  const { email, password, name, is_admin } = req.body || {};
  res.json({ id: createUser(email, password, name, !!is_admin) });
}));
app.post('/api/admin/users/:id', auth, admin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  if ('is_admin' in b) {
    if (id === req.user.id && !b.is_admin) throw bad("You can't remove your own admin rights");
    q.setAdmin.run(b.is_admin ? 1 : 0, id);
  }
  if (b.password) {
    if (String(b.password).length < 8) throw bad('Password must be at least 8 characters');
    q.setPassword.run(bcrypt.hashSync(String(b.password), 10), id);
    q.deleteUserTokens.run(id);
  }
  if (b.disconnect) await wa.get(`u${id}`).logout();
  res.json({ ok: true });
}));
app.delete('/api/admin/users/:id', auth, admin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) throw bad("You can't delete yourself");
  await wa.get(`u${id}`).logout();
  db.wipeSession(`u${id}`);
  q.deleteUserTokens.run(id);
  q.deleteUser.run(id);
  res.json({ ok: true });
}));
app.post('/api/admin/disconnect-all', auth, admin, wrap(async (req, res) => {
  const n = await wa.disconnectAll();
  console.log(`[admin] ${req.user.email} disconnected all WhatsApp sessions (${n})`);
  res.json({ ok: true, count: n });
}));

// Public health endpoint for uptime monitors (Uptime Kuma etc.) — no private data
app.get('/health', async (req, res) => {
  const o = await ai.health();
  res.status(o.ok ? 200 : 503).json({ ok: o.ok, uptimeSec: Math.round((Date.now() - started) / 1000) });
});

app.get('/metrics', auth, admin, async (req, res) => {
  const s = await snapshot();
  res.type('text/plain').send([
    `wa_agent_uptime_seconds ${s.uptimeSec}`,
    `wa_agent_users ${s.users}`,
    `wa_agent_sessions_open ${s.sessions.filter((x) => x.status === 'open').length}`,
    `wa_agent_messages_total ${s.messages.total}`,
    `wa_agent_ai_requests_total ${s.ai.requests}`,
    `wa_agent_ai_errors_total ${s.ai.errors}`,
    `wa_agent_ai_avg_ms ${s.ai.avgMs}`,
    `wa_agent_ollama_up ${s.ollama.ok ? 1 : 0}`,
  ].join('\n') + '\n');
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `File is larger than ${config.maxUploadMb} MB` : err.message });
  res.status(500).json({ error: err.message || 'Server error' });
});
app.get('/{*splat}', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// ---------- housekeeping ----------
if (config.retentionDays > 0) {
  const prune = () => { q.prune.run(config.retentionDays * 86400); q.pruneEvents.run(Math.max(30, config.retentionDays) * 86400); };
  prune();
  setInterval(prune, 6 * 3600_000).unref();
}

if (require.main === module) {
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`${config.botName} v${config.version} running on :${config.port} | AI ${getApp('ai_base_url') || config.ollamaUrl} model ${getApp('ai_model') || config.model}`);
    wa.restoreAll();
    actions.startScheduler(wa);
    email.startPoller(wa);
    require('./autoupdate').start(() => process.kill(process.pid, 'SIGTERM'));
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      for (const s of wa.sessions.values()) { try { s.sock?.end(undefined); } catch (_) {} }
      process.exit(0);
    });
  }
}

module.exports = app;
