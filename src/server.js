const path = require('path');
const crypto = require('crypto');
const os = require('os');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const config = require('./config');
const { q, getSettings, cleanOptions } = require('./db');
const { hasApprovedNumbers } = require('./security');
const ai = require('./ai');
const wa = require('./wa');
const mail = require('./mail');

const app = express();
app.disable('x-powered-by');
// Signed inbound relay: validate the original JSON bytes before parsing.
app.post('/api/webhooks/inbound-email', express.raw({ type: 'application/json', limit: '65kb' }), (req, res) => {
  if (!Buffer.isBuffer(req.body) ||
      !mail.verifyInbound(req.body, req.get('x-air-timestamp'), req.get('x-air-signature')))
    return res.status(403).json({ error: 'Invalid webhook signature' });
  let payload;
  try { payload = JSON.parse(req.body.toString('utf8')); }
  catch (_) { return res.status(400).json({ error: 'Invalid email payload' }); }
  mail.ingest(payload);
  return res.status(202).json({ accepted: true });
});
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public')));

const started = Date.now();
const sessionIdFor = (user) => `u${user.id}`;

// Bearer tokens are one-way hashed in SQLite, protecting browser sessions if the DB is copied.
const tokenHash = (token) => 'sha256:' + crypto.createHash('sha256').update(String(token)).digest('hex');
const constantTimeMatch = (a, b) => crypto.timingSafeEqual(
  crypto.createHash('sha256').update(String(a)).digest(),
  crypto.createHash('sha256').update(String(b)).digest());

// ---------- auth ----------
function auth(req, res, next) {
  const user = req.cookies.token && q.userByToken.get(tokenHash(req.cookies.token));
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  req.user = user;
  next();
}
const admin = (req, res, next) => (req.user.is_admin ? next() : res.status(403).json({ error: 'Admins only' }));

function login(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  q.insertToken.run(tokenHash(token), userId);
  res.cookie('token', token, { httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, maxAge: 1000 * 60 * 60 * 24 * 7 });
}

const tries = new Map();
function slowDown(req, res, next) {
  const k = req.ip; const now = Date.now();
  const arr = (tries.get(k) || []).filter((t) => now - t < 15 * 60_000);
  if (arr.length >= 20) return res.status(429).json({ error: 'Too many attempts, try again later' });
  arr.push(now); tries.set(k, arr); next();
}

// Bootstrap requires a strong setup token set privately on the server, not just being first.
app.get('/api/auth/config', (req, res) =>
  res.json({ firstUser: q.userCount.get().c === 0, signupEnabled: config.openSignup }));

app.post('/api/signup', slowDown, (req, res) => {
  const { email, password, name, setupToken } = req.body || {};
  const first = q.userCount.get().c === 0;
  if (first) {
    if (config.bootstrapAdminToken.length < 24 ||
        !constantTimeMatch(setupToken || '', config.bootstrapAdminToken)) {
      return res.status(403).json({ error: 'First admin requires BOOTSTRAP_ADMIN_TOKEN (24+ characters) configured on the server.' });
    }
  } else if (!config.openSignup) {
    return res.status(403).json({ error: 'Signups are closed' });
  }
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
  if (req.cookies.token) q.deleteToken.run(tokenHash(req.cookies.token));
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

// Emergency switch: revoke every locally stored linked-device session.
// For sessions offline during revocation, also remove them in WhatsApp Linked Devices.
app.post('/api/admin/disconnect-all', auth, admin, async (req, res) => {
  try {
    const result = await wa.logoutAll();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: 'Not all sessions could be disconnected; check server logs.' });
  }
});

