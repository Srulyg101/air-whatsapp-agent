// Password recovery email: configured only by the server administrator.
// Never use a request Host or Origin to construct a password reset URL.
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { getApp, getAppSecret } = require('./db');
const { assertPublicHost } = require('./netguard');

const RESET_TTL_SECONDS = 20 * 60;
const RESET_COOLDOWN_SECONDS = 5 * 60;
const SAFE_ORIGIN = 'https://agent.llama2.com';
function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function newToken() { return crypto.randomBytes(32).toString('hex'); }
function senderSettings() {
  const host = getApp('bot_smtp_host') || '';
  const user = getApp('bot_smtp_user') || '';
  const pass = getAppSecret('bot_smtp_pass') || '';
  if (!host || !user || !pass) return null;
  const port = Number(getApp('bot_smtp_port')) || 587;
  const fromEmail = getApp('reset_email_from') || user;
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(fromEmail)) return null;
  return { host, user, pass, port, from: `Air Agent <${fromEmail}>` };
}
function isConfigured() { return !!senderSettings(); }
function recoveryLink(token) {
  const origin = (process.env.PUBLIC_URL || SAFE_ORIGIN).replace(/\/$/, '');
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('PUBLIC_URL must be an HTTPS site origin');
  return `${url.origin}/#/reset?token=${encodeURIComponent(token)}`;
}
function createSmtpTransport(cfg) {
  // SMTP submission is authenticated and must negotiate TLS (587) or use TLS-on-connect (465).
  return nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.port === 465,
    requireTLS: cfg.port !== 465,
    tls: { minVersion: 'TLSv1.2' },
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
  });
}

async function sendRecoveryEmail({ to, token }) {
  const cfg = senderSettings();
  if (!cfg) throw new Error('Password reset email is not configured');
  await assertPublicHost(cfg.host);
  const transport = createSmtpTransport(cfg);
  const link = recoveryLink(token);
  await transport.sendMail({
    from: cfg.from, to, subject: 'Reset your Air Agent password',
    text: `Someone requested a password reset for your Air Agent account.\n\nTo choose a new password, use this link within 20 minutes:\n${link}\n\nIf this was not you, you can ignore this email. Never share this link.`,
  });
}
/** Admin-only delivery test: SMTP accepted the message, not proof of inbox delivery. */
async function sendTestEmail({ to }) {
  const cfg = senderSettings();
  if (!cfg) throw new Error('SMTP is not configured. Enter server, username and password in Admin.');
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to || '')) throw new Error('Invalid admin email');
  await assertPublicHost(cfg.host);
  const transport = createSmtpTransport(cfg);
  await transport.verify();
  await transport.sendMail({
    from: cfg.from,
    to,
    subject: 'Air Agent password recovery — test email',
    text: 'Air Agent submitted this test email using your configured SMTP server.\n\nIf this reached your inbox, password recovery email is ready for a live test.\nIf it went to spam, check the sending domain SPF, DKIM and DMARC records.',
  });
  return { submitted: true };
}
module.exports = { RESET_TTL_SECONDS, RESET_COOLDOWN_SECONDS, hashToken, newToken, senderSettings, isConfigured, recoveryLink, sendRecoveryEmail, sendTestEmail };
