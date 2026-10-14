// Protect all new database and journal files from the first open.
process.umask(0o077);
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
fs.chmodSync(config.dataDir, 0o700);
const db = new Database(path.join(config.dataDir, 'app.db'));
db.pragma('journal_mode = WAL');
fs.chmodSync(path.join(config.dataDir, 'app.db'), 0o600);

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
CREATE TABLE IF NOT EXISTS reply_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  peer_masked TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  ts INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_reply_audit_ts ON reply_audit(ts);
CREATE TABLE IF NOT EXISTS observed_messages (
  session_id TEXT NOT NULL, chat_jid TEXT NOT NULL, message_id TEXT NOT NULL,
  role TEXT NOT NULL, content TEXT NOT NULL, ts INTEGER DEFAULT (strftime('%s','now')),
  PRIMARY KEY(session_id, chat_jid, message_id)
);
CREATE INDEX IF NOT EXISTS idx_observed_chat ON observed_messages(session_id, chat_jid, ts);
CREATE TABLE IF NOT EXISTS reply_receipts (
  session_id TEXT NOT NULL, chat_jid TEXT NOT NULL,
  last_reply_at INTEGER DEFAULT (strftime('%s','now')), reply_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(session_id, chat_jid)
);
CREATE TABLE IF NOT EXISTS controller_auth (
  session_id TEXT PRIMARY KEY, pin_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS processed_controller_commands (
  session_id TEXT NOT NULL, message_id TEXT NOT NULL,
  ts INTEGER DEFAULT (strftime('%s','now')),
  PRIMARY KEY(session_id, message_id)
);
CREATE TABLE IF NOT EXISTS controller_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
  peer_masked TEXT NOT NULL, action TEXT NOT NULL, outcome TEXT NOT NULL,
  ts INTEGER DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS bot_mailboxes (
  session_id TEXT PRIMARY KEY, alias TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS bot_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
  sender TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT NOT NULL,
  body TEXT NOT NULL, received_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_bot_emails ON bot_emails(session_id, received_at DESC);

CREATE TABLE IF NOT EXISTS muted_chats (
  session_id TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  PRIMARY KEY (session_id, chat_jid)
);
`);
try { db.exec('ALTER TABLE settings ADD COLUMN options TEXT'); } catch (_) { /* already there */ }
// Invalidate old plaintext bearer tokens once; new token values are stored as hashes.
db.prepare("DELETE FROM auth_tokens WHERE token NOT LIKE 'sha256:%'").run();

// Every per-number option with its default. Shown in the dashboard and enforced in agent.js.
const DEFAULT_OPTIONS = {
  reply_once: true,        // personal accounts reply only once to an approved contact
  cooldown_minutes: 0,    // optional waiting time between auto replies (if reply_once off)
  context_enabled: false, // opt-in storage of observed recent messages
  context_limit: 10,      // maximum observed prior chat messages to use
  control_enabled: false, // privileged WhatsApp commands are opt-in
  control_numbers: '',    // international numbers authorized to send commands
  email_allowed_to: '',   // email action can only send to these addresses
  self_chat: true,          // answer in the owner's "Message yourself" chat
  ai_trigger: true,         // owner can type "/ai ..." in any chat
  trigger_word: '/ai',
  allow_list: '',           // REQUIRED for personal incoming replies; empty = nobody
  block_list: '',           // never reply to these numbers
  prefix_on: true,          // start auto-replies with a label
  prefix_text: '🤖',
  use_emojis: true,         // let the AI use emojis
  quote_reply: true,        // reply as a quote of the incoming message
  typing: true,             // show "typing..."
  reply_delay: 0,           // extra seconds to wait before replying
  memory: true,             // remember the conversation
  reply_length: 'short',    // short | medium | long
  language: '',             // empty = same language as the sender
  quiet_enabled: false,     // don't reply during quiet hours
  quiet_start: '22:00',
  quiet_end: '08:00',
  timezone: 'America/New_York',
  away_message: '',         // optional one-time message during quiet hours
};

const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT id, email, name, is_admin, created_at FROM users WHERE id = ?'),
  userCount: db.prepare('SELECT COUNT(*) c FROM users'),
  insertUser: db.prepare('INSERT INTO users (email, name, password_hash, is_admin) VALUES (?, ?, ?, ?)'),
  insertToken: db.prepare('INSERT INTO auth_tokens (token, user_id) VALUES (?, ?)'),
  userByToken: db.prepare('SELECT u.id, u.email, u.name, u.is_admin FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token = ?'),
  deleteToken: db.prepare('DELETE FROM auth_tokens WHERE token = ?'),
  addReplyAudit: db.prepare('INSERT INTO reply_audit (session_id, peer_masked, action, outcome) VALUES (?, ?, ?, ?)'),
  listReplyAudits: db.prepare('SELECT id, session_id, peer_masked, action, outcome, ts FROM reply_audit ORDER BY id DESC LIMIT ?'),
  pruneReplyAudits: db.prepare("DELETE FROM reply_audit WHERE ts < strftime('%s','now') - ?"),
  addObserved: db.prepare('INSERT OR IGNORE INTO observed_messages (session_id, chat_jid, message_id, role, content) VALUES (?, ?, ?, ?, ?)'),
  recentObserved: db.prepare('SELECT role, content FROM (SELECT role, content, ts, rowid FROM observed_messages WHERE session_id = ? AND chat_jid = ? AND message_id != ? ORDER BY ts DESC, rowid DESC LIMIT ?) ORDER BY ts ASC, rowid ASC'),
  trimObserved: db.prepare('DELETE FROM observed_messages WHERE session_id = ? AND chat_jid = ? AND rowid NOT IN (SELECT rowid FROM observed_messages WHERE session_id = ? AND chat_jid = ? ORDER BY ts DESC, rowid DESC LIMIT ?)'),
  clearObserved: db.prepare('DELETE FROM observed_messages WHERE session_id = ?'),
  pruneObserved: db.prepare("DELETE FROM observed_messages WHERE ts < strftime('%s','now') - ?"),
  hasReceipt: db.prepare('SELECT last_reply_at, reply_count FROM reply_receipts WHERE session_id = ? AND chat_jid = ?'),
  recordReceipt: db.prepare("INSERT INTO reply_receipts (session_id, chat_jid) VALUES (?, ?) ON CONFLICT(session_id,chat_jid) DO UPDATE SET last_reply_at=strftime('%s','now'), reply_count=reply_count+1"),
  clearReceipts: db.prepare('DELETE FROM reply_receipts WHERE session_id = ?'),
  receiptCount: db.prepare('SELECT COUNT(*) c FROM reply_receipts WHERE session_id = ?'),
  getControllerPin: db.prepare('SELECT pin_hash FROM controller_auth WHERE session_id = ?'),
  setControllerPin: db.prepare('INSERT INTO controller_auth (session_id, pin_hash) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET pin_hash=excluded.pin_hash'),
  logController: db.prepare('INSERT INTO controller_audit (session_id, peer_masked, action, outcome) VALUES (?, ?, ?, ?)'),
  claimController: db.prepare('INSERT OR IGNORE INTO processed_controller_commands (session_id, message_id) VALUES (?, ?)'),
  pruneProcessedControllers: db.prepare("DELETE FROM processed_controller_commands WHERE ts < strftime('%s','now') - ?"),
  listControllerAudit: db.prepare('SELECT id, session_id, peer_masked, action, outcome, ts FROM controller_audit WHERE session_id = ? ORDER BY id DESC LIMIT 50'),
  pruneControllerAudit: db.prepare("DELETE FROM controller_audit WHERE ts < strftime('%s','now') - ?"),
  getMailbox: db.prepare('SELECT * FROM bot_mailboxes WHERE session_id = ?'),
  mailboxByAlias: db.prepare('SELECT * FROM bot_mailboxes WHERE alias = ? AND enabled=1'),
  createMailbox: db.prepare('INSERT INTO bot_mailboxes(session_id, alias) VALUES (?, ?)'),
  addBotEmail: db.prepare('INSERT INTO bot_emails(session_id, sender, recipient, subject, body) VALUES (?, ?, ?, ?, ?)'),
  listBotEmails: db.prepare('SELECT id, sender, recipient, subject, substr(body,1,140) preview, received_at FROM bot_emails WHERE session_id = ? ORDER BY id DESC LIMIT 100'),
  getBotEmail: db.prepare('SELECT id, sender, recipient, subject, body, received_at FROM bot_emails WHERE session_id = ? AND id = ?'),
  pruneBotEmails: db.prepare("DELETE FROM bot_emails WHERE received_at < strftime('%s','now') - ?"),

  listUsers: db.prepare('SELECT id, email, name, is_admin, created_at FROM users ORDER BY id DESC'),
  getSettings: db.prepare('SELECT * FROM settings WHERE session_id = ?'),
  upsertSettings: db.prepare(`INSERT INTO settings (session_id, persona, auto_reply, reply_groups, enabled, options)
    VALUES (@session_id, @persona, @auto_reply, @reply_groups, @enabled, @options)
    ON CONFLICT(session_id) DO UPDATE SET persona=@persona, auto_reply=@auto_reply, reply_groups=@reply_groups, enabled=@enabled, options=@options`),
  isMuted: db.prepare('SELECT 1 FROM muted_chats WHERE session_id = ? AND chat_jid = ?'),
  mute: db.prepare('INSERT OR IGNORE INTO muted_chats (session_id, chat_jid) VALUES (?, ?)'),
  unmute: db.prepare('DELETE FROM muted_chats WHERE session_id = ? AND chat_jid = ?'),
  addMsg: db.prepare('INSERT INTO messages (session_id, chat_jid, role, content) VALUES (?, ?, ?, ?)'),
  history: db.prepare('SELECT role, content FROM (SELECT id, role, content FROM messages WHERE session_id = ? AND chat_jid = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC'),
  clearChat: db.prepare('DELETE FROM messages WHERE session_id = ? AND chat_jid = ?'),
  msgCount: db.prepare('SELECT COUNT(*) c FROM messages WHERE session_id = ?'),
  msgTotals: db.prepare("SELECT COUNT(*) total, SUM(ts > strftime('%s','now') - 86400) last24h FROM messages"),
  prune: db.prepare("DELETE FROM messages WHERE ts < strftime('%s','now') - ?"),
};

function getSettings(sessionId) {
  const row = q.getSettings.get(sessionId) || {
    session_id: sessionId, persona: '', auto_reply: 0, reply_groups: 0, enabled: 1, options: null,
  };
  let opts = {};
  try { opts = JSON.parse(row.options || '{}'); } catch (_) {}
  const defaults = { ...DEFAULT_OPTIONS, ...(sessionId === 'house' ? { prefix_on: false } : {}) };
  return { ...row, options: { ...defaults, ...opts } };
}

function cleanOptions(input = {}) {
  const out = {};
  for (const [k, def] of Object.entries(DEFAULT_OPTIONS)) {
    if (!(k in input)) continue;
    const v = input[k];
    if (typeof def === 'boolean') out[k] = !!v;
    else if (typeof def === 'number') out[k] = Math.max(0, Math.min(60, Number(v) || 0));
    else out[k] = String(v ?? '').slice(0, 2000);
  }
  if (out.reply_length && !['short', 'medium', 'long'].includes(out.reply_length)) out.reply_length = 'short';
  if ('context_limit' in out) out.context_limit = Math.max(0, Math.min(10, Number(out.context_limit) || 0));
  if ('cooldown_minutes' in out) out.cooldown_minutes = Math.max(0, Math.min(10080, Number(out.cooldown_minutes) || 0));
  return out;
}

module.exports = { db, q, getSettings, cleanOptions, DEFAULT_OPTIONS };
