// AI "brain" client. Works with the local Ollama server (default, open source)
// and with any OpenAI-compatible API (Groq, Together, OpenRouter, DeepSeek, OpenAI, a self-hosted vLLM...).
const config = require('./config');
const { getApp, getAppSecret, getSecret } = require('./db');
const { assertPublicUrl } = require('./netguard');

let stats = { requests: 0, errors: 0, totalMs: 0, lastError: null };

const LOCAL = () => `${config.ollamaUrl}/v1`;
const isLocal = (base) => !base || base.replace(/\/$/, '') === LOCAL() || base.replace(/\/$/, '') === config.ollamaUrl;

/** Which model/provider a number uses: its own (if allowed) or the server default. */
function resolveProvider(settings) {
  const o = settings?.options || {};
  if (settings && o.ai_mode === 'custom' && getApp('allow_custom_ai') === '1' && o.ai_base_url && o.ai_model) {
    return { base: o.ai_base_url.replace(/\/$/, ''), model: o.ai_model, key: getSecret(settings.session_id, 'ai_key'), label: 'custom' };
  }
  const base = (getApp('ai_base_url') || '').replace(/\/$/, '');
  return { base: base || LOCAL(), model: getApp('ai_model') || config.model, key: getAppSecret('ai_key'), label: base ? 'server-api' : 'local' };
}

/**
 * chat(messages, { provider, tools }) -> { content, toolCalls: [{id, name, args}] }
 * messages use the OpenAI format (role/content, assistant.tool_calls, role:'tool').
 */
async function chat(messages, { provider, tools, temperature = 0.6, timeoutMs = 180_000 } = {}) {
  const p = provider || resolveProvider(null);
  const started = Date.now();
  stats.requests++;
  try {
    if (p.label === 'custom') await assertPublicUrl(p.base);
    const out = isLocal(p.base) && p.label !== 'custom'
      ? await ollamaChat(p, messages, tools, temperature, timeoutMs)
      : isAnthropic(p.base)
        ? await anthropicChat(p, messages, tools, temperature, timeoutMs)
        : await openaiChat(p, messages, tools, temperature, timeoutMs);
    stats.totalMs += Date.now() - started;
    return out;
  } catch (err) {
    stats.errors++;
    stats.lastError = `${new Date().toISOString()} ${err.message}`;
    throw err;
  }
}

async function ollamaChat(p, messages, tools, temperature, timeoutMs) {
  const msgs = messages.map((m) => {
    if (m.role === 'assistant' && m.tool_calls) {
      return { role: 'assistant', content: m.content || '', tool_calls: m.tool_calls.map((t) => ({ function: { name: t.function.name, arguments: safeJson(t.function.arguments) } })) };
    }
    if (m.role === 'tool') return { role: 'tool', content: m.content };
    return { role: m.role, content: m.content };
  });
  const body = { model: p.model, messages: msgs, stream: false, keep_alive: '30m', options: { num_ctx: config.numCtx, temperature } };
  if (tools?.length) body.tools = tools;
  const res = await fetch(`${config.ollamaUrl}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const t = (await res.text()).slice(0, 300);
    if (tools?.length && /does not support tools/i.test(t)) return ollamaChat(p, messages, null, temperature, timeoutMs);
    throw new Error(`Local AI error ${res.status}: ${t}`);
  }
  const data = await res.json();
  const m = data.message || {};
  return {
    content: (m.content || '').trim(),
    toolCalls: (m.tool_calls || []).map((t, i) => ({ id: `call_${Date.now()}_${i}`, name: t.function?.name, args: safeJson(t.function?.arguments) })),
  };
}

function isAnthropic(base) {
  return String(base || '').replace(/\\/$/, '') === 'https://api.anthropic.com/v1';
}

function toAnthropicMessages(messages) {
  let system = '';
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'system') { system += (system ? '\\n\\n' : '') + String(m.content || ''); continue; }
    if (m.role === 'tool') {
      const blocks = [];
      while (i < messages.length && messages[i].role === 'tool') {
        const tool = messages[i++];
        blocks.push({ type: 'tool_result', tool_use_id: tool.tool_call_id, content: String(tool.content || '') });
      }
      i--;
      out.push({ role: 'user', content: blocks });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const content = [];
      if (m.content) content.push({ type: 'text', text: String(m.content) });
      for (const call of m.tool_calls) {
        const fn = call.function || {};
        content.push({ type: 'tool_use', id: call.id, name: fn.name, input: safeJson(fn.arguments) });
      }
      out.push({ role: 'assistant', content });
      continue;
    }
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') });
  }
  return { system, messages: out };
}

async function anthropicChat(p, messages, tools, temperature, timeoutMs) {
  const converted = toAnthropicMessages(messages);
  const body = { model: p.model, max_tokens: 2048, messages: converted.messages, temperature };
  if (converted.system) body.system = converted.system;
  if (tools?.length) body.tools = tools.map((t) => ({
    name: t.function.name,
    description: t.function.description || '',
    input_schema: t.function.parameters || { type: 'object', properties: {} },
  }));
  const res = await fetch(`${p.base}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': p.key || '', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const t = (await res.text()).slice(0, 300);
    throw new Error(`Claude API error ${res.status}: ${t}`);
  }
  const data = await res.json();
  const blocks = data.content || [];
  return {
    content: blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('\\n').trim(),
    toolCalls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} })),
  };
}

