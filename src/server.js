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
const website = require('./website-import');
const voice = require('./voice');
const actions = require('./actions');
const operations = require('./operations');
const { think } = require('./agent');
const wa = require('./wa');
const { mask } = require('./secrets');
const email = require('./email');
const recovery = require('./password-recovery');

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
const wrap = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch((e) => {
  if (res.headersSent) return next(e);
  const status = Number(e.status) >= 400 && Number(e.status) < 500 ? Number(e.status) : 500;
  res.status(status).json({ error: status === 500 ? 'Internal server error' : (e.message || 'Bad request') });
});
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

app.get('/api/public', (req, res) => res.json({ botName: config.botName, signupOpen: signupOpen() || q.userCount.get().c === 0, firstUser: q.userCount.get().c === 0, passwordRecoveryReady: recovery.isConfigured() }));

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
  q.deletePasswordResets.run(u.id);
  login(req, res, u.id);
  res.json({ ok: true });
}));

app.post('/api/account/delete-data', auth, wrap(async (req, res) => {
  const s = wa.get(sessionIdFor(req.user));
  await s.logout();
  db.wipeSession(s.id);
  res.json({ ok: true });
}));

// ---------- self-service password recovery ----------
// Always return the same message: callers must not learn whether an email has an account.
const resetSentMessage = 'If an account exists for that email and recovery email is set up, a reset link will arrive shortly. Please check spam too.';
app.post('/api/password/forgot', slowDown, wrap(async (req, res) => {
  const address = String(req.body?.email || '').trim().toLowerCase();
  if (address.length > 254 || !/^\S+@\S+\.\S+$/.test(address)) return res.status(400).json({ error: 'Enter a valid email address' });
  const user = q.userByEmail.get(address);
  if (!user || !recovery.isConfigured()) return res.json({ message: resetSentMessage });
  const now = Math.floor(Date.now() / 1000);
  q.prunePasswordResets.run(now);
  if (q.recentPasswordReset.get(user.id, now - recovery.RESET_COOLDOWN_SECONDS))
    return res.json({ message: resetSentMessage });
  const token = recovery.newToken();
  const hash = recovery.hashToken(token);
  // Only a SHA-256 digest is persisted. The raw token appears solely in the email URL.
  q.deletePasswordResets.run(user.id);
  q.issuePasswordReset.run(hash, user.id, now, now + recovery.RESET_TTL_SECONDS);
  try { await recovery.sendRecoveryEmail({ to: user.email, token }); }
  catch (err) {
    q.revokePasswordReset.run(hash);
    console.error('[password-recovery] Email delivery failed:', err.message);
  }
  res.json({ message: resetSentMessage });
}));

app.post('/api/password/reset', slowDown, wrap((req, res) => {
  const token = String(req.body?.token || '');
  const password = String(req.body?.password || '');
  if (!/^[a-f0-9]{64}$/i.test(token)) throw bad('This reset link is invalid or expired. Request a new one.', 400);
  if (password.length < 10 || password.length > 72) throw bad('Choose a password between 10 and 72 characters.', 400);
  const hash = recovery.hashToken(token.toLowerCase());
  const newHash = bcrypt.hashSync(password, 10);
  const updated = db.db.transaction(() => {
    const claimed = q.consumePasswordReset.get(hash, Math.floor(Date.now() / 1000));
    if (!claimed) return false;
    q.setPassword.run(newHash, claimed.user_id);
    q.deleteUserTokens.run(claimed.user_id);
    q.deletePasswordResets.run(claimed.user_id);
    return true;
  })();
  if (!updated) throw bad('This reset link is invalid or expired. Request a new one.', 400);
  res.clearCookie('token', { path: '/' });
  res.json({ ok: true, message: 'Password updated. Sign in with your new password.' });
}));
// ---------- which number are we editing ----------
function sessionFor(req) {
  const id = req.query.target === 'house' && req.user.is_admin ? 'house' : sessionIdFor(req.user);
  return wa.get(id);
}
const sid = (req) => sessionFor(req).id;

