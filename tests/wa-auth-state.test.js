const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const tmp = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'air-agent-auth-state-'));
process.env.DATA_DIR = tmp;
process.env.APP_SECRET = 'test-only-key-not-for-production';

const { useEncryptedMultiFileAuthState, ENCRYPTED_PREFIX } = require('../src/wa-auth-state');
const { decrypt } = require('../src/secrets');

test('existing WhatsApp auth JSON migrates in place and remains readable without a relink', async t => {
  const folder = path.join(tmp, 'auth', 'u-test');
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const legacy = JSON.stringify({ registrationId: 17, syntheticFixture: 'keep-linked-session' });
  await fs.writeFile(path.join(folder, 'creds.json'), legacy, { mode: 0o600 });

  const state = await useEncryptedMultiFileAuthState(folder);
  assert.equal(state.state.creds.syntheticFixture, 'keep-linked-session');
  let onDisk = await fs.readFile(path.join(folder, 'creds.json'), 'utf8');
  assert.ok(onDisk.startsWith(ENCRYPTED_PREFIX));
  assert.equal(onDisk.includes('keep-linked-session'), false);
  assert.equal(JSON.parse(decrypt(onDisk.slice(ENCRYPTED_PREFIX.length))).syntheticFixture, 'keep-linked-session');

  await state.saveCreds();
  await state.state.keys.set({ 'sender-key': { synthetic: { value: 'private-key-fixture' } } });
  const [key] = Object.values(await state.state.keys.get('sender-key', ['synthetic']));
  assert.equal(key.value, 'private-key-fixture');
  onDisk = await fs.readFile(path.join(folder, 'sender-key-synthetic.json'), 'utf8');
  assert.ok(onDisk.startsWith(ENCRYPTED_PREFIX));
  assert.equal((await fs.stat(folder)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(folder, 'creds.json'))).mode & 0o777, 0o600);
  t.after(() => require('node:fs').rmSync(tmp, { recursive: true, force: true }));
});

test('session auth refuses ciphertext that cannot be decrypted', async () => {
  const folder = path.join(tmp, 'bad-auth');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'creds.json'), ENCRYPTED_PREFIX + 'v1:corrupt');
  await assert.rejects(() => useEncryptedMultiFileAuthState(folder), /could not be decrypted/);
});
