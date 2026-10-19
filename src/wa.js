const fs = require('fs');
const path = require('path');
const pino = require('pino');
const QRCode = require('qrcode');
const baileys = require('@whiskeysockets/baileys');
const config = require('./config');
const { handleMessage, extractContent } = require('./agent');
const { logEvent } = require('./db');
const { useEncryptedMultiFileAuthState } = require('./wa-auth-state');

const makeWASocket = baileys.default;
const { DisconnectReason, fetchLatestBaileysVersion, Browsers } = baileys;

// Baileys diagnostics may contain untrusted protocol data. Application-level
// status and safe event codes are logged separately; raw library logs stay off.
const logger = pino({ level: 'silent' });
const authRoot = path.join(config.dataDir, 'auth');
fs.mkdirSync(authRoot, { recursive: true, mode: 0o700 });
try { fs.chmodSync(authRoot, 0o700); } catch (_) {}

let waVersion = null;
async function getVersion() {
  if (waVersion) return waVersion;
  try { waVersion = (await fetchLatestBaileysVersion()).version; } catch (_) { waVersion = undefined; }
  return waVersion;
}

class Session {
  constructor(id) {
    this.id = id;
    this.isHouse = id === 'house';
    this.status = 'idle'; // idle | connecting | qr | open | closed | logged_out
    this.qr = null; // data URL
    this.me = null;
    this.sock = null;
    this.sentIds = new Set();
    this.retries = 0;
    this.stopped = false;
    this.handled = 0;
    this.lastError = null;
    this.groupCache = new Map(); // jid -> { name, at }
    this.recent = new Map();     // jid -> last messages (RAM only), used as chat context for the AI
    this.seenMessages = new Map(); // guards against repeated WhatsApp upserts
    this.pendingText = new Map(); // short window to combine rapid customer texts
  }

  /** Remember the last messages of each chat in memory (never written to disk). */
  remember(m) {
    const jid = m.key?.remoteJid;
    if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return null;
    const c = extractContent(m);
    const text = c.text || (c.audio ? '[voice note]' : c.document ? `[file: ${c.document.fileName || 'document'}]` : c.inner?.imageMessage ? '[photo]' : c.inner?.videoMessage ? '[video]' : c.inner?.stickerMessage ? '[sticker]' : '');
    if (!text) return null;
    const by = m.key.fromMe ? (this.sentIds.has(m.key.id) ? 'ai' : 'owner') : 'them';
    const entry = { id: m.key.id, by, name: m.key.fromMe ? null : m.pushName || null, text: text.slice(0, 1500), ts: Number(m.messageTimestamp || Date.now() / 1000) };
    const arr = this.recent.get(jid) || [];
    if (arr.some((x) => x.id === entry.id)) return null;
    arr.push(entry);
    if (arr.length > 30) arr.splice(0, arr.length - 30);
    this.recent.set(jid, arr);
    if (this.recent.size > 2000) this.recent.delete(this.recent.keys().next().value);
    return entry;
  }

  async groupName(jid) {
    const c = this.groupCache.get(jid);
    if (c && Date.now() - c.at < 3600_000) return c.name;
    const meta = await this.sock.groupMetadata(jid);
    this.groupCache.set(jid, { name: meta.subject, at: Date.now() });
    return meta.subject;
  }

