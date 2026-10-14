'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const security = require('../src/security');

test('personal sender list denies unknown numbers and opaque Linked IDs', () => {
  assert.equal(security.hasApprovedNumbers(''), false);
  assert.equal(security.approvedSender({ key: { remoteJid: '7654321098765@lid' } }, '13475550123'), false);
  assert.equal(security.approvedSender({ key: { remoteJid: '13475550123@s.whatsapp.net' } }, ''), false);
  assert.equal(security.approvedSender({ key: { remoteJid: '13475550123@s.whatsapp.net' } }, '5550123'), false);
});
test('only exact valid international phone numbers can match', () => {
  const m = { key: { remoteJid: '8000000000@lid', remoteJidAlt: '13475550123@s.whatsapp.net' } };
  assert.equal(security.approvedSender(m, '13475550123'), true);
  assert.equal(security.approvedSender(m, '+1 (347) 555-0123'), true);
  assert.equal(security.approvedSender(m, '2348155454251'), false);
  assert.equal(security.blockedSender(m, '13475550123'), true);
  assert.equal(security.maskedPeer(m), '••••0123');
});
test('not every digit-only WhatsApp identifier is a verified phone number', () => {
  assert.equal(security.phoneFromJid('1234567890123@lid'), '');
  assert.equal(security.phoneFromJid('1234567890123@g.us'), '');
  assert.equal(security.phoneFromJid('13475550123@s.whatsapp.net'), '13475550123');
});

// Evaluate the agent with mocked Baileys, AI and database dependencies.
function agentHarness({ allowList = '', autoReply = 1, changePermissionsDuringAI = false, replyOnce = true, contextOn = false } = {}) {
  const replies = []; const audit = []; const receipts = new Map(); const observations = []; const modelCalls = [];
  let settings = {
    enabled: 1, auto_reply: autoReply, reply_groups: 0,
    persona: '', options: { allow_list: allowList, block_list: '', self_chat: true,
      reply_once: replyOnce, context_enabled: contextOn, context_limit: 10, cooldown_minutes: 0,
      ai_trigger: true, trigger_word: '/ai', prefix_on: true, prefix_text: '🤖',
      quote_reply: false, reply_delay: 0, typing: false, memory: false,
      use_emojis: true, reply_length: 'short', language: '', quiet_enabled: false },
  };
  const q = {
    isMuted: { get: () => false }, mute: { run() {} }, unmute: { run() {} },
    clearChat: { run() {} }, history: { all: () => [] }, addMsg: { run() {} },
    addReplyAudit: { run: (...args) => audit.push(args) },
    hasReceipt: { get: (sid,jid) => receipts.get(sid+':'+jid) },
    recordReceipt: { run: (sid,jid) => receipts.set(sid+':'+jid, {last_reply_at:Math.floor(Date.now()/1000),reply_count:1}) },
    recentObserved: { all: (sid,jid,current,limit) => observations.filter((o) => o.sid===sid && o.jid===jid && o.id!==current).slice(-limit).map((o)=>({role:o.role,content:o.content})) },
    addObserved: { run: (sid,jid,id,role,content) => observations.push({sid,jid,id,role,content}) },
    trimObserved: { run: () => {} },
  };
  const mockRequire = (id) => {
    if (id === '@whiskeysockets/baileys') return {
      isJidGroup: (id) => id.endsWith('@g.us'),
      isJidBroadcast: () => false, isJidStatusBroadcast: () => false,
      isJidNewsletter: () => false,
    };
    if (id === './db') return { q, getSettings: () => settings };
    if (id === './config') return { botName: 'Agent', rateLimitPerMin: 100, systemPrompt: 'You are {BOT_NAME}.' };
    if (id === './security') return security;
    if (id === './controller') return { handleControl: async () => false };
    if (id === './ai') return { chat: async (messages) => {
      modelCalls.push(messages);
      if (changePermissionsDuringAI) settings = { ...settings, auto_reply: 0 };
      return 'AI answer';
    } };
    throw new Error('Unknown dependency: ' + id);
  };
  const mod = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../src/agent.js'), 'utf8');
  vm.runInNewContext('(function(require, module, exports) {' + source + '\n})', {
    console: { log() {}, error() {} }, setTimeout, Date, Intl,
  })(mockRequire, mod, mod.exports);
  const sock = { user: { id: '13470000000@s.whatsapp.net' },
    authState: { creds: {} }, sendMessage: async (jid, payload) => {
      replies.push({ jid, payload }); return { key: { id: 'sent1' } };
    } };
  const message = (phone) => ({ key: { remoteJid: phone + '@s.whatsapp.net',
    fromMe: false, id: 'incoming1' }, message: { conversation: 'Hello' } });
  const ctx = { sessionId: 'u1', isHouse: false, sentIds: new Set(), sock, isActive: () => true };
  return { handleMessage: mod.exports.handleMessage, message, ctx, replies, audit, receipts, observations, modelCalls };
}
test('old saved auto-reply without an allow list is blocked', async () => {
  const a = agentHarness({ allowList: '' });
  await a.handleMessage(a.message('2348155454251'), a.ctx);
  assert.equal(a.replies.length, 0);
  assert.equal(a.audit.length, 0);
});
test('approved sender triggers AI and audit records only masked metadata', async () => {
  const a = agentHarness({ allowList: '13475550123' });
  await a.handleMessage(a.message('13475550123'), a.ctx);
  assert.equal(a.replies.length, 1);
  assert.equal(a.audit.length, 1);
  assert.deepEqual([...a.audit[0]], ['u1', '••••0123', 'ai', 'submitted']);
});
test('permissions revoked while AI runs prevent late send', async () => {
  const a = agentHarness({ allowList: '13475550123', changePermissionsDuringAI: true });
  await a.handleMessage(a.message('13475550123'), a.ctx);
  assert.equal(a.replies.length, 0);
});
test('unauthorized senders cannot trigger even command responses', async () => {
  const a = agentHarness({ allowList: '13475550123' });
  const m = a.message('2348155454251'); m.message.conversation = '/help';
  await a.handleMessage(m, a.ctx);
  assert.equal(a.replies.length, 0);
});

test('reply once persists per verified phone identity', async () => {
  const a = agentHarness({ allowList: '13475550123', replyOnce: true });
  const first = a.message('13475550123');
  await a.handleMessage(first, a.ctx);
  const second = a.message('13475550123');
  second.key.id = 'incoming2';
  await a.handleMessage(second, a.ctx);
  assert.equal(a.replies.length, 1, 'never send a second automatic reply');
  assert.equal(a.modelCalls.length, 1, 'do not run AI after the first reply');
});
test('context opt-in reads up to ten previous observed chat messages', async () => {
  const a = agentHarness({ allowList: '13475550123', replyOnce: false, contextOn: true });
  const first = a.message('13475550123');
  first.message.conversation = 'My appointment is Monday.';
  await a.handleMessage(first, a.ctx);
  const second = a.message('13475550123');
  second.key.id = 'incoming2';
  second.message.conversation = 'When is my appointment?';
  await a.handleMessage(second, a.ctx);
  assert.equal(a.modelCalls.length, 2);
  assert.equal(a.modelCalls[1].some((m) => m.content === 'My appointment is Monday.'), true);
  assert.equal(a.modelCalls[1].some((m) => m.content === 'When is my appointment?'), true);
});