// Operations API uses cookie sessions only for configuration and separately scoped API keys for integrations.
operations.register(app, auth, sid, wrap);

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
app.post('/api/kb/website', auth, slowDown, wrap(async (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!url || url.length > 1400) throw bad('Enter a business website URL.');
  res.json(await website.importWebsite(sid(req), url));
}));
app.get('/api/kb/:id', auth, (req, res) => {
  const d = q.doc.get(Number(req.params.id), sid(req));
  if (!d) return res.status(404).json({ error: 'Not found' });
  res.json({ ...d, text: kb.documentText(sid(req), d.id).slice(0, 50000) });
});
app.delete('/api/kb/:id', auth, (req, res) => { kb.deleteDocument(sid(req), Number(req.params.id)); res.json({ ok: true }); });
app.post('/api/kb/search', auth, (req, res) => res.json(kb.search(sid(req), String(req.body?.q || ''), 5)));

// ---------- AI model ----------
app.get('/api/ai/models', auth, wrap(async (req, res) => {
  const settings = getSettings(sid(req));
  if (settings.options.ai_mode !== 'custom') throw bad('Connect a custom AI provider first');
  if (getApp('allow_custom_ai') !== '1') throw bad('The admin has disabled custom AI providers', 403);
  const provider = ai.resolveProvider(settings);
  const models = await ai.listModels(provider);
  res.json({ models: models.slice(0, 300), current: provider.model });
}));

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
app.get('/api/voice/status', auth, (req, res) => res.json({ local: voice.whisperStatus(), model: config.whisperModel, serverApi: voice.managedSpeechReady(), managed: voice.managedSpeechReady() }));
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
    b.automated = !!p.headers?.get('auto-submitted') && p.headers.get('auto-submitted') !== 'no';
    b.listMail = !!p.headers?.get('list-id') || !!p.headers?.get('list-unsubscribe') || !!p.headers?.get('precedence');
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
      automated: !!b.automated, listMail: !!b.listMail,
    }, wa);
    if (id) delivered++;
  }
  res.json({ ok: true, delivered });
}));

// ---------- one-click AI sign-in (OpenRouter OAuth, PKCE) ----------
// Two ways to sign in:
//  1. "Sign in on this device": the callback must come back to the same logged-in user + session.
//  2. Scan the QR code on your phone: the QR opens a confirm page here that shows which Air Agent
//     account will be connected; only after the person taps Continue is a callback from a browser
//     that isn't logged in accepted. A browser logged in as a *different* user is always rejected.
// Every state is single-use and expires after 15 minutes. The dashboard polls /status.
const QRCode = require('qrcode');
const OAUTH_TTL = 15 * 60_000;
const oauthPending = new Map(); // state -> { sessionId, userId, loginToken, email, verifier, authUrl, handoff, phoneOk, at }
const oauthDone = new Map();    // state -> { userId, ok, at }
const oauthHandoff = new Map(); // handoff token -> state
function oauthSweep() {
  const now = Date.now();
  for (const [k, v] of oauthPending) if (now - v.at > OAUTH_TTL) { oauthPending.delete(k); oauthHandoff.delete(v.handoff); }
  for (const [k, v] of oauthDone) if (now - v.at > OAUTH_TTL) oauthDone.delete(k);
}
const maskEmail = (e) => String(e || '').replace(/^(.)(.*)(.@.*)$/, (_, a, m, z) => a + '•'.repeat(Math.min(m.length, 6)) + z);
const htmlEsc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const simplePage = (icon, title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Air Agent</title>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;text-align:center;padding:16px;margin:0">
<div style="max-width:420px"><div style="font-size:56px">${icon}</div><h2>${title}</h2>${body}</div></body>`;

app.get('/api/ai/openrouter/start', auth, wrap(async (req, res) => {
  if (getApp('allow_custom_ai') !== '1') return res.status(403).json({ error: 'The admin has disabled custom AI providers' });
  let host = '';
  try { host = new URL(`${req.protocol}://${req.get('host')}`).hostname.toLowerCase(); } catch {}
  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(host);
  if (req.protocol !== 'https' && !isLoopback) {
    const ipHost = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? `https://${host.replace(/\./g, '-')}.sslip.io` : '';
    return res.status(400).json({ error: `OpenRouter sign-in requires HTTPS. ${ipHost ? `Open ${ipHost} (free HTTPS) and log in there, then try again.` : 'Open Air Agent through your HTTPS domain, then try again.'}`, https: ipHost || undefined });
  }
  oauthSweep();
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');
  const handoff = crypto.randomBytes(18).toString('base64url');
  const origin = `${req.protocol}://${req.get('host')}`;
  const authUrl = new URL('https://openrouter.ai/auth');
  authUrl.searchParams.set('callback_url', `${origin}/ai/openrouter/callback`);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('key_label', 'Air Agent');
  oauthPending.set(state, { sessionId: sid(req), userId: req.user.id, loginToken: req.cookies.token, email: req.user.email, verifier, authUrl: authUrl.toString(), handoff, phoneOk: false, at: Date.now() });
  oauthHandoff.set(handoff, state);
  const phoneUrl = `${origin}/ai/openrouter/phone?h=${handoff}`;
  const qr = await QRCode.toDataURL(phoneUrl, { margin: 1, width: 300 });
  res.json({ url: authUrl.toString(), qr, state });
}));

