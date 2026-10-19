const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'air-agent-security-'));
process.env.DATA_DIR = tmp;
process.env.APP_SECRET = 'test-only-security-key-not-for-production';
process.env.AUTO_UPDATE_MIN = '0';
process.env.FORCE_OPEN_SIGNUP = 'false';
const db = require('../src/db');
const app = require('../src/server');
const actions = require('../src/actions');

test('tenant isolation, cookie hashing, CSRF rejection, masked secrets, and action approval', async t => {
  const server = app.listen(0, '127.0.0.1');
  t.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = async (uri, body, headers = {}) => {
    const res = await fetch(origin + uri, { method: 'POST', headers: { 'content-type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie') };
  };
  const alice = await post('/api/signup', { email: 'alice-security@example.test', password: 'aliceTestPassword12', name: 'Alice' }, { 'X-Forwarded-Proto': 'https' });
  assert.equal(alice.status, 200);
  assert.match(alice.cookie, /HttpOnly/);
  assert.match(alice.cookie, /SameSite=Lax/);
  assert.match(alice.cookie, /Secure/);
  assert.match(alice.cookie, /Max-Age=2592000/);
  const aliceCookie = alice.cookie.split(';')[0];
  const rawToken = decodeURIComponent(aliceCookie.slice('token='.length));
  const storedToken = db.db.prepare('SELECT token FROM auth_tokens WHERE user_id = 1').get().token;
  assert.notEqual(storedToken, rawToken);
  assert.equal(storedToken, crypto.createHash('sha256').update(rawToken).digest('hex'));

  const createUser = await post('/api/admin/users', { email: 'bob-security@example.test', password: 'bobTestPassword12', name: 'Bob' }, { Cookie: aliceCookie });
  assert.equal(createUser.status, 200);
  const bob = await post('/api/login', { email: 'bob-security@example.test', password: 'bobTestPassword12' });
  assert.equal(bob.status, 200);
  const bobCookie = bob.cookie.split(';')[0];

  db.q.addNote.run('u1', 'synthetic-chat', 'Fixture', 'synthetic Alice-only note');
  db.q.addNote.run('house', 'synthetic-chat', 'Fixture', 'synthetic shared-house note');
  const aliceDoc = require('../src/knowledge').addDocument('u1', 'synthetic-private-doc.txt', 'Synthetic private document text owned only by Alice.').id;
  const aliceNotes = await fetch(origin + '/api/notes', { headers: { Cookie: aliceCookie } });
  assert.match(await aliceNotes.text(), /synthetic Alice-only note/);
  for (const target of ['', '?target=house']) {
    const res = await fetch(origin + '/api/notes' + target, { headers: { Cookie: bobCookie } });
    assert.doesNotMatch(await res.text(), /synthetic Alice-only note|synthetic shared-house note/);
  }
  const crossTenantDoc = await fetch(origin + `/api/kb/${aliceDoc}`, { headers: { Cookie: bobCookie } });
  assert.equal(crossTenantDoc.status, 404);
  const crossTenantDelete = await fetch(origin + `/api/kb/${aliceDoc}`, { method: 'DELETE', headers: { Cookie: bobCookie, Origin: origin } });
  assert.equal(crossTenantDelete.status, 200);
  assert.equal(db.q.doc.get(aliceDoc, 'u1')?.name, 'synthetic-private-doc.txt');

  const noOrigin = await fetch(origin + '/api/admin/settings', { method: 'POST', headers: { 'content-type': 'application/json', Cookie: aliceCookie }, body: JSON.stringify({ signup_open: true }) });
  assert.equal(noOrigin.status, 403);
  const wrongOrigin = await post('/api/admin/settings', { signup_open: true }, { Cookie: aliceCookie, Origin: 'https://attacker.example' });
  assert.equal(wrongOrigin.status, 403);
  const setSecret = await post('/api/admin/settings', { ai_key: 'synthetic-secret-fixture-1234567890' }, { Cookie: aliceCookie });
  assert.equal(setSecret.status, 200);
  const enableCustom = await post('/api/admin/settings', { allow_custom_ai: true }, { Cookie: aliceCookie });
  assert.equal(enableCustom.status, 200);
  const tenantSecretSave = await post('/api/settings', { secrets: { twilio_token: 'synthetic-tenant-secret-fixture' } }, { Cookie: aliceCookie });
  assert.equal(tenantSecretSave.status, 200);
  assert.notEqual(db.q.getSecret.get('u1', 'twilio_token').value, 'synthetic-tenant-secret-fixture');
  assert.equal(db.getSecret('u1', 'twilio_token'), 'synthetic-tenant-secret-fixture');
  const bobSettings = await fetch(origin + '/api/settings', { headers: { Cookie: bobCookie } });
  const bobSettingsBody = await bobSettings.json();
  assert.equal(bobSettingsBody.secrets.twilio_token, '');
  assert.doesNotMatch(JSON.stringify(bobSettingsBody), /synthetic-tenant-secret-fixture/);
  db.setApp('inbound_secret', 'synthetic-legacy-webhook-secret');
  assert.equal(require('../src/email').inboundSecret(), 'synthetic-legacy-webhook-secret');
  const settings = await fetch(origin + '/api/admin/settings', { headers: { Cookie: aliceCookie } });
  const settingsBody = await settings.json();
  assert.equal(settingsBody.ai_key, '••••••••');
  assert.equal(settingsBody.inbound_secret_configured, true);
  assert.equal(JSON.stringify(settingsBody).includes('synthetic-secret-fixture-1234567890'), false);
  assert.equal(JSON.stringify(settingsBody).includes('synthetic-legacy-webhook-secret'), false);
  assert.equal(db.getApp('inbound_secret'), '');
  assert.equal(db.getAppSecret('inbound_secret'), 'synthetic-legacy-webhook-secret');

  const nativeFetch = global.fetch;
  const startOAuth = await nativeFetch(origin + '/api/ai/openrouter/start', { headers: { Cookie: aliceCookie } });
  assert.equal(startOAuth.status, 200);
  const oauthState = (await startOAuth.json()).state;
  global.fetch = async url => {
    assert.equal(String(url), 'https://openrouter.ai/api/v1/auth/keys');
    return { ok: true, json: async () => ({ key: 'synthetic-openrouter-session-key' }) };
  };
  let callback;
  try {
    callback = await nativeFetch(`${origin}/ai/openrouter/callback?state=${encodeURIComponent(oauthState)}&code=synthetic-code`, { headers: { Cookie: aliceCookie }, redirect: 'manual' });
  } finally { global.fetch = nativeFetch; }
  assert.equal(callback.status, 302);
  assert.match(callback.headers.get('location') || '', /signin=ok/);
  assert.equal(db.getSecret('u1', 'ai_key'), 'synthetic-openrouter-session-key');

  const ctx = { sessionId: 'u1', jid: 'synthetic-chat', isOwner: true, settings: { options: { act_reminder: 'me', timezone: 'UTC' } } };
  const before = db.q.listReminders.all('u1').length;
  const preview = await actions.execute('set_reminder', { minutes_from_now: 60, text: 'synthetic approval fixture' }, ctx);
  assert.ok(preview.confirm);
  assert.equal(db.q.listReminders.all('u1').length, before);
  await actions.handleConfirmation(ctx, 'yes');
  assert.equal(db.q.listReminders.all('u1').length, before + 1);

  const health = await fetch(origin + '/health', { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(health.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"), true);
  assert.match(health.headers.get('strict-transport-security') || '', /max-age=/);

  const staleRaw = crypto.randomBytes(32).toString('hex');
  const staleHash = crypto.createHash('sha256').update(staleRaw).digest('hex');
  db.q.insertToken.run(staleHash, 2);
  db.db.prepare('UPDATE auth_tokens SET created_at = ? WHERE token = ?').run(Math.floor(Date.now() / 1000) - 31 * 86400, staleHash);
  const expiredSession = await fetch(origin + '/api/me', { headers: { Cookie: `token=${staleRaw}` } });
  assert.equal(expiredSession.status, 401);
});

test('SSRF guard rejects private and reserved IPv4/IPv6 targets and credential URLs', async () => {
  const guard = require('../src/netguard');
  for (const ip of ['127.0.0.1', '10.0.0.2', '169.254.169.254', '::1', '::ffff:127.0.0.1', '2001::1', 'fd00::1']) {
    assert.equal(guard.isPrivateIp(ip), true, `blocked ${ip}`);
  }
  assert.equal(guard.isPrivateIp('8.8.8.8'), false);
  assert.equal(guard.isPrivateIp('::ffff:8.8.8.8'), false);
  await assert.rejects(() => guard.assertPublicUrl('http://127.0.0.1/'));
  await assert.rejects(() => guard.assertPublicUrl('https://user:password@example.com/'));
  await assert.rejects(() => guard.assertPublicUrl('http://8.8.8.8/', { requireHttps: true }), /requires HTTPS/);
});
