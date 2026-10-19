// Single-process fixed-window limiter for this single-container app. Keys must
// be opaque (IP or a digest), never raw email addresses or request contents.
function createRateLimiter({ windowMs, max, key = req => req.ip || 'unknown', message = 'Too many attempts. Try again later.', maxKeys = 10000, now = Date.now }) {
  const buckets = new Map();
  const middleware = (req, res, next) => {
    const k = String(key(req) || 'unknown').slice(0, 180);
    const time = now();
    let bucket = buckets.get(k);
    if (!bucket || time >= bucket.resetAt) {
      bucket = { count: 0, resetAt: time + windowMs };
      buckets.set(k, bucket);
    }
    bucket.count++;
    if (buckets.size > maxKeys) {
      for (const [entry, value] of buckets) {
        if (value.resetAt <= time || buckets.size > maxKeys) buckets.delete(entry);
        if (buckets.size <= maxKeys) break;
      }
    }
    if (bucket.count > max) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - time) / 1000))));
      return res.status(429).json({ error: message });
    }
    next();
  };
  middleware.reset = () => buckets.clear();
  middleware.size = () => buckets.size;
  return middleware;
}

module.exports = { createRateLimiter };
