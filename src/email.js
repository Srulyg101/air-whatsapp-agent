// Bot email: every assistant can have an inbox.
//  1) Connect any mailbox (Gmail, Outlook, company mail) over IMAP — checked every 2 minutes.
//  2) Or claim its own address name@<mail domain> (admin sets the domain; mail arrives via /api/inbound/email).
// New mail is saved, and the owner gets a WhatsApp alert. The AI can read and reply (with confirmation).
const crypto = require('crypto');
const { q, getSettings, getSecret, getApp, setApp, getAppSecret, logEvent } = require('./db');
const { assertPublicHost } = require('./netguard');

const state = new Map(); // sessionId -> { lastCheck, error, busy }

function inboundSecret() {
  let s = getApp('inbound_secret');
  if (!s) { s = crypto.randomBytes(24).toString('hex'); setApp('inbound_secret', s); }
  return s;
}

function botAddress(sessionId) {
  const r = q.emailOf.get(sessionId);
  const domain = getApp('mail_domain');
  return r && domain ? `${r.local}@${domain}` : null;
}

/** Store an email and alert the owner on WhatsApp. */
async function receive(sessionId, mail, wa) {
  const info = q.addEmail.run({
    s: sessionId, source: mail.source, uid: String(mail.uid).slice(0, 300),
    from_addr: (mail.from_addr || '').slice(0, 300), from_name: (mail.from_name || '').slice(0, 200), to_addr: (mail.to_addr || '').slice(0, 300),
    subject: (mail.subject || '(no subject)').slice(0, 500), text: (mail.text || '').slice(0, 50000), message_id: (mail.message_id || '').slice(0, 500),
    date: mail.date || Math.floor(Date.now() / 1000),
  });
  if (!info.changes) return null; // already had it
  const id = info.lastInsertRowid;
  logEvent(sessionId, 'info', null, `📧 Email from ${mail.from_name || mail.from_addr}: ${mail.subject || '(no subject)'}`);
  const o = getSettings(sessionId).options;
  const s = wa?.get(sessionId);
  if (o.mail_notify && s?.status === 'open' && s.me?.phone) {
    const preview = String(mail.text || '').replace(/\s+/g, ' ').trim().slice(0, 350);
    const body = `📧 *New email* (#${id})\n*From:* ${mail.from_name ? `${mail.from_name} <${mail.from_addr}>` : mail.from_addr}\n*Subject:* ${mail.subject || '(no subject)'}\n\n${preview}${preview.length >= 350 ? '…' : ''}\n\n_Reply here, e.g. "reply to email ${id}: thanks, I'll call tomorrow"_`;
    try { const sent = await s.sock.sendMessage(`${s.me.phone}@s.whatsapp.net`, { text: body }); if (sent?.key?.id) s.sentIds.add(sent.key.id); } catch (_) {}
  }
  return id;
}

// ---------- IMAP ----------
function imapConfig(sessionId, o) {
  const pass = getSecret(sessionId, 'imap_pass');
  if (!o.imap_host || !o.imap_user || !pass) return null;
  return { host: o.imap_host, port: Number(o.imap_port) || 993, secure: o.imap_secure !== false, auth: { user: o.imap_user, pass }, logger: false, socketTimeout: 60_000 };
}

