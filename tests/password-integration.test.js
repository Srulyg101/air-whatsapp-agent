// End-to-end account recovery with temporary SQLite storage and a mocked email sender.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'air-agent-reset-'));
process.env.DATA_DIR = tmp;
process.env.APP_SECRET = 'testing-only-do-not-use-in-production';
process.env.AUTO_UPDATE_MIN = '0';

const recovery = require('../src/password-recovery');
let lastEmail;
recovery.isConfigured = () => true;
recovery.sendRecoveryEmail = async ({ to, token }) => { lastEmail = { to, token }; };
let lastSmtpTest;
recovery.sendTestEmail = async ({ to }) => { lastSmtpTest = to; return { submitted: true }; };
const app = require('../src/server');

test('forgot password issues a single-use link, revokes old logins and accepts new password', async t => {
  const server = app.listen(0, '127.0.0.1');
  t.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const post = async (uri, body, headers = {}) => {
    const res = await fetch(origin + uri, { method: 'POST', headers: { 'content-type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie') };
  };
  const email = 'alice@example.com';
  const signup = await post('/api/signup', { email, password:'oldPassword1234', name:'Alice' });
  assert.equal(signup.status, 200);
  const cookie = signup.cookie.split(';')[0];
  const smtp = await post('/api/admin/settings', {
    bot_smtp_host: 'smtp.example.test', bot_smtp_port: 587,
    bot_smtp_user: 'support@example.test', bot_smtp_pass: 'test-only-mailbox-password',
  }, { Cookie: cookie });
  assert.equal(smtp.status, 200);
  // Only logged-in admins may trigger an SMTP test; no arbitrary recipients.
  const noAuth = await post('/api/admin/password-recovery/test', {});
  assert.equal(noAuth.status, 401);
  const adminTest = await post('/api/admin/password-recovery/test', {}, { Cookie: cookie });
  assert.equal(adminTest.status, 200);
  assert.equal(adminTest.body.ok, true);
  assert.equal(adminTest.body.recipient, email);
  assert.equal(lastSmtpTest, email);
  const unknown = await post('/api/password/forgot', { email:'unknown@example.com' });
  const requested = await post('/api/password/forgot', { email });
  assert.equal(unknown.status, 200);
  assert.equal(requested.status, 200);
  assert.equal(requested.body.message, unknown.body.message);
  for (let attempt = 0; attempt < 20 && !lastEmail; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(lastEmail.to, email);
  assert.match(lastEmail.token, /^[0-9a-f]{64}$/);

  const changed = await post('/api/password/reset', { token:lastEmail.token, password:'newPassword1234' });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.ok, true);

  const priorSession = await fetch(origin + '/api/me', { headers: { Cookie: cookie } });
  assert.equal(priorSession.status, 401);
  assert.equal((await post('/api/login', { email, password:'oldPassword1234' })).status, 401);
  assert.equal((await post('/api/login', { email, password:'newPassword1234' })).status, 200);
  const reused = await post('/api/password/reset', { token:lastEmail.token, password:'anotherPassword1234' });
  assert.equal(reused.status, 400);
  assert.match(reused.body.error, /invalid or expired/);

  const recovery = require('../src/password-recovery');
  const now = Math.floor(Date.now() / 1000);
  const expired = recovery.newToken();
  require('../src/db').q.issuePasswordReset.run(recovery.hashToken(expired), 1, now - 1800, now - 1);
  const expiredAttempt = await post('/api/password/reset', { token: expired, password:'anotherPassword1234' });
  assert.equal(expiredAttempt.status, 400);
  assert.match(expiredAttempt.body.error, /invalid or expired/);

  for (let i = 0; i < 6; i++) assert.equal((await post('/api/login', { email, password:'wrongPasswordFixture' })).status, 401);
  assert.equal((await post('/api/login', { email, password:'newPassword1234' })).status, 429);
});
