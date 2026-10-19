// Import a business website into its private Air Agent knowledge base.
// Firecrawl is optional and configured by the server operator (never by customers).
// Without Firecrawl, import one public HTML page only. No browser automation.
const { assertPublicUrl } = require('./netguard');
const { getAppSecret } = require('./db');
const kb = require('./knowledge');

function normalizeWebsite(raw) {
  const input = String(raw || '').trim();
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new Error('Enter a normal public https:// website URL (no passwords or custom ports).');
  }
  url.hash = '';
  if (url.toString().length > 1400) throw new Error('Website URL is too long.');
  return url.toString();
}

function htmlToText(html) {
  return String(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[^]*?-->/g, ' ')
    .replace(/<\/(?:p|div|h[1-6]|li|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function importWebsite(sessionId, raw) {
  const url = normalizeWebsite(raw);
  await assertPublicUrl(url);
  const key = process.env.FIRECRAWL_API_KEY || getAppSecret('firecrawl_key');
  let text, via;
  if (key) {
    const r = await fetch('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST',
      redirect: 'manual',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true, timeout: 30000 }),
      signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) throw new Error('Firecrawl could not read this website (HTTP ' + r.status + ').');
    const json = await r.json();
    text = json.data?.markdown || json.markdown || '';
    via = 'Firecrawl';
  } else {
    // Never follow redirects: redirecting to a private LAN target would bypass our URL validation.
    const r = await fetch(url, { redirect: 'manual', headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('Website could not be fetched (HTTP ' + r.status + ').');
    if (!String(r.headers.get('content-type') || '').includes('text/html')) throw new Error('This URL is not an HTML page.');
    let bytes = 0;
    const parts = [];
    for await (const chunk of r.body) {
      bytes += chunk.length;
      if (bytes > 600000) { await r.body.cancel().catch(() => {}); throw new Error('Website is too large. Try a specific page.'); }
      parts.push(Buffer.from(chunk));
    }
    text = htmlToText(Buffer.concat(parts).toString('utf8'));
    via = 'Basic webpage import';
  }
  text = String(text).slice(0, 150000).trim();
  if (text.length < 30) throw new Error('No readable website text found.');
  const result = kb.addDocument(sessionId, 'Website: ' + url, 'Source: ' + url + '\n\n' + text, { kind: 'website', size: text.length });
  return { ...result, url, via };
}

module.exports = { importWebsite, normalizeWebsite, htmlToText };
