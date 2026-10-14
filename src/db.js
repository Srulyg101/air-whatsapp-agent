const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new Database(path.join(config.dataDir, 'app.db'));
db.pragma('journal_mode = WAL');

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
`);

const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT id, email, name, is_admin, created_at FROM users WHERE id = ?'),
  userCount: db.prepare('SELECT COUNT(*) c FROM users'),
  insertUser: db.prepare('INSERT INTO users (email, name, password_hash, is_admin) VALUES (?, ?, ?, ?)'),
  insertToken: db.prepare('INSERT INTO auth_tokens (token, user_id) VALUES (?, ?)'),
  userByToken: db.prepare('SELECT u.id, u.email, u.name, u.is_admin FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token = ?'),
  deleteToken: db.prepare('DELETE FROM auth_tokens WHERE token = ?'),
  listUsers: db.prepare('SELECT id, email, name, is_admin, created_at FROM users ORDER BY id DESC'),
  getSettings: db.prepare('SELECT * FROM settings WHERE session_id = ?'),
  upsertSettings: db.prepare(`INSERT INTO settings (session_id, persona, auto_reply, reply_groups, enabled)
    VALUES (@session_id, @persona, @auto_reply, @reply_groups, @enabled)
    ON CONFLICT(session_id) DO UPDATE SET persona=@persona, auto_reply=@auto_reply, reply_groups=@reply_groups, enabled=@enabled`),
  addMsg: db.prepare('INSERT INTO messages (session_id, chat_jid, role, content) VALUES (?, ?, ?, ?)'),
  history: db.prepare('SELECT role, content FROM (SELECT id, role, content FROM messages WHERE session_id = ? AND chat_jid = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC'),
  clearChat: db.prepare('DELETE FROM messages WHERE session_id = ? AND chat_jid = ?'),
  msgCount: db.prepare('SELECT COUNT(*) c FROM messages WHERE session_id = ?'),
  msgTotals: db.prepare("SELECT COUNT(*) total, SUM(ts > strftime('%s','now') - 86400) last24h FROM messages"),
  prune: db.prepare("DELETE FROM messages WHERE ts < strftime('%s','now') - ?"),
};

function getSettings(sessionId) {
  return q.getSettings.get(sessionId) || {
    session_id: sessionId, persona: '', auto_reply: 0, reply_groups: 0, enabled: 1,
  };
}

module.exports = { db, q, getSettings };
