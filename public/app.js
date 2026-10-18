/* Air Agent dashboard — plain JS, no build step. */
(() => {
'use strict';

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = (x) => JSON.parse(JSON.stringify(x));
const ago = (ts) => {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago';
};
const fmtDate = (ts) => new Date(ts * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const kb = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

async function api(url, opts = {}) {
  const isForm = opts.body instanceof FormData;
  const r = await fetch(url, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: isForm || !opts.body ? {} : { 'Content-Type': 'application/json' },
    body: opts.body ? (isForm ? opts.body : JSON.stringify(opts.body)) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || r.statusText); e.status = r.status; throw e; }
  return d;
}
const T = (target) => (target === 'house' ? '?target=house' : '');
const tq = () => T(S.target);
const sep = (u) => (u.includes('?') ? '&' : '?');

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = 'toast'), 3200);
}
async function busy(btn, fn) {
  const old = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span> ' + esc(btn.dataset.busy || 'Working…'); }
  try { return await fn(); } catch (e) { toast(e.message, true); } finally { if (btn) { btn.disabled = false; btn.innerHTML = old; } }
}

// ---------- state ----------
const S = {
  me: null, pub: null, target: 'mine', settings: null, draft: null, secretsDraft: {}, dirty: false,
  wa: null, page: 'home', poll: null, pg: { history: [], as: 'customer' }, groups: null, chatSel: null,
};
try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch (_) {}

// ---------- tiny form builders (bound to S.draft.options via data-opt) ----------
const o = () => S.draft.options;
const sw = (k, t, d = '', extra = '') => `
  <div class="sw"><div><div class="t">${t}</div>${d ? `<div class="d">${d}</div>` : ''}${extra}</div>
  <label class="toggle"><input type="checkbox" data-opt="${k}" ${o()[k] ? 'checked' : ''} aria-label="${esc(t)}"><span></span></label></div>`;
const txt = (k, label, ph = '', hint = '', type = 'text') => `
  <div class="field">${label ? `<label class="lbl">${label}</label>` : ''}<input type="${type}" data-opt="${k}" value="${esc(o()[k])}" placeholder="${esc(ph)}">${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
const area = (k, label, ph = '', hint = '', cls = '') => `
  <div class="field">${label ? `<label class="lbl">${label}</label>` : ''}<textarea class="${cls}" data-opt="${k}" placeholder="${esc(ph)}">${esc(o()[k])}</textarea>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
