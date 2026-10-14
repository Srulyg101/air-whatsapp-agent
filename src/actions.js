// Actions the AI can take: email, phone calls, WhatsApp messages, reminders, notes, webhooks.
// Each action has a permission per number: off | me (owner only) | anyone.
// Risky actions (email, call, WhatsApp to someone else) ask "yes/no" first.
const crypto = require('crypto');
const { q, getSecret, logEvent } = require('./db');
const { assertPublicUrl } = require('./netguard');
const email = require('./email');

const digits = (s) => String(s || '').replace(/\D/g, '');
function normPhone(s) {
  let d = digits(s);
  if (d.length === 10) d = '1' + d; // assume US/Canada for 10-digit numbers
  return d.length >= 8 && d.length <= 15 ? d : '';
}

// ---------- time helpers ----------
function zonedToUtc(local, tz) {
  // local "2026-10-14 15:30" (or ISO) interpreted in time zone tz -> Date
  const m = String(local).trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
  if (!m) { const d = new Date(local); return isNaN(d) ? null : d; }
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(local)) return new Date(local);
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const offset = tzOffsetMs(new Date(asUtc), tz);
  return new Date(asUtc - offset);
}
function tzOffsetMs(date, tz) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(date).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - date.getTime();
  } catch (_) { return 0; }
}
function fmtTime(date, tz) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date); } catch (_) { return date.toISOString(); }
}