app.get('/api/ai/openrouter/status', auth, (req, res) => {
  const state = String(req.query.state || '');
  const d = oauthDone.get(state);
  if (d && d.userId === req.user.id) return res.json({ done: true, ok: d.ok });
  const p = oauthPending.get(state);
  res.json({ done: false, expired: !p || p.userId !== req.user.id });
});

// QR landing page on the phone: show which account gets connected before going to OpenRouter.
app.get('/ai/openrouter/phone', (req, res) => {
  oauthSweep();
  const state = oauthHandoff.get(String(req.query.h || ''));
  const p = state && oauthPending.get(state);
  if (!p) return res.status(410).type('html').send(simplePage('⌛', 'This code expired', '<p style="color:#555">Go back to the dashboard and click Sign in again.</p>'));
  res.type('html').send(simplePage('🔐', 'Connect OpenRouter',
    `<p style="color:#555">Your OpenRouter account will power the AI for this Air Agent account:</p>
     <p style="font-size:18px"><b>${htmlEsc(maskEmail(p.email))}</b></p>
     <p style="color:#a33;font-size:14px">Only continue if this is <b>your own</b> Air Agent account and you just scanned this code yourself.</p>
     <p><a href="/ai/openrouter/phone/go?h=${encodeURIComponent(String(req.query.h))}" style="display:inline-block;background:#00a884;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:600">Continue to OpenRouter</a></p>`));
});
app.get('/ai/openrouter/phone/go', (req, res) => {
  const state = oauthHandoff.get(String(req.query.h || ''));
  const p = state && oauthPending.get(state);
  if (!p) return res.redirect('/ai/openrouter/phone');
  oauthHandoff.delete(String(req.query.h));
  p.phoneOk = true;
  res.redirect(p.authUrl);
});

app.get('/ai/openrouter/callback', async (req, res) => {
  const state = String(req.query.state || '');
  const p = oauthPending.get(state);
  oauthPending.delete(state);
  if (p) oauthHandoff.delete(p.handoff);
  const user = req.cookies.token && q.userByToken.get(req.cookies.token);
  const sameSession = !!(p && user && user.id === p.userId && req.cookies.token === p.loginToken);
  const page = (ok) => res.type('html').send(ok
    ? simplePage('✅', 'Connected to OpenRouter', '<p style="color:#555">Your assistant now uses your OpenRouter account. You can close this page — the dashboard updates by itself.</p>')
    : simplePage('⚠️', 'Sign-in failed', '<p style="color:#555">Go back to the dashboard and try again.</p>'));
  const back = (ok) => (sameSession ? res.redirect(`/#/model?signin=${ok ? 'ok' : 'failed'}`) : page(ok));
  // Allowed: same user + same session, or a confirmed phone hand-off from a browser not logged in as someone else.
  const allowed = p && req.query.code && (sameSession || (p.phoneOk && (!user || user.id === p.userId)));
  if (!allowed) { if (p) oauthDone.set(state, { userId: p.userId, ok: false, at: Date.now() }); return back(false); }
  const finish = (ok) => oauthDone.set(state, { userId: p.userId, ok, at: Date.now() });
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
    finish(true);
    back(true);
  } catch (e) {
    console.error('OpenRouter sign-in failed:', e.message);
    finish(false);
    back(false);
  }
});

