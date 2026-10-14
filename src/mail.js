'use strict';
// Optional email service. No provider keys or mailbox messages are ever committed.
// Real delivery requires a verified domain and a configured outbound email provider.
const crypto = require('crypto');
const config = require('./config');
const { q } = require('./db');

const cleanEmail = (v) => String(v || '').trim().toLowerCase();
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail(value));
const normalizeDomain = (v) => String(v || '').trim().toLowerCase().replace(/^@/, '');
const domain = normalizeDomain(config.mailDomain);

function readiness() {
  return {
    domainReady: !!domain && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain),
    outboundReady: !!(config.resendApiKey && config.emailFrom && validEmail(config.emailFrom)),
    inboundReady: !!(domain && config.inboundEmailWebhookSecret.length >= 32),
    domain: domain || null,
    outboundProvider: 'Resend (optional)',
  };
}

function mailbox(sessionId) {
  const row = q.getMailbox.get(sessionId);
  return row?.enabled ? row.alias : null;
}

function provision(sessionId) {
  if (!readiness().domainReady) throw new Error('MAIL_DOMAIN must be configured with a verified email domain');
  const existing = mailbox(sessionId);
  if (existing) return existing;
  const id = crypto.randomBytes(5).toString('hex');
  const alias = 'agent-' + id + '@' + domain;
  q.createMailbox.run(sessionId, alias);
  return alias;
}

async function send({ sessionId, to, subject, text }) {
  if (!readiness().outboundReady) throw new Error('Email sending is not configured. Set RESEND_API_KEY and EMAIL_FROM on the VPS.');
  const recipient = cleanEmail(to);
  if (!validEmail(recipient)) throw new Error('Invalid recipient address');
  const sender = mailbox(sessionId) || config.emailFrom;
  const body = String(text || '').trim().slice(0, 10000);
  const safeSubject = String(subject || '').trim().slice(0, 180);
  if (!safeSubject || !body) throw new Error('Email needs a subject and message');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + config.resendApiKey,
      'Content-Type': 'application/json' },
    body: JSON.stringify({ from: sender, to: [recipient], subject: safeSubject, text: body }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    // No raw provider responses: they may echo recipient addresses or message text.
    throw new Error('Email provider rejected the message (HTTP ' + response.status + ')');
  }
  return { submitted: true };
}

function verifyInbound(rawBody, timestamp, signature) {
  if (!readiness().inboundReady) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) return false;
  const expected = crypto.createHmac('sha256', config.inboundEmailWebhookSecret)
    .update(String(timestamp) + '.').update(rawBody).digest('hex');
  const got = String(signature || '').replace(/^sha256=/i, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(got) &&
    crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(expected, 'hex'));
}

function ingest(payload) {
  // A mail provider/forwarder must POST a normalized JSON envelope here after
  // validating the original provider signature and relaying with the Air HMAC.
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const to = cleanEmail(Array.isArray(payload.to) ? payload.to[0] : payload.to);
  const row = q.mailboxByAlias.get(to);
  if (!row) return false;
  const from = cleanEmail(payload.from).slice(0, 250);
  if (!validEmail(from)) return false;
  const subject = String(payload.subject || '').slice(0, 250);
  const body = String(payload.text || '').slice(0, 50000);
  const providerId = String(payload.messageId || payload.id || '').trim().slice(0, 128) ||
    crypto.createHash('sha256').update([from,to,subject,body].join('\\u0000')).digest('hex');
  q.addBotEmail.run(row.session_id, from, to, subject, body, providerId);
  return true;
}

module.exports = { readiness, mailbox, provision, send, verifyInbound, ingest, validEmail, cleanEmail };
