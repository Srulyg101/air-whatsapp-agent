const { isJidGroup, isJidBroadcast, isJidStatusBroadcast, isJidNewsletter } = require('@whiskeysockets/baileys');
const config = require('./config');
const ai = require('./ai');
const { q, getSettings } = require('./db');

const HELP = `*${config.botName}* — your AI on WhatsApp\n\n` +
  `Just send a message and I'll reply.\n\n` +
  `Commands:\n` +
  `/reset — forget this conversation\n` +
  `/help — show this message`;

const rate = new Map(); // key -> [timestamps]
function rateLimited(key) {
  const now = Date.now();
  const arr = (rate.get(key) || []).filter((t) => now - t < 60_000);
  if (arr.length >= config.rateLimitPerMin) { rate.set(key, arr); return true; }
  arr.push(now); rate.set(key, arr); return false;
}

const userPart = (jid) => (jid || '').split('@')[0].split(':')[0];

function extractText(m) {
  const msg = m.message || {};
  const inner = msg.ephemeralMessage?.message || msg.viewOnceMessage?.message || msg;
  return (
    inner.conversation ||
    inner.extendedTextMessage?.text ||
    inner.imageMessage?.caption ||
    inner.videoMessage?.caption ||
    ''
  ).trim();
}

function mentionsMe(m, sock) {
  const ctx = m.message?.extendedTextMessage?.contextInfo;
  const mine = [userPart(sock.user?.id), userPart(sock.user?.lid)].filter(Boolean);
  return (ctx?.mentionedJid || []).some((j) => mine.includes(userPart(j)));
}

function buildSystemPrompt(settings) {
  let p = config.systemPrompt.replace(/\{BOT_NAME\}/g, config.botName);
  if (settings.persona) p += `\n\nExtra instructions from the owner of this assistant:\n${settings.persona}`;
  return p;
}

/**
 * Decide whether to answer a message and, if so, generate + send a reply.
 * ctx = { sessionId, isHouse, sock, sentIds:Set }
 */
async function handleMessage(m, ctx) {
  const { sessionId, isHouse, sock, sentIds } = ctx;
  const jid = m.key.remoteJid;
  if (!jid || isJidBroadcast(jid) || isJidStatusBroadcast(jid) || isJidNewsletter(jid)) return;
  if (sentIds.has(m.key.id)) return; // our own reply echoing back

  const text = extractText(m);
  if (!text) return;

  const settings = getSettings(sessionId);
  if (!settings.enabled) return;

  const group = isJidGroup(jid);
  const myIds = [userPart(sock.user?.id), userPart(sock.user?.lid)].filter(Boolean);
  const isSelfChat = !group && myIds.includes(userPart(jid));

  let shouldReply = false;
  let prefix = '';
  if (m.key.fromMe) {
    // The owner typing in their own "Message yourself" chat = talking to the agent.
    shouldReply = !isHouse && isSelfChat;
  } else if (group) {
    shouldReply = !!settings.reply_groups && mentionsMe(m, sock);
  } else if (isHouse) {
    shouldReply = true; // the shared Air number answers everyone
  } else {
    shouldReply = !!settings.auto_reply; // personal number answering contacts
    prefix = '🤖 ';
  }
  if (!shouldReply) return;

  const sender = m.key.participant || jid;
  if (rateLimited(`${sessionId}:${sender}`)) return;

  const send = async (body) => {
    const sent = await sock.sendMessage(jid, { text: body }, { quoted: m });
    if (sent?.key?.id) sentIds.add(sent.key.id);
  };

  const cmd = text.toLowerCase();
  if (cmd === '/help' || cmd === 'help') return send(HELP);
  if (cmd === '/reset') { q.clearChat.run(sessionId, jid); return send('Memory cleared. Fresh start 👍'); }

  try { await sock.sendPresenceUpdate('composing', jid); } catch (_) {}

  const history = q.history.all(sessionId, jid, config.historyTurns * 2);
  const messages = [{ role: 'system', content: buildSystemPrompt(settings) }, ...history, { role: 'user', content: text }];

  let reply;
  try {
    reply = await ai.chat(messages);
  } catch (err) {
    console.error(`[${sessionId}] AI error:`, err.message);
    reply = "Sorry, my brain is warming up. Try again in a minute.";
    try { await sock.sendPresenceUpdate('paused', jid); } catch (_) {}
    return send(reply);
  }
  if (!reply) reply = '🤔';

  q.addMsg.run(sessionId, jid, 'user', text);
  q.addMsg.run(sessionId, jid, 'assistant', reply);
  try { await sock.sendPresenceUpdate('paused', jid); } catch (_) {}
  await send(prefix + reply);
}

module.exports = { handleMessage, extractText };
