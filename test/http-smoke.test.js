'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

test('server denies unauthenticated access and requires private admin bootstrap', { timeout: 30000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'air-agent-security-'));
  const port = 19081;
  const url = 'http://127.0.0.1:' + port;
  const secret = 'temporary-local-test-bootstrap-token-2026';
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DATA_DIR: tmp,
      OPEN_SIGNUP: 'false', COOKIE_SECURE: 'true',
      BOOTSTRAP_ADMIN_TOKEN: secret, OLLAMA_URL: 'http://127.0.0.1:9' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data.toString(); });
  child.stderr.on('data', (data) => { output += data.toString(); });
  const post = (route, body, cookie) => fetch(url + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body),
  });
  try {
    let ready = false;
    for (let i = 0; i < 70; i++) {
      if (child.exitCode !== null) throw new Error('Server exited: ' + output.slice(-2000));
      try { if ((await fetch(url + '/api/auth/config')).ok) { ready = true; break; } }
      catch (_) {}
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(ready, 'server did not start: ' + output.slice(-2000));
    const cfg = await (await fetch(url + '/api/auth/config')).json();
    assert.equal(cfg.firstUser, true);
    assert.equal(cfg.signupEnabled, false);
    const credentials = { name: 'Local Test', email: 'private@example.test', password: 'StrongPassword123!' };

    assert.equal((await post('/api/signup', credentials)).status, 403,
      'First signup must not work without bootstrap token');
    const first = await post('/api/signup', { ...credentials, setupToken: secret });
    assert.equal(first.status, 200);
    const setCookie = first.headers.get('set-cookie') || '';
    assert.match(setCookie, /; Secure/i);
    assert.match(setCookie, /SameSite=Strict/i);
    const cookie = setCookie.split(';')[0];

    const database = new Database(path.join(tmp, 'app.db'), { readonly: true });
    try {
      assert.match(database.prepare('SELECT token FROM auth_tokens LIMIT 1').get().token, /^sha256:[0-9a-f]{64}$/);
    } finally { database.close(); }

    assert.equal((await post('/api/signup', { ...credentials, email: 'second@example.test' })).status, 403);
    assert.equal((await fetch(url + '/api/admin/reply-audit')).status, 401);
    assert.equal((await fetch(url + '/metrics')).status, 401);
    assert.equal((await post('/api/admin/disconnect-all', {})).status, 401);

    // Force permissions even when an old saved configuration enables auto-reply.
    assert.equal((await post('/api/settings', { auto_reply: true, options: { allow_list: '' } }, cookie)).status, 400);
    assert.equal((await post('/api/settings', {
      auto_reply: true, options: { allow_list: '13475550123' },
    }, cookie)).status, 200);
    const audit = await fetch(url + '/api/admin/reply-audit', { headers: { Cookie: cookie } });
    assert.equal(audit.status, 200);
    assert.deepEqual((await audit.json()).events, []);
    const panic = await post('/api/admin/disconnect-all', {}, cookie);
    assert.equal(panic.status, 200);
    assert.equal((await panic.json()).ok, true);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => { if (child.exitCode !== null) r(); else child.once('exit', r); });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
