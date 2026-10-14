// Knowledge base: files and notes the AI answers from.
// Text is split into chunks and indexed with SQLite full-text search (no extra services needed).
const path = require('path');
const { db, q } = require('./db');

const EXT = ['.pdf', '.docx', '.txt', '.md', '.csv', '.tsv', '.json', '.html', '.htm', '.xlsx'];

async function extractText(buffer, filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (!EXT.includes(ext)) throw new Error(`Unsupported file type ${ext || '(none)'}. Use PDF, Word (.docx), Excel (.xlsx), CSV or text.`);
  if (ext === '.pdf') {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false }).promise;
    let text = '';
    for (let i = 1; i <= Math.min(doc.numPages, 500); i++) {
      const page = await doc.getPage(i);
      const c = await page.getTextContent();
      text += c.items.map((x) => x.str + (x.hasEOL ? '\n' : ' ')).join('') + '\n\n';
    }
    await doc.destroy();
    return text;
  }
  if (ext === '.docx') {
    const mammoth = require('mammoth');
    const out = await mammoth.extractRawText({ buffer });
    return out.value;
  }
  if (ext === '.xlsx') {
    const readXlsx = require('read-excel-file/node');
    const sheets = await readXlsx(buffer, { getSheets: true });
    const parts = [];
    for (const s of sheets) {
      const rows = await readXlsx(buffer, { sheet: s.name });
      const header = (rows[0] || []).map((c) => String(c ?? '').trim());
      parts.push(`Sheet: ${s.name}`);
      // Rows become "Header: value" lines so every chunk stays understandable on its own.
      for (const r of rows.slice(1)) {
        const line = r.map((c, i) => (c === null || c === '' ? null : `${header[i] || 'Col' + (i + 1)}: ${c instanceof Date ? c.toISOString().slice(0, 10) : c}`)).filter(Boolean).join(' | ');
        if (line) parts.push(line);
      }
    }
    return parts.join('\n');
  }
  let text = buffer.toString('utf8');
  if (ext === '.html' || ext === '.htm') text = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  if (ext === '.csv' || ext === '.tsv') {
    const sep = ext === '.tsv' ? '\t' : ',';
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const header = splitCsv(lines[0] || '', sep);
    text = lines.slice(1).map((l) => splitCsv(l, sep).map((v, i) => (v ? `${header[i] || 'Col' + (i + 1)}: ${v}` : null)).filter(Boolean).join(' | ')).join('\n');
  }
  return text;
}

function splitCsv(line, sep) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
    else if (ch === sep && !inQ) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Split text into ~900 character chunks on paragraph/line boundaries. */
function chunk(text, size = 900) {
  const clean = String(text || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const pieces = clean.split(/\n\n|\n(?=[^\n]{0,80}:)|\n/);
  const chunks = []; let cur = '';
  for (const p of pieces) {
    if ((cur + '\n' + p).length > size && cur) { chunks.push(cur.trim()); cur = ''; }
    if (p.length > size) {
      for (let i = 0; i < p.length; i += size) chunks.push(p.slice(i, i + size).trim());
    } else cur += (cur ? '\n' : '') + p;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.filter((c) => c.length > 2);
}

function addDocument(sessionId, name, text, { kind = 'file', size = 0 } = {}) {
  const chunks = chunk(text);
  if (!chunks.length) throw new Error('No readable text found in this file (scanned PDFs/images are not supported yet).');
  if (chunks.length > 5000) throw new Error('This file is too large (over ~4 MB of text). Split it into smaller files.');
  const id = db.transaction(() => {
    const info = q.addDoc.run(sessionId, String(name).slice(0, 200), kind, size, text.length);
    for (const c of chunks) q.addChunk.run(c, info.lastInsertRowid, sessionId);
    return info.lastInsertRowid;
  })();
  return { id, chunks: chunks.length, chars: text.length };
}

function deleteDocument(sessionId, id) {
  db.transaction(() => { q.delChunks.run(id, sessionId); q.delDoc.run(id, sessionId); })();
}

function documentText(sessionId, id) {
  return q.docText.all(id, sessionId).map((r) => r.content).join('\n\n');
}

const STOP = new Set('a an and are as at be but by can could did do does for from had has have hello hi how i if in into is it its me my no not of on or our please so than that the their them then there these they this to us was we were what when where which who why will with would you your yes ok okay thanks thank'.split(' '));

/** Find the chunks most relevant to a question. */
function search(sessionId, question, limit = 5) {
  const words = String(question || '').toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]{2,}/gu) || [];
  const terms = [...new Set(words.filter((w) => !STOP.has(w)))].slice(0, 20);
  if (!terms.length) return [];
  const ftsQuery = terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(' OR ');
  try {
    return q.searchChunks.all(ftsQuery, sessionId, limit).map((r) => ({ text: r.content, docId: r.doc_id }));
  } catch (_) { return []; }
}

function hasDocs(sessionId) { return q.docs.all(sessionId).length > 0; }

module.exports = { extractText, addDocument, deleteDocument, documentText, search, chunk, hasDocs, EXT };
