const path = require('path');
const crypto = require('crypto');
const os = require('os');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const config = require('./config');
const { q, getSettings } = require('./db');
const ai = require('./ai');
const wa = require('./wa');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

const started = Date.now();
const sessionIdFor = (user) => `u${user.id}`;

// ---------- auth ----------
function auth(req, res, next) {
  const user = req.cookies.token && q.userByToken.get(req.cookies.token);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  req.user = user;
  next();
}
const admin = (req, res, next) => (req.user.is_admin ? next() : res.status(403).json({ error: 'Admins only' }));

function login(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  q.insertToken.run(token, userId);
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: 1000 * 60 * 60 * 24 * 90 });
}

const tries = new Map();
function slowDown(req, res, next) {
  const k = req.ip; const now = Date.now();
  const arr = (tries.get(k) || []).filter((t) => now - t < 15 * 60_000);
  if (arr.length >= 20) return res.status(429).json({ error: 'Too many attempts, try again later' });
  arr.push(now); tries.set(k, arr); next();
}

app.post('/api/signup', slowDown, (req, res) => {
  const { email, password, name } = req.body || {};
  const first = q.userCount.get().c === 0;
  if (!config.openSignup && !first) return res.status(403).json({ error: 'Signups are closed' });
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Valid email required' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (q.userByEmail.get(email.toLowerCase())) return res.status(409).json({ error: 'Email already registered' });
  const info = q.insertUser.run(email.toLowerCase(), (name || '').slice(0, 80), bcrypt.hashSync(password, 10), first ? 1 : 0);
  login(res, info.lastInsertRowid);
  res.json({ ok: true, admin: first });
});

app.post('/api/login', slowDown, (req, res) => {
  const { email, password } = req.body || {};
  const u = email && q.userByEmail.get(String(email).toLowerCase());
  if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash)) return res.status(401).json({ error: 'Wrong email or password' });
  login(res, u.id);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  if (req.cookies.token) q.deleteToken.run(req.cookies.token);
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  const house = wa.get('house');
  res.json({
    user: req.user,
    botName: config.botName,
    houseNumber: house.status === 'open' ? house.me?.phone : null,
  });
});

// ---------- WhatsApp linking ----------
function sessionFor(req) {
  const id = req.query.target === 'house' && req.user.is_admin ? 'house' : sessionIdFor(req.user);
  return wa.get(id);
}

app.post('/api/wa/connect', auth, async (req, res) => {
  const s = sessionFor(req);
  s.retries = 0;
  try { await s.start(); } catch (e) { return res.status(500).json({ error: e.message }); }
  res.json(s.info());
});
app.get('/api/wa/status', auth, (req, res) => res.json(sessionFor(req).info()));
app.post('/api/wa/logout', auth, async (req, res) => { const s = sessionFor(req); await s.logout(); res.json(s.info()); });

// ---------- settings ----------
app.get('/api/settings', auth, (req, res) => res.json(getSettings(sessionFor(req).id)));
app.post('/api/settings', auth, (req, res) => {
  const id = sessionFor(req).id;
  const b = req.body || {};
  q.upsertSettings.run({
    session_id: id,
    persona: String(b.persona || '').slice(0, 2000),
    auto_reply: b.auto_reply ? 1 : 0,
    reply_groups: b.reply_groups ? 1 : 0,
    enabled: b.enabled === false ? 0 : 1,
  });
  res.json(getSettings(id));
});

// ---------- try the AI in the browser ----------
app.post('/api/test-ai', auth, async (req, res) => {
  try {
    const reply = await ai.chat([{ role: 'user', content: String(req.body?.text || 'Say hi in one sentence.').slice(0, 2000) }]);
    res.json({ reply });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- admin / monitoring ----------
async function snapshot() {
  const mem = process.memoryUsage();
  const totals = q.msgTotals.get();
  return {
    uptimeSec: Math.round((Date.now() - started) / 1000),
    model: config.model,
    ollama: await ai.health(),
    ai: ai.getStats(),
    sessions: wa.summary(),
    messages: { total: totals.total || 0, last24h: totals.last24h || 0 },
    users: q.userCount.get().c,
    host: {
      load: os.loadavg().map((n) => n.toFixed(2)),
      memFreeMb: Math.round(os.freemem() / 1048576),
      memTotalMb: Math.round(os.totalmem() / 1048576),
      appRssMb: Math.round(mem.rss / 1048576),
    },
  };
}
app.get('/api/admin/stats', auth, admin, async (req, res) => res.json({ ...(await snapshot()), userList: q.listUsers.all() }));

// Public health endpoint for uptime monitors (Uptime Kuma etc.)
app.get('/health', async (req, res) => {
  const o = await ai.health();
  const house = wa.get('house');
  const body = { ok: true, ollama: o.ok, modelReady: o.modelReady, houseNumber: house.status, uptimeSec: Math.round((Date.now() - started) / 1000) };
  res.status(o.ok ? 200 : 503).json(body);
});

// Prometheus-style metrics
app.get('/metrics', async (req, res) => {
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

app.get('/{*splat}', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// ---------- housekeeping ----------
if (config.retentionDays > 0) {
  setInterval(() => q.prune.run(config.retentionDays * 86400), 6 * 3600_000).unref();
}

app.listen(config.port, '0.0.0.0', () => {
  console.log(`${config.botName} running on :${config.port} | model ${config.model} @ ${config.ollamaUrl}`);
  wa.restoreAll();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    for (const s of wa.sessions.values()) { try { s.sock?.end(undefined); } catch (_) {} }
    process.exit(0);
  });
}
