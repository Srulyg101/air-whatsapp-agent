const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load(file, mocks, extras = {}) {
  const module = { exports: {} };
  const sandbox = {
    module, exports: module.exports,
    require: (name) => Object.hasOwn(mocks, name) ? mocks[name] : require(name),
    process: { env: { GROQ_API_KEY: 'test-managed-key' } },
    fetch: extras.fetch || (() => { throw new Error('unexpected network'); }),
    AbortSignal, Buffer, Blob, FormData, console, Date, setTimeout, clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../' + file), 'utf8'), sandbox, { filename: file });
  return module.exports;
}

test('managed mode selects Groq without asking users for keys', async () => {
  const values = { ai_base_url: '', ai_model: '', ai_daily_limit: '300' };
  const claims = []; const calls = [];
  const mocks = {
    './db': { getApp: (k) => values[k] || '', getAppSecret: () => '', getSecret: () => '',
      q: { claimAi: { run: (...args) => { claims.push(args); return { changes: 1 }; } } } },
    './config': { ollamaUrl: 'http://ollama:11434', model: 'qwen2.5:1.5b' },
    './netguard': { assertPublicUrl: async () => {} },
    './token-budget': require('../src/token-budget'),
  };
  const ai = load('src/ai.js', mocks, { fetch: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'Hello!' } }] }) };
  } });
  const provider = ai.resolveProvider({ options: { ai_mode: 'server' } });
  assert.equal(provider.base, 'https://api.groq.com/openai/v1');
  assert.equal(provider.model, 'openai/gpt-oss-20b');
  assert.equal(provider.key, 'test-managed-key');
  const r = await ai.chat([{ role: 'user', content: 'hi' }], { provider, budgetSessionId: 'u42' });
  assert.equal(r.content, 'Hello!');
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.reasoning_effort, 'low');
  assert.ok(body.max_completion_tokens <= 1100);
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(claims.length, 1);
  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/chat/completions');
});

test('smart voice prefers managed Whisper and transcribes WhatsApp OGG', async () => {
  const values = { ai_base_url: 'https://api.groq.com/openai/v1', voice_api_base: '' };
  const calls = [];
  const voice = load('src/voice.js', {
    './config': { dataDir: '/tmp', whisperModel: 'unused' },
    './db': { getApp: (k) => values[k] || '', getAppSecret: (k) => k === 'ai_key' ? 'test-managed-key' : '', getSecret: () => '' },
    './netguard': { assertPublicUrl: async () => {} },
    'ffmpeg-static': '/tmp/ffmpeg',
  }, { fetch: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ text: 'Can you help me?' }) };
  } });
  const settings = { session_id: 'u42', options: { voice_engine: 'smart', voice_api_model: '', ai_mode: 'server' } };
  assert.equal(voice.managedSpeechReady(), true);
  const transcript = await voice.transcribe(Buffer.alloc(1000, 1), 'audio/ogg', settings);
  assert.equal(transcript, 'Can you help me?');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(calls[0].options.body.get('model'), 'whisper-large-v3-turbo');
  await assert.rejects(() => voice.transcribe(Buffer.alloc(20), 'audio/ogg', settings), /15 MB/);
});