const num = (k, label, min, max, hint = '') => `
  <div class="field"><label class="lbl">${label}</label><input type="number" min="${min}" max="${max}" data-opt="${k}" value="${esc(o()[k])}" style="max-width:140px">${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
const seg = (k, opts) => `<div class="seg" role="radiogroup">${opts.map(([v, l]) => `<label><input type="radio" name="${k}" data-opt="${k}" value="${v}" ${String(o()[k]) === v ? 'checked' : ''}>${l}</label>`).join('')}</div>`;
const cards = (k, opts) => `<div class="choices">${opts.map(([v, t, d, ico]) => `
  <label class="choice"><input type="radio" name="${k}" data-opt="${k}" value="${v}" ${o()[k] === v ? 'checked' : ''}>
  <div class="ct">${ico || ''} ${t}</div><div class="cd">${d}</div></label>`).join('')}</div>`;
const secret = (name, label, ph = '', hint = '') => `
  <div class="field"><label class="lbl">${label}</label><input type="password" autocomplete="new-password" data-secret="${name}" value="${esc(S.secretsDraft[name] ?? S.settings.secrets[name] ?? '')}" placeholder="${esc(ph)}">${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
const chipList = (k) => String(o()[k] || '').split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);
const chips = (k, label, hint = '', ph = '+1 718 555 1234') => `
  <div class="field"><label class="lbl">${label}</label>
    <div class="chipadd"><input id="chip-${k}" data-chip="${k}" placeholder="${esc(ph)}" inputmode="tel"><button class="btn ghost" data-act="chipAdd" data-k="${k}">+ Add</button></div>
    <div class="chips">${chipList(k).map((n, i) => `<span class="chip">${esc(n)}<button data-act="chipDel" data-k="${k}" data-i="${i}" aria-label="Remove ${esc(n)}">✕</button></span>`).join('') || '<span class="small faint">None yet</span>'}</div>
    ${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
const card = (title, desc, body, right = '') => `<section class="card">${title || desc || right ? `<div class="head"><div>${title ? `<h2>${title}</h2>` : ''}${desc ? `<p>${desc}</p>` : ''}</div>${right}</div>` : ''}${body}</section>`;
const pill = (cls, text) => `<span class="pill ${cls}"><span class="dot"></span>${esc(text)}</span>`;
const LOGO = '<div class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-12.3 7.4L3 21l2.1-5.6A8.4 8.4 0 1 1 21 11.5z"/><path d="M12 7.5l1.2 2.6 2.8.4-2 2 .5 2.8-2.5-1.3-2.5 1.3.5-2.8-2-2 2.8-.4z" fill="currentColor" stroke="none"/></svg></div>';
const empty = (ico, text) => `<div class="empty"><div class="ei">${ico}</div>${text}</div>`;

// ---------- boot ----------
async function boot() {
  try { S.pub = await api('/api/public'); } catch (_) { S.pub = { botName: 'Air Agent', signupOpen: false }; }
  try { S.me = await api('/api/me'); } catch (_) { const mode = (location.hash.match(/^#\/(reset|forgot|signup|login)(?:\?|$)/) || [])[1]; return renderAuth(mode || (S.pub.firstUser ? 'signup' : 'login')); }
  try { const t = sessionStorage.getItem('target'); if (t === 'house' && S.me.user.is_admin) S.target = 'house'; } catch (_) {}
  await loadSettings();
  window.addEventListener('hashchange', route);
  route();
}

async function loadSettings() {
  S.settings = await api('/api/settings' + tq());
  S.draft = clone({ options: S.settings.options, persona: S.settings.persona, enabled: S.settings.enabled });
  S.secretsDraft = {}; S.dirty = false; S.mail = undefined;
  S.wa = await api('/api/wa/status' + tq()).catch(() => null);
}

function route() {
  const [pagePart, qs] = (location.hash.replace(/^#\/?/, '') || 'home').split('?');
  const page = pagePart;
  if (qs && /signin=ok/.test(qs)) { setTimeout(() => toast('Signed in ✓ — your smarter AI is connected'), 300); loadSettings().then(() => rerender()); history.replaceState(null, '', '#/' + page); }
  if (qs && /signin=failed/.test(qs)) { setTimeout(() => toast('Sign-in did not finish. Try again.', true), 300); history.replaceState(null, '', '#/' + page); }
  if (S.dirty && page !== S.page && !confirm('You have unsaved changes. Leave without saving?')) { location.hash = '#/' + S.page; return; }
  if (S.dirty && page !== S.page) { S.draft = clone({ options: S.settings.options, persona: S.settings.persona, enabled: S.settings.enabled }); S.secretsDraft = {}; S.dirty = false; }
  S.page = PAGES[page] ? page : 'home';
  if (PAGES[page]?.admin && !S.me.user.is_admin) S.page = 'home';
  renderShell();
}

// ---------- landing / sign-in ----------
function renderAuth(mode) {
  if (mode === 'forgot' || mode === 'reset') return renderRecoveryAuth(mode);
  const signup = mode === 'signup';
  const first = S.pub.firstUser;
  $('#root').innerHTML = `
  <div class="landing">
    <div class="top">${LOGO}<span>${esc(S.pub.botName)}</span><span class="topHint">Your WhatsApp. A lot less work.</span></div>
    <div class="hero">
      <div class="l">
        <span class="eyebrow">YOUR WHATSAPP AI ASSISTANT</span>
        <h1>More time for business.<br><b>Less time answering chats.</b></h1>
        <p class="landingLead">Air Agent helps you reply to customers, understand voice notes, and stay on top of messages. No coding. No confusing setup.</p>
        <div class="landingSteps">
          <div><span class="stepNum">1</span><span><b>Create your account</b><small>Just your email and a password.</small></span></div>
          <div><span class="stepNum">2</span><span><b>Connect WhatsApp</b><small>Scan a QR code from Linked devices.</small></span></div>
          <div><span class="stepNum">3</span><span><b>Choose who gets replies</b><small>You're in control. Start with just yourself.</small></span></div>
        </div>
        <div class="trustLine">✓ Simple setup &nbsp; ✓ You stay in control &nbsp; ✓ Voice notes supported</div>
      </div>
      <div class="r">
        <div class="authHeader"><span class="authGlyph">✦</span><h2>${first ? 'Create the administrator account' : signup ? 'Create your Air Agent account' : 'Welcome back'}</h2><p>${first ? 'Set up your private Air Agent server.' : signup ? 'Start with your own WhatsApp AI.' : 'Sign in to manage your WhatsApp assistant.'}</p></div>
        <form id="authForm" class="stack">
          ${signup ? '<div><label class="lbl" for="aName">Your name</label><input id="aName" autocomplete="name" placeholder="Your name" required></div>' : ''}
          <div><label class="lbl" for="aEmail">Email address</label><input id="aEmail" type="email" autocomplete="email" placeholder="you@business.com" required></div>
          <div><div class="authLabel"><label class="lbl" for="aPass">Password</label>${!signup ? '<a href="#/forgot" id="aForgot">Forgot password?</a>' : ''}</div>
            <div class="passwordInput"><input id="aPass" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" placeholder="Enter your password" required minlength="8"><button type="button" id="aShowPass" aria-label="Show or hide password">Show</button></div></div>
          <div class="hint" id="aErr" role="alert"></div>
          <button class="btn lg authSubmit" id="aSubmit" type="submit">${signup ? 'Create account' : 'Sign in'} <span>→</span></button>
        </form>
        ${S.pub.signupOpen && !first ? `<p class="authBottom">${signup ? 'Already have an account?' : 'New to Air Agent?'} <a href="#/${signup ? 'login' : 'signup'}" id="aSwitch">${signup ? 'Sign in' : 'Create an account'}</a></p>` : ''}
        ${!S.pub.signupOpen && !signup ? '<p class="authBottom muted">Need an account? Ask your Air Agent administrator.</p>' : ''}
        <div class="authPrivacy">🔒 Your account is protected. Your AI only replies when you allow it.</div>
      </div>
    </div>
    <div class="feats">
      <div class="feat"><div class="fi">💬</div><b>Customer replies</b><span>Answer common questions while you focus on work.</span></div>
      <div class="feat"><div class="fi">🎙️</div><b>Voice notes</b><span>Understand audio messages automatically.</span></div>
      <div class="feat"><div class="fi">📚</div><b>Knows your business</b><span>Teach it prices, hours and frequently asked questions.</span></div>
      <div class="feat"><div class="fi">🛡️</div><b>You're in control</b><span>Pick exactly who can get an automated reply.</span></div>
    </div>
    <div class="legal">${esc(S.pub.botName)} is independent of WhatsApp and Meta. Linked-device connections may be restricted by WhatsApp.</div>
  </div>`;
  $('#aSwitch')?.addEventListener('click', (e) => { e.preventDefault(); location.hash = signup ? '#/login' : '#/signup'; renderAuth(signup ? 'login' : 'signup'); });
  $('#aForgot')?.addEventListener('click', (e) => { e.preventDefault(); location.hash = '#/forgot'; renderAuth('forgot'); });
  $('#aShowPass')?.addEventListener('click', () => {
    const input = $('#aPass'); input.type = input.type === 'password' ? 'text' : 'password';
    $('#aShowPass').textContent = input.type === 'password' ? 'Show' : 'Hide';
  });
  $('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#aErr').textContent = '';
    const submit = $('#aSubmit'); submit.disabled = true; submit.textContent = 'One moment…';
    try {
      await api('/api/' + (signup ? 'signup' : 'login'), { body: { email: $('#aEmail').value, password: $('#aPass').value, name: $('#aName')?.value } });
      location.hash = '#/home'; await boot();
    } catch (err) { $('#aErr').textContent = err.message; submit.disabled = false; submit.textContent = signup ? 'Create account →' : 'Sign in →'; }
  });
}

function renderRecoveryAuth(mode) {
  const reset = mode === 'reset';
  const token = new URLSearchParams((location.hash.split('?')[1] || '')).get('token') || '';
  const tokenValid = /^[a-f0-9]{64}$/i.test(token);
  $('#root').innerHTML = `
  <div class="landing recoveryLanding">
    <div class="top">${LOGO}<span>${esc(S.pub.botName)}</span></div>
    <div class="recoveryPanel">
      <div class="recoveryIcon">${reset ? '🔐' : '✉️'}</div>
      <h1>${reset ? 'Choose a new password' : 'Forgot your password?'}</h1>
      <p class="muted">${reset ? 'Create a strong new password for your Air Agent account.' : 'Enter the email address you use to sign in. We’ll email you a private reset link.'}</p>
      ${!reset && S.pub.passwordRecoveryReady === false ? '<div class="recoveryInfo">Email recovery isn’t set up on this server yet. Ask your Air Agent administrator to enable it in Admin → Password recovery.</div>' : ''}
      ${reset && !tokenValid ? '<div class="recoveryInfo">This link is invalid. Please request a new password-reset email.</div>' : `
      <form id="recoveryForm" class="stack">
        ${reset ? `<div><label class="lbl" for="newPassword">New password (10–72 characters)</label><input type="password" id="newPassword" autocomplete="new-password" minlength="10" maxlength="72" required></div>
         <div><label class="lbl" for="confirmPassword">Confirm new password</label><input type="password" id="confirmPassword" autocomplete="new-password" minlength="10" maxlength="72" required></div>` :
          '<div><label class="lbl" for="recoveryEmail">Your account email</label><input id="recoveryEmail" type="email" autocomplete="email" placeholder="you@business.com" required></div>'}
        <div id="recoveryNotice" role="status" class="hint"></div>
        <button id="recoverySubmit" type="submit" class="btn lg authSubmit">${reset ? 'Change password' : 'Email me a reset link'} <span>→</span></button>
      </form>`}
      <a href="#/login" id="backToLogin" class="authBack">← Back to sign in</a>
    </div>
  </div>`;
  $('#backToLogin').addEventListener('click', (e) => { e.preventDefault(); location.hash = '#/login'; renderAuth('login'); });
  $('#recoveryForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const note = $('#recoveryNotice'); note.textContent = '';
    const submit = $('#recoverySubmit'); submit.disabled = true; submit.textContent = 'Working…';
    try {
      if (reset) {
        const password = $('#newPassword').value;
        if (password !== $('#confirmPassword').value) throw new Error('Passwords do not match.');
        const result = await api('/api/password/reset', { body: { token, password } });
        $('#recoveryForm').innerHTML = `<div class="banner ok"><div class="bi">✓</div><div>${esc(result.message)}</div></div><a class="btn" href="#/login" id="resetDone">Sign in with new password →</a>`;
        $('#resetDone').addEventListener('click', e => { e.preventDefault(); location.hash = '#/login'; renderAuth('login'); });
      } else {
        const result = await api('/api/password/forgot', { body: { email: $('#recoveryEmail').value } });
        note.textContent = result.message;
        note.className = 'recoverySuccess';
        submit.textContent = 'Send another link';
        submit.disabled = false;
        return;
      }
    } catch (err) { note.textContent = err.message; note.className = 'recoveryError'; submit.disabled = false; submit.textContent = reset ? 'Change password' : 'Email me a reset link'; }
  });
}

// ---------- shell ----------
const MAIN_NAV = [
  ['home', '🏠', 'Overview'],
  ['replies', '💬', 'Who gets replies'],
  ['brain', '📚', 'Teach your AI'],
  ['chats', '🗂️', 'Conversations'],
  ['playground', '✨', 'Try your AI'],
];
const MORE_NAV = [
  ['voice', '🎙️', 'Voice notes'],
  ['actions', '⚡', 'Automations'],
  ['model', '🤖', 'AI model'],
  ['email', '📧', 'Email'],
  ['account', '👤', 'Account'],
  ['admin', '🛡️', 'Admin', true],
];
const navEntry = ([id, ico, label, adm]) => adm && !S.me.user.is_admin ? '' :
  `<a href="#/${id}" class="${S.page === id ? 'active' : ''}"><span class="ico">${ico}</span>${label}</a>`;

function renderShell() {
  clearInterval(S.poll);
  const isAdmin = !!S.me.user.is_admin;
  const st = S.wa?.status;
  const statusPill = st === 'open' ? pill('ok', 'Connected') : st === 'qr' || st === 'connecting' ? pill('warn', 'Connecting') : pill('bad', 'Not connected');
  $('#root').innerHTML = `
  <div class="mobilebar"><button class="btn ghost sm" data-act="menu" aria-label="Menu">☰</button><div class="brand">${LOGO}${esc(S.me.botName)}</div>${statusPill}</div>
  <div class="app">
    <aside class="side" id="side">
      <div class="brand">${LOGO}${esc(S.me.botName)}</div>
      <div class="numberSwitch">
        ${isAdmin ? `<label class="lbl small faint" for="targetSel">Settings for</label>
        <select id="targetSel"><option value="mine" ${S.target === 'mine' ? 'selected' : ''}>My WhatsApp</option><option value="house" ${S.target === 'house' ? 'selected' : ''}>Shared Air number</option></select>` : '<div class="small faint">My WhatsApp</div>'}
        <div class="row between" style="margin-top:8px">${statusPill}<span class="small muted mono">${S.wa?.me?.phone ? '+' + esc(S.wa.me.phone) : ''}</span></div>
      </div>
      <nav class="nav" aria-label="Main navigation">
        <div class="navCaption">YOUR ASSISTANT</div>
        ${MAIN_NAV.map(navEntry).join('')}
        <details class="navMore" ${MORE_NAV.some(([id]) => id === S.page) ? 'open' : ''}>
          <summary>⚙️ More settings <span aria-hidden="true">⌄</span></summary>
          <div class="navMoreItems">${MORE_NAV.map(navEntry).join('')}</div>
        </details>
      </nav>
      <div class="foot"><div class="faint small">${esc(S.me.user.email)} · v${esc(S.me.version)}</div><div class="row"><button class="btn ghost sm" data-act="theme">◐ Theme</button><button class="btn ghost sm" data-act="logout">Log out</button></div></div>
    </aside>
    <div class="mainwrap"><main class="main" id="main"></main></div>
  </div>
  <div class="savebar" id="savebar"><div><b>Unsaved changes</b> <span class="muted small">— your AI keeps using the old settings until you save.</span></div><div class="row"><button class="btn ghost sm" data-act="discard">Discard</button><button class="btn" data-act="save" data-busy="Saving…">Save changes</button></div></div>`;
  $('#targetSel')?.addEventListener('change', async (e) => {
    if (S.dirty && !confirm('Discard unsaved changes?')) { e.target.value = S.target; return; }
    S.target = e.target.value; try { sessionStorage.setItem('target', S.target); } catch (_) {}
    await loadSettings(); renderShell();
  });
  const page = PAGES[S.page];
  $('#main').innerHTML = page.render();
  page.after?.();
  markDirty(S.dirty);
}

function markDirty(on) { S.dirty = on; $('#savebar')?.classList.toggle('show', on); }

// ---------- form binding ----------
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.dataset?.chip) { e.preventDefault(); ACTIONS.chipAdd({ dataset: { k: e.target.dataset.chip } }); }
});
document.addEventListener('input', onField);
document.addEventListener('change', onField);
function onField(e) {
  const el = e.target;
  if (el.dataset.opt) {
    const k = el.dataset.opt; const def = S.settings.options[k];
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.type === 'radio') { if (!el.checked) return; v = typeof def === 'number' ? Number(el.value) : el.value; }
    else if (typeof def === 'number') v = el.value === '' ? 0 : Number(el.value);
    else v = el.value;
    if (o()[k] === v) return;
    o()[k] = v; markDirty(true);
    if (el.dataset.rerender !== undefined || el.type === 'radio' || (el.type === 'checkbox' && el.dataset.rerender !== 'no')) rerenderSoon(el);
  } else if (el.dataset.secret) {
    S.secretsDraft[el.dataset.secret] = el.value; markDirty(true);
  } else if (el.dataset.special === 'handoff') {
    if (e.type !== 'change') return;
    if (el.value === 'forever') o().pause_forever = true; else { o().pause_forever = false; o().pause_minutes = Number(el.value); }
    markDirty(true);
  } else if (el.id === 'masterSw') {
    if (e.type !== 'change') return;
    const on = el.checked;
    api('/api/settings' + tq(), { body: { enabled: on } }).then((st) => {
      S.settings.enabled = st.enabled; S.draft.enabled = st.enabled;
      toast(on ? 'AI turned on' : 'AI turned off'); rerender();
    }).catch((err) => { el.checked = !on; toast(err.message, true); });
  } else if (el.dataset.field) {
    S.draft[el.dataset.field] = el.type === 'checkbox' ? el.checked : el.value; markDirty(true);
  } else if (el.dataset.list) {
    const arr = o()[el.dataset.list]; const i = Number(el.dataset.i);
    if (arr?.[i]) { arr[i][el.dataset.k] = el.value; markDirty(true); }
  }
}
// Re-render the page when a choice changes what is shown (keeps scroll position).
let rrT;
function rerenderSoon(el) {
  if (!el.closest('[data-live]')) return;
  clearTimeout(rrT);
  rrT = setTimeout(() => { const y = window.scrollY; $('#main').innerHTML = PAGES[S.page].render(); PAGES[S.page].after?.(); window.scrollTo(0, y); }, 0);
}
function rerender() { const y = window.scrollY; $('#main').innerHTML = PAGES[S.page].render(); PAGES[S.page].after?.(); window.scrollTo(0, y); }

async function save(btn) {
  await busy(btn, async () => {
    const secrets = {};
    for (const [k, v] of Object.entries(S.secretsDraft)) secrets[k] = v;
    S.settings = await api('/api/settings' + tq(), { body: { options: o(), persona: S.draft.persona, enabled: S.draft.enabled, secrets } });
    S.draft = clone({ options: S.settings.options, persona: S.settings.persona, enabled: S.settings.enabled });
    S.secretsDraft = {}; S.mail = undefined;
    markDirty(false);
    toast('Saved ✓');
    rerender();
  });
}

// ---------- global clicks ----------
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) { if (e.target.closest('.nav a')) $('#side')?.classList.remove('open'); return; }
  const act = b.dataset.act;
  const h = ACTIONS[act] || PAGES[S.page]?.acts?.[act];
  if (h) { e.preventDefault(); await h(b, e); }
});

const ACTIONS = {
  menu: () => $('#side').classList.toggle('open'),
  theme: () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const next = cur === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next; try { localStorage.setItem('theme', next); } catch (_) {}
  },
  logout: async () => { await api('/api/logout', { body: {} }); location.hash = ''; location.reload(); },
  save: (b) => save(b),
  discard: () => { S.draft = clone({ options: S.settings.options, persona: S.settings.persona, enabled: S.settings.enabled }); S.secretsDraft = {}; markDirty(false); rerender(); },
  listAdd: (b) => {
    const k = b.dataset.list; const blank = k === 'faq' ? { q: '', a: '' } : { keyword: '', match: 'contains', reply: '' };
    o()[k] = [...(o()[k] || []), blank]; markDirty(true); rerender();
    setTimeout(() => { const rows = $$(`[data-list="${k}"]`); rows[rows.length - (k === 'faq' ? 2 : 3)]?.focus(); }, 0);
  },
  listDel: (b) => { const k = b.dataset.list; o()[k].splice(Number(b.dataset.i), 1); markDirty(true); rerender(); },
  chipAdd: (b) => {
    const k = b.dataset.k; const inp = $(`#chip-${k}`); const v = inp.value.trim();
    if (!v) return;
    const digits = v.replace(/[^\d]/g, '');
    if (digits.length < 7) { toast('Enter a full number with country code', true); return; }
    const pretty = '+' + digits;
    const cur = chipList(k);
    if (!cur.some((x) => x.replace(/\D/g, '') === digits)) cur.push(pretty);
    o()[k] = cur.join(', '); markDirty(true); rerender();
    setTimeout(() => $(`#chip-${k}`)?.focus(), 0);
  },
  chipDel: (b) => { const k = b.dataset.k; const cur = chipList(k); cur.splice(Number(b.dataset.i), 1); o()[k] = cur.join(', '); markDirty(true); rerender(); },
};

// =====================================================================
// PAGES
// =====================================================================
const PAGES = {};

