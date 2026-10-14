const { isJidGroup, isJidBroadcast, isJidStatusBroadcast, isJidNewsletter } = require('@whiskeysockets/baileys');
const config = require('./config');
const ai = require('./ai');
const { q, getSettings } = require('./db');

const HELP = `*${config.botName}* — your AI on WhatsApp\n\n` +
  `Just send a message and I'll reply.\n\n` +
  `Commands:\n` +
  `/reset — forget this conversation\n` +
  `/ai <question> — ask me from inside any chat (owner only)\n` +
  `/stop — I stay quiet in this chat\n` +
  `/start — turn me back on in this chat\n` +
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
  let inner = m.message || {};
  for (let i = 0; i < 4; i++) {
    const next = inner.deviceSentMessage?.message || inner.ephemeralMessage?.message ||
      inner.viewOnceMessage?.message || inner.viewOnceMessageV2?.message || inner.documentWithCaptionMessage?.message;
    if (!next) break;
    inner = next;
  }
  return (
    inner.conversation ||
    inner.extendedTextMessage?.text ||
    inner.imageMessage?.caption ||
    inner.videoMessage?.caption ||
    ''
  ).trim();
}

function myIds(sock) {
  const me = sock.authState?.creds?.me || {};
  return [sock.user?.id, sock.user?.lid, me.id, me.lid].map(userPart).filter(Boolean);
}

function mentionsMe(m, sock) {
  const ctx = m.message?.extendedTextMessage?.contextInfo;
  const mine = myIds(sock);
  return (ctx?.mentionedJid || []).some((j) => mine.includes(userPart(j)));
}

const LENGTH_RULE = {
  short: 'Keep replies to 1-3 short sentences.',
  medium: 'Keep replies to a short paragraph or a few bullet points.',
  long: 'Give complete, detailed answers when useful.',
};

function buildSystemPrompt(settings) {
  const o = settings.options;
  let p = config.systemPrompt.replace(/\{BOT_NAME\}/g, config.botName);
  p += `\n${LENGTH_RULE[o.reply_length] || LENGTH_RULE.short}`;
  if (!o.use_emojis) p += '\nNever use emojis.';
  if (o.language) p += `\nAlways reply in ${o.language}.`;
  if (settings.persona) p += `\n\nExtra instructions from the owner of this assistant:\n${settings.persona}`;
  return p;
}

const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/gu;
const digits = (s) => String(s || '').replace(/\D/g, '');
const numberList = (s) => String(s || '').split(/[,;\n]+/).map(digits).filter((n) => n.length >= 5);
const matchesList = (ids, list) => list.length && ids.some((id) => list.some((n) => id.endsWith(n) || n.endsWith(id)));