async function openaiChat(p, messages, tools, temperature, timeoutMs) {
  const body = { model: p.model, messages, temperature };
  if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }
  const res = await fetch(`${p.base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(p.key ? { Authorization: `Bearer ${p.key}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const t = (await res.text()).slice(0, 300);
    // Some models/providers reject tools; fall back to plain chat.
    if (tools?.length && res.status === 400 && /tool|function/i.test(t)) return openaiChat(p, messages, null, temperature, timeoutMs);
    throw new Error(`AI provider error ${res.status}: ${t}`);
  }
  const data = await res.json();
  const m = data.choices?.[0]?.message || {};
  return {
    content: (m.content || '').trim(),
    toolCalls: (m.tool_calls || []).map((t) => ({ id: t.id, name: t.function?.name, args: safeJson(t.function?.arguments) })),
  };
}

function safeJson(x) {
  if (x && typeof x === 'object') return x;
  try { return JSON.parse(x || '{}'); } catch (_) { return {}; }
}

/** List models for a provider (used by "Test connection"). */
async function listModels(p) {
  if (p.label === 'custom') await assertPublicUrl(p.base);
  if (isLocal(p.base) && p.label !== 'custom') {
    const res = await fetch(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    return (data.models || []).map((m) => m.name);
  }
  const headers = isAnthropic(p.base)
    ? { 'x-api-key': p.key || '', 'anthropic-version': '2023-06-01' }
    : (p.key ? { Authorization: `Bearer ${p.key}` } : {});
  const res = await fetch(`${p.base}/models`, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean).slice(0, 300);
}

async function health() {
  try {
    const res = await fetch(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    const models = (data.models || []).map((m) => m.name);
    const want = getApp('ai_model') || config.model;
    return { ok: true, models, modelReady: models.some((m) => m === want || m.startsWith(want + ':')) };
  } catch (err) {
    return { ok: false, error: err.message, models: [], modelReady: false };
  }
}

// Admin: download a local open-source model (runs in the background)
const pulls = {};
function pullModel(name) {
  if (pulls[name]?.status === 'pulling') return pulls[name];
  pulls[name] = { status: 'pulling', started: Date.now(), detail: '' };
  (async () => {
    try {
      const res = await fetch(`${config.ollamaUrl}/api/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name, stream: true }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const l of lines) {
          try {
            const j = JSON.parse(l);
            if (j.error) throw new Error(j.error);
            pulls[name].detail = j.total ? `${j.status} ${Math.round((j.completed || 0) / j.total * 100)}%` : j.status;
          } catch (e) { if (e.message && !/JSON/.test(e.message)) throw e; }
        }
      }
      pulls[name].status = 'done';
    } catch (e) { pulls[name].status = 'error'; pulls[name].detail = e.message; }
  })();
  return pulls[name];
}

function getStats() {
  return { ...stats, avgMs: stats.requests ? Math.round(stats.totalMs / Math.max(1, stats.requests - stats.errors)) : 0 };
}

module.exports = { chat, resolveProvider, listModels, health, pullModel, pulls, getStats, isLocal };
