// Blocks user-supplied URLs (custom AI provider, speech API, webhooks) from reaching
// this server, the Docker network, the cloud metadata service or the private LAN (SSRF protection).
const dns = require('dns').promises;
const net = require('net');

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}

const cache = new Map(); // host -> { ok, at }
async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (_) { throw new Error('Invalid URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('URL must start with http:// or https://');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < 300_000) { if (!hit.ok) throw new Error('That address is not allowed (private network)'); return; }
  let addrs;
  if (net.isIP(host)) addrs = [host];
  else {
    try { addrs = (await dns.lookup(host, { all: true })).map((a) => a.address); } catch (_) { throw new Error(`Cannot resolve ${host}`); }
  }
  const ok = addrs.length > 0 && !addrs.some(isPrivateIp);
  cache.set(host, { ok, at: Date.now() });
  if (!ok) throw new Error('That address is not allowed (private network)');
}

/** Same check for a bare host name (SMTP / IMAP servers). */
const assertPublicHost = (host) => assertPublicUrl(`https://${String(host || '').trim()}/`);

module.exports = { assertPublicUrl, assertPublicHost, isPrivateIp };
