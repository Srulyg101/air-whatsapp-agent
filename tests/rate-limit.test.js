const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter } = require('../src/rate-limit');

test('rate limiter returns 429 and Retry-After, bounds keys, and resets expired buckets', () => {
  let now = 1000;
  const limiter = createRateLimiter({ windowMs: 1000, max: 1, maxKeys: 2, now: () => now, key: req => req.key });
  const response = () => ({ code: 200, headers: {}, set(k, v) { this.headers[k] = v; }, status(v) { this.code = v; return this; }, json(v) { this.body = v; } });
  const hit = key => { const res = response(); let next = false; limiter({ key }, res, () => { next = true; }); return { res, next }; };
  assert.equal(hit('tenant-a').next, true);
  assert.equal(hit('tenant-a').res.code, 429);
  assert.equal(hit('tenant-a').res.headers['Retry-After'], '1');
  hit('tenant-b'); hit('tenant-c');
  assert.ok(limiter.size() <= 2);
  now += 1001;
  assert.equal(hit('tenant-a').next, true);
  assert.ok(limiter.size() <= 2);
});
