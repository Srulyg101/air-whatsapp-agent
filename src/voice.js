// Voice notes: speech-to-text (open-source Whisper on this server, or any OpenAI-compatible audio API)
// and optional text-to-speech replies.
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');
const { getApp, getAppSecret, getSecret } = require('./db');
const { assertPublicUrl } = require('./netguard');

let ffmpegPath = null;
try { ffmpegPath = require('ffmpeg-static'); } catch (_) { ffmpegPath = 'ffmpeg'; }

function runFfmpeg(args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args]);
    const out = []; const err = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error('ffmpeg: ' + Buffer.concat(err).toString().slice(0, 300)))));
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

/** Any audio (WhatsApp voice notes are OGG/Opus) -> 16 kHz mono float samples for Whisper. */
async function decodeTo16k(buffer) {
  const raw = await runFfmpeg(['-i', 'pipe:0', '-f', 'f32le', '-ac', '1', '-ar', '16000', 'pipe:1'], buffer);
  return new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
}

async function toVoiceNote(buffer) {
  return runFfmpeg(['-i', 'pipe:0', '-c:a', 'libopus', '-b:a', '32k', '-ac', '1', '-ar', '48000', '-f', 'ogg', 'pipe:1'], buffer);
}

// ---------- local Whisper (loaded on first use, model downloaded once) ----------
let whisper = null; let whisperLoading = null; let whisperState = { status: 'idle', error: null };
async function getWhisper() {
  if (whisper) return whisper;
  if (!whisperLoading) {
    whisperState = { status: 'loading', error: null };
    whisperLoading = (async () => {
      const tf = await import('@huggingface/transformers');
      tf.env.cacheDir = path.join(config.dataDir, 'models');
      tf.env.allowLocalModels = false;
      const pipe = await tf.pipeline('automatic-speech-recognition', config.whisperModel, { dtype: 'q8', device: 'cpu' });
      whisper = pipe; whisperState = { status: 'ready', error: null };
      return pipe;
    })().catch((e) => { whisperLoading = null; whisperState = { status: 'error', error: e.message }; throw e; });
  }
  return whisperLoading;
}

async function transcribeLocal(buffer) {
  const audio = await decodeTo16k(buffer);
  if (audio.length < 1600) return '';
  if (audio.length > 16000 * 60 * 10) throw new Error('Voice note is longer than 10 minutes');
  const pipe = await getWhisper();
  const out = await pipe(audio, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: false });
  return String(out?.text || '').trim();
}

// ---------- API (Groq, OpenAI, self-hosted faster-whisper, ...) ----------
async function audioProvider(settings) {
  const o = settings.options;
  if (o.ai_mode === 'custom' && o.ai_base_url && getApp('allow_custom_ai') === '1') {
    await assertPublicUrl(o.ai_base_url);
    return { base: o.ai_base_url.replace(/\/$/, ''), key: getSecret(settings.session_id, 'voice_api_key') || getSecret(settings.session_id, 'ai_key') };
  }
  const base = (getApp('voice_api_base') || '').replace(/\/$/, '');
  if (!base) throw new Error('No speech API configured. Ask the admin to set one, or use your own AI provider.');
  return { base, key: getAppSecret('voice_api_key') };
}

async function transcribeApi(buffer, mimetype, settings) {
  const p = await audioProvider(settings);
  const model = settings.options.voice_api_model || (/groq\.com/.test(p.base) ? 'whisper-large-v3-turbo' : getApp('voice_api_model') || 'whisper-1');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimetype || 'audio/ogg' }), 'voice.ogg');
  form.append('model', model);
  const res = await fetch(`${p.base}/audio/transcriptions`, { method: 'POST', headers: p.key ? { Authorization: `Bearer ${p.key}` } : {}, body: form, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Speech API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return String(data.text || '').trim();
}

async function transcribe(buffer, mimetype, settings) {
  return settings.options.voice_engine === 'api' ? transcribeApi(buffer, mimetype, settings) : transcribeLocal(buffer);
}

/** Text -> WhatsApp voice note (needs an OpenAI-compatible /audio/speech API). */
async function speak(text, settings) {
  const p = await audioProvider(settings);
  const res = await fetch(`${p.base}/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(p.key ? { Authorization: `Bearer ${p.key}` } : {}) },
    body: JSON.stringify({ model: settings.options.tts_model || 'tts-1', voice: settings.options.tts_voice || 'alloy', input: String(text).slice(0, 3000), response_format: 'mp3' }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Speech API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return toVoiceNote(Buffer.from(await res.arrayBuffer()));
}

module.exports = { transcribe, speak, decodeTo16k, toVoiceNote, whisperStatus: () => whisperState, warmup: () => getWhisper().catch(() => {}) };