// ---------- definitions ----------
const DEFS = {
  send_email: {
    perm: 'act_email', confirm: true,
    ready: (o, s) => email.canSend(s, o),
    schema: { description: 'Send an email.', parameters: { type: 'object', properties: { to: { type: 'string', description: 'Recipient email address' }, subject: { type: 'string' }, body: { type: 'string', description: 'Plain-text email body' } }, required: ['to', 'subject', 'body'] } },
    preview: (a) => `📧 *Send email*\nTo: ${a.to}\nSubject: ${a.subject}\n\n${a.body}`,
  },
  check_email: {
    perm: 'act_email_read', confirm: false,
    ready: (o, s) => !!(email.status(s).imap || email.botAddress(s)),
    schema: { description: "List the newest emails in the assistant's inbox (or read one in full by id).", parameters: { type: 'object', properties: { email_id: { type: 'number', description: 'Optional: id of one email to read in full' } } } },
  },
  reply_email: {
    perm: 'act_email_read', confirm: true,
    ready: (o, s) => email.canSend(s, o) && !!(email.status(s).imap || email.botAddress(s)),
    schema: { description: 'Reply to an email in the inbox by its id.', parameters: { type: 'object', properties: { email_id: { type: 'number' }, body: { type: 'string', description: 'Plain-text reply' } }, required: ['email_id', 'body'] } },
    preview: (a, ctx) => { const m = q.email.get(Number(a.email_id), ctx.sessionId); return `📧 *Reply to email #${a.email_id}*
To: ${m ? m.from_addr : '?'}
Subject: Re: ${m ? m.subject : '?'}

${a.body}`; },
  },
  make_phone_call: {
    perm: 'act_call', confirm: true,
    ready: (o, s) => !!(o.twilio_sid && o.twilio_from && getSecret(s, 'twilio_token')),
    schema: { description: 'Place a phone call to a number and speak a message out loud (text-to-speech).', parameters: { type: 'object', properties: { to: { type: 'string', description: 'Phone number with country code' }, message: { type: 'string', description: 'What to say on the call' } }, required: ['to', 'message'] } },
    preview: (a) => `📞 *Phone call*\nTo: +${normPhone(a.to) || a.to}\nWill say: "${a.message}"`,
  },
  send_whatsapp: {
    perm: 'act_whatsapp', confirm: true,
    ready: () => true,
    schema: { description: "Send a WhatsApp message from the owner's number to another phone number.", parameters: { type: 'object', properties: { to: { type: 'string', description: 'Phone number with country code' }, message: { type: 'string' } }, required: ['to', 'message'] } },
    preview: (a) => `💬 *WhatsApp message*\nTo: +${normPhone(a.to) || a.to}\n\n${a.message}`,
  },
  set_reminder: {
    perm: 'act_reminder', confirm: false,
    ready: () => true,
    schema: { description: 'Schedule a reminder message in this chat at a future time.', parameters: { type: 'object', properties: { when: { type: 'string', description: 'Local date and time, format YYYY-MM-DD HH:MM' }, minutes_from_now: { type: 'number', description: 'Alternative to "when": minutes from now' }, text: { type: 'string', description: 'What to remind about' } }, required: ['text'] } },
  },
  save_note: {
    perm: 'act_note', confirm: false,
    ready: () => true,
    schema: { description: 'Save a note or lead for the owner (e.g. a customer name, phone, order or request).', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  },
  notify_owner: {
    perm: 'act_notify', confirm: false,
    ready: () => true,
    schema: { description: 'Alert the human owner when someone needs a real person, wants to buy, or something is urgent.', parameters: { type: 'object', properties: { message: { type: 'string', description: 'Short summary for the owner' } }, required: ['message'] } },
  },
  trigger_webhook: {
    perm: 'act_webhook', confirm: false,
    ready: (o) => !!o.webhook_url,
    schema: { description: 'Send an event to the owner\'s automation (Zapier/Make/n8n/CRM), e.g. new order or booking request.', parameters: { type: 'object', properties: { event: { type: 'string', description: 'Short event name, e.g. new_order' }, details: { type: 'string', description: 'All relevant details' } }, required: ['event', 'details'] } },
  },
};

/** Tools this sender may use in this chat. */
function toolsFor(ctx) {
  const o = ctx.settings.options;
  const out = [];
  for (const [name, d] of Object.entries(DEFS)) {
    const perm = o[d.perm];
    if (perm === 'off' || !perm) continue;
    if (perm === 'me' && !ctx.isOwner) continue;
    if (name === 'notify_owner' && ctx.isOwner) continue; // owner doesn't need to notify themselves
    if (!d.ready(o, ctx.sessionId)) continue;
    out.push({ type: 'function', function: { name, ...d.schema } });
  }
  return out;
}

// ---------- confirmations ----------
const pending = new Map(); // `${session}:${jid}` -> { name, args, expires }
const YES = /^(y|yes|yeah|yep|ok|okay|confirm|send|do it|go|go ahead|sure|כן|יא|jo|ja)[.! ]*$/i;
const NO = /^(n|no|nope|cancel|stop|don'?t|לא|nein|nisht)[.! ]*$/i;

/** If the owner is answering a pending yes/no, handle it. Returns reply text or null. */
async function handleConfirmation(ctx, text) {
  const key = `${ctx.sessionId}:${ctx.jid}:${ctx.isOwner ? 'owner' : ctx.sender || ''}`;
  const p = pending.get(key);
  if (!p) return null;
  if (Date.now() > p.expires) { pending.delete(key); return null; }
  if (p.isOwner !== !!ctx.isOwner) return null; // only whoever asked can confirm
  if (YES.test(text.trim())) { pending.delete(key); return run(p.name, p.args, ctx, true); }
  if (NO.test(text.trim())) { pending.delete(key); logEvent(ctx.sessionId, 'action', ctx.jid, `Cancelled ${p.name}`); return '👍 Cancelled.'; }
  pending.delete(key); // anything else = moved on
  return null;
}

/**
 * Execute a tool call. Returns a short result string for the AI (or for the user).
 * When confirmation is needed, the returned object has { confirm: '...' } instead.
 */
async function execute(name, args, ctx) {
  const d = DEFS[name];
  if (!d) return `Unknown action ${name}`;
  const o = ctx.settings.options;
  const perm = o[d.perm];
  if (!perm || perm === 'off' || (perm === 'me' && !ctx.isOwner)) return 'This action is not allowed here.';
  if (!d.ready(o, ctx.sessionId)) return `Error: ${name.replace(/_/g, ' ')} is not set up yet. Tell the user to set it up in the dashboard.`;
  const bad = validate(name, args);
  if (bad) return bad;
  if (ctx.dryRun) return `(test mode) Would run ${name}: ${JSON.stringify(args)}`;
  if (d.confirm && o.confirm_actions) {
    pending.set(`${ctx.sessionId}:${ctx.jid}:${ctx.isOwner ? 'owner' : ctx.sender || ''}`, { name, args, isOwner: !!ctx.isOwner, expires: Date.now() + 10 * 60_000 });
    return { confirm: `${d.preview(args, ctx)}\n\nReply *yes* to go ahead or *no* to cancel.` };
  }
  return run(name, args, ctx, false);
}

function validate(name, a) {
  if (name === 'send_email' && !/^\S+@\S+\.\S+$/.test(String(a.to || ''))) return 'Error: need a valid email address. Ask for it.';
  if (name === 'reply_email' && !String(a.body || '').trim()) return 'Error: the reply is empty.';
  if ((name === 'make_phone_call' || name === 'send_whatsapp') && !normPhone(a.to)) return 'Error: need a full phone number with country code. Ask for it.';
  if ((name === 'make_phone_call' || name === 'send_whatsapp') && !String(a.message || '').trim()) return 'Error: message is empty.';
  return null;
}

async function run(name, a, ctx, viaConfirm) {
  const o = ctx.settings.options;
  try {
    let result;
    if (name === 'send_email') {
      await email.send(ctx.sessionId, o, { to: a.to, subject: a.subject, text: a.body });
      result = `Email sent to ${a.to}.`;
    } else if (name === 'check_email') {
      if (a.email_id) {
        const m = q.email.get(Number(a.email_id), ctx.sessionId);
        return m ? `Email #${m.id} from ${m.from_name || ''} <${m.from_addr}>, subject "${m.subject}", ${new Date(m.date * 1000).toISOString().slice(0, 16)}:\n${m.text.slice(0, 4000)}` : 'No email with that id.';
      }
      const list = q.listEmails.all(ctx.sessionId, 10);
      if (!list.length) return 'The inbox is empty.';
      return 'Newest emails:\n' + list.map((m) => `#${m.id} · ${new Date(m.date * 1000).toISOString().slice(0, 16)} · from ${m.from_name || m.from_addr} · "${m.subject}" · ${m.snippet.replace(/\s+/g, ' ').slice(0, 160)}`).join('\n');
    } else if (name === 'reply_email') {
      const m = q.email.get(Number(a.email_id), ctx.sessionId);
      if (!m) return 'No email with that id.';
      await email.send(ctx.sessionId, o, { to: m.from_addr, subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`, text: a.body, inReplyTo: m.message_id || undefined });
      result = `Replied to ${m.from_addr}.`;
    } else if (name === 'make_phone_call') {
      const to = '+' + normPhone(a.to);
      const say = String(a.message).slice(0, 3000).replace(/[<>&]/g, ' ');
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(o.twilio_sid)}/Calls.json`, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + Buffer.from(`${o.twilio_sid}:${getSecret(ctx.sessionId, 'twilio_token')}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: to, From: o.twilio_from, Twiml: `<Response><Pause length="1"/><Say>${say}</Say><Pause length="1"/><Say>${say}</Say></Response>` }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 200)}`);
      result = `Calling ${to} now.`;
    } else if (name === 'send_whatsapp') {
      const num = normPhone(a.to);
      const [hit] = await ctx.sock.onWhatsApp(num);
      if (!hit?.exists) return `+${num} is not on WhatsApp.`;
      await ctx.sendRaw(hit.jid, { text: String(a.message).slice(0, 4000) });
      result = `WhatsApp message sent to +${num}.`;
    } else if (name === 'set_reminder') {
      let due = null;
      if (a.minutes_from_now) due = new Date(Date.now() + Math.max(1, Number(a.minutes_from_now)) * 60_000);
      else if (a.when) due = zonedToUtc(a.when, o.timezone);
      if (!due || isNaN(due)) return 'Error: I need a time for the reminder. Ask when.';
      if (due.getTime() < Date.now() - 60_000) return 'Error: that time is in the past. Ask for a future time.';
      // The owner's reminders go to their own "Message yourself" chat, not to whoever they were talking to.
      const target = ctx.isOwner && ctx.ownerJid && !ctx.isCommander ? ctx.ownerJid : ctx.jid;
      q.addReminder.run(ctx.sessionId, target, Math.floor(due.getTime() / 1000), String(a.text).slice(0, 1000));
      result = `Reminder set for ${fmtTime(due, o.timezone)}.`;
    } else if (name === 'save_note') {
      q.addNote.run(ctx.sessionId, ctx.jid, ctx.contact || null, String(a.text).slice(0, 4000));
      result = 'Saved.';
    } else if (name === 'notify_owner') {
      if (!ctx.ownerJid) return 'Could not reach the owner right now.';
      await ctx.sendRaw(ctx.ownerJid, { text: `📣 *${ctx.contact || 'Someone'}* needs you:\n${String(a.message).slice(0, 2000)}` });
      result = 'The owner has been notified.';
    } else if (name === 'trigger_webhook') {
      await assertPublicUrl(o.webhook_url);
      const payload = JSON.stringify({ event: String(a.event).slice(0, 100), details: String(a.details).slice(0, 8000), contact: ctx.contact || null, chat: ctx.jid, at: new Date().toISOString() });
      const secret = getSecret(ctx.sessionId, 'webhook_secret');
      const headers = { 'Content-Type': 'application/json' };
      if (secret) headers['X-Air-Signature'] = crypto.createHmac('sha256', secret).update(payload).digest('hex');
      const res = await fetch(o.webhook_url, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`Webhook HTTP ${res.status}`);
      result = 'Done.';
    }
    logEvent(ctx.sessionId, 'action', ctx.jid, `${name}: ${result}`);
    return viaConfirm ? `✅ ${result}` : result;
  } catch (e) {
    logEvent(ctx.sessionId, 'error', ctx.jid, `${name} failed: ${e.message}`);
    return viaConfirm ? `⚠️ Failed: ${e.message}` : `Error: ${e.message}`;
  }
}

// ---------- reminder scheduler ----------
function startScheduler(wa) {
  const tick = async () => {
    for (const r of q.dueReminders.all()) {
      const s = wa.get(r.session_id);
      if (s.status !== 'open' || !s.sock) {
        if (Date.now() / 1000 - r.due_ts > 86400) q.setReminder.run('failed', r.id);
        continue;
      }
      try {
        const sent = await s.sock.sendMessage(r.chat_jid, { text: `⏰ *Reminder:* ${r.text}` });
        if (sent?.key?.id) s.sentIds.add(sent.key.id);
        q.setReminder.run('sent', r.id);
        logEvent(r.session_id, 'action', r.chat_jid, `Reminder sent: ${r.text.slice(0, 80)}`);
      } catch (e) { logEvent(r.session_id, 'error', r.chat_jid, `Reminder failed: ${e.message}`); }
    }
  };
  setInterval(() => tick().catch(() => {}), 20_000).unref();
}

/** Owner-triggered test of a connector from the dashboard. */
async function testConnector(kind, ctx, target) {
  if (kind === 'email') return run('send_email', { to: target, subject: 'Air Agent test email', body: 'Your Air Agent email is set up correctly.' }, ctx, false);
  if (kind === 'imap') { const n = await email.checkImap(ctx.sessionId, null); return `Connected ✓ — ${n} new email(s) loaded.`; }
  if (kind === 'call') return run('make_phone_call', { to: target, message: 'Hello, this is a test call from your Air Agent.' }, ctx, false);
  if (kind === 'webhook') return run('trigger_webhook', { event: 'test', details: 'Test event from the Air Agent dashboard' }, ctx, false);
  return 'Unknown connector';
}

module.exports = { toolsFor, execute, handleConfirmation, startScheduler, testConnector, normPhone, fmtTime, zonedToUtc, DEFS };
