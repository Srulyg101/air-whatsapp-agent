// Deterministic context bounds keep provider costs predictable.
function boundedText(value, max = 800) { return String(value ?? '').slice(0, max); }
function boundedHistory(history, limit = 8, perMessage = 650) {
  return (Array.isArray(history) ? history : []).slice(-limit)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
    .map(m => ({ role: m.role, content: boundedText(m.content, perMessage) }));
}
module.exports = { boundedText, boundedHistory };