// ---------- free HTTPS (Caddy on-demand TLS) ----------
// Caddy asks here before getting a Let's Encrypt certificate for a hostname.
// Allowed: DOMAIN (env or Admin), or <this-server-ip>.sslip.io / .nip.io (free, no domain needed).
let publicIp = process.env.PUBLIC_IP || '';
async function getPublicIp() {
  if (publicIp) return publicIp;
  try { publicIp = (await (await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5000) })).text()).trim(); } catch {}
  return publicIp;
}
app.get('/api/tls/allow', wrap(async (req, res) => {
  const d = String(req.query.domain || '').toLowerCase();
  const custom = (process.env.DOMAIN || getApp('domain') || '').toLowerCase().trim();
  if (custom && d === custom) return res.send('ok');
  const m = d.match(/^(?:[a-z0-9-]+\.)?(\d{1,3})[.-](\d{1,3})[.-](\d{1,3})[.-](\d{1,3})\.(?:sslip|nip)\.io$/);
  if (m) {
    const ip = m.slice(1, 5).join('.');
    const mine = await getPublicIp();
    if (!mine || ip === mine) return res.send('ok');
  }
  res.status(403).send('no');
}));

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
  ai_daily_limit: getApp('ai_daily_limit'), voice_daily_seconds: getApp('voice_daily_seconds'),
  groqConfigured: !!(process.env.GROQ_API_KEY || (getApp('ai_base_url') === 'https://api.groq.com/openai/v1' && getAppSecret('ai_key'))),
  firecrawlConfigured: !!(process.env.FIRECRAWL_API_KEY || getAppSecret('firecrawl_key')),
  firecrawl_key: mask(getAppSecret('firecrawl_key')),
  local_default_model: config.model, ollama_url: config.ollamaUrl, pulls: ai.pulls,
  mail_domain: getApp('mail_domain'), bot_smtp_host: getApp('bot_smtp_host'), bot_smtp_port: getApp('bot_smtp_port'), bot_smtp_user: getApp('bot_smtp_user'),
  bot_smtp_pass: mask(getAppSecret('bot_smtp_pass')), reset_email_from: getApp('reset_email_from'), passwordRecoveryReady: recovery.isConfigured(), inbound_secret: email.inboundSecret(),
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
  if ('reset_email_from' in b) {
    const addr = String(b.reset_email_from || '').trim();
    if (addr && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(addr)) throw bad('Enter a valid password reset sender email');
    setApp('reset_email_from', addr);
  }
  for (const k of ['ai_daily_limit', 'voice_daily_seconds']) if (k in b) {
    const n = Number(b[k]);
    if (!Number.isSafeInteger(n) || n < 1 || n > 100000) throw bad(`${k} must be between 1 and 100,000`);
    setApp(k, String(n));
  }
  for (const k of ['ai_model', 'voice_api_model', 'bot_smtp_host', 'bot_smtp_user']) if (k in b) setApp(k, String(b[k] || '').trim().slice(0, 200));
  if ('bot_smtp_port' in b) setApp('bot_smtp_port', String(Number(b.bot_smtp_port) || 587));
  if ('mail_domain' in b) {
    const d = String(b.mail_domain || '').trim().toLowerCase();
    if (d && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) throw bad('Mail domain looks wrong (e.g. bots.yourdomain.com)');
    setApp('mail_domain', d);
  }
  for (const k of ['ai_key', 'voice_api_key', 'bot_smtp_pass', 'firecrawl_key']) if (k in b && !String(b[k]).startsWith('••••')) setAppSecret(k, String(b[k] || '').trim());
  res.json({ ok: true });
}));
// Test the real SMTP submission path without exposing credentials to the browser.
app.post('/api/admin/password-recovery/test', auth, admin, slowDown, wrap(async (req, res) => {
  if (!recovery.isConfigured()) throw bad('Set your SMTP host, username and password in Admin first.', 400);
  await recovery.sendTestEmail({ to: req.user.email });
  res.json({
    ok: true, recipient: req.user.email,
    message: 'SMTP accepted the test email. Check your inbox and spam folder; acceptance does not guarantee delivery.',
  });
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
    q.deletePasswordResets.run(id);
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
  res.status(o.ok ? 200 : 503).json({ ok: o.ok, version: config.version, uptimeSec: Math.round((Date.now() - started) / 1000) });
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
  const status = Number(err.status) >= 400 && Number(err.status) < 500 ? Number(err.status) : 500;
  res.status(status).json({ error: status === 500 ? 'Internal server error' : (err.message || 'Bad request') });
});
app.get('/{*splat}', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// ---------- housekeeping ----------
if (config.retentionDays > 0) {
  const prune = () => { q.prune.run(config.retentionDays * 86400); q.pruneEvents.run(Math.max(30, config.retentionDays) * 86400); q.pruneDaily.run(); q.prunePasswordResets.run(Math.floor(Date.now() / 1000)); operations.pruneEvents(config.retentionDays); };
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