  /** Groups this number is in (for the group picker in the dashboard). */
  async listGroups() {
    if (!this.sock || this.status !== 'open') throw new Error('WhatsApp is not connected');
    const all = await this.sock.groupFetchAllParticipating();
    return Object.values(all).map((g) => {
      this.groupCache.set(g.id, { name: g.subject, at: Date.now() });
      return { jid: g.id, name: g.subject, size: (g.participants || []).length };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  get authDir() { return path.join(authRoot, this.id); }
  hasCreds() { return fs.existsSync(path.join(this.authDir, 'creds.json')); }

  async start() {
    if (this.starting || (this.sock && ['connecting', 'qr', 'open'].includes(this.status))) return;
    this.starting = true;
    clearTimeout(this.reconnectTimer);
    try { await this._start(); } finally { this.starting = false; }
  }

  async _start() {
    this.stopped = false;
    this.status = 'connecting';
    const { state, saveCreds } = await useEncryptedMultiFileAuthState(this.authDir);
    const sock = makeWASocket({
      auth: state,
      version: await getVersion(),
      logger,
      browser: Browsers.ubuntu(config.botName),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });
    this.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      if (u.qr) {
        this.status = 'qr';
        this.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 });
      }
      if (u.connection === 'open') {
        this.status = 'open';
        this.qr = null;
        this.retries = 0;
        this.me = { id: sock.user?.id, name: sock.user?.name, phone: (sock.user?.id || '').split(':')[0].split('@')[0] };
        console.log(`[${this.id}] WhatsApp session connected`);
        if (this.lastLogged !== this.me.phone) { logEvent(this.id, 'info', null, 'WhatsApp session connected'); this.lastLogged = this.me.phone; }
      }
      if (u.connection === 'close') {
        for (const p of this.pendingText.values()) clearTimeout(p.timer);
        this.pendingText.clear();
        const code = u.lastDisconnect?.error?.output?.statusCode;
        // The upstream error can include connection metadata. Expose only a
        // stable code to the dashboard; never surface raw transport details.
        this.lastError = code ? `WhatsApp connection closed (code ${code})` : 'WhatsApp connection closed';
        this.sock = null;
        if (code === DisconnectReason.loggedOut) {
          console.log(`[${this.id}] WhatsApp session logged out`);
          logEvent(this.id, 'info', null, 'WhatsApp unlinked from the phone');
          this.lastLogged = null;
          this.me = null;
          this.status = 'logged_out';
          this.qr = null;
          fs.rmSync(this.authDir, { recursive: true, force: true });
          return;
        }
        if (this.stopped) { this.status = 'closed'; return; }
        // If nobody scanned the QR in time, stop instead of looping forever.
        if (!this.hasCreds() && this.retries >= 3) { this.status = 'closed'; this.qr = null; return; }
        this.retries++;
        this.status = 'connecting';
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.retries, 5));
        this.reconnectTimer = setTimeout(() => { if (!this.stopped) this.start().catch(() => console.error(`[${this.id}] WhatsApp reconnect failed`)); }, code === DisconnectReason.restartRequired ? 0 : delay);
      }
    });

    const processOne = async (m, before, entry) => {
      if (this.stopped || this.sock !== sock) return;
      try {
        await handleMessage(m, { sessionId: this.id, isHouse: this.isHouse, sock, sentIds: this.sentIds, me: this.me, groupName: (j) => this.groupName(j), recent: before, entry });
        this.handled++;
      } catch (_) { console.error(`[${this.id}] WhatsApp message processing failed`); }
    };
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      for (const m of messages) {
        const ts = Number(m.messageTimestamp || 0);
        if (type !== 'notify' && !(m.key?.fromMe && ts && Date.now() / 1000 - ts < 120)) continue;
        const jid = m.key?.remoteJid;
        const id = m.key?.id;
        if (jid && id) {
          const key = jid + ':' + (m.key.participant || '') + ':' + id;
          if (this.seenMessages.has(key)) continue;
          this.seenMessages.set(key, Date.now());
          if (this.seenMessages.size > 10000) {
            const cutoff = Date.now() - 30 * 60_000;
            for (const [k, when] of this.seenMessages) {
              if (when > cutoff && this.seenMessages.size < 5000) break;
              this.seenMessages.delete(k);
            }
          }
        }
        const before = (this.recent.get(jid) || []).slice();
        const entry = this.remember(m);
        const content = extractContent(m);
        const text = content.text?.trim() || '';
        const batch = jid && !m.key?.fromMe && !jid.endsWith('@g.us') && !content.audio && !content.document &&
          text && !/^\/(stop|start|help|reset)\b/i.test(text);
        if (batch) {
          const previous = this.pendingText.get(jid);
          const pending = previous || { parts: [], before };
          pending.parts.push({ m, entry, text });
          clearTimeout(pending.timer);
          pending.timer = setTimeout(() => {
            if (this.pendingText.get(jid) !== pending) return;
            this.pendingText.delete(jid);
            const last = pending.parts[pending.parts.length - 1];
            const merged = pending.parts.length === 1 ? last.m :
              { ...last.m, message: { conversation: pending.parts.map(p => p.text).join('\n').slice(0, 4000) } };
            processOne(merged, pending.before, last.entry);
          }, 1200);
          pending.timer.unref?.();
          this.pendingText.set(jid, pending);
        } else await processOne(m, before, entry);
      }
      if (this.sentIds.size > 5000) { let n = this.sentIds.size - 1000; for (const id of this.sentIds) { if (n-- <= 0) break; this.sentIds.delete(id); } }
    });
  }

  async stop() {
    this.stopped = true;
    for (const p of this.pendingText.values()) clearTimeout(p.timer);
    this.pendingText.clear();
    clearTimeout(this.reconnectTimer);
    try { this.sock?.end(undefined); } catch (_) {}
    this.sock = null;
    this.status = 'closed';
  }

  async logout() {
    this.stopped = true;
    for (const p of this.pendingText.values()) clearTimeout(p.timer);
    this.pendingText.clear();
    this.seenMessages.clear();
    clearTimeout(this.reconnectTimer);
    try { await this.sock?.logout(); } catch (_) {}
    this.sock = null;
    fs.rmSync(this.authDir, { recursive: true, force: true });
    this.status = 'logged_out';
    this.qr = null;
    this.me = null;
    this.groupCache.clear();
    this.recent.clear();
  }

  info() {
    return { id: this.id, status: this.status, qr: this.qr, me: this.me, handled: this.handled, lastError: this.lastError };
  }
}

class SessionManager {
  constructor() { this.sessions = new Map(); }

  get(id) {
    if (!this.sessions.has(id)) this.sessions.set(id, new Session(id));
    return this.sessions.get(id);
  }

  /** Reconnect every session that was linked before the server restarted. */
  async restoreAll() {
    for (const id of fs.readdirSync(authRoot)) {
      const s = this.get(id);
      if (s.hasCreds()) {
        console.log(`[${id}] restoring session`);
        s.start().catch(() => console.error(`[${id}] WhatsApp session restore failed`));
      }
    }
  }

  /** Emergency switch: unlink every WhatsApp number from this server. */
  async disconnectAll() {
    const ids = new Set([...this.sessions.keys(), ...fs.readdirSync(authRoot)]);
    for (const id of ids) { try { await this.get(id).logout(); logEvent(id, 'info', null, 'Disconnected by admin (disconnect all)'); } catch (_) {} }
    return ids.size;
  }

  summary() {
    return [...this.sessions.values()].map((s) => ({ id: s.id, status: s.status, phone: s.me?.phone || null, handled: s.handled }));
  }
}

module.exports = new SessionManager();
