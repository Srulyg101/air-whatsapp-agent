const path = require('path');

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

module.exports = {
  version: '2.1.0',
  port: Number(env('PORT', 3000)),
  dataDir: path.resolve(env('DATA_DIR', path.join(__dirname, '..', 'data'))),
  botName: env('BOT_NAME', 'Air Agent'),
  ollamaUrl: env('OLLAMA_URL', 'http://localhost:11434').replace(/\/$/, ''),
  model: env('MODEL', 'qwen2.5:3b'),
  numCtx: Number(env('NUM_CTX', 4096)),
  historyTurns: Number(env('HISTORY_TURNS', 12)),
  // Signups are controlled from the Admin page (closed by default). Set FORCE_OPEN_SIGNUP=true only for testing.
  forceOpenSignup: env('FORCE_OPEN_SIGNUP', 'false') === 'true',
  // Per-sender rate limit (messages per minute) to protect the server
  rateLimitPerMin: Number(env('RATE_LIMIT_PER_MIN', 12)),
  // Delete chat history older than N days (0 = keep forever)
  retentionDays: Number(env('RETENTION_DAYS', 30)),
  // 'auto' = secure cookies when the request came over HTTPS
  cookieSecure: env('COOKIE_SECURE', 'auto'),
  // Optional fixed encryption key for stored API keys/passwords (otherwise one is generated in DATA_DIR)
  appSecret: env('APP_SECRET', ''),
  maxUploadMb: Number(env('MAX_UPLOAD_MB', 15)),
  // Local speech-to-text model (open-source Whisper via transformers.js)
  whisperModel: env('WHISPER_MODEL', 'onnx-community/whisper-base'),
};
