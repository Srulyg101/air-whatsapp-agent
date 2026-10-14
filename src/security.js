'use strict';
// Only explicitly approved international phone numbers can receive personal-account replies.
// Opaque WhatsApp @lid IDs must never be mistaken for a phone number.
const normalizeNumbers = (input) => String(input || '').split(/[,;\n]+/)
  .map((item) => item.replace(/\D/g, ''))
  .filter((phone) => /^[1-9]\d{7,14}$/.test(phone));
const hasApprovedNumbers = (input) => normalizeNumbers(input).length > 0;
const phoneFromJid = (jid) => {
  if (typeof jid !== 'string') return '';
  const [user, domain] = jid.split('@');
  if (!['s.whatsapp.net', 'c.us'].includes(domain)) return '';
  const phone = (user || '').split(':')[0];
  return /^[1-9]\d{7,14}$/.test(phone) ? phone : '';
};
const peerNumbers = (m) => {
  const k = m?.key || {};
  return [k.senderPn, k.remoteJidAlt, k.participantAlt, k.participant, k.remoteJid]
    .map(phoneFromJid).filter(Boolean);
};
const approvedSender = (m, input) => {
  const approved = new Set(normalizeNumbers(input));
  return approved.size > 0 && peerNumbers(m).some((n) => approved.has(n));
};
const blockedSender = (m, input) => {
  const blocked = new Set(normalizeNumbers(input));
  return peerNumbers(m).some((n) => blocked.has(n));
};
// Audit only a masked identifier; message content and phone numbers are never recorded.
const maskedPeer = (m) => {
  const phone = peerNumbers(m)[0];
  return phone ? '••••' + phone.slice(-4) : 'unknown';
};
module.exports = { normalizeNumbers, hasApprovedNumbers, phoneFromJid, peerNumbers, approvedSender, blockedSender, maskedPeer };
