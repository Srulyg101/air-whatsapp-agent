// SSRF guard for user-supplied provider, webhook, website, and mail hosts.
// Resolve on every use; a cached public answer can become a private address.
const dns = require('dns').promises;
const net = require('net');
const ipaddr = require('ipaddr.js');

const blocked = { ipv4: new net.BlockList(), ipv6: new net.BlockList() };
for (const [range, prefix, family] of [
  ['0.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'], ['169.254.0.0', 16, 'ipv4'], ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'], ['192.0.2.0', 24, 'ipv4'], ['192.88.99.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'], ['198.18.0.0', 15, 'ipv4'], ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'], ['224.0.0.0', 3, 'ipv4'],
  ['::', 96, 'ipv6'], ['::1', 128, 'ipv6'],
  ['64:ff9b::', 96, 'ipv6'], ['64:ff9b:1::', 48, 'ipv6'],
  ['100::', 64, 'ipv6'], ['2001::', 23, 'ipv6'], ['2001:2::', 48, 'ipv6'], ['2001:10::', 28, 'ipv6'],
  ['2001:20::', 28, 'ipv6'], ['2001:db8::', 32, 'ipv6'], ['2002::', 16, 'ipv6'],
  ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6'], ['ff00::', 8, 'ipv6'],
]) blocked[family].addSubnet(range, prefix, family);

function isPrivateIp(ip) {
  if (String(ip).includes('%')) return true; // reject IPv6 zone identifiers
  const family = net.isIP(ip);
  if (!family) return true;
  let address;
  try { address = ipaddr.parse(ip); } catch (_) { return true; }
  if (address.kind() === 'ipv6' && address.isIPv4MappedAddress()) return isPrivateIp(address.toIPv4Address().toString());
  const version = family === 4 ? 'ipv4' : 'ipv6';
  return address.range() !== 'unicast' || blocked[version].check(ip, version);
}

async function assertPublicUrl(raw, { requireHttps = false } = {}) {
  let u;
  try { u = new URL(raw); } catch (_) { throw new Error('Invalid URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('URL must start with http:// or https://');
  if (requireHttps && u.protocol !== 'https:') throw new Error('This service requires HTTPS.');
  if (u.username || u.password) throw new Error('URL must not contain embedded credentials');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host.includes('%')) throw new Error('That address is not allowed');
  let addresses;
  if (net.isIP(host)) addresses = [host];
  else {
    try { addresses = (await dns.lookup(host, { all: true, verbatim: true })).map(a => a.address); }
    catch (_) { throw new Error('Could not resolve the requested host'); }
  }
  if (!addresses.length || addresses.some(isPrivateIp)) throw new Error('That address is not allowed (private or reserved network)');
}

/** Same check for a bare host name (SMTP / IMAP servers). */
const assertPublicHost = host => assertPublicUrl(`https://${String(host || '').trim()}/`);

module.exports = { assertPublicUrl, assertPublicHost, isPrivateIp };
