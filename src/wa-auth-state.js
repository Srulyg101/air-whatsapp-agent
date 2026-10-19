// Baileys multi-file state with authenticated encryption at rest. The on-disk
// format stays compatible with the Baileys JSON representation so existing
// linked sessions migrate in place without asking users to scan again.
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { proto, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const { encrypt, decrypt } = require('./secrets');

const ENCRYPTED_PREFIX = 'AIR-WA-AUTH:v1:';
const fileLocks = new Map();

function safeName(name) { return String(name || '').replace(/\//g, '__').replace(/:/g, '-'); }

async function withFileLock(file, fn) {
  const previous = fileLocks.get(file) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  const tail = previous.then(() => current);
  fileLocks.set(file, tail);
  await previous;
  try { return await fn(); }
  finally {
    release();
    if (fileLocks.get(file) === tail) fileLocks.delete(file);
  }
}

function decodeFile(onDisk) {
  const encrypted = String(onDisk).startsWith(ENCRYPTED_PREFIX);
  if (!encrypted) return { plaintext: String(onDisk), encrypted: false };
  const plaintext = decrypt(String(onDisk).slice(ENCRYPTED_PREFIX.length));
  if (!plaintext) throw new Error('WhatsApp session data could not be decrypted. Check the server encryption key and restore path.');
  return { plaintext, encrypted: true };
}

async function writeEncrypted(file, plaintext) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const value = ENCRYPTED_PREFIX + encrypt(plaintext);
  try {
    await fs.writeFile(tmp, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, file);
    await fs.chmod(file, 0o600);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

async function secureDirectory(folder) {
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  await fs.chmod(folder, 0o700);
  const entries = await fs.readdir(folder, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue;
    const file = path.join(folder, entry.name);
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unexpected file type in WhatsApp session storage.');
    const data = await fs.readFile(file, 'utf8');
    const decoded = decodeFile(data);
    // Validate before replacing a legacy file. A failed migration leaves the
    // original session file intact and prevents a fresh, unlinked session.
    JSON.parse(decoded.plaintext, BufferJSON.reviver);
    if (!decoded.encrypted) await writeEncrypted(file, decoded.plaintext);
    else await fs.chmod(file, 0o600);
  }
}

async function useEncryptedMultiFileAuthState(folder) {
  await secureDirectory(folder);
  const filePath = file => path.join(folder, safeName(file));

  const writeData = async (data, name) => {
    const file = filePath(name);
    return withFileLock(file, async () => {
      await fs.mkdir(folder, { recursive: true, mode: 0o700 });
      await writeEncrypted(file, JSON.stringify(data, BufferJSON.replacer));
    });
  };

  const readData = async name => {
    const file = filePath(name);
    return withFileLock(file, async () => {
      try {
        const raw = await fs.readFile(file, 'utf8');
        const decoded = decodeFile(raw);
        const value = JSON.parse(decoded.plaintext, BufferJSON.reviver);
        if (!decoded.encrypted) await writeEncrypted(file, decoded.plaintext);
        else await fs.chmod(file, 0o600);
        return value;
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        if (/could not be decrypted|Unexpected file type/.test(err.message)) throw err;
        throw new Error('WhatsApp session data is invalid. Restore its secure backup before reconnecting.');
      }
    });
  };

  const removeData = async name => {
    const file = filePath(name);
    return withFileLock(file, () => fs.unlink(file).catch(err => { if (err.code !== 'ENOENT') throw err; }));
  };

  const creds = (await readData('creds.json')) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async id => {
            let value = await readData(`${type}-${id}.json`);
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            data[id] = value;
          }));
          return data;
        },
        set: async data => {
          const writes = [];
          for (const category of Object.keys(data || {})) {
            for (const id of Object.keys(data[category] || {})) {
              const value = data[category][id];
              const file = `${category}-${id}.json`;
              writes.push(value ? writeData(value, file) : removeData(file));
            }
          }
          await Promise.all(writes);
        },
      },
    },
    saveCreds: async () => writeData(creds, 'creds.json'),
  };
}

module.exports = { useEncryptedMultiFileAuthState, ENCRYPTED_PREFIX, secureDirectory };