// ---------- settings ----------
app.get('/api/settings', auth, (req, res) => res.json(getSettings(sessionFor(req).id)));
app.post('/api/settings', auth, (req, res) => {
  const id = sessionFor(req).id;
  const b = req.body || {};
  const current = getSettings(id);
  const options = { ...current.options, ...cleanOptions(b.options) };
  const autoReply = (b.auto_reply ?? current.auto_reply) ? 1 : 0;
  const replyGroups = (b.reply_groups ?? current.reply_groups) ? 1 : 0;
  if (options.control_enabled && !hasApprovedNumbers(options.control_numbers)) {
    return res.status(400).json({ error: 'Add an approved controller phone number before enabling commands.' });
  }
  if (id !== 'house' && (autoReply || replyGroups) && !hasApprovedNumbers(options.allow_list)) {
    return res.status(400).json({ error: 'Personal WhatsApp incoming replies require an approved international phone number.' });
  }
  q.upsertSettings.run({
    session_id: id,
    persona: String(b.persona ?? current.persona ?? '').slice(0, 2000),
    auto_reply: autoReply,
    reply_groups: replyGroups,
    enabled: b.enabled === false ? 0 : 1,
    options: JSON.stringify(options),
  });
  if (current.options.context_enabled && !options.context_enabled) q.clearObserved.run(id);
  res.json(getSettings(id));
});

// ---------- reply-once & opt-in context ----------
app.get('/api/reply-state', auth, (req, res) => {
  res.json({ answeredChats: q.receiptCount.get(sessionFor(req).id).c });
});
app.post('/api/reply-state/reset', auth, (req, res) => {
  q.clearReceipts.run(sessionFor(req).id);
  res.json({ ok: true, answeredChats: 0 });
});

// ---------- authorized controller ----------
app.get('/api/controller/status', auth, (req, res) => {
  const id = sessionFor(req).id;
  res.json({ hasPin: !!q.getControllerPin.get(id), recent: q.listControllerAudit.all(id) });
});
app.post('/api/controller/pin', auth, (req, res) => {
  const pin = String(req.body?.pin || '');
  if (!/^(?=.*[a-zA-Z])(?=.*[0-9])[A-Za-z0-9!@#$%*_-]{10,64}$/.test(pin))
    return res.status(400).json({ error: 'Use a 10–64 character PIN with letters and numbers (no spaces).' });
  q.setControllerPin.run(sessionFor(req).id, bcrypt.hashSync(pin, 12));
  res.json({ ok: true });
});

// ---------- optional bot email ----------
app.get('/api/email/status', auth, (req, res) => {
  res.json({ ...mail.readiness(), address: mail.mailbox(sessionFor(req).id) });
});
app.post('/api/email/provision', auth, (req, res) => {
  try { res.json({ address: mail.provision(sessionFor(req).id) }); }
  catch (err) { res.status(409).json({ error: err.message }); }
});
app.get('/api/email/inbox', auth, (req, res) => {
  res.json({ messages: q.listBotEmails.all(sessionFor(req).id) });
});
app.get('/api/email/inbox/:id', auth, (req, res) => {
  const m = q.getBotEmail.get(sessionFor(req).id, Number(req.params.id));
  if (!m) return res.status(404).json({ error: 'Message not found' });
  res.json({ message: m });
});
app.post('/api/email/send', auth, async (req, res) => {
  try {
    const id = sessionFor(req).id;
    res.json(await mail.send({ sessionId: id, to: req.body?.to,
      subject: req.body?.subject, text: req.body?.text }));
  } catch (err) { res.status(422).json({ error: err.message }); }
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
app.get('/api/admin/reply-audit', auth, admin, (req, res) =>
  res.json({ events: q.listReplyAudits.all(100) }));

// Public health endpoint for uptime monitors (Uptime Kuma etc.)
app.get('/health', async (req, res) => {
  const o = await ai.health();
  const house = wa.get('house');
  const body = { ok: true, ollama: o.ok, modelReady: o.modelReady, houseNumber: house.status, uptimeSec: Math.round((Date.now() - started) / 1000) };
  res.status(o.ok ? 200 : 503).json(body);
});

// Prometheus-style metrics
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

app.get('/{*splat}', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// ---------- housekeeping ----------
if (config.retentionDays > 0) {
  setInterval(() => {
    q.prune.run(config.retentionDays * 86400);
    q.pruneReplyAudits.run(config.retentionDays * 86400);
    q.pruneObserved.run(config.retentionDays * 86400);
    q.pruneControllerAudit.run(config.retentionDays * 86400);
    q.pruneProcessedControllers.run(config.retentionDays * 86400);
    q.pruneBotEmails.run(config.retentionDays * 86400);
  }, 6 * 3600_000).unref();
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