// ---------- HOME ----------
PAGES.home = {
  render() {
  const st = S.wa?.status || 'idle';
  const op = o();
  const house = S.target === 'house';
  const connected = st === 'open';
  const hasInfo = !!String(op.about || '').trim() || !!(op.faq || []).length;
  const audience = { me: 'Just me (safe default)', allow: 'Only chosen people', everyone: 'Everyone who messages' }[op.reply_mode] || 'Just me';
  const banners = [];
  if (!S.draft.enabled) banners.push('<div class="banner warn"><div class="bi">⏸️</div><div><b>AI replies are turned off.</b> Turn them back on using the switch below.</div></div>');
  if (!house && op.reply_mode === 'everyone') banners.push('<div class="banner warn"><div class="bi">⚠️</div><div><b>Your AI can answer anyone who messages you.</b> This can include unknown contacts. <a href="#/replies">Change who it answers</a>.</div></div>');
  return `
    <div class="pagehead homeHead">
      <div><span class="eyebrow">AIR AGENT DASHBOARD</span><h1>${house ? 'Shared WhatsApp assistant' : `Hi${S.me.user.name ? `, ${esc(S.me.user.name.split(' ')[0])}` : ''} 👋`}</h1><p>Let's make WhatsApp easier. Start here — no technical knowledge needed.</p></div>
      ${connected ? pill('ok','WhatsApp connected') : pill('warn','1 step to get started')}
    </div>
    ${banners.join('')}
    <section class="homeIntro">
      <div><span class="eyebrow">YOUR NEXT STEP</span>
        <h2>${connected ? 'Your WhatsApp is connected.' : 'Connect your WhatsApp in a few taps.'}</h2>
        <p>${connected ? 'Now decide who the AI should reply to, and teach it the basics about your business.' : 'Open WhatsApp → Linked devices → Link a device. Scan the QR code. That’s it.'}</p>
        <div class="row"><a href="${connected ? '#/replies' : '#connectCard'}" class="btn lg">${connected ? 'Choose who gets AI replies →' : 'Connect WhatsApp ↓'}</a>
        ${connected ? '<a class="btn ghost" href="#/playground">Try your AI</a>' : ''}</div>
      </div><div class="homeIntroMark" aria-hidden="true">${connected ? '✓' : '💬'}</div>
    </section>
    <div class="setupHead"><h2>Get started in 3 simple steps</h2><span>Everything can be changed later</span></div>
    <div class="setupGrid">
      <a class="setupCard" href="${connected ? '#/home' : '#connectCard'}"><div class="setupIcon">${connected ? '✓' : '1'}</div>
        <div class="setupBody"><b>Connect WhatsApp</b><p>${connected ? `Connected to +${esc(S.wa.me?.phone || '')}` : 'Scan the QR code from your phone'}</p><span class="setupLink">${connected ? 'Connected' : 'Connect now →'}</span></div></a>
      <a class="setupCard" href="#/replies"><div class="setupIcon">2</div>
        <div class="setupBody"><b>Choose who the AI answers</b><p>Currently: ${esc(audience)}</p><span class="setupLink">Change replies →</span></div></a>
      <a class="setupCard" href="#/brain"><div class="setupIcon">${hasInfo ? '✓' : '3'}</div>
        <div class="setupBody"><b>Teach it about your business</b><p>${hasInfo ? 'You have started teaching your assistant' : 'Add your opening hours, prices and FAQs'}</p><span class="setupLink">${hasInfo ? 'Manage information →' : 'Add business details →'}</span></div></a>
    </div>
    <div class="${connected ? 'grid2' : ''}">
      <section class="card" id="connectCard">${connectBody(st)}</section>
      <section class="card simpleControls">
        <div class="head"><div><h2>Quick controls</h2><p>No complicated settings.</p></div></div>
        <div class="sw"><div><div class="t">AI replies ${S.draft.enabled ? 'ON' : 'OFF'}</div><div class="d">Pause or resume this number’s AI.</div></div><label class="toggle"><input type="checkbox" data-field="enabled" id="masterSw" ${S.draft.enabled ? 'checked' : ''} aria-label="Turn AI on or off"><span></span></label></div>
        <div class="sw"><div><div class="t">Who gets AI replies?</div><div class="d">${esc(audience)}</div></div><a class="btn ghost sm" href="#/replies">Change</a></div>
        <div class="sw"><div><div class="t">Business knowledge</div><div class="d" id="kbSum">Checking…</div></div><a class="btn ghost sm" href="#/brain">Manage</a></div>
        <div class="sw"><div><div class="t">Voice messages</div><div class="d">${op.voice_in ? 'AI can understand incoming voice notes' : 'Voice understanding is off'}</div></div><a class="btn ghost sm" href="#/voice">Change</a></div>
      </section>
    </div>
    <div class="setupHead"><h2>What your assistant has been doing</h2><a href="#/chats">View conversations →</a></div>
    <div class="stats" id="stats"></div>
    ${card('Recent activity','Messages handled and important actions.','<div class="feed" id="feed"><div class="muted">Loading activity…</div></div>')}
    <section class="helpStrip"><div><b>Want to test your AI before customers see it?</b><p>Try a message in the test area. It won’t send anything to a real contact.</p></div><a class="btn ghost" href="#/playground">Test a message →</a></section>
  `;
},
  async after() {
    pollStatus();
    api('/api/kb' + tq()).then((d) => { $('#kbSum') && ($('#kbSum').textContent = `${d.length} file(s)/note(s), ${(o().faq || []).length} FAQ`); }).catch(() => {});
    try {
      const a = await api('/api/activity' + tq() + sep(tq()) + 'limit=15');
      const c = a.counts;
      $('#stats').innerHTML = [['Replies today', (c.reply || 0) + (c.rule || 0)], ['Voice notes today', c.voice || 0], ['Actions today', c.action || 0], ['Hand-offs today', c.handoff || 0]]
        .map(([l, v]) => `<div class="stat"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');
      $('#feed').innerHTML = a.events.length ? a.events.map(evRow).join('') : empty('🌱', 'Nothing yet. Connect WhatsApp and send a message to "Message yourself".');
    } catch (e) { $('#feed').innerHTML = `<div class="muted">${esc(e.message)}</div>`; }
  },
  acts: {
    connect: (b) => busy(b, async () => { S.wa = await api('/api/wa/connect' + tq(), { body: {} }); $('#connectCard').innerHTML = connectBody(S.wa.status); pollStatus(); }),
    unlink: (b) => { if (confirm('Unlink WhatsApp from Air Agent? The AI stops immediately.')) busy(b, async () => { S.wa = await api('/api/wa/logout' + tq(), { body: {} }); renderShell(); toast('Unlinked'); }); },
  },
};

const EV_ICON = { reply: '💬', voice: '🎙️', action: '⚡', handoff: '🙋', rule: '📌', error: '⚠️', info: 'ℹ️' };
const evRow = (e) => `<div class="ev"><div class="ei">${EV_ICON[e.type] || '•'}</div><div>${esc(e.summary)}${e.name || e.phone ? `<div class="small faint">${esc(e.name || '')} ${e.phone ? '+' + esc(e.phone) : ''}</div>` : ''}</div><div class="et">${ago(e.ts)}</div></div>`;

function connectBody(st) {
  const w = S.wa || {};
  if (st === 'open') return `
    <div class="head"><div><h2>WhatsApp</h2><p>Linked and running.</p></div>${pill('ok', 'Connected')}</div>
    <div class="connected"><div class="big">📱</div><div><div class="phone">+${esc(w.me?.phone || '')}</div><div class="muted">${esc(w.me?.name || '')}</div></div></div>
    <div class="divider"></div>
    <div class="row between"><span class="small muted">To stop instantly: unlink here, or on your phone in WhatsApp → Linked devices.</span><button class="btn danger sm" data-act="unlink" data-busy="Unlinking…">Unlink</button></div>`;
  const showQr = st === 'qr' && w.qr;
  return `
    <div class="linkbox">
      <div>
        <h2>Link your WhatsApp</h2>
        <ol class="wsteps" style="font-size:15px">
          <li><span>Open <b>WhatsApp</b> on your phone</span></li>
          <li><span>Tap <b>Settings</b> (iPhone) or <b>⋮ Menu</b> (Android) → <b>Linked devices</b></span></li>
          <li><span>Tap <b>Link a device</b> and point your phone at the QR code</span></li>
        </ol>
        <p class="small muted" style="margin-top:6px">Safe by default: until you change <a href="#/replies">Reply rules</a>, the AI only answers <b>you</b>.</p>
        ${w.lastError && st !== 'logged_out' && !showQr ? `<p class="small" style="color:var(--danger)">${esc(w.lastError)}</p>` : ''}
      </div>
      <div class="qrframe">
        ${showQr ? `<img src="${w.qr}" alt="WhatsApp QR code">` :
          `<div class="qrph">${st === 'connecting' ? '<span class="pill warn"><span class="spin"></span> Getting QR code…</span>' : '<button class="btn" data-act="connect" data-busy="Starting…">Get QR code</button>'}</div>`}
      </div>
    </div>`;
}

function pollStatus() {
  clearInterval(S.poll);
  S.poll = setInterval(async () => {
    if (S.page !== 'home') return clearInterval(S.poll);
    const prev = S.wa?.status; const prevQr = S.wa?.qr;
    try { S.wa = await api('/api/wa/status' + tq()); } catch (_) { return; }
    if (S.wa.status !== prev) { renderShell(); return; }
    if (S.wa.qr !== prevQr && $('#connectCard')) $('#connectCard').innerHTML = connectBody(S.wa.status);
  }, 2500);
}

// ---------- REPLY RULES ----------
PAGES.replies = {
  render() {
    const op = o(); const house = S.target === 'house';
    return `
    <div class="pagehead"><div><h1>Reply rules</h1><p>Decide exactly who your AI talks to, when, and how.</p></div></div>
    <div data-live>
    ${house ? card('Who it answers', '', '<div class="banner ok" style="margin:0"><div class="bi">🌐</div><div>This is the shared number: it answers <b>everyone</b> who messages it, except blocked numbers.</div></div>' + chips('block_list', 'Never reply to these numbers', 'With country code. Always wins over everything else.')) :
    card('Who can talk to your AI', 'Messages from other people in private chats.', `
      ${cards('reply_mode', [
        ['me', 'Only me', 'The AI answers only you — in "Message yourself" and when you type the trigger word. Safest.', '🔒'],
        ['allow', 'People I choose', 'Answers only the numbers on your list. Everyone else just reaches you.', '👥'],
        ['everyone', 'Everyone', 'Answers anyone who messages you, including strangers. Good for a business line.', '🌐'],
      ])}
      ${op.reply_mode === 'everyone' ? '<div class="banner warn" style="margin-top:14px"><div class="bi">⚠️</div><div>Strangers and spammers will get AI replies <b>as you</b>. Add a label (Style below) and block numbers you don\'t want answered.</div></div>' : ''}
      ${op.reply_mode === 'allow' ? '<div style="margin-top:16px">' + chips('allow_list', 'Numbers the AI may answer', 'Type a number with country code and press + Add.') + '</div>' : ''}
      <div style="margin-top:16px">${chips('block_list', 'Never reply to these numbers', 'Always wins over everything else — spam, scammers, family you don\'t want answered.', '+234 815 545 4251')}</div>`)}

    ${!house ? card('Your own use', 'How you talk to your AI.', `
      ${sw('self_chat', 'Answer me in "Message yourself"', 'Your private chat with the AI — text or voice notes.')}
      ${sw('ai_trigger', 'Trigger word in any chat', `Start a message with the trigger word in any chat and the AI answers right there (visible to that chat).`)}
      ${op.ai_trigger ? `<div style="max-width:220px;margin-top:8px">${txt('trigger_word', 'Trigger word', '/ai')}</div>` : ''}`) : ''}

    ${card('Groups', 'The AI never answers groups unless you allow it.', `
      ${cards('group_mode', [
        ['off', 'Off', 'Stays silent in every group.', '🔕'],
        ['mention', 'When @mentioned', 'In any group, only when someone @mentions you or replies to the AI.', '📣'],
        ['selected', 'Chosen groups', 'Only in the groups you pick below.', '✅'],
      ])}
      ${op.group_mode === 'selected' ? groupPicker() : ''}`)}

    ${card('Hand-off to you', 'Let the AI step back when you take over.', `
      ${sw('pause_on_manual', "Don't reply once I reply", 'When you type in a chat yourself, the AI stops answering there.')}
      ${op.pause_on_manual ? `<div class="field" style="max-width:320px;margin-top:8px"><label class="lbl">Stay quiet for</label>
        <select data-special="handoff">${[['30', '30 minutes'], ['60', '1 hour'], ['240', '4 hours'], ['1440', '24 hours'], ['forever', 'Until I turn it back on']].map(([v, l]) => `<option value="${v}" ${(op.pause_forever ? 'forever' : String(op.pause_minutes)) === v ? 'selected' : ''}>${l}</option>`).join('')}${!op.pause_forever && ![30, 60, 240, 1440].includes(op.pause_minutes) ? `<option value="${op.pause_minutes}" selected>${op.pause_minutes} minutes</option>` : ''}</select></div>` : ''}
      ${sw('reply_once', 'Reply only once per person', 'The AI answers the first message (like a smart greeting), then leaves the chat to you.')}
      <p class="small muted" style="margin:6px 0 0">Anyone can also send <code>/stop</code> to silence the AI in their chat and <code>/start</code> to bring it back. You can pause chats in <a href="#/chats">Conversations</a>.</p>`)}

    ${card('Chat context', 'Let the AI read the recent messages of the chat — including what you typed yourself — so its replies fit the conversation.', `
      <div class="row between"><span class="small muted">Messages to read before replying</span>${seg('context_messages', [['0', 'Off'], ['5', '5'], ['10', '10'], ['20', '20']])}</div>
      <p class="hint" style="margin-top:10px">Read from memory only while the server is running; nothing extra is saved to disk.</p>`)}

    ${card('Quick replies', 'Fixed answers for keywords — instant, no AI. Great for prices, links, addresses.', `
      <div class="rep">${(op.keyword_rules || []).map((r, i) => `
        <div class="repRow kw">
          <input data-list="keyword_rules" data-i="${i}" data-k="keyword" value="${esc(r.keyword)}" placeholder="Keyword, e.g. price">
          <select data-list="keyword_rules" data-i="${i}" data-k="match"><option value="contains" ${r.match !== 'exact' ? 'selected' : ''}>contains</option><option value="exact" ${r.match === 'exact' ? 'selected' : ''}>is exactly</option></select>
          <textarea data-list="keyword_rules" data-i="${i}" data-k="reply" placeholder="Reply to send">${esc(r.reply)}</textarea>
          <button class="btn ghost sm" data-act="listDel" data-list="keyword_rules" data-i="${i}" aria-label="Remove">✕</button>
        </div>`).join('') || '<div class="muted small">No quick replies yet.</div>'}</div>
      <button class="btn ghost sm" style="margin-top:12px" data-act="listAdd" data-list="keyword_rules">+ Add quick reply</button>`)}

    ${card('Style', 'How replies look and feel.', `
      <div class="grid2"><div>
        ${sw('prefix_on', 'Label replies to other people', 'So people know it\'s your AI, not you.')}
        ${op.prefix_on ? `<div style="max-width:220px;margin:6px 0 10px">${txt('prefix_text', '', '🤖')}</div>` : ''}
        ${sw('typing', 'Show "typing…"')}
        ${sw('memory', 'Remember the conversation', 'Keeps recent messages per chat so replies make sense.')}
        ${sw('use_emojis', 'Use emojis')}
        ${sw('quote_reply', 'Quote the message it answers')}
      </div><div>
        <div class="field"><label class="lbl">Reply length</label>${seg('reply_length', [['short', 'Short'], ['medium', 'Medium'], ['long', 'Detailed']])}</div>
        ${txt('language', 'Language', 'Same as the sender', 'Leave empty to answer in whatever language people write. Or e.g. English, Yiddish, Hebrew, Spanish.')}
        ${num('reply_delay', 'Wait before replying (seconds)', 0, 60, 'Feels more human. 0 = instant.')}
      </div></div>`)}

    ${card('Quiet hours', 'Times the AI should not answer other people.', `
      ${sw('quiet_enabled', 'Use quiet hours')}
      ${op.quiet_enabled ? `<div class="grid3" style="margin-top:10px">${txt('quiet_start', 'From', '', '', 'time')}${txt('quiet_end', 'To', '', '', 'time')}${txt('timezone', 'Time zone', 'America/New_York')}</div>
      ${txt('away_message', 'Away message (optional, sent once per chat)', "I'm offline right now — I'll get back to you soon.")}` : `<div style="max-width:320px;margin-top:10px">${txt('timezone', 'Your time zone', 'America/New_York', 'Used for quiet hours and reminders.')}</div>`}`)}
    </div>`;
  },
  acts: {
    loadGroups: (b) => busy(b, async () => { S.groups = await api('/api/wa/groups' + tq()); rerender(); }),
    toggleGroup: (b) => {
      const jid = b.dataset.jid; const sel = o().selected_groups || [];
      const i = sel.findIndex((g) => g.jid === jid);
      if (i >= 0) sel.splice(i, 1); else sel.push({ jid, name: b.dataset.name });
      o().selected_groups = sel; markDirty(true); rerender();
    },
  },
};

function groupPicker() {
  const sel = o().selected_groups || [];
  const list = S.groups;
  return `<div style="margin-top:16px">
    <div class="row between"><div><b>Chosen groups</b> <span class="muted small">(${sel.length})</span></div>
      <button class="btn ghost sm" data-act="loadGroups" data-busy="Loading…">${list ? 'Refresh list' : 'Load my groups'}</button></div>
    <div style="margin-top:10px">${list ? (list.length ? list.map((g) => {
      const on = sel.some((x) => x.jid === g.jid);
      return `<div class="sw"><div><div class="t">${esc(g.name)}</div><div class="d">${g.size} members</div></div><button class="btn sm ${on ? '' : 'ghost'}" data-act="toggleGroup" data-jid="${esc(g.jid)}" data-name="${esc(g.name)}">${on ? '✓ Chosen' : 'Choose'}</button></div>`;
    }).join('') : '<div class="muted small">You are not in any groups.</div>') :
      (sel.length ? sel.map((g) => `<div class="sw"><div class="t">${esc(g.name)}</div><button class="btn sm" data-act="toggleGroup" data-jid="${esc(g.jid)}" data-name="${esc(g.name)}">✓ Chosen</button></div>`).join('') : '<div class="muted small">Connect WhatsApp, then load your groups to pick from.</div>')}</div>
    <div class="field" style="margin-top:12px"><label class="lbl">In chosen groups, answer</label>${seg('selected_groups_reply', [['mention', 'Only when @mentioned'], ['all', 'Every message']])}</div>
  </div>`;
}

// ---------- KNOWLEDGE & PROMPTS ----------
PAGES.brain = {
  docs: null,
  render() {
    const op = o();
    return `
    <div class="pagehead"><div><h1>Knowledge & prompts</h1><p>Teach your AI who it works for, how to talk, and what to know.</p></div><a class="btn ghost" href="#/playground">🧪 Test it</a></div>
    ${card('Identity & instructions', 'This is the AI\'s main prompt. Plain language works best.', `
      <div class="grid2">${txt('bot_name', 'AI name', S.me.botName, 'What it calls itself.')}<div class="field"><label class="lbl">Tone</label>${seg('tone', [['friendly', 'Friendly'], ['professional', 'Professional'], ['casual', 'Casual'], ['funny', 'Playful'], ['custom', 'Custom']])}<div class="hint">"Custom" = only your instructions below.</div></div></div>
      ${area('about', 'Who is the AI working for?', 'e.g. I\'m Yisroel, CEO of Air Business Solutions (airbiz.ai). We sell electronic shelf labels (AirESL), POS (AirPOS), ERP and payments to retailers in the US. Office hours Sun–Thu 9–6 ET.', 'Business, role, products, location, hours — anything it should always know.', 'tall')}
      ${area('rules', 'Rules (always / never)', 'Always: offer a demo call for store owners.\nNever: give discounts, promise delivery dates, or share my personal number.\nIf someone is angry or asks for a person: notify me.', 'One rule per line.')}
      <div class="field"><label class="lbl">Extra instructions</label><textarea data-field="persona" placeholder="Anything else: how to greet, sign-offs, things to ask for…">${esc(S.draft.persona)}</textarea></div>`)}

    ${card('FAQ', 'Questions people ask a lot — the AI answers these exactly.', `
      <div class="rep">${(op.faq || []).map((f, i) => `
        <div class="repRow">
          <input data-list="faq" data-i="${i}" data-k="q" value="${esc(f.q)}" placeholder="Question">
          <textarea data-list="faq" data-i="${i}" data-k="a" placeholder="Answer">${esc(f.a)}</textarea>
          <button class="btn ghost sm" data-act="listDel" data-list="faq" data-i="${i}" aria-label="Remove">✕</button>
        </div>`).join('') || '<div class="muted small">No FAQ yet.</div>'}</div>
      <button class="btn ghost sm" style="margin-top:12px" data-act="listAdd" data-list="faq">+ Add question</button>`)}

    ${card('Files & notes', 'Upload price lists, catalogs, policies, menus, scripts. The AI looks up the right part for each question.', `
      ${sw('use_knowledge', 'Use my files when answering')}
      <label class="drop" id="drop" for="fileIn" style="display:block;margin-top:10px">
        <div class="big">📄</div><b>Drop files here or click to upload</b>
        <div class="muted small">PDF, Word, Excel, CSV, text · up to 15 MB each</div>
        <input type="file" id="fileIn" multiple accept=".pdf,.docx,.xlsx,.csv,.tsv,.txt,.md,.json,.html,.htm" class="hidden">
      </label>
      <div id="upProg" class="small muted" style="margin-top:8px"></div>
      <details style="margin-top:14px"><summary>+ Paste text instead</summary>
        <div class="field"><input id="noteTitle" placeholder="Title, e.g. Shipping policy"></div>
        <div class="field"><textarea id="noteText" class="tall" placeholder="Paste or type anything the AI should know…"></textarea></div>
        <button class="btn sm" data-act="addNote" data-busy="Adding…">Add to knowledge</button>
      </details>
      <div class="divider"></div>
      <div id="docList"><div class="muted">Loading…</div></div>
      <div class="divider"></div>
      <div class="row"><input id="kbQ" class="grow" placeholder="Check what it finds — e.g. how much is the 2.9 inch label?"><button class="btn ghost" data-act="kbSearch">Search</button></div>
      <div id="kbRes" style="margin-top:10px"></div>
      <p class="hint" style="margin-top:12px">Tip: send any file to yourself in WhatsApp with the caption <code>/learn</code> and it's added here.</p>`)}`;
  },
  async after() {
    loadDocs();
    const drop = $('#drop'); const input = $('#fileIn');
    input.addEventListener('change', () => uploadFiles([...input.files]));
    ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => uploadFiles([...e.dataTransfer.files]));
    $('#kbQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') PAGES.brain.acts.kbSearch(); });
  },
  acts: {
    addNote: (b) => busy(b, async () => {
      await api('/api/kb/text' + tq(), { body: { title: $('#noteTitle').value || 'Note', text: $('#noteText').value } });
      $('#noteTitle').value = ''; $('#noteText').value = ''; toast('Added to knowledge ✓'); loadDocs();
    }),
    delDoc: async (b) => { if (!confirm(`Remove "${b.dataset.name}" from the AI's knowledge?`)) return; await api(`/api/kb/${b.dataset.id}${tq()}`, { method: 'DELETE' }); loadDocs(); },
    viewDoc: async (b) => {
      const d = await api(`/api/kb/${b.dataset.id}${tq()}`);
      const box = $(`#doc-${d.id}`); box.classList.toggle('hidden');
      box.innerHTML = `<pre style="white-space:pre-wrap;max-height:260px;overflow:auto;background:var(--card2);padding:10px;border-radius:10px;border:1px solid var(--line);font-size:12.5px">${esc(d.text.slice(0, 20000))}</pre>`;
    },
    kbSearch: async () => {
      const r = await api('/api/kb/search' + tq(), { body: { q: $('#kbQ').value } });
      $('#kbRes').innerHTML = r.length ? r.map((x, i) => `<div class="banner" style="margin-bottom:8px"><div class="bi">${i + 1}</div><div class="small" style="white-space:pre-wrap">${esc(x.text.slice(0, 600))}</div></div>`).join('') : '<div class="muted small">Nothing found — the AI would say it needs to check.</div>';
    },
  },
};

async function loadDocs() {
  const docs = await api('/api/kb' + tq()).catch(() => []);
  const el = $('#docList'); if (!el) return;
  el.innerHTML = docs.length ? docs.map((d) => {
    const ext = d.kind === 'text' ? 'TXT' : (d.name.split('.').pop() || '').slice(0, 4).toUpperCase();
    return `<div class="fileRow"><div class="ficon">${esc(ext)}</div>
      <div class="grow"><div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.name)}</div><div class="small faint">${d.kind === 'text' ? 'Note' : kb(d.size)} · ${d.chars.toLocaleString()} characters · ${ago(d.created_at)}</div><div id="doc-${d.id}" class="hidden" style="margin-top:8px"></div></div>
      <div class="row"><button class="btn ghost sm" data-act="viewDoc" data-id="${d.id}">View</button><button class="btn ghost sm" data-act="delDoc" data-id="${d.id}" data-name="${esc(d.name)}" aria-label="Delete">🗑</button></div></div>`;
  }).join('') : empty('📚', 'No files yet. Upload a price list, catalog or FAQ document.');
}

async function uploadFiles(files) {
  const prog = $('#upProg');
  for (const f of files) {
    prog.innerHTML = `<span class="spin"></span> Reading ${esc(f.name)}…`;
    const fd = new FormData(); fd.append('file', f);
    try { const r = await api('/api/kb/upload' + tq(), { body: fd }); toast(`Learned ${f.name} (${r.chunks} sections)`); }
    catch (e) { toast(`${f.name}: ${e.message}`, true); }
  }
  prog.textContent = ''; $('#fileIn').value = ''; loadDocs();
}

// ---------- ACTIONS ----------
const PERM = { off: 'Off', me: 'Only me', anyone: 'Anyone' };
const permSeg = (k, opts = ['off', 'me', 'anyone']) => seg(k, opts.map((v) => [v, PERM[v]]));
PAGES.actions = {
  render() {
    const op = o(); const sec = S.settings.secrets;
    const emailReady = S.mail?.canSend ?? (op.smtp_host && op.smtp_user && sec.smtp_pass);
    const callReady = op.twilio_sid && op.twilio_from && sec.twilio_token;
    const ready = (r) => (r ? pill('ok', 'Ready') : pill('warn', 'Needs setup'));
    const actionCard = (ico, title, desc, k, opts, status, body = '') => `
      <section class="card"><div class="head"><div><h2>${ico} ${title}</h2><p>${desc}</p></div>${status || ''}</div>
        <div class="row between"><span class="small muted">Who can use it</span>${permSeg(k, opts)}</div>${body}</section>`;
    return `
    <div class="pagehead"><div><h1>Actions</h1><p>Let your AI do real things — just ask it in WhatsApp.</p></div></div>
    <div class="banner ok"><div class="bi">💡</div><div>Try in <b>Message yourself</b>: <i>"email dan@acme.com that the order shipped"</i> · <i>"remind me tomorrow at 9 to call Mike"</i> · <i>"call +1 718 555 1234 and tell them we're open till 6"</i> · <i>"send Mom a WhatsApp that I'm running late"</i></div></div>
    <div data-live>
    ${card('Safety', '', sw('confirm_actions', 'Ask me "yes / no" before sending emails, calls or WhatsApp messages', 'The AI shows exactly what it will send and waits for your OK. Strongly recommended.'))}

    ${card('🎯 Command numbers', 'Messages from these numbers are treated as <b>you</b>: they can ask the AI to email, call, set reminders, send WhatsApps — anything you can. Use it for your second phone, your office line or a trusted assistant.', chips('owner_numbers', 'Command numbers', 'Only add numbers you fully trust. Risky actions still ask "yes / no" first.'))}

    ${actionCard('📧', 'Email', 'Send emails — from your own mailbox or the bot\'s own address.', 'act_email', ['off', 'me', 'anyone'], ready(emailReady), `<p class="small muted" style="margin:12px 0 0">Set up sending, the bot's inbox and its own address on the <a href="#/email">Bot email</a> page.</p>`)}

    ${actionCard('📞', 'Phone calls', 'The AI calls a number and speaks your message.', 'act_call', ['off', 'me', 'anyone'], ready(callReady), `
      <details style="margin-top:12px" ${callReady ? '' : 'open'}><summary>Calling provider</summary>
        <p class="small muted">Uses Twilio for now (more providers coming). Get the Account SID, Auth Token and a phone number from your Twilio console.</p>
        <div class="grid2">${txt('twilio_sid', 'Account SID', 'AC…')}${secret('twilio_token', 'Auth token', '')}</div>
        ${txt('twilio_from', 'Call from (your Twilio number)', '+15551234567')}
        <div class="row" style="margin-top:8px"><input id="testCall" placeholder="Test call to +1…" style="max-width:280px"><button class="btn ghost sm" data-act="testConn" data-kind="call" data-busy="Calling…">Test call</button></div>
      </details>`)}

    ${actionCard('💬', 'Send WhatsApp messages', 'Message other people from your number when you ask.', 'act_whatsapp', ['off', 'me'], pill('ok', 'Ready'))}

    ${actionCard('⏰', 'Reminders', 'Reminders arrive in WhatsApp at the right time.', 'act_reminder', ['off', 'me', 'anyone'], pill('ok', 'Ready'), '<div id="remList" style="margin-top:12px"></div>')}

    ${actionCard('📝', 'Notes & leads', 'Saves names, orders and requests from your chats.', 'act_note', ['off', 'me', 'anyone'], pill('ok', 'Ready'), '<div id="noteList" style="margin-top:12px"></div>')}

    ${actionCard('📣', 'Notify me', 'When someone needs a real person, the AI pings you in "Message yourself".', 'act_notify', ['off', 'anyone'], pill('ok', 'Ready'))}

    ${actionCard('🔗', 'Automations (webhook)', 'Send orders, bookings and leads to Zapier, Make, n8n or your CRM.', 'act_webhook', ['off', 'me', 'anyone'], ready(!!op.webhook_url), `
      <details style="margin-top:12px" ${op.webhook_url ? '' : 'open'}><summary>Webhook</summary>
        ${txt('webhook_url', 'Webhook URL', 'https://hooks.zapier.com/…')}
        ${secret('webhook_secret', 'Signing secret (optional)', '', 'Adds an X-Air-Signature header (HMAC-SHA256) so you can verify requests.')}
        <button class="btn ghost sm" data-act="testConn" data-kind="webhook" data-busy="Sending…">Send test event</button>
      </details>`)}
    </div>`;
  },
  async after() {
    loadReminders(); loadNotes();
    if (S.mail === undefined) { S.mail = await api('/api/email' + tq()).catch(() => null); if (S.page === 'actions') rerender(); }
  },
  acts: {
    testConn: (b) => busy(b, async () => {
      if (S.dirty) { toast('Save your changes first', true); return; }
      const kind = b.dataset.kind;
      const target = kind === 'email' ? $('#testEmail').value : kind === 'call' ? $('#testCall').value : '';
      const r = await api('/api/actions/test' + tq(), { body: { kind, target } });
      toast(r.result, /error|fail/i.test(r.result));
    }),
    cancelRem: async (b) => { await api(`/api/reminders/${b.dataset.id}${tq()}`, { method: 'DELETE' }); loadReminders(); },
    delNote: async (b) => { await api(`/api/notes/${b.dataset.id}${tq()}`, { method: 'DELETE' }); loadNotes(); },
  },
};
async function loadReminders() {
  const r = await api('/api/reminders' + tq()).catch(() => []);
  const el = $('#remList'); if (!el) return;
  el.innerHTML = r.length ? `<div class="tablewrap"><table><tr><th>When</th><th>Reminder</th><th>Status</th><th></th></tr>${r.slice(0, 20).map((x) => `<tr><td class="small">${fmtDate(x.due_ts)}</td><td>${esc(x.text)}</td><td><span class="tag">${esc(x.status)}</span></td><td>${x.status === 'pending' ? `<button class="btn link small" data-act="cancelRem" data-id="${x.id}">Cancel</button>` : ''}</td></tr>`).join('')}</table></div>` : '<div class="small muted">No reminders yet.</div>';
}
async function loadNotes() {
  const r = await api('/api/notes' + tq()).catch(() => []);
  const el = $('#noteList'); if (!el) return;
  el.innerHTML = r.length ? `<div class="tablewrap"><table><tr><th>Saved</th><th>From</th><th>Note</th><th></th></tr>${r.slice(0, 50).map((x) => `<tr><td class="small">${fmtDate(x.ts)}</td><td class="small">${esc(x.contact || '')}</td><td>${esc(x.text)}</td><td><button class="btn link small" data-act="delNote" data-id="${x.id}">Delete</button></td></tr>`).join('')}</table></div>` : '<div class="small muted">No notes yet.</div>';
}

// ---------- BOT EMAIL ----------
PAGES.email = {
  render() {
    const op = o(); const m = S.mail;
    if (!m) return `<div class="pagehead"><div><h1>Bot email</h1><p>Give your assistant an inbox.</p></div></div><div class="card muted">Loading…</div>`;
    const imapPreset = (h) => `<button class="btn ghost sm" data-act="imapPreset" data-h="${h}">${h === 'imap.gmail.com' ? 'Gmail' : h === 'outlook.office365.com' ? 'Outlook / Microsoft 365' : 'Yahoo'}</button>`;
    return `
    <div class="pagehead"><div><h1>Bot email</h1><p>Your assistant gets an inbox: it tells you on WhatsApp when mail arrives, and reads or replies when you ask.</p></div></div>
    <div class="banner ok"><div class="bi">💡</div><div>In WhatsApp: <i>"any new emails?"</i> · <i>"read email 12"</i> · <i>"reply to email 12: thanks, I'll call you tomorrow"</i> · <i>"email dan@acme.com the price list"</i></div></div>
    <div data-live>
    ${card('📮 The bot\'s own address', 'A dedicated address for your assistant, e.g. for customers or sign-ups.', !m.domain
      ? `<div class="banner" style="margin:0"><div class="bi">🛠️</div><div>Not available yet — the server admin needs to add a mail domain${S.me.user.is_admin ? ' on the <a href="#/admin">Admin</a> page' : ''}. Meanwhile, connect any mailbox below.</div></div>`
      : m.address
        ? `<div class="row between"><div><div class="mailaddr">${esc(m.address)}</div><div class="small muted">${m.sendingVia === 'bot' ? 'Receives and sends.' : 'Receives mail. Sending uses your mailbox below if set up.'}</div></div><div class="row"><button class="btn ghost sm" data-act="copyAddr" data-v="${esc(m.address)}">Copy</button><button class="btn danger sm" data-act="releaseAddr">Remove</button></div></div>`
        : `<div class="row"><input id="mailLocal" placeholder="yourname" style="max-width:220px" autocomplete="off"><span class="mailaddr">@${esc(m.domain)}</span><button class="btn" data-act="claimAddr" data-busy="Saving…">Get this address</button></div>`)}

    ${card('📥 Connect a mailbox', 'Use any existing inbox (Gmail, Outlook, company mail). Checked every 2 minutes.', `
      <div class="row" style="margin-bottom:12px">${imapPreset('imap.gmail.com')}${imapPreset('outlook.office365.com')}${imapPreset('imap.mail.yahoo.com')}</div>
      <p class="small muted">Gmail: turn on 2-Step Verification, then create an <b>App Password</b> (Google Account → Security → App passwords) and paste it below — not your normal password.</p>
      <div class="grid2">${txt('imap_host', 'IMAP server', 'imap.gmail.com')}${num('imap_port', 'Port', 1, 65535)}</div>
      <div class="grid2">${txt('imap_user', 'Email address', 'you@gmail.com')}${secret('imap_pass', 'App password', '')}</div>
      ${sw('mail_check', 'Check this inbox')}
      ${sw('mail_notify', 'WhatsApp me when a new email arrives', 'Sent to your "Message yourself" chat with a short preview.')}
      <div class="row" style="margin-top:10px"><button class="btn ghost sm" data-act="checkMail" data-busy="Checking…">Check now</button>
        <span class="small ${m.error ? '' : 'muted'}" style="${m.error ? 'color:var(--danger)' : ''}">${m.error ? esc(m.error) : m.lastCheck ? 'Last checked ' + ago(m.lastCheck / 1000) : m.imap ? 'Not checked yet' : ''}</span></div>`)}

    ${card('📤 Sending', 'How the assistant sends email. Your mailbox above usually works with the same app password.', `
      <div class="row" style="margin-bottom:12px"><button class="btn ghost sm" data-act="smtpFromImap">Use same account as inbox</button></div>
      <div class="grid2">${txt('smtp_host', 'SMTP server', 'smtp.gmail.com')}${num('smtp_port', 'Port', 1, 65535)}</div>
      <div class="grid2">${txt('smtp_user', 'Username / email', 'you@gmail.com')}${secret('smtp_pass', 'Password / app password', '')}</div>
      ${txt('smtp_from', 'Send as (optional)', 'Your Name <you@gmail.com>')}
      ${sw('smtp_secure', 'Use SSL (port 465)')}
      <div class="row" style="margin-top:8px"><input id="testEmail" type="email" placeholder="Send a test to…" style="max-width:280px"><button class="btn ghost sm" data-act="testConn" data-kind="email" data-busy="Sending…">Send test</button></div>
      <div class="divider"></div>
      <div class="row between"><span><b>AI can read & reply to emails</b><div class="small muted">Only for you (and your command numbers). Replies ask "yes / no" first.</div></span>${seg('act_email_read', [['off', 'Off'], ['me', 'Only me']])}</div>`)}
    </div>
    ${card('Inbox', `${m.emails.length} recent`, m.emails.length ? m.emails.map((e) => `
      <div class="emailRow" data-act="openMail" data-id="${e.id}"><div style="min-width:0"><div><b>${esc(e.from_name || e.from_addr)}</b> <span class="small faint">#${e.id}</span></div><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(e.subject)}</div><div class="small muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(e.snippet)}</div><div id="mail-${e.id}" class="hidden"></div></div><div class="small faint">${ago(e.date)}</div></div>`).join('') : empty('📭', 'No emails yet.'))}`;
  },
  async after() {
    if (S.mail === undefined) { S.mail = await api('/api/email' + tq()).catch((e) => ({ emails: [], error: e.message })); if (S.page === 'email') rerender(); }
  },
  acts: {
    imapPreset: (b) => { o().imap_host = b.dataset.h; o().imap_port = 993; o().imap_secure = true; markDirty(true); rerender(); },
    smtpFromImap: () => {
      const h = o().imap_host || '';
      o().smtp_host = h.includes('gmail') ? 'smtp.gmail.com' : h.includes('office365') ? 'smtp.office365.com' : h.includes('yahoo') ? 'smtp.mail.yahoo.com' : h.replace(/^imap\./, 'smtp.');
      o().smtp_port = 587; o().smtp_secure = false; o().smtp_user = o().imap_user;
      if (S.secretsDraft.imap_pass) S.secretsDraft.smtp_pass = S.secretsDraft.imap_pass;
      markDirty(true); rerender();
      if (!S.secretsDraft.smtp_pass && !S.settings.secrets.smtp_pass) toast('Now paste the same app password in the sending password field');
    },
    claimAddr: (b) => busy(b, async () => { S.mail = { ...S.mail, ...(await api('/api/email/claim' + tq(), { body: { local: $('#mailLocal').value } })) }; toast('Address saved ✓'); rerender(); }),
    releaseAddr: async () => { if (!confirm('Remove this address? Mail sent to it will bounce.')) return; S.mail = { ...S.mail, ...(await api('/api/email/release' + tq(), { body: {} })) }; rerender(); },
    copyAddr: async (b) => { try { await navigator.clipboard.writeText(b.dataset.v); toast('Copied'); } catch (_) { toast(b.dataset.v); } },
    checkMail: (b) => busy(b, async () => {
      if (S.dirty) throw new Error('Save your changes first');
      const r = await api('/api/email/check' + tq(), { body: {} });
      toast(`Inbox checked — ${r.added} new`);
      S.mail = await api('/api/email' + tq()); rerender();
    }),
    openMail: async (b) => {
      const box = $(`#mail-${b.dataset.id}`); if (!box) return;
      if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
      const m = await api(`/api/email/${b.dataset.id}${tq()}`);
      box.innerHTML = `<pre style="white-space:pre-wrap;margin:10px 0 0;font:inherit;font-size:13.5px;max-height:320px;overflow:auto">${esc(m.text.slice(0, 20000))}</pre>`;
      box.classList.remove('hidden');
    },
    testConn: (...a) => PAGES.actions.acts.testConn(...a),
  },
};

// ---------- VOICE ----------
PAGES.voice = {
  render() {
    const op = o();
    return `
    <div class="pagehead"><div><h1>Voice notes</h1><p>Your AI listens to voice notes and answers them.</p></div></div>
    <div data-live>
    ${card('Listening', '', `
      ${sw('voice_in', 'Understand voice notes', 'Voice notes are turned into text, then answered like a normal message.')}
      ${op.voice_in ? `
      <div class="field" style="margin-top:12px"><label class="lbl">Speech-to-text engine</label>
        ${cards('voice_engine', [
          ['smart', 'Air Smart Voice (recommended)', 'Fast managed Whisper when enabled by admin, or local Whisper otherwise.', '⚡'],
          ['server', 'On this server (free)', 'Open-source Whisper runs on your VPS. Private. First voice note downloads the model (~80 MB) and is slower.', '🖥️'],
          ['api', 'Speech API (fast)', 'Uses your AI provider\'s Whisper (e.g. Groq) or the admin\'s speech API. Faster, better accuracy.', '⚡'],
        ])}</div>
      <div id="whisperState" class="small muted"></div>
      ${op.voice_engine === 'api' ? txt('voice_api_model', 'Speech model (optional)', 'whisper-large-v3-turbo', 'Leave empty for the default of your provider.') + secret('voice_api_key', 'Speech API key (optional)', '', 'Only if different from the AI model key.') : ''}
      ${sw('voice_transcript_self', 'Show me the transcript in "Message yourself"', 'Handy to check what it heard.')}` : ''}`)}

    ${card('Talking back', 'Answer voice notes with a voice note.', `
      ${sw('voice_reply', 'Reply to voice notes with voice', 'Needs a text-to-speech API (OpenAI-compatible /audio/speech) on your own AI provider or set by the admin. Falls back to text if unavailable.')}
      ${op.voice_reply ? `<div class="grid2">${txt('tts_voice', 'Voice', 'alloy')}${txt('tts_model', 'Speech model', 'tts-1')}</div>` : ''}`)}

    ${card('Test it', 'Upload a voice note or audio file to see what the AI hears. Save your settings first.', `
      <div class="row"><input type="file" id="audioIn" accept="audio/*,.ogg,.opus,.m4a,.mp3,.wav"><button class="btn ghost" data-act="testVoice" data-busy="Listening…">Transcribe</button></div>
      <div id="voiceOut" style="margin-top:12px"></div>`)}
    </div>`;
  },
  async after() {
    try {
      const s = await api('/api/voice/status' + tq());
      const st = { idle: 'not loaded yet (loads on the first voice note)', loading: 'loading…', ready: 'ready', error: 'error: ' + (s.local.error || '') }[s.local.status];
      if ($('#whisperState')) $('#whisperState').textContent = o().voice_engine === 'smart' ?
         (s.managed ? 'Managed speech provider configured. Use Test it to verify.' : `Local fallback: ${s.model} — ${st}`) :
         (o().voice_engine === 'server' ? `Local Whisper ${s.model}: ${st}` : (s.serverApi ? 'Speech API configured' : 'Speech API requires administrator setup'));
    } catch (_) {}
  },
  acts: {
    testVoice: (b) => busy(b, async () => {
      const f = $('#audioIn').files[0]; if (!f) throw new Error('Choose an audio file first');
      const fd = new FormData(); fd.append('file', f);
      const r = await api('/api/voice/test' + tq(), { body: fd });
      $('#voiceOut').innerHTML = `<div class="banner ok"><div class="bi">🎙️</div><div><b>Heard (${(r.ms / 1000).toFixed(1)}s):</b><br>${esc(r.text || '(nothing)')}</div></div>`;
    }),
  },
};

// ---------- AI MODEL ----------
const PRESETS = [
  ['groq', 'Groq (fast, open-source models)', 'https://api.groq.com/openai/v1', 'llama-3.3-70b-versatile'],
  ['openrouter', 'OpenRouter (hundreds of models)', 'https://openrouter.ai/api/v1', 'meta-llama/llama-3.3-70b-instruct'],
  ['together', 'Together AI', 'https://api.together.xyz/v1', 'meta-llama/Llama-3.3-70B-Instruct-Turbo'],
  ['deepseek', 'DeepSeek', 'https://api.deepseek.com/v1', 'deepseek-chat'],
  ['openai', 'OpenAI', 'https://api.openai.com/v1', 'gpt-4o-mini'],
  ['anthropic', 'Anthropic Claude', 'https://api.anthropic.com/v1', 'claude-sonnet-5-5'],
  ['custom', 'Other OpenAI-compatible API', '', ''],
];
async function refreshOpenRouterModels() {
  const result = await api('/api/ai/models' + tq());
  const select = $('#orModelChoice');
  if (select) {
    const current = o().ai_model;
    const ids = [...new Set([current, ...result.models].filter(Boolean))];
    select.innerHTML = '<option value="">Choose a model…</option>' + ids.map((id) =>
      `<option value="${esc(id)}" ${id === current ? 'selected' : ''}>${esc(id)}</option>`).join('');
  }
  const status = $('#orModelStatus');
  if (status) status.textContent = `${result.models.length} models available. Choose one above, then save and test it.`;
  const datalist = $('#modelList');
  if (datalist) datalist.innerHTML = result.models.map((id) => `<option value="${esc(id)}">`).join('');
  return result;
}

const OR_BASE = 'https://openrouter.ai/api/v1';
const OR_MODELS = [
  ['openai/gpt-4o-mini', 'ChatGPT · GPT-4o mini', 'Fast, cheap, great for most chats'],
  ['openai/gpt-4o', 'ChatGPT · GPT-4o', 'Smarter answers, costs more'],
  ['anthropic/claude-3.5-haiku', 'Claude Haiku', 'Fast and friendly'],
  ['anthropic/claude-sonnet-4', 'Claude Sonnet', 'Top writing and reasoning'],
  ['meta-llama/llama-3.3-70b-instruct', 'Llama 3.3 70B', 'Open source'],
  ['qwen/qwen-2.5-72b-instruct', 'Qwen 2.5 72B', 'Open source, many languages'],
  ['deepseek/deepseek-chat', 'DeepSeek', 'Open source, very cheap'],
];
PAGES.model = {
  render() {
    const op = o();
    if (!S.me.allowCustomAi) return `<div class="pagehead"><div><h1>AI model</h1><p>The brain behind your assistant.</p></div></div>
      ${card('Server AI', '', '<p class="muted">Your account uses Air Smart AI, managed by your administrator. No personal API key needed.</p>')}
      ${S.me.user.is_admin
        ? card('OpenRouter sign-in is off', 'Enable personal AI providers to show the QR sign-in and model choices.', '<button class="btn lg" data-act="enableCustomAi" data-busy="Enabling…">Enable OpenRouter sign-in</button>')
        : card('OpenRouter sign-in is off', 'Ask your Air Agent administrator to enable “Users may use their own AI provider.” Then return here and choose Sign in & connect.')}`;
    const onOR = op.ai_mode === 'custom' && op.ai_base_url === OR_BASE && (S.settings.secrets.ai_key || S.secretsDraft.ai_key);
    const known = OR_MODELS.some(([id]) => id === op.ai_model);
    return `
    <div class="pagehead"><div><h1>AI model</h1><p>The brain behind your assistant.</p></div></div>
    <div data-live>
    ${onOR ? card('Smarter AI', 'Connected through OpenRouter. Pick the model you like — you can switch anytime.', `
        <div class="row between" style="margin-bottom:14px">${pill('ok', 'Signed in')}<div class="row"><button class="btn ghost sm" data-act="orSignin" data-busy="Opening…">Sign in again</button><button class="btn danger sm" data-act="orOff">Use server AI instead</button></div></div>
        ${cards('ai_model', OR_MODELS.map(([id, t, d]) => [id, t, d]).concat(known ? [] : [[op.ai_model, op.ai_model || 'Other model', 'Your custom choice']]))}
        <div class="field" style="margin-top:14px"><label class="lbl">Choose from all OpenRouter models</label>
          <select id="orModelChoice"><option value="">Loading models…</option></select>
          <div class="hint" id="orModelStatus">Loading your available OpenRouter models…</div></div>
        <details style="margin-top:12px"><summary>Use another model</summary>${txt('ai_model', 'Model id', 'provider/model-name', 'Any model listed on openrouter.ai/models')}</details>`)
      : card('', '', `
        <div class="signin"><div class="big">✨</div><div class="grow"><h2 style="font-size:18px">Make your assistant much smarter — one click</h2>
          <p class="muted" style="margin:4px 0 0">Sign in with Google or email and choose ChatGPT, Claude, Llama and more. No API keys to copy. Pay only for what you use on your OpenRouter account.</p></div>
          <button class="btn lg" data-act="orSignin" data-busy="Opening…">Sign in & connect</button></div>
        <p class="small faint" style="margin:12px 0 0">Your assistant can't use a personal ChatGPT or Claude chat subscription — those services don't allow it — so this connects through OpenRouter instead.</p>`)}
    ${location.protocol === 'http:' && /^\d{1,3}(\.\d{1,3}){3}$/.test(location.hostname) ? `<div class="banner warn"><div class="bi">🔒</div><div>Sign-in needs a secure (HTTPS) address. Open <a href="https://${location.hostname.replace(/\./g, '-')}.sslip.io/#/model"><b>https://${location.hostname.replace(/\./g, '-')}.sslip.io</b></a> (free HTTPS for this server), log in, and sign in from there.</div></div>` : ''}
    <div id="orQr"></div>

    ${card('Which AI answers', '', cards('ai_mode', [
      ['server', 'Air Smart AI', 'Uses the managed AI when enabled, otherwise open-source local AI. No key required.', '⚡'],
      ['custom', 'My connected AI', 'The smarter model you signed in to (or your own API key below).', '🔑'],
    ]))}

    <details class="card"><summary>Advanced: use your own API key</summary>
      <p class="small muted">OpenAI-compatible services use their own API key. Claude uses an Anthropic API key; it cannot use an OpenAI key.</p>
      <div class="field"><label class="lbl">Quick setup</label><select id="preset"><option value="">Choose a provider…</option>${PRESETS.map(([id, l]) => `<option value="${id}">${esc(l)}</option>`).join('')}</select></div>
      ${txt('ai_base_url', 'API base URL', 'https://api.groq.com/openai/v1')}
      <div class="field"><label class="lbl">Model</label><input data-opt="ai_model" list="modelList" value="${esc(op.ai_model)}" placeholder="llama-3.3-70b-versatile"><datalist id="modelList"></datalist></div>
      ${secret('ai_key', 'API key', 'sk-…')}
    </details>
    ${card('Test it', 'Checks the AI you selected above (save first).', `<button class="btn ghost" data-act="testAi" data-busy="Testing…">Test now</button><div id="aiOut" style="margin-top:12px"></div>`)}
    </div>`;
  },
  after() {
    $('#preset')?.addEventListener('change', (e) => {
      const p = PRESETS.find((x) => x[0] === e.target.value); if (!p) return;
      if (p[2]) o().ai_base_url = p[2]; if (p[3]) o().ai_model = p[3];
      o().ai_mode = 'custom'; markDirty(true); rerender();
    });
    $('#orModelChoice')?.addEventListener('change', (e) => {
      if (!e.target.value) return;
      o().ai_model = e.target.value; markDirty(true); rerender();
    });
    if ($('#orModelChoice')) refreshOpenRouterModels().catch((e) => {
      const status = $('#orModelStatus'); if (status) status.textContent = 'Could not load models: ' + e.message;
    });
  },
  acts: {
    enableCustomAi: (b) => busy(b, async () => {
      await api('/api/admin/settings', { body: { allow_custom_ai: true } });
      S.me = await api('/api/me'); await loadSettings(); rerender();
      toast('OpenRouter sign-in enabled — click Sign in & connect to show the QR');
    }),
    refreshORModels: (b) => busy(b, async () => { await refreshOpenRouterModels(); toast('OpenRouter models refreshed'); }),
    orSignin: (b) => busy(b, async () => {
      if (S.dirty) throw new Error('Save or discard your changes first');
      const r = await api('/api/ai/openrouter/start' + tq());
      const box = $('#orQr'); if (!box) { location.href = r.url; return; }
      box.innerHTML = card('Scan to sign in', 'Point your phone camera at this code, check that it shows your account, then sign in to OpenRouter. This page updates by itself when you are done.', `
        <div class="row" style="gap:20px;align-items:center;flex-wrap:wrap">
          <img src="${r.qr}" alt="OpenRouter sign-in QR code" width="220" height="220" style="border-radius:8px;background:#fff;padding:6px">
          <div class="grow"><p class="muted" id="orQrSt"><span class="spin"></span> Waiting for you to sign in…</p>
            <a class="btn ghost" href="${esc(r.url)}">Or sign in on this device</a></div></div>`);
      clearInterval(S.orPoll);
      const t0 = Date.now();
      S.orPoll = setInterval(async () => {
        if (!$('#orQrSt') || Date.now() - t0 > 15 * 60_000) { clearInterval(S.orPoll); return; }
        const st = await api('/api/ai/openrouter/status?state=' + encodeURIComponent(r.state)).catch(() => null);
        if (!st) return;
        if (st.done) {
          clearInterval(S.orPoll);
          if (st.ok) { await loadSettings(); rerender(); toast('Signed in ✓ — your smarter AI is connected'); }
          else $('#orQrSt').textContent = 'Sign-in failed. Try again.';
        } else if (st.expired) { clearInterval(S.orPoll); $('#orQrSt').textContent = 'This code expired. Click Sign in again.'; }
      }, 2500);
    }),
    orOff: () => { o().ai_mode = 'server'; markDirty(true); rerender(); },
    testAi: (b) => busy(b, async () => {
      const op = o();
      const r = await api('/api/ai/test' + tq(), { body: { mode: op.ai_mode, base_url: op.ai_base_url, model: op.ai_model, api_key: S.secretsDraft.ai_key ?? S.settings.secrets.ai_key } });
      $('#aiOut').innerHTML = `<div class="banner ok"><div class="bi">✅</div><div><b>${esc(r.model)}</b> answered in ${(r.ms / 1000).toFixed(1)}s: "${esc(r.reply)}"${r.models?.length ? `<div class="small muted" style="margin-top:4px">${r.models.length} models available</div>` : ''}</div></div>`;
      const dl = $('#modelList'); if (dl) dl.innerHTML = (r.models || []).map((m) => `<option value="${esc(m)}">`).join('');
      if (op.ai_base_url === OR_BASE) await refreshOpenRouterModels();
    }),
  },
};

// ---------- CONVERSATIONS ----------
PAGES.chats = {
  render() {
    return `
    <div class="pagehead"><div><h1>Conversations</h1><p>Chats your AI has answered. Pause it anywhere, anytime.</p></div></div>
    <div class="chatwrap">
      <section class="card tight chatlist" id="chatList"><div class="muted">Loading…</div></section>
      <section class="card" id="chatView">${empty('👈', 'Pick a conversation')}</section>
    </div>`;
  },
  async after() { await loadChats(); if (S.chatSel) openChat(S.chatSel); },
  acts: {
    openChat: (b) => openChat(b.dataset.jid),
    pause: async (b) => { await api('/api/chats/pause' + tq(), { body: { jid: S.chatSel, minutes: Number(b.dataset.min) } }); toast(Number(b.dataset.min) === 0 ? 'AI resumed in this chat' : 'AI paused in this chat'); await loadChats(); openChat(S.chatSel); },
    clearMem: async () => { if (!confirm('Clear the AI\'s memory of this chat?')) return; await api('/api/chats/clear' + tq(), { body: { jid: S.chatSel } }); openChat(S.chatSel); },
  },
};
let chatCache = [];
async function loadChats() {
  chatCache = await api('/api/chats' + tq()).catch(() => []);
  const el = $('#chatList'); if (!el) return;
  el.innerHTML = chatCache.length ? chatCache.map((c) => {
    const name = c.name || (c.phone ? '+' + c.phone : c.is_group ? 'Group' : 'Chat');
    return `<div class="chatItem ${S.chatSel === c.chat_jid ? 'active' : ''}" data-act="openChat" data-jid="${esc(c.chat_jid)}">
      <div class="row" style="gap:10px;flex-wrap:nowrap;min-width:0"><div class="avatar">${c.is_group ? '👥' : esc(name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 1).toUpperCase() || '?')}</div>
      <div style="min-width:0"><div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(name)}</div><div class="small faint">${c.replies} replies · ${ago(c.last_ts)}</div></div></div>
      ${c.paused ? '<span class="tag">paused</span>' : ''}</div>`;
  }).join('') : empty('💬', 'No conversations yet.');
}
async function openChat(jid) {
  S.chatSel = jid;
  $$('.chatItem').forEach((x) => x.classList.toggle('active', x.dataset.jid === jid));
  const c = chatCache.find((x) => x.chat_jid === jid); if (!c) return;
  const msgs = await api('/api/chats/messages' + tq() + sep(tq()) + 'jid=' + encodeURIComponent(jid)).catch(() => []);
  const name = c.name || (c.phone ? '+' + c.phone : 'Chat');
  const until = c.paused_until === -1 ? 'until you resume' : c.paused ? 'until ' + fmtDate(c.paused_until) : '';
  $('#chatView').innerHTML = `
    <div class="head"><div><h2>${esc(name)}</h2><p>${c.phone ? '+' + esc(c.phone) + ' · ' : ''}${c.is_group ? 'Group · ' : ''}${c.replies} AI replies</p></div>${c.paused ? pill('warn', 'Paused ' + until) : pill('ok', 'AI active')}</div>
    <div class="row" style="margin-bottom:12px">${c.paused ? '<button class="btn sm" data-act="pause" data-min="0">Resume AI</button>' : '<button class="btn ghost sm" data-act="pause" data-min="60">Pause 1 hour</button><button class="btn ghost sm" data-act="pause" data-min="-1">Pause until I resume</button>'}<button class="btn ghost sm" data-act="clearMem">Clear memory</button></div>
    <div class="thread">${msgs.length ? msgs.map((m) => `<div class="bubble ${m.role}">${m.kind === 'voice' ? '🎙️ ' : ''}${esc(m.content)}<span class="meta">${fmtDate(m.ts)}</span></div>`).join('') : '<div class="bubble sys">No saved messages (memory may be off or cleared).</div>'}</div>`;
  const th = $('.thread'); th.scrollTop = th.scrollHeight;
}

// ---------- PLAYGROUND ----------
PAGES.playground = {
  render() {
    const pg = S.pg;
    return `
    <div class="pagehead"><div><h1>Test your AI</h1><p>Uses your saved prompts, knowledge and rules. Actions are simulated — nothing is sent.</p></div>
      <div class="seg" role="radiogroup"><label><input type="radio" name="pgas" value="customer" ${pg.as === 'customer' ? 'checked' : ''}>As a customer</label><label><input type="radio" name="pgas" value="owner" ${pg.as === 'owner' ? 'checked' : ''}>As me</label></div></div>
    ${S.dirty ? '<div class="banner warn"><div class="bi">💾</div><div>You have unsaved changes — save them so the test uses them.</div></div>' : ''}
    <section class="card">
      <div class="thread" id="pgThread">${pg.history.length ? pg.history.map(pgBubble).join('') : `<div class="bubble sys">${pg.as === 'owner' ? 'Try: "remind me in 10 minutes to call Mike" or "what do we sell?"' : 'Try: "how much is it?", "what are your hours?", "I want to talk to a person"'}</div>`}</div>
      <form class="composer" id="pgForm"><input id="pgIn" placeholder="Type a message…" autocomplete="off" class="grow"><button class="btn" type="submit">Send</button><button class="btn ghost" type="button" data-act="pgReset">Reset</button></form>
    </section>`;
  },
  after() {
    $$('input[name=pgas]').forEach((r) => r.addEventListener('change', () => { S.pg = { history: [], as: r.value }; rerender(); }));
    $('#pgForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = $('#pgIn').value.trim(); if (!text) return;
      const prior = S.pg.history.filter((m) => !m.meta).map(({ role, content }) => ({ role, content }));
      S.pg.history.push({ role: 'user', content: text });
      $('#pgIn').value = ''; rerender();
      $('#pgThread').insertAdjacentHTML('beforeend', '<div class="bubble assistant" id="pgWait"><span class="spin"></span></div>');
      const th = $('#pgThread'); th.scrollTop = th.scrollHeight;
      try {
        const r = await api('/api/playground' + tq(), { body: { text, as: S.pg.as, history: prior } });
        S.pg.history.push({ role: 'assistant', content: r.confirm || r.reply, tools: r.tools, knowledge: r.knowledge, ms: r.ms });
      } catch (err) { S.pg.history.push({ role: 'assistant', content: '⚠️ ' + err.message, meta: true }); }
      rerender(); $('#pgIn').focus();
      const t2 = $('#pgThread'); t2.scrollTop = t2.scrollHeight;
    });
    $('#pgIn').focus();
  },
  acts: { pgReset: () => { S.pg.history = []; rerender(); } },
};
const pgBubble = (m) => `<div class="bubble ${m.role}">${esc(m.content)}${m.tools?.length ? `<div>${m.tools.map((t) => `<span class="toolchip">⚡ ${esc(t.name)}</span>`).join('')}</div>` : ''}${m.ms ? `<span class="meta">${(m.ms / 1000).toFixed(1)}s${m.knowledge ? ` · ${m.knowledge} knowledge match${m.knowledge > 1 ? 'es' : ''}` : ''}</span>` : ''}</div>`;

// ---------- ACCOUNT ----------
PAGES.account = {
  render() {
    return `
    <div class="pagehead"><div><h1>Account</h1><p>${esc(S.me.user.email)}</p></div></div>
    ${card('Change password', '', `<div class="grid2"><div class="field"><label class="lbl">Current password</label><input type="password" id="pwCur" autocomplete="current-password"></div><div class="field"><label class="lbl">New password</label><input type="password" id="pwNew" autocomplete="new-password" minlength="8"></div></div><button class="btn" data-act="pw" data-busy="Saving…">Update password</button>`)}
    ${card('Privacy', '', `<p class="muted">What's stored: your settings, files you upload, and recent messages the AI answered (for its memory, deleted after the retention period). Your other WhatsApp chats are never stored.</p>
      <button class="btn danger" data-act="wipe" data-busy="Deleting…">Unlink WhatsApp & delete all my data</button>`)}`;
  },
  acts: {
    pw: (b) => busy(b, async () => { await api('/api/account/password', { body: { current: $('#pwCur').value, next: $('#pwNew').value } }); $('#pwCur').value = $('#pwNew').value = ''; toast('Password updated ✓'); }),
    wipe: (b) => { if (prompt('Type DELETE to unlink WhatsApp and erase your settings, files and history.') === 'DELETE') busy(b, async () => { await api('/api/account/delete-data', { body: {} }); toast('All your data was deleted'); S.target = 'mine'; await loadSettings(); renderShell(); }); },
  },
};

// ---------- ADMIN ----------
PAGES.admin = {
  admin: true,
  render() {
    return `
    <div class="pagehead"><div><h1>Admin</h1><p>Server, users and security.</p></div><button class="btn dangerSolid" data-act="killAll" data-busy="Disconnecting…">⛔ Disconnect all WhatsApp</button></div>
    <div class="stats" id="aStats"></div>
    <div class="grid2">
      ${card('Access', '', `<div id="aAccess" class="muted">Loading…</div>`)}
      ${card('Air Smart AI', 'Default model for everyone who doesn\'t bring their own.', '<div id="aAi" class="muted">Loading…</div>')}
    </div>
    ${card('Users', '', `<div id="aUsers" class="muted">Loading…</div>
      <details style="margin-top:14px"><summary>+ Create a user</summary>
        <div class="grid3"><div class="field"><label class="lbl">Name</label><input id="nuName"></div><div class="field"><label class="lbl">Email</label><input id="nuEmail" type="email"></div><div class="field"><label class="lbl">Temporary password</label><input id="nuPass" type="text" minlength="8"></div></div>
        <button class="btn sm" data-act="newUser" data-busy="Creating…">Create user</button></details>`)}
    ${card('Bot email domain', 'Lets every user claim an address like name@yourdomain for their assistant.', '<div id="aMail" class="muted">Loading…</div>')}
    ${card('Speech API (optional)', 'Used by "Speech API" voice mode for people without their own provider. Any OpenAI-compatible /audio endpoint (e.g. Groq).', '<div id="aVoice" class="muted">Loading…</div>')}`;
  },
  async after() { await loadAdmin(); },
  acts: {
    groqPreset: () => {
      $('[data-admin="ai_base_url"]').value = 'https://api.groq.com/openai/v1';
      $('[data-admin="ai_model"]').value = 'openai/gpt-oss-20b';
      $('[data-admin="voice_api_base"]').value = 'https://api.groq.com/openai/v1';
      $('[data-admin="voice_api_model"]').value = 'whisper-large-v3-turbo';
      toast('Groq selected. Enter your Groq API key under Air Smart AI, then Save.');
    },
    killAll: (b) => { if (prompt('This unlinks EVERY WhatsApp number from this server right now. Type DISCONNECT to confirm.') === 'DISCONNECT') busy(b, async () => { const r = await api('/api/admin/disconnect-all', { body: {} }); toast(`Disconnected ${r.count} session(s)`); await loadSettings(); loadAdmin(); }); },
    saveAdmin: (b) => busy(b, async () => {
      const body = {};
      $$('[data-admin]').forEach((el) => { body[el.dataset.admin] = el.type === 'checkbox' ? el.checked : el.value; });
      await api('/api/admin/settings', { body }); toast('Saved ✓'); loadAdmin();
      S.me = await api('/api/me');
    }),
    pull: (b) => busy(b, async () => { const name = $('#pullName').value.trim(); if (!name) throw new Error('Enter a model name'); await api('/api/admin/pull', { body: { model: name } }); toast('Downloading ' + name + '…'); setTimeout(loadAdmin, 2000); }),
    newUser: (b) => busy(b, async () => { await api('/api/admin/users', { body: { name: $('#nuName').value, email: $('#nuEmail').value, password: $('#nuPass').value } }); toast('User created — share the email & password with them'); $('#nuName').value = $('#nuEmail').value = $('#nuPass').value = ''; loadAdmin(); }),
    uAdmin: (b) => busy(b, async () => { await api(`/api/admin/users/${b.dataset.id}`, { body: { is_admin: b.dataset.v === '1' } }); loadAdmin(); }),
    uPw: async (b) => { const p = prompt('New password for this user (min 8 characters):'); if (p) await busy(b, async () => { await api(`/api/admin/users/${b.dataset.id}`, { body: { password: p } }); toast('Password reset'); }); },
    uDisc: (b) => busy(b, async () => { await api(`/api/admin/users/${b.dataset.id}`, { body: { disconnect: true } }); toast('Unlinked'); loadAdmin(); }),
    uDel: (b) => { if (confirm(`Delete ${b.dataset.email} and all their data?`)) busy(b, async () => { await api(`/api/admin/users/${b.dataset.id}`, { method: 'DELETE' }); loadAdmin(); }); },
  },
};
async function loadAdmin() {
  const [s, a] = await Promise.all([api('/api/admin/stats'), api('/api/admin/settings')]);
  const up = s.uptimeSec > 86400 ? Math.floor(s.uptimeSec / 86400) + 'd' : Math.floor(s.uptimeSec / 3600) + 'h';
  $('#aStats').innerHTML = [
    ['Users', s.users], ['Numbers connected', s.sessions.filter((x) => x.status === 'open').length], ['AI messages (24h)', s.messages.last24h],
    ['Avg AI reply', s.ai.avgMs ? (s.ai.avgMs / 1000).toFixed(1) + 's' : '–'], ['Server RAM free', `${(s.host.memFreeMb / 1024).toFixed(1)} / ${(s.host.memTotalMb / 1024).toFixed(1)} GB`], ['Uptime', up],
  ].map(([l, v]) => `<div class="stat"><div class="v">${esc(v)}</div><div class="l">${l}</div></div>`).join('');
  const chk = (k, v) => `<label class="toggle"><input type="checkbox" data-admin="${k}" ${v ? 'checked' : ''}><span></span></label>`;
  $('#aAccess').innerHTML = `
    <div class="sw"><div><div class="t">Public sign-ups</div><div class="d">Off = only you can create accounts (recommended until you have a domain + HTTPS).</div></div>${chk('signup_open', a.signup_open)}</div>
    <div class="sw"><div><div class="t">Users may use their own AI provider</div><div class="d">Lets people plug in their own API keys.</div></div>${chk('allow_custom_ai', a.allow_custom_ai)}</div>
    <button class="btn sm" style="margin-top:10px" data-act="saveAdmin" data-busy="Saving…">Save</button>`;
  const pulls = Object.entries(a.pulls || {}).map(([n, p]) => `<div class="small">${esc(n)}: ${esc(p.status)} ${esc(p.detail || '')}</div>`).join('');
  $('#aAi').innerHTML = `
    <div class="small muted" style="margin-bottom:10px">Managed Groq: ${a.groqConfigured ? pill('ok', 'Configured') : pill('bad', 'Add your Groq key')} · Local fallback: ${s.ollama.ok ? pill('ok', 'Ollama running') : pill('bad', 'Ollama down')} ${s.ollama.ok ? `<span class="faint">models: ${esc(s.ollama.models.join(', ') || 'none')}</span>` : ''}</div>
    <div class="row" style="margin-bottom:10px"><button class="btn ghost sm" data-act="groqPreset">Select Groq GPT-OSS 20B + Whisper</button></div>
    <div class="field"><label class="lbl">API base URL</label><input data-admin="ai_base_url" value="${esc(a.ai_base_url)}" placeholder="Empty = local Ollama on this server"></div>
    <div class="grid2"><div class="field"><label class="lbl">Model</label><input data-admin="ai_model" value="${esc(a.ai_model)}" placeholder="${esc(a.local_default_model)}"></div>
    <div class="field"><label class="lbl">API key (if using an API)</label><input type="password" data-admin="ai_key" value="${esc(a.ai_key)}" autocomplete="new-password"></div></div>
    <div class="grid2"><div class="field"><label class="lbl">AI calls per number per day</label><input type="number" min="1" max="100000" data-admin="ai_daily_limit" value="${esc(a.ai_daily_limit)}"></div>
    <div class="field"><label class="lbl">Voice seconds per number per day</label><input type="number" min="1" max="100000" data-admin="voice_daily_seconds" value="${esc(a.voice_daily_seconds)}"></div></div>
    <div class="hint">Daily budgets protect your usage. 50 GB disk storage is not equivalent to RAM for running a local model.</div>
    <button class="btn sm" data-act="saveAdmin" data-busy="Saving…">Save</button>
    <div class="divider"></div>
    <label class="lbl">Download a local open-source model</label>
    <div class="row"><input id="pullName" class="grow" placeholder="qwen2.5:3b  ·  qwen2.5:7b  ·  llama3.2:3b"><button class="btn ghost sm" data-act="pull" data-busy="Starting…">Download</button></div>
    <div class="hint">Bigger = smarter but needs more RAM (3b ≈ 3 GB, 7b ≈ 6 GB). After downloading, set it as the Model above.</div>${pulls}`;
  $('#aVoice').innerHTML = `
    <div class="grid3"><div class="field"><label class="lbl">Base URL</label><input data-admin="voice_api_base" value="${esc(a.voice_api_base)}" placeholder="https://api.groq.com/openai/v1"></div>
    <div class="field"><label class="lbl">Model</label><input data-admin="voice_api_model" value="${esc(a.voice_api_model)}" placeholder="whisper-large-v3-turbo"></div>
    <div class="field"><label class="lbl">API key</label><input type="password" data-admin="voice_api_key" value="${esc(a.voice_api_key)}" autocomplete="new-password"></div></div>
    <button class="btn sm" data-act="saveAdmin" data-busy="Saving…">Save</button>`;
  $('#aMail').innerHTML = `
    <div class="grid2"><div class="field"><label class="lbl">Mail domain</label><input data-admin="mail_domain" value="${esc(a.mail_domain)}" placeholder="bots.airbiz.ai"><div class="hint">A domain or subdomain you control, used only for bot addresses.</div></div>
    <div class="field"><label class="lbl">Incoming mail webhook</label><input readonly value="${esc(a.inbound_url)}"><div class="hint">Header <code>X-Inbound-Secret: ${esc(a.inbound_secret)}</code></div></div></div>
    <details><summary>How to receive mail (free with Cloudflare)</summary>
      <ol class="small" style="margin:0;padding-left:18px">
        <li><span>Add the domain to Cloudflare → <b>Email → Email Routing</b> → enable it (it adds the MX records).</span></li>
        <li><span>Create an <b>Email Worker</b> that forwards each message to the webhook above with the secret header (copy-paste code in the README).</span></li>
        <li><span>Routing rules → <b>Catch-all</b> → Send to Worker.</span></li>
      </ol></details>
    <div class="divider"></div>
    <label class="lbl">Sending from bot addresses (SMTP for the domain — e.g. Resend, Mailgun, Brevo, SES)</label>
    <div class="grid2"><div class="field"><label class="lbl small">SMTP server</label><input data-admin="bot_smtp_host" value="${esc(a.bot_smtp_host)}" placeholder="smtp.resend.com"></div><div class="field"><label class="lbl small">Port</label><input data-admin="bot_smtp_port" value="${esc(a.bot_smtp_port)}" placeholder="587"></div></div>
    <div class="grid2"><div class="field"><label class="lbl small">Username</label><input data-admin="bot_smtp_user" value="${esc(a.bot_smtp_user)}"></div><div class="field"><label class="lbl small">Password / API key</label><input type="password" data-admin="bot_smtp_pass" value="${esc(a.bot_smtp_pass)}" autocomplete="new-password"></div></div>
    <button class="btn sm" data-act="saveAdmin" data-busy="Saving…">Save</button>`;
  $('#aUsers').innerHTML = `<div class="tablewrap"><table><tr><th>User</th><th>WhatsApp</th><th>Joined</th><th></th></tr>${s.userList.map((u) => `
    <tr><td><b>${esc(u.name || '—')}</b> ${u.is_admin ? '<span class="tag">admin</span>' : ''}<div class="small faint">${esc(u.email)}</div></td>
    <td>${u.wa === 'open' ? pill('ok', '+' + (u.phone || '')) : `<span class="small muted">${esc(u.wa)}</span>`}</td>
    <td class="small">${new Date(u.created_at * 1000).toLocaleDateString()}</td>
    <td><div class="row" style="justify-content:flex-end">
      ${u.wa === 'open' ? `<button class="btn ghost sm" data-act="uDisc" data-id="${u.id}">Unlink</button>` : ''}
      <button class="btn ghost sm" data-act="uPw" data-id="${u.id}">Reset password</button>
      ${u.id !== S.me.user.id ? `<button class="btn ghost sm" data-act="uAdmin" data-id="${u.id}" data-v="${u.is_admin ? 0 : 1}">${u.is_admin ? 'Remove admin' : 'Make admin'}</button><button class="btn danger sm" data-act="uDel" data-id="${u.id}" data-email="${esc(u.email)}">Delete</button>` : ''}
    </div></td></tr>`).join('')}</table></div>`;
}

window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
boot();
})();
