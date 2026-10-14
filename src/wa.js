// Keep session keys and all subsequently created files owner-readable only.
process.umask(0o077);
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const QRCode = require('qrcode');
const baileys = require('@whiskeysockets/baileys');
const config = require('./config');
const { handleMessage } = require('./agent');

const makeWASocket = baileys.default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = baileys;

const logger = pino({ level: process.env.WA_LOG_LEVEL || 'warn' });
const authRoot = path.join(config.dataDir, 'auth');
fs.mkdirSync(authRoot, { recursive: true, mode: 0o700 });
fs.chmodSync(authRoot, 0o700);

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
    this.reconnectTimer = null;
  }

  get authDir() { return path.join(authRoot, this.id); }
  hasCreds() { return fs.existsSync(path.join(this.authDir, 'creds.json')); }

  async start() {
    if (this.sock && ['connecting', 'qr', 'open'].includes(this.status)) return;
    this.stopped = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.status = 'connecting';
    fs.mkdirSync(this.authDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.authDir, 0o700);
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
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
        console.log(`[${this.id}] connected`);
      }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        this.lastError = u.lastDisconnect?.error?.message || null;
        this.sock = null;
        if (code === DisconnectReason.loggedOut) {
          console.log(`[${this.id}] logged out from phone`);
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
        this.reconnectTimer = setTimeout(() => {
          if (!this.stopped) this.start().catch((e) => console.error(e));
        }, code === DisconnectReason.restartRequired ? 0 : delay);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      console.log(`[${this.id}] upsert type=${type} n=${messages.length}`);
      for (const m of messages) {
        // Messages typed on the owner's own phone can arrive as 'append'; only handle fresh ones.
        const ts = Number(m.messageTimestamp || 0);
        if (type !== 'notify' && !(m.key?.fromMe && ts && Date.now() / 1000 - ts < 120)) continue;
        try {
          await handleMessage(m, { sessionId: this.id, isHouse: this.isHouse, sock, sentIds: this.sentIds,
            isActive: () => !this.stopped && this.sock === sock });
          this.handled++;
        } catch (err) {
          console.error(`[${this.id}] handle error:`, err.message);
        }
      }
      if (this.sentIds.size > 5000) this.sentIds = new Set([...this.sentIds].slice(-1000));
    });
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try { this.sock?.end(undefined); } catch (_) {}
    this.sock = null;
    this.status = 'closed';
  }

  async logout() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try { await this.sock?.logout(); } catch (_) {}
    this.sock = null;
    fs.rmSync(this.authDir, { recursive: true, force: true });
    this.status = 'logged_out';
    this.qr = null;
    this.me = null;
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
        s.start().catch((e) => console.error(`[${id}] restore failed`, e.message));
      }
    }
  }

  async logoutAll() {
    // Also remove saved credentials for sessions not currently instantiated.
    const ids = new Set([...this.sessions.keys(), ...fs.readdirSync(authRoot)]);
    const failed = [];
    for (const id of ids) {
      if (!/^(house|u[0-9]+)$/.test(id)) continue;
      try { await this.get(id).logout(); } catch (err) { failed.push(id); }
    }
    if (failed.length) throw new Error('Could not disconnect all sessions: ' + failed.join(', '));
    return { disconnected: ids.size };
  }

  summary() {
    return [...this.sessions.values()].map((s) => ({ id: s.id, status: s.status, phone: s.me?.phone || null, handled: s.handled }));
  }
}

module.exports = new SessionManager();
