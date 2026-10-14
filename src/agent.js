const { isJidGroup, isJidBroadcast, isJidStatusBroadcast, isJidNewsletter } = require('@whiskeysockets/baileys');
const config = require('./config');
const ai = require('./ai');
const { q, getSettings } = require('./db');
const { approvedSender, blockedSender, maskedPeer, peerNumbers } = require('./security');
const { handleControl } = require('./controller');

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

function inQuietHours(o) {
  if (!o.quiet_enabled) return false;
  const now = new Intl.DateTimeFormat('en-GB', { timeZone: o.timezone || 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  const n = toMin(now), a = toMin(o.quiet_start), b = toMin(o.quiet_end);
  return a <= b ? n >= a && n < b : n >= a || n < b;
}
const awaySent = new Map(); // chat -> timestamp of last away message
const pendingReplies = new Set(); // avoid double response if two messages arrive together

/**
 * Decide whether to answer a message and, if so, generate + send a reply.
 * ctx = { sessionId, isHouse, sock, sentIds:Set }
 */
async function handleMessage(m, ctx) {
  const { sessionId, isHouse, sock, sentIds } = ctx;
  const isActive = ctx.isActive || (() => true);
  const jid = m.key.remoteJid;
  if (!jid || isJidBroadcast(jid) || isJidStatusBroadcast(jid) || isJidNewsletter(jid)) return;
  if (sentIds.has(m.key.id)) return; // our own reply echoing back

  const text = extractText(m);
  if (!text) return;

  const settings = getSettings(sessionId);
  const o = settings.options;
  // Reserved privileged commands must never be handled by the general AI.
  if (await handleControl(m, { sock, sessionId, isHouse, isActive })) return;
  if (!settings.enabled) return;

  const group = isJidGroup(jid);
  const mine = myIds(sock);
  const chatIds = [jid, m.key.remoteJidAlt, m.key.senderPn].map(userPart).filter(Boolean);
  const isSelfChat = !group && chatIds.some((c) => mine.includes(c));
  // Use the verified phone identity rather than unstable @lid and @s.whatsapp.net IDs.
  const verifiedPhone = peerNumbers(m)[0];
  const receiptKey = !group && verifiedPhone ? 'phone:' + verifiedPhone : jid;
  console.log(`[${sessionId}] msg fromMe=${!!m.key.fromMe} group=${!!group} peer=${maskedPeer(m)} len=${text.length}`);

  // Opt-in: retain only messages observed since context was enabled.
  // Never store controller commands or their PIN.
  const contextOn = !!o.context_enabled && !group && !isHouse && !!m.key.id &&
    !text.toLowerCase().startsWith('/do ');
  let observedHistory = [];
  if (contextOn) {
    observedHistory = q.recentObserved.all(sessionId, jid, String(m.key.id),
      Math.max(0, Math.min(10, Number(o.context_limit) || 10)));
    q.addObserved.run(sessionId, jid, String(m.key.id),
      m.key.fromMe ? 'assistant' : 'user', text.slice(0, 2000));
    q.trimObserved.run(sessionId, jid, sessionId, jid, 10);
  }

  let replyAction = 'command';
  const send = async (body) => {
    if (!isActive()) return;
    // Re-evaluate permissions AFTER slow AI generation and delay.
    const fresh = getSettings(sessionId);
    if (!fresh.enabled) return false;
    if (!m.key.fromMe) {
      if (blockedSender(m, fresh.options.block_list)) return false;
      if (!isHouse && (!approvedSender(m, fresh.options.allow_list) ||
        (group ? !fresh.reply_groups : !fresh.auto_reply))) return false;
      const receipt = !isHouse && !group ? q.hasReceipt.get(sessionId, receiptKey) : null;
      if (receipt && fresh.options.reply_once && !isHouse && !group) return false;
      if (receipt && Number(fresh.options.cooldown_minutes) > 0 &&
          Date.now() - receipt.last_reply_at * 1000 < Number(fresh.options.cooldown_minutes) * 60000) return false;
    }
    try {
      const sent = await sock.sendMessage(jid, { text: body }, o.quote_reply ? { quoted: m } : undefined);
      if (sent?.key?.id) {
        sentIds.add(sent.key.id);
        if (!m.key.fromMe && !isHouse && !group) q.recordReceipt.run(sessionId, receiptKey);
        if (contextOn) {
          q.addObserved.run(sessionId, jid, String(sent.key.id), 'assistant', body.slice(0, 2000));
          q.trimObserved.run(sessionId, jid, sessionId, jid, 10);
        }
      }
      q.addReplyAudit.run(sessionId, maskedPeer(m), replyAction, sent?.key?.id ? 'submitted' : 'unconfirmed');
      return !!sent?.key?.id;
    } catch (err) {
      q.addReplyAudit.run(sessionId, maskedPeer(m), replyAction, 'send_error');
      throw err;
    }
  };

  // Per-chat on/off: anyone can send /stop or /start in a chat.
  const cmd = text.trim().toLowerCase();
  // Check the sender BEFORE command handling, including /start and /stop.
  // Unknown @lid senders are denied on personal accounts unless a phone JID is available.
  if (!m.key.fromMe && (blockedSender(m, o.block_list) ||
    (!isHouse && !approvedSender(m, o.allow_list)))) return;
  const activeHere = m.key.fromMe || isHouse || (group ? !!settings.reply_groups : !!settings.auto_reply);
  if (!activeHere && (cmd === '/stop' || cmd === '/start')) return;
  if (cmd === '/stop') { q.mute.run(sessionId, jid); return send('Okay, I will stay quiet in this chat. Send /start to turn me back on.'); }
  if (cmd === '/start') { q.unmute.run(sessionId, jid); return send(`${config.botName} is back on in this chat.`); }
  if (q.isMuted.get(sessionId, jid)) return;

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
  if (!m.key.fromMe && !isHouse && !group) {
    const receipt = q.hasReceipt.get(sessionId, receiptKey);
    if (receipt && o.reply_once) return;
    if (receipt && Number(o.cooldown_minutes) > 0 &&
        Date.now() - receipt.last_reply_at * 1000 < Number(o.cooldown_minutes) * 60000) return;
  }
  const lockKey = sessionId + ':' + jid;
  if (pendingReplies.has(lockKey)) return;
  pendingReplies.add(lockKey);
  try {
  replyAction = 'ai';
  if (!m.key.fromMe && o.prefix_on && o.prefix_text) prefix = o.prefix_text.trim() + ' ';

  const sender = m.key.participant || jid;
  if (rateLimited(`${sessionId}:${sender}`)) return;

  if (cmd === '/help' || cmd === 'help') { replyAction = 'command'; return send(HELP); }
  if (cmd === '/reset') { replyAction = 'command'; q.clearChat.run(sessionId, jid); return send('Memory cleared. Fresh start 👍'); }

  if (!m.key.fromMe && inQuietHours(o)) {
    const last = awaySent.get(`${sessionId}:${jid}`) || 0;
    if (o.away_message && Date.now() - last > 6 * 3600_000) {
      awaySent.set(`${sessionId}:${jid}`, Date.now());
      replyAction = 'away';
      return send(o.away_message);
    }
    return;
  }

  if (o.typing) { try { await sock.sendPresenceUpdate('composing', jid); } catch (_) {} }

  const history = contextOn ? observedHistory :
    (o.memory ? q.history.all(sessionId, jid, config.historyTurns * 2) : []);
  const messages = [{ role: 'system', content: buildSystemPrompt(settings) }, ...history, { role: 'user', content: prompt }];

  let reply;
  try {
    reply = await ai.chat(messages);
  } catch (err) {
    console.error(`[${sessionId}] AI error:`, err.message);
    if (o.typing) { try { await sock.sendPresenceUpdate('paused', jid); } catch (_) {} }
    replyAction = 'error';
    return send('Sorry, my brain is warming up. Try again in a minute.');
  }
  if (!o.use_emojis) reply = reply.replace(EMOJI_RE, '').replace(/[ \t]{2,}/g, ' ').trim();
  if (!reply) reply = '...';

  if (o.reply_delay > 0) await new Promise((r) => setTimeout(r, o.reply_delay * 1000));
  if (o.typing) { try { await sock.sendPresenceUpdate('paused', jid); } catch (_) {} }
  const didSend = await send(prefix + reply);
  if (didSend && o.memory) {
    q.addMsg.run(sessionId, jid, 'user', prompt);
    q.addMsg.run(sessionId, jid, 'assistant', reply);
  }
  } finally {
    pendingReplies.delete(lockKey);
  }
}

module.exports = { handleMessage, extractText };
