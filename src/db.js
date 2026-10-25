const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('./config');
const { encrypt, decrypt, mask } = require('./secrets');

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new Database(path.join(config.dataDir, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  password_hash TEXT NOT NULL,
  is_admin INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS auth_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_reset_user ON password_reset_tokens(user_id);
CREATE TABLE IF NOT EXISTS settings (
  session_id TEXT PRIMARY KEY,
  persona TEXT,
  auto_reply INTEGER DEFAULT 0,
  reply_groups INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  ts INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_msg_chat ON messages(session_id, chat_jid, id);
CREATE TABLE IF NOT EXISTS muted_chats (
  session_id TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  PRIMARY KEY (session_id, chat_jid)
);

-- v2 --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS daily_ai_usage (
  session_id TEXT NOT NULL, day TEXT NOT NULL, calls INTEGER DEFAULT 0,
  voice_seconds INTEGER DEFAULT 0, PRIMARY KEY(session_id, day)
);
CREATE TABLE IF NOT EXISTS session_secrets (
  session_id TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (session_id, name)
);
CREATE TABLE IF NOT EXISTS chats (
  session_id TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  name TEXT,
  phone TEXT,
  is_group INTEGER DEFAULT 0,
  paused_until INTEGER DEFAULT 0,   -- unix seconds; -1 = paused until turned back on
  last_ts INTEGER DEFAULT 0,
  replies INTEGER DEFAULT 0,
  PRIMARY KEY (session_id, chat_jid)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ts INTEGER DEFAULT (strftime('%s','now')),
  type TEXT NOT NULL,               -- reply | voice | action | handoff | rule | error | info
  chat_jid TEXT,
  summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_events ON events(session_id, id);
CREATE TABLE IF NOT EXISTS kb_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,               -- file | text
  size INTEGER DEFAULT 0,
  chars INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks USING fts5(content, doc_id UNINDEXED, session_id UNINDEXED, tokenize = 'unicode61');
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  due_ts INTEGER NOT NULL,
  text TEXT NOT NULL,
  status TEXT DEFAULT 'pending',    -- pending | sent | failed | cancelled
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  source TEXT NOT NULL,             -- imap | inbound
  uid TEXT NOT NULL,
  from_addr TEXT, from_name TEXT, to_addr TEXT,
  subject TEXT, text TEXT, message_id TEXT,
  date INTEGER,
  created_at INTEGER DEFAULT (strftime('%s','now')),
  UNIQUE (session_id, source, uid)
);
CREATE INDEX IF NOT EXISTS idx_emails ON emails(session_id, id);
CREATE TABLE IF NOT EXISTS bot_emails (local TEXT PRIMARY KEY, session_id TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  chat_jid TEXT,
  contact TEXT,
  text TEXT NOT NULL,
  ts INTEGER DEFAULT (strftime('%s','now'))
);
`);
for (const sql of [
  'ALTER TABLE settings ADD COLUMN options TEXT',
  'ALTER TABLE messages ADD COLUMN kind TEXT DEFAULT \'text\'',
]) { try { db.exec(sql); } catch (_) { /* already there */ } }

// Old per-chat mutes become "paused until turned back on".
db.exec(`INSERT OR IGNORE INTO chats (session_id, chat_jid, paused_until) SELECT session_id, chat_jid, -1 FROM muted_chats;
         DELETE FROM muted_chats;`);

// Every per-number option with its default. Shown in the dashboard and enforced in agent.js.
// SAFE DEFAULTS: the AI only talks to the owner until the owner chooses otherwise.
const DEFAULT_OPTIONS = {
  // ---- who it answers
  reply_mode: 'me',          // me | allow | everyone   (private chats from other people)
  self_chat: true,           // answer in the owner's "Message yourself" chat
  ai_trigger: true,          // owner can type "/ai ..." in any chat
  trigger_word: '/ai',
  allow_list: '',            // numbers for reply_mode=allow
  block_list: '',            // never reply to these numbers
  group_mode: 'off',         // off | mention | selected
  selected_groups: [],       // [{jid, name}]
  selected_groups_reply: 'mention', // mention | all
  pause_on_manual: true,     // stop the AI in a chat when the owner types there
  pause_minutes: 60,
  pause_forever: false,      // ...until the owner turns it back on
  reply_once: false,         // answer each person once, then leave the chat to the owner
  context_messages: 10,      // read the last N messages of the chat for context (0 = off)
  owner_numbers: '',         // "command numbers": treated as the owner, can trigger any action
  // ---- style
  prefix_on: true,           // start replies to other people with a label
  prefix_text: '🤖',
  use_emojis: true,
  quote_reply: false,
  typing: true,
  reply_delay: 0,            // seconds
  memory: true,
  reply_length: 'short',     // short | medium | long
  language: '',              // empty = same language as the sender
  // ---- hours
  quiet_enabled: false,
  quiet_start: '22:00',
  quiet_end: '08:00',
  timezone: 'America/New_York',
  away_message: '',
  // ---- brain
  bot_name: '',
  about: '',                 // who the AI works for / what the business does
  tone: 'friendly',          // friendly | professional | casual | funny | custom
  rules: '',                 // always / never rules
  faq: [],                   // [{q, a}]
  keyword_rules: [],         // [{keyword, match: contains|exact, reply}]
  use_knowledge: true,
  booking_url: '',         // verified customer-provided scheduling page; never claim booked from a link
  // ---- AI model
  ai_mode: 'server',         // server | custom
  ai_base_url: '',
  ai_model: '',
  // ---- voice
  voice_in: true,            // understand voice notes
  voice_engine: 'smart',     // smart | server | api
  voice_reply: false,        // answer voice notes with a voice note (needs a speech API)
  tts_voice: 'alloy',
  tts_model: 'tts-1',
  voice_api_model: '',
  voice_transcript_self: true, // in "Message yourself", show the transcript first
  // ---- actions: who may use each one (off | me | anyone)
  act_email: 'me',
  act_call: 'me',
  act_whatsapp: 'me',
  act_reminder: 'me',
  act_webhook: 'off',
  act_ticket: 'me', // create and read helpdesk tickets: owner/command numbers only
  act_note: 'anyone',
  act_notify: 'anyone',
  act_booking: 'anyone',   // share booking page or save a request for a person
  confirm_actions: true,     // ask "yes/no" before email, calls and WhatsApp sends
  smtp_host: '', smtp_port: 587, smtp_user: '', smtp_from: '', smtp_secure: false,
  call_provider: 'twilio',   // twilio (more later)
  twilio_sid: '', twilio_from: '',
  webhook_url: '',
  // ---- bot email
  act_email_read: 'me',      // read & reply to the bot's emails (off | me)
  mail_check: true,          // check the connected mailbox
  mail_notify: true,         // WhatsApp me when a new email arrives
  mail_auto_reply: false,    // optional; OFF until customer explicitly enables it
  imap_host: '', imap_port: 993, imap_user: '', imap_secure: true,
};

const SECRET_NAMES = ['ai_key', 'smtp_pass', 'twilio_token', 'voice_api_key', 'webhook_secret', 'imap_pass'];

const q = {
  // users / auth
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT id, email, name, is_admin, created_at FROM users WHERE id = ?'),
  userCount: db.prepare('SELECT COUNT(*) c FROM users'),
  insertUser: db.prepare('INSERT INTO users (email, name, password_hash, is_admin) VALUES (?, ?, ?, ?)'),
  setAdmin: db.prepare('UPDATE users SET is_admin = ? WHERE id = ?'),
  setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
  insertToken: db.prepare('INSERT INTO auth_tokens (token, user_id) VALUES (?, ?)'),
  userByToken: db.prepare(`SELECT u.id, u.email, u.name, u.is_admin FROM auth_tokens t JOIN users u ON u.id = t.user_id
                           WHERE t.token = ? AND t.created_at > strftime('%s','now') - 7776000`),
  deleteToken: db.prepare('DELETE FROM auth_tokens WHERE token = ?'),
  deleteUserTokens: db.prepare('DELETE FROM auth_tokens WHERE user_id = ?'),
  recentPasswordReset: db.prepare('SELECT created_at FROM password_reset_tokens WHERE user_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1'),
  deletePasswordResets: db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?'),
  issuePasswordReset: db.prepare('INSERT INTO password_reset_tokens (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
  revokePasswordReset: db.prepare('DELETE FROM password_reset_tokens WHERE token_hash = ?'),
  consumePasswordReset: db.prepare('DELETE FROM password_reset_tokens WHERE token_hash = ? AND expires_at > ? RETURNING user_id'),
  prunePasswordResets: db.prepare('DELETE FROM password_reset_tokens WHERE expires_at <= ?'),
  listUsers: db.prepare('SELECT id, email, name, is_admin, created_at FROM users ORDER BY id DESC'),
  // Persistent per-number daily limits (UTC); count failed calls against limit.
  claimAi: db.prepare(`INSERT INTO daily_ai_usage (session_id, day, calls) VALUES (?, date('now'), 1)
    ON CONFLICT(session_id, day) DO UPDATE SET calls = calls + 1 WHERE calls < ?`),
  claimVoice: db.prepare(`INSERT INTO daily_ai_usage (session_id, day, voice_seconds) VALUES (?, date('now'), ?)
    ON CONFLICT(session_id, day) DO UPDATE SET voice_seconds = voice_seconds + excluded.voice_seconds
    WHERE voice_seconds + excluded.voice_seconds <= ?`),
  usageToday: db.prepare("SELECT calls, voice_seconds FROM daily_ai_usage WHERE session_id = ? AND day = date('now')"),
  pruneDaily: db.prepare("DELETE FROM daily_ai_usage WHERE day < date('now', '-45 days')"),
  // app settings
  getApp: db.prepare('SELECT value FROM app_settings WHERE key = ?'),
  setApp: db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  // per-number settings
  getSettings: db.prepare('SELECT * FROM settings WHERE session_id = ?'),
  upsertSettings: db.prepare(`INSERT INTO settings (session_id, persona, auto_reply, reply_groups, enabled, options)
    VALUES (@session_id, @persona, 0, 0, @enabled, @options)
    ON CONFLICT(session_id) DO UPDATE SET persona=@persona, enabled=@enabled, options=@options`),
  getSecret: db.prepare('SELECT value FROM session_secrets WHERE session_id = ? AND name = ?'),
  setSecret: db.prepare(`INSERT INTO session_secrets (session_id, name, value) VALUES (?, ?, ?)
    ON CONFLICT(session_id, name) DO UPDATE SET value = excluded.value`),
  delSecret: db.prepare('DELETE FROM session_secrets WHERE session_id = ? AND name = ?'),
  // chats
  touchChat: db.prepare(`INSERT INTO chats (session_id, chat_jid, name, phone, is_group, last_ts) VALUES (@s, @j, @name, @phone, @g, strftime('%s','now'))
    ON CONFLICT(session_id, chat_jid) DO UPDATE SET name = COALESCE(NULLIF(@name, ''), name), phone = COALESCE(NULLIF(@phone, ''), phone),
    last_ts = strftime('%s','now')`),
  chat: db.prepare('SELECT * FROM chats WHERE session_id = ? AND chat_jid = ?'),
  countReply: db.prepare('UPDATE chats SET replies = replies + 1 WHERE session_id = ? AND chat_jid = ?'),
  pauseChat: db.prepare(`INSERT INTO chats (session_id, chat_jid, paused_until) VALUES (?, ?, ?)
    ON CONFLICT(session_id, chat_jid) DO UPDATE SET paused_until = excluded.paused_until`),
  listChats: db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = c.session_id AND m.chat_jid = c.chat_jid) msgs
    FROM chats c WHERE c.session_id = ? ORDER BY c.last_ts DESC LIMIT 300`),
  // messages (AI memory)
  addMsg: db.prepare('INSERT INTO messages (session_id, chat_jid, role, content, kind) VALUES (?, ?, ?, ?, ?)'),
  history: db.prepare('SELECT role, content FROM (SELECT id, role, content FROM messages WHERE session_id = ? AND chat_jid = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC'),
  chatMessages: db.prepare('SELECT role, content, kind, ts FROM messages WHERE session_id = ? AND chat_jid = ? ORDER BY id DESC LIMIT 200'),
  clearChat: db.prepare('DELETE FROM messages WHERE session_id = ? AND chat_jid = ?'),
  msgTotals: db.prepare("SELECT COUNT(*) total, SUM(ts > strftime('%s','now') - 86400) last24h FROM messages"),
  prune: db.prepare("DELETE FROM messages WHERE ts < strftime('%s','now') - ?"),
  pruneEvents: db.prepare("DELETE FROM events WHERE ts < strftime('%s','now') - ?"),
  // events
  addEvent: db.prepare('INSERT INTO events (session_id, type, chat_jid, summary) VALUES (?, ?, ?, ?)'),
  events: db.prepare('SELECT e.*, c.name, c.phone FROM events e LEFT JOIN chats c ON c.session_id = e.session_id AND c.chat_jid = e.chat_jid WHERE e.session_id = ? ORDER BY e.id DESC LIMIT ?'),
  eventCounts: db.prepare("SELECT type, COUNT(*) n FROM events WHERE session_id = ? AND ts > strftime('%s','now') - 86400 GROUP BY type"),
  // knowledge
  addDoc: db.prepare('INSERT INTO kb_docs (session_id, name, kind, size, chars) VALUES (?, ?, ?, ?, ?)'),
  docs: db.prepare('SELECT * FROM kb_docs WHERE session_id = ? ORDER BY id DESC'),
  doc: db.prepare('SELECT * FROM kb_docs WHERE id = ? AND session_id = ?'),
  delDoc: db.prepare('DELETE FROM kb_docs WHERE id = ? AND session_id = ?'),
  addChunk: db.prepare('INSERT INTO kb_chunks (content, doc_id, session_id) VALUES (?, ?, ?)'),
  delChunks: db.prepare('DELETE FROM kb_chunks WHERE doc_id = ? AND session_id = ?'),
  docText: db.prepare('SELECT content FROM kb_chunks WHERE doc_id = ? AND session_id = ? ORDER BY rowid'),
  searchChunks: db.prepare(`SELECT content, doc_id, bm25(kb_chunks) score FROM kb_chunks
    WHERE kb_chunks MATCH ? AND session_id = ? ORDER BY score LIMIT ?`),
  // reminders & notes
  addReminder: db.prepare('INSERT INTO reminders (session_id, chat_jid, due_ts, text) VALUES (?, ?, ?, ?)'),
  dueReminders: db.prepare("SELECT * FROM reminders WHERE status = 'pending' AND due_ts <= strftime('%s','now') ORDER BY due_ts LIMIT 50"),
  setReminder: db.prepare('UPDATE reminders SET status = ? WHERE id = ?'),
  listReminders: db.prepare("SELECT * FROM reminders WHERE session_id = ? ORDER BY (status = 'pending') DESC, due_ts DESC LIMIT 100"),
  cancelReminder: db.prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ? AND session_id = ? AND status = 'pending'"),
  addEmail: db.prepare(`INSERT OR IGNORE INTO emails (session_id, source, uid, from_addr, from_name, to_addr, subject, text, message_id, date)
    VALUES (@s, @source, @uid, @from_addr, @from_name, @to_addr, @subject, @text, @message_id, @date)`),
  listEmails: db.prepare('SELECT id, source, from_addr, from_name, to_addr, subject, substr(text, 1, 400) snippet, date, message_id FROM emails WHERE session_id = ? ORDER BY id DESC LIMIT ?'),
  email: db.prepare('SELECT * FROM emails WHERE id = ? AND session_id = ?'),
  claimEmail: db.prepare('INSERT INTO bot_emails (local, session_id) VALUES (?, ?)'),
  releaseEmail: db.prepare('DELETE FROM bot_emails WHERE session_id = ?'),
  emailOf: db.prepare('SELECT local FROM bot_emails WHERE session_id = ?'),
  sessionOfEmail: db.prepare('SELECT session_id FROM bot_emails WHERE local = ?'),
  addNote: db.prepare('INSERT INTO notes (session_id, chat_jid, contact, text) VALUES (?, ?, ?, ?)'),
  listNotes: db.prepare('SELECT * FROM notes WHERE session_id = ? ORDER BY id DESC LIMIT 200'),
  delNote: db.prepare('DELETE FROM notes WHERE id = ? AND session_id = ?'),
};

// ---------- app-wide settings (admin) ----------
const APP_DEFAULTS = {
  signup_open: '0',
  allow_custom_ai: '1',
  ai_base_url: '',      // empty = local Ollama
  ai_model: '',         // empty = MODEL env
  voice_api_base: '',
  voice_api_model: 'whisper-1',
  ai_daily_limit: '300',
  voice_daily_seconds: '3600',
  mail_domain: '',      // e.g. bots.airbiz.ai  -> each bot can claim name@bots.airbiz.ai
  bot_smtp_host: '', bot_smtp_port: '587', bot_smtp_user: '', reset_email_from: '',
};
function getApp(key) { const r = q.getApp.get(key); return r ? r.value : APP_DEFAULTS[key]; }
function setApp(key, value) { q.setApp.run(key, String(value ?? '')); }
function getAppSecret(name) { return decrypt(getApp('secret_' + name) || ''); }
function setAppSecret(name, value) { setApp('secret_' + name, value ? encrypt(value) : ''); }

// ---------- per-number settings ----------
function getSettings(sessionId) {
  const row = q.getSettings.get(sessionId) || { session_id: sessionId, persona: '', enabled: 1, options: null };
  let opts = {};
  try { opts = JSON.parse(row.options || '{}'); } catch (_) {}
  const defaults = { ...DEFAULT_OPTIONS, ...(sessionId === 'house' ? { prefix_on: false, reply_mode: 'everyone', act_email: 'off', act_call: 'off', act_whatsapp: 'off', act_reminder: 'off' } : {}) };
  // v1 -> v2: older installs had no reply_mode; they start in the safe "only me" mode.
  return { session_id: sessionId, persona: row.persona || '', enabled: row.enabled === 0 ? 0 : 1, options: { ...defaults, ...opts } };
}

const ENUMS = {
  reply_mode: ['me', 'allow', 'everyone'], group_mode: ['off', 'mention', 'selected'], selected_groups_reply: ['mention', 'all'],
  reply_length: ['short', 'medium', 'long'], tone: ['friendly', 'professional', 'casual', 'funny', 'custom'],
  ai_mode: ['server', 'custom'], voice_engine: ['smart', 'server', 'api'], call_provider: ['twilio'],
  act_email: ['off', 'me', 'anyone'], act_call: ['off', 'me', 'anyone'], act_whatsapp: ['off', 'me'],
  act_reminder: ['off', 'me', 'anyone'], act_webhook: ['off', 'me', 'anyone'], act_note: ['off', 'me', 'anyone'], act_notify: ['off', 'anyone'], act_email_read: ['off', 'me'],
};
const NUM_LIMITS = { reply_delay: [0, 60], pause_minutes: [0, 10080], smtp_port: [1, 65535], imap_port: [1, 65535], context_messages: [0, 30] };

function cleanOptions(input = {}) {
  const out = {};
  for (const [k, def] of Object.entries(DEFAULT_OPTIONS)) {
    if (!(k in input)) continue;
    const v = input[k];
    if (typeof def === 'boolean') out[k] = !!v;
    else if (typeof def === 'number') { const [lo, hi] = NUM_LIMITS[k] || [0, 1e6]; out[k] = Math.max(lo, Math.min(hi, Number(v) || 0)); }
    else if (Array.isArray(def)) out[k] = cleanArray(k, v);
    else out[k] = String(v ?? '').slice(0, k === 'about' || k === 'rules' ? 8000 : 2000);
    if (ENUMS[k] && !ENUMS[k].includes(out[k])) out[k] = def;
  }
  if (out.ai_base_url && !/^https?:\/\//i.test(out.ai_base_url)) out.ai_base_url = '';
  if (out.webhook_url && !/^https?:\/\//i.test(out.webhook_url)) out.webhook_url = '';
  if (out.booking_url && !/^https:\/\/[^\s@/]+\.[^\s@/]+/i.test(out.booking_url)) out.booking_url = '';
  return out;
}

function cleanArray(k, v) {
  const arr = Array.isArray(v) ? v.slice(0, 200) : [];
  const s = (x, n = 2000) => String(x ?? '').slice(0, n).trim();
  if (k === 'faq') return arr.map((x) => ({ q: s(x.q, 500), a: s(x.a) })).filter((x) => x.q && x.a);
  if (k === 'keyword_rules') return arr.map((x) => ({ keyword: s(x.keyword, 200), match: x.match === 'exact' ? 'exact' : 'contains', reply: s(x.reply) })).filter((x) => x.keyword && x.reply);
  if (k === 'selected_groups') return arr.map((x) => ({ jid: s(x.jid, 100), name: s(x.name, 200) })).filter((x) => /@g\.us$/.test(x.jid));
  return [];
}

function saveSettings(sessionId, body = {}) {
  const cur = getSettings(sessionId);
  q.upsertSettings.run({
    session_id: sessionId,
    persona: String(body.persona ?? cur.persona ?? '').slice(0, 8000),
    enabled: body.enabled === undefined ? cur.enabled : (body.enabled ? 1 : 0),
    options: JSON.stringify({ ...cur.options, ...cleanOptions(body.options) }),
  });
  if (body.secrets && typeof body.secrets === 'object') {
    for (const name of SECRET_NAMES) {
      if (!(name in body.secrets)) continue;
      const v = String(body.secrets[name] ?? '').trim();
      if (v === '') q.delSecret.run(sessionId, name);
      else if (!v.startsWith('••••')) q.setSecret.run(sessionId, name, encrypt(v.slice(0, 4000)));
    }
  }
  return getSettings(sessionId);
}

function getSecret(sessionId, name) { const r = q.getSecret.get(sessionId, name); return r ? decrypt(r.value) : ''; }
function maskedSecrets(sessionId) {
  const out = {};
  for (const n of SECRET_NAMES) out[n] = mask(getSecret(sessionId, n));
  return out;
}

function logEvent(sessionId, type, chatJid, summary) {
  try { q.addEvent.run(sessionId, type, chatJid || null, String(summary || '').slice(0, 500)); } catch (_) {}
}

function wipeSession(sessionId) {
  db.transaction(() => {
    for (const t of ['messages', 'chats', 'events', 'reminders', 'notes', 'kb_docs', 'session_secrets', 'settings', 'emails', 'bot_emails', 'ops_api_keys', 'ops_integrations', 'ops_events', 'ops_tickets']) {
      db.prepare(`DELETE FROM ${t} WHERE session_id = ?`).run(sessionId);
    }
    db.prepare('DELETE FROM kb_chunks WHERE session_id = ?').run(sessionId);
  })();
}

module.exports = {
  db, q, DEFAULT_OPTIONS, getSettings, saveSettings, cleanOptions, getSecret, maskedSecrets,
  getApp, setApp, getAppSecret, setAppSecret, logEvent, wipeSession,
};
