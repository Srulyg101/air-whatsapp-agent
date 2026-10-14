'use strict';
// Explicit, authenticated command dispatcher. Never turn arbitrary AI text into actions.
const bcrypt = require('bcryptjs');
const { q, getSettings } = require('./db');
const { approvedSender, maskedPeer } = require('./security');
const mail = require('./mail');
const failures = new Map();
const CMD = /^\/do\s+(\S+)\s+([\s\S]+)$/i;
const EMAIL = /^email\s+([^|]+)\|([^|]+)\|([\s\S]+)$/i;

function emailAllowList(raw) {
  return new Set(String(raw || '').split(/[,;\n]+/).map(mail.cleanEmail).filter(mail.validEmail));
}
function matchesControl(message, options) {
  return !!options.control_enabled && approvedSender(message, options.control_numbers);
}

async function handleControl(message, { sock, sessionId, isHouse, isActive }) {
  const jid = message.key?.remoteJid;
  const text = String(message.message?.conversation || message.message?.extendedTextMessage?.text || '').trim();
  if (!/^\/do(?:\s|$)/i.test(text)) return false;
  // Reserve /do entirely: normal AI must never interpret privileged messages.
  if (!jid || isHouse || message.key?.fromMe || jid.endsWith('@g.us') || !isActive()) return true;
  const settings = getSettings(sessionId);
  if (!matchesControl(message, settings.options)) return true; // no response to unknown sender
  const match = text.match(CMD);
  if (!match) return true;
  const k = sessionId + ':' + maskedPeer(message);
  const entry = failures.get(k) || { count: 0, until: 0 };
  if (entry.until > Date.now()) return true;
  const record = q.getControllerPin.get(sessionId);
  if (!record || !bcrypt.compareSync(match[1], record.pin_hash)) {
    const next = { count: entry.count + 1, until: 0 };
    if (next.count >= 5) next.until = Date.now() + 15 * 60 * 1000;
    failures.set(k, next);
    q.logController.run(sessionId, maskedPeer(message), 'authentication', 'denied');
    return true;
  }
  failures.delete(k);
  const command = match[2].trim();
  const name = /^email\s/i.test(command) ? 'email' : command.split(/\s+/)[0].toLowerCase();
  const claimed = q.claimController.run(sessionId, String(message.key.id || ''));
  if (!claimed.changes) return true; // fail closed on replay
  const reply = async (body) => {
    if (!isActive()) return;
    // Do not quote messages: the WhatsApp command contains a PIN.
    await sock.sendMessage(jid, { text: body });
  };
  let outcome = 'rejected';
  try {
    if (name === 'status' && command.toLowerCase() === 'status') {
      const linked = sock.user?.id ? 'connected' : 'connecting';
      outcome = 'ok';
      await reply('Air Agent: ' + linked + '. Email: ' +
        (mail.readiness().outboundReady ? 'ready' : 'not configured') + '.');
    } else if ((name === 'pause' || name === 'resume') && command.toLowerCase() === name) {
      const current = getSettings(sessionId);
      q.upsertSettings.run({
        session_id: sessionId, persona: current.persona,
        auto_reply: current.auto_reply, reply_groups: current.reply_groups,
        enabled: name === 'resume' ? 1 : 0, options: JSON.stringify(current.options),
      });
      outcome = 'ok';
      await reply('Air Agent ' + (name === 'pause' ? 'paused.' : 'resumed.'));
    } else if (name === 'email') {
      const parts = command.match(EMAIL);
      if (!parts) {
        await reply('Usage: /do PIN email recipient@example.com | Subject | Message');
      } else {
        const recipient = mail.cleanEmail(parts[1]);
        if (!emailAllowList(settings.options.email_allowed_to).has(recipient)) {
          await reply('Recipient not on your approved email list.');
        } else {
          await mail.send({ sessionId, to: recipient, subject: parts[2], text: parts[3] });
          outcome = 'submitted';
          await reply('Email submitted to your provider.');
        }
      }
    } else {
      await reply('Supported commands: status, pause, resume, email. Arbitrary commands are blocked.');
    }
  } catch (err) {
    outcome = 'failed';
    await reply('Action failed. Check email settings or server logs.');
  } finally {
    q.logController.run(sessionId, maskedPeer(message), name.slice(0, 24), outcome);
  }
  return true;
}
module.exports = { handleControl, matchesControl, emailAllowList };