async function checkImap(sessionId, wa, { firstRunLimit = 5 } = {}) {
  const o = getSettings(sessionId).options;
  const cfg = imapConfig(sessionId, o);
  if (!cfg) throw new Error('Mailbox not set up');
  await assertPublicHost(cfg.host);
  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');
  const st = state.get(sessionId) || {};
  if (st.busy) return 0;
  st.busy = true; state.set(sessionId, st);
  const client = new ImapFlow(cfg);
  client.on('error', () => {});
  let added = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const key = `imap_last_uid_${sessionId}`;
      const last = Number(getApp(key) || 0);
      const status = client.mailbox;
      const top = Number(status.uidNext || 1) - 1;
      // first run: only take the newest few, don't flood WhatsApp with old mail
      const from = last ? last + 1 : Math.max(1, top - firstRunLimit + 1);
      if (top >= from) {
        for await (const msg of client.fetch(`${from}:*`, { uid: true, source: true, envelope: true }, { uid: true })) {
          if (msg.uid < from) continue;
          const parsed = await simpleParser(msg.source);
          const f = parsed.from?.value?.[0] || {};
          const id = await receive(sessionId, {
            source: 'imap', uid: msg.uid, from_addr: f.address, from_name: f.name, to_addr: parsed.to?.text,
            subject: parsed.subject, text: parsed.text || (parsed.html ? String(parsed.html).replace(/<[^>]+>/g, ' ') : ''),
            message_id: parsed.messageId, date: parsed.date ? Math.floor(parsed.date.getTime() / 1000) : undefined,
          }, last ? wa : null); // no WhatsApp alerts for the initial backfill
          if (id) added++;
        }
      }
      setApp(key, String(Math.max(last, top)));
    } finally { lock.release(); }
    await client.logout();
    st.error = null;
  } catch (e) {
    st.error = e.responseText || e.message;
    try { client.close(); } catch (_) {}
    throw new Error(st.error);
  } finally {
    st.busy = false; st.lastCheck = Date.now();
  }
  return added;
}

function startPoller(wa) {
  const tick = async () => {
    const rows = require('./db').db.prepare("SELECT session_id FROM session_secrets WHERE name = 'imap_pass'").all();
    for (const { session_id: sid } of rows) {
      const o = getSettings(sid).options;
      if (!o.mail_check) continue;
      try { await checkImap(sid, wa); } catch (_) { /* error kept in state */ }
    }
  };
  setTimeout(() => tick().catch(() => {}), 20_000).unref();
  setInterval(() => tick().catch(() => {}), 120_000).unref();
}

// ---------- sending ----------
function senderFor(sessionId, o) {
  if (o.smtp_host && o.smtp_user && getSecret(sessionId, 'smtp_pass')) {
    return { transport: { host: o.smtp_host, port: Number(o.smtp_port) || 587, secure: !!o.smtp_secure || Number(o.smtp_port) === 465, auth: { user: o.smtp_user, pass: getSecret(sessionId, 'smtp_pass') } }, from: o.smtp_from || o.smtp_user };
  }
  const addr = botAddress(sessionId);
  const host = getApp('bot_smtp_host');
  if (addr && host) {
    const port = Number(getApp('bot_smtp_port')) || 587;
    return { transport: { host, port, secure: port === 465, auth: { user: getApp('bot_smtp_user'), pass: getAppSecret('bot_smtp_pass') } }, from: `${o.bot_name || 'Air Agent'} <${addr}>` };
  }
  return null;
}
const canSend = (sessionId, o) => !!senderFor(sessionId, o);

async function send(sessionId, o, { to, subject, text, inReplyTo }) {
  const s = senderFor(sessionId, o);
  if (!s) throw new Error('Email sending is not set up');
  if (o.smtp_host && s.transport.host === o.smtp_host) await assertPublicHost(o.smtp_host);
  const nodemailer = require('nodemailer');
  const t = nodemailer.createTransport(s.transport);
  await t.sendMail({ from: s.from, to, subject: String(subject).slice(0, 300), text: String(text).slice(0, 20000), ...(inReplyTo ? { inReplyTo, references: inReplyTo } : {}) });
}

function status(sessionId) {
  const st = state.get(sessionId) || {};
  const o = getSettings(sessionId).options;
  return {
    address: botAddress(sessionId), domain: getApp('mail_domain') || null,
    imap: !!imapConfig(sessionId, o), lastCheck: st.lastCheck || null, error: st.error || null,
    canSend: canSend(sessionId, o), sendingVia: o.smtp_host ? 'smtp' : botAddress(sessionId) && getApp('bot_smtp_host') ? 'bot' : null,
  };
}

module.exports = { receive, checkImap, startPoller, send, canSend, status, botAddress, inboundSecret };
