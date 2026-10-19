const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'air-agent-web-test-'));
process.env.DATA_DIR = tmp;

const { normalizeWebsite, htmlToText } = require('../src/website-import');
const { DEFAULT_OPTIONS } = require('../src/db');

test('website input must be public-style HTTPS without custom credentials', () => {
  assert.equal(normalizeWebsite('https://example.com/docs#faq'), 'https://example.com/docs');
  for (const url of ['http://example.com', 'ftp://example.com', 'https://me:pw@example.com', 'https://example.com:8443/a', 'example.com']) {
    assert.throws(() => normalizeWebsite(url));
  }
});

test('HTML conversion ignores scripts and makes paragraphs readable', () => {
  const input = '<h1>Shop</h1><p>Open 9–5 &amp; weekends</p><script>STEAL_SECRETS()</script><style>.x{color:red}</style>';
  const text = htmlToText(input);
  assert.match(text, /Shop/);
  assert.match(text, /Open 9–5 & weekends/);
  assert.doesNotMatch(text, /STEAL_SECRETS|color:red/);
});

test('email automation is opt-in and booking requests do not claim reservations', () => {
  assert.equal(DEFAULT_OPTIONS.mail_auto_reply, false);
  assert.equal(DEFAULT_OPTIONS.booking_url, '');
  assert.equal(DEFAULT_OPTIONS.act_booking, 'anyone');
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
