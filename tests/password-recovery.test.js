const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const net = require('node:net');

function loadRecovery(env, configured = true) {
  const module = { exports: {} };
  const deliveries = [];
  const settings = {
    bot_smtp_host: configured ? 'smtp.example.com' : '',
    bot_smtp_user: 'support@example.com',
    bot_smtp_port: '587',
    reset_email_from: '',
  };
  const requireMock = name => {
    if (name === 'crypto') return crypto;
    if (name === 'net') return net;
    if (name === 'nodemailer') return { createTransport: params => ({ verify: async () => true, sendMail: async message => deliveries.push({ params, message }) }) };
    if (name === './db') return {
      getApp: k => settings[k] || '',
      getAppSecret: k => k === 'bot_smtp_pass' ? 'dummy-secret' : '',
    };
    if (name === './netguard') return { assertPublicHost: async name => assert.equal(name, 'smtp.example.com') };
    throw new Error('Unexpected dependency: ' + name);
  };
  vm.runInNewContext(
    fs.readFileSync(require.resolve('../src/password-recovery.js'), 'utf8'),
    { module, require: requireMock, process: { env }, URL, encodeURIComponent },
    { filename: 'src/password-recovery.js' }
  );
  return { recovery: module.exports, deliveries, settings };
}

test('random links are unguessable; only hashes need to be stored', () => {
  const { recovery } = loadRecovery({});
  const a = recovery.newToken();
  const b = recovery.newToken();
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.notEqual(a, b);
  assert.equal(recovery.hashToken(a).length, 64);
  assert.notEqual(recovery.hashToken(a), a);
});

test('email links have 20-minute expiry and use trusted HTTPS domain', async () => {
  const { recovery, deliveries } = loadRecovery({});
  assert.equal(recovery.RESET_TTL_SECONDS, 1200);
  assert.equal(recovery.RESET_COOLDOWN_SECONDS, 300);
  const token = recovery.newToken();
  const link = recovery.recoveryLink(token);
  assert.equal(link, 'https://agent.llama2.com/#/reset?token=' + token);
  await recovery.sendRecoveryEmail({ to: 'alice@example.com', token });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].message.to, 'alice@example.com');
  assert.match(deliveries[0].message.text, /20 minutes/);
  assert.ok(deliveries[0].message.text.includes(link));
  assert.equal(deliveries[0].params.auth.user, 'support@example.com');
});

test('reset links cannot use an insecure or credential-bearing custom origin', () => {
  for (const value of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/other']) {
    const { recovery } = loadRecovery({ PUBLIC_URL: value });
    assert.throws(() => recovery.recoveryLink('a'.repeat(64)), /PUBLIC_URL/);
  }
});

test('password recovery is correctly disabled when mail is unconfigured', () => {
  const { recovery } = loadRecovery({}, false);
  assert.equal(recovery.isConfigured(), false);
});

test('custom sender and trusted HTTPS origin are supported', () => {
  const { recovery, settings } = loadRecovery({ PUBLIC_URL: 'https://agent.llama2.com' });
  settings.reset_email_from = 'hello@example.com';
  assert.match(recovery.senderSettings().from, /hello@example.com/);
  assert.match(recovery.recoveryLink('b'.repeat(64)), /^https:\/\/agent\.llama2\.com\/#\/reset\?token=/);
});

test('SMTP test sends to admin only with required TLS submission', async () => {
  const { recovery, deliveries } = loadRecovery({});
  const result = await recovery.sendTestEmail({ to: 'admin@example.com' });
  assert.equal(result.submitted, true);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].message.to, 'admin@example.com');
  assert.equal(deliveries[0].params.requireTLS, true);
  assert.equal(deliveries[0].params.tls.minVersion, 'TLSv1.2');
  assert.equal(deliveries[0].params.port, 587);
  assert.match(deliveries[0].message.subject, /test/i);
});
test('SMTP test fails closed when no sending account exists', async () => {
  const { recovery } = loadRecovery({}, false);
  await assert.rejects(() => recovery.sendTestEmail({ to: 'admin@example.com' }), /incomplete or invalid/);
});

test('Hostinger SMTP status identifies missing fields without returning credential values', () => {
  const { recovery, settings } = loadRecovery({});
  settings.bot_smtp_host = 'smtp.hostinger.com';
  settings.bot_smtp_port = '465';
  const status = recovery.setupStatus();
  assert.equal(status.configured, true);
  assert.equal(status.ready, true);
  assert.equal(status.enabled, true);
  assert.equal(JSON.stringify(status).includes('dummy-secret'), false);
  assert.equal(recovery.senderSettings().host, 'smtp.hostinger.com');
  assert.equal(recovery.senderSettings().port, 465);
});

test('invalid SMTP port is not silently replaced with a default', () => {
  const { recovery, settings } = loadRecovery({});
  settings.bot_smtp_port = 'banana';
  assert.equal(recovery.setupStatus().configured, false);
});
