const test = require('node:test');
const assert = require('node:assert/strict');
const { boundedText, boundedHistory } = require('../src/token-budget');
test('bounds text and handles empty values', () => {
  assert.equal(boundedText('abc', 2), 'ab');
  assert.equal(boundedText(null), '');
});
test('keeps the latest valid context at a capped size', () => {
  const history = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(800) }));
  const bounded = boundedHistory(history, 8, 60);
  assert.equal(bounded.length, 8);
  assert.equal(bounded[0].role, 'user');
  assert.ok(bounded.every(x => x.content.length === 60));
  assert.deepEqual(boundedHistory([{role:'system',content:'secret'}]), []);
});
