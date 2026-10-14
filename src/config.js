const path = require('path');

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

module.exports = {
  port: Number(env('PORT', 3000)),
  dataDir: path.resolve(env('DATA_DIR', path.join(__dirname, '..', 'data'))),
  botName: env('BOT_NAME', 'Air Agent'),
  ollamaUrl: env('OLLAMA_URL', 'http://localhost:11434').replace(/\/$/, ''),
  model: env('MODEL', 'qwen2.5:3b'),
  numCtx: Number(env('NUM_CTX', 4096)),
  historyTurns: Number(env('HISTORY_TURNS', 12)),
  systemPrompt: env('SYSTEM_PROMPT',
    "You are {BOT_NAME}, a friendly, sharp personal AI assistant chatting on WhatsApp. " +
    "Keep replies short and conversational (WhatsApp style), use plain text, and only use lists when they help. " +
    "Answer in the same language the user writes in. If you don't know something, say so."),
  openSignup: env('OPEN_SIGNUP', 'false') === 'true',
  bootstrapAdminToken: env('BOOTSTRAP_ADMIN_TOKEN', ''),
  // Per-sender rate limit (messages per minute) to protect the server
  rateLimitPerMin: Number(env('RATE_LIMIT_PER_MIN', 12)),
  // Delete chat history older than N days (0 = keep forever)
  retentionDays: Number(env('RETENTION_DAYS', 30)),
  cookieSecure: env('COOKIE_SECURE', 'true') === 'true',
  mailDomain: env('MAIL_DOMAIN', ''),
  emailFrom: env('EMAIL_FROM', ''),
  resendApiKey: env('RESEND_API_KEY', ''),
  inboundEmailWebhookSecret: env('INBOUND_EMAIL_WEBHOOK_SECRET', ''),

};
