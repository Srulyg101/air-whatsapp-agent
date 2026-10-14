// Encrypts API keys and passwords before they are stored in the database (AES-256-GCM).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
const keyFile = path.join(config.dataDir, 'secret.key');

function loadKey() {
  if (config.appSecret) return crypto.createHash('sha256').update(config.appSecret).digest();
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
}
const KEY = loadKey();

function encrypt(plain) {
  if (plain === undefined || plain === null || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

function decrypt(blob) {
  if (!blob) return '';
  try {
    const [v, iv, tag, data] = String(blob).split(':');
    if (v !== 'v1') return '';
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch (_) { return ''; }
}

const mask = (s) => (s ? '••••' + String(s).slice(-4) : '');

module.exports = { encrypt, decrypt, mask };