function inQuietHours(o) {
  if (!o.quiet_enabled) return false;
  const now = new Intl.DateTimeFormat('en-GB', { timeZone: o.timezone || 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  const n = toMin(now), a = toMin(o.quiet_start), b = toMin(o.quiet_end);
  return a <= b ? n >= a && n < b : n >= a || n < b;
}
const awaySent = new Map(); // chat -> timestamp of last away message

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
  const o = settings.options;
  if (!settings.enabled) return;

  const group = isJidGroup(jid);
  const mine = myIds(sock);
  const chatIds = [jid, m.key.remoteJidAlt, m.key.senderPn].map(userPart).filter(Boolean);
  const isSelfChat = !group && chatIds.some((c) => mine.includes(c));
  console.log(`[${sessionId}] msg chat=${jid} alt=${m.key.remoteJidAlt || m.key.senderPn || '-'} fromMe=${!!m.key.fromMe} self=${isSelfChat} group=${!!group} len=${text.length}`);

  const send = async (body) => {
    const sent = await sock.sendMessage(jid, { text: body }, o.quote_reply ? { quoted: m } : undefined);
    if (sent?.key?.id) sentIds.add(sent.key.id);
  };

  // Per-chat on/off: anyone can send /stop or /start in a chat.
  const cmd = text.trim().toLowerCase();
  const activeHere = m.key.fromMe || isHouse || (group ? !!settings.reply_groups : !!settings.auto_reply);
  if (!activeHere && (cmd === '/stop' || cmd === '/start')) return;
  if (cmd === '/stop') { q.mute.run(sessionId, jid); return send('Okay, I will stay quiet in this chat. Send /start to turn me back on.'); }
  if (cmd === '/start') { q.unmute.run(sessionId, jid); return send(`${config.botName} is back on in this chat.`); }
  if (q.isMuted.get(sessionId, jid)) return;

  const senderIds = [m.key.participant, ...chatIds].map(digits).filter(Boolean);
  if (!m.key.fromMe) {
    if (matchesList(senderIds, numberList(o.block_list))) return;
    const allow = numberList(o.allow_list);
    if (allow.length && !matchesList(senderIds, allow)) return;
  }

  let shouldReply = false;
  let prefix = '';
  let prompt = text;
  const word = (o.trigger_word || '/ai').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const aiTrigger = o.ai_trigger && word ? text.match(new RegExp(`^\\s*${word}[:\\s]+([\\s\\S]+)`, 'i')) : null;
  if (m.key.fromMe && aiTrigger && !isHouse) {
    shouldReply = true; // owner summons the agent in any chat
    prompt = aiTrigger[1].trim();
  } else if (m.key.fromMe) {
    shouldReply = !isHouse && isSelfChat && o.self_chat; // "Message yourself" chat
  } else if (group) {
    shouldReply = !!settings.reply_groups && mentionsMe(m, sock);
  } else if (isHouse) {
    shouldReply = true; // the shared Air number answers everyone
  } else {
    shouldReply = !!settings.auto_reply; // personal number answering contacts
  }
  if (!shouldReply) return;
  if (!m.key.fromMe && o.prefix_on && o.prefix_text) prefix = o.prefix_text.trim() + ' ';

  const sender = m.key.participant || jid;
  if (rateLimited(`${sessionId}:${sender}`)) return;

  if (cmd === '/help' || cmd === 'help') return send(HELP);
  if (cmd === '/reset') { q.clearChat.run(sessionId, jid); return send('Memory cleared. Fresh start 👍'); }

  if (!m.key.fromMe && inQuietHours(o)) {
    const last = awaySent.get(`${sessionId}:${jid}`) || 0;
    if (o.away_message && Date.now() - last > 6 * 3600_000) {
      awaySent.set(`${sessionId}:${jid}`, Date.now());
      return send(o.away_message);
    }
    return;
  }

  if (o.typing) { try { await sock.sendPresenceUpdate('composing', jid); } catch (_) {} }

  const history = o.memory ? q.history.all(sessionId, jid, config.historyTurns * 2) : [];
  const messages = [{ role: 'system', content: buildSystemPrompt(settings) }, ...history, { role: 'user', content: prompt }];

  let reply;
  try {
    reply = await ai.chat(messages);
  } catch (err) {
    console.error(`[${sessionId}] AI error:`, err.message);
    if (o.typing) { try { await sock.sendPresenceUpdate('paused', jid); } catch (_) {} }
    return send('Sorry, my brain is warming up. Try again in a minute.');
  }
  if (!o.use_emojis) reply = reply.replace(EMOJI_RE, '').replace(/[ \t]{2,}/g, ' ').trim();
  if (!reply) reply = '...';

  if (o.memory) {
    q.addMsg.run(sessionId, jid, 'user', prompt);
    q.addMsg.run(sessionId, jid, 'assistant', reply);
  }
  if (o.reply_delay > 0) await new Promise((r) => setTimeout(r, o.reply_delay * 1000));
  if (o.typing) { try { await sock.sendPresenceUpdate('paused', jid); } catch (_) {} }
  await send(prefix + reply);
}

module.exports = { handleMessage, extractText };
