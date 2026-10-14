const config = require('./config');

let stats = { requests: 0, errors: 0, totalMs: 0, lastError: null };

async function chat(messages, { model } = {}) {
  const started = Date.now();
  stats.requests++;
  try {
    const res = await fetch(`${config.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || config.model,
        messages,
        stream: false,
        keep_alive: '30m',
        options: { num_ctx: config.numCtx, temperature: 0.7 },
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    stats.totalMs += Date.now() - started;
    return (data.message && data.message.content || '').trim();
  } catch (err) {
    stats.errors++;
    stats.lastError = `${new Date().toISOString()} ${err.message}`;
    throw err;
  }
}

async function health() {
  try {
    const res = await fetch(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    const models = (data.models || []).map((m) => m.name);
    return { ok: true, models, modelReady: models.some((m) => m === config.model || m.startsWith(config.model + ':')) };
  } catch (err) {
    return { ok: false, error: err.message, models: [], modelReady: false };
  }
}

function getStats() {
  return { ...stats, avgMs: stats.requests ? Math.round(stats.totalMs / Math.max(1, stats.requests - stats.errors)) : 0 };
}

module.exports = { chat, health, getStats };
