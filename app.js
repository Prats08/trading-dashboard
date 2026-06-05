'use strict';

// ---------- config ----------
const DEFAULT_REPO = 'Prats08/yoda-trading-master';
const PORTFOLIOS_PATH = 'memory/portfolios.json';
const LS_TOKEN = 'tm_gh_token';
const LS_REPO = 'tm_gh_repo';
const SYMBOL_RE = /^[A-Z][A-Z.\-]{0,7}$/;            // mirrors scripts/serve_dashboard.py
const EDITABLE_BOOKS = ['stock', 'options', 'watchlist'];
const AUTO_REBUILT = new Set(['options', 'watchlist']); // rebuilt by the weekly review
const BOOK_LABELS = { stock: 'Stock', options: 'Options', watchlist: 'Watchlist' };

const STATE = {
  portfolios: {},   // { book: { tickers: [...] } }
  accounts: null,   // accounts.json
  sha: null,        // blob SHA of portfolios.json (for Contents API writes)
};

// ---------- token / connection ----------
function getToken() { return localStorage.getItem(LS_TOKEN) || ''; }
function getRepo() { return localStorage.getItem(LS_REPO) || DEFAULT_REPO; }
function isConnected() { return !!getToken(); }

function renderConnection() {
  const dot = document.getElementById('conn-dot');
  const label = document.getElementById('conn-label');
  if (isConnected()) {
    dot.classList.remove('dot-off');
    label.textContent = 'Editing enabled';
    document.getElementById('conn-status').title = `Editing ${getRepo()}`;
  } else {
    dot.classList.add('dot-off');
    label.textContent = 'Read-only';
    document.getElementById('conn-status').title = 'Connect a GitHub token to edit';
  }
}

function openConnect() {
  document.getElementById('repo-input').value = getRepo();
  document.getElementById('token-input').value = '';
  document.getElementById('connect-msg').textContent = '';
  document.getElementById('connect-panel').hidden = false;
}
function closeConnect() { document.getElementById('connect-panel').hidden = true; }

async function saveToken() {
  const repo = (document.getElementById('repo-input').value || DEFAULT_REPO).trim().replace(/^\/+|\/+$/g, '');
  const token = (document.getElementById('token-input').value || '').trim();
  const msg = document.getElementById('connect-msg');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { msg.textContent = 'Repo must be owner/repo.'; return; }
  if (!token) { msg.textContent = 'Paste a token.'; return; }
  msg.textContent = 'Verifying…';
  // Validate by reading portfolios.json — confirms token + repo + Contents access.
  const res = await ghGetPortfolios(repo, token);
  if (!res.ok) {
    msg.textContent = res.error || 'Could not verify token.';
    return;
  }
  localStorage.setItem(LS_TOKEN, token);
  localStorage.setItem(LS_REPO, repo);
  STATE.portfolios = normalizePortfolios(res.json);
  STATE.sha = res.sha;
  renderConnection();
  renderPortfolios();
  closeConnect();
}

function clearToken() {
  localStorage.removeItem(LS_TOKEN);
  renderConnection();
  document.getElementById('connect-msg').textContent = 'Disconnected.';
}

// ---------- GitHub Contents API ----------
function ghHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// GET memory/portfolios.json → { ok, json, sha } (or { ok:false, error })
async function ghGetPortfolios(repo, token) {
  const url = `https://api.github.com/repos/${repo}/contents/${PORTFOLIOS_PATH}`;
  let r;
  try {
    r = await fetch(url + '?ts=' + Date.now(), { headers: ghHeaders(token), cache: 'no-store' });
  } catch (e) {
    return { ok: false, error: 'Network error reaching GitHub.' };
  }
  if (r.status === 401) return { ok: false, error: 'Bad token (401). Check the token and its Contents permission.' };
  if (r.status === 403) return { ok: false, error: 'Forbidden (403). Token lacks Contents access to this repo.' };
  if (r.status === 404) return { ok: false, error: 'Not found (404). Check the repo name and that portfolios.json exists.' };
  if (!r.ok) return { ok: false, error: `GitHub error ${r.status}.` };
  const data = await r.json();
  let json;
  try { json = JSON.parse(b64DecodeUtf8(data.content || '')); }
  catch (e) { return { ok: false, error: 'portfolios.json is not valid JSON.' }; }
  return { ok: true, json, sha: data.sha };
}

// PUT memory/portfolios.json with a full new object → { ok, sha } (or error)
async function ghPutPortfolios(repo, token, obj, sha, message) {
  const url = `https://api.github.com/repos/${repo}/contents/${PORTFOLIOS_PATH}`;
  const body = {
    message,
    content: b64EncodeUtf8(JSON.stringify(obj, null, 2)), // match memory._write_json (indent=2)
    sha,
  };
  let r;
  try {
    r = await fetch(url, { method: 'PUT', headers: ghHeaders(token), body: JSON.stringify(body) });
  } catch (e) {
    return { ok: false, error: 'Network error reaching GitHub.' };
  }
  if (r.status === 409) return { ok: false, conflict: true, error: 'Conflict (the file changed). Retrying…' };
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json()).message || ''; } catch (e) {}
    return { ok: false, error: `GitHub error ${r.status}${detail ? ': ' + detail : ''}.` };
  }
  const data = await r.json();
  return { ok: true, sha: data.content && data.content.sha };
}

// ---------- add / remove ----------
async function mutate(book, symbol, add) {
  const msg = document.getElementById('ticker-msg');
  const sym = (symbol || '').toUpperCase().trim();
  if (add && !SYMBOL_RE.test(sym)) {
    showMsg(msg, `Invalid symbol — 1-8 chars, A-Z, . or -`, true);
    return;
  }
  if (!isConnected()) {
    showMsg(msg, 'Connect a GitHub token to edit.', true);
    openConnect();
    return;
  }
  const repo = getRepo(), token = getToken();
  showMsg(msg, add ? `Adding ${sym}…` : `Removing ${sym}…`);

  const apply = async () => {
    const got = await ghGetPortfolios(repo, token);
    if (!got.ok) return got;
    const obj = got.json || {};
    const cur = (obj[book] && obj[book].tickers) ? obj[book].tickers.slice()
              : Array.isArray(obj[book]) ? obj[book].slice() : [];
    const set = new Set(cur.map(t => String(t).toUpperCase()));
    if (add) {
      if (set.has(sym)) return { ok: false, soft: true, error: `${sym} already in ${BOOK_LABELS[book]}.` };
      set.add(sym);
    } else {
      if (!set.has(sym)) return { ok: false, soft: true, error: `${sym} not in ${BOOK_LABELS[book]}.` };
      set.delete(sym);
    }
    obj[book] = { tickers: Array.from(set).sort() };  // mirror save_portfolio: sorted+deduped
    const verb = add ? 'add' : 'remove';
    const put = await ghPutPortfolios(repo, token, obj, got.sha,
      `web: ${verb} ${sym} ${add ? 'to' : 'from'} ${book}`);
    if (put.ok) { STATE.portfolios = normalizePortfolios(obj); STATE.sha = put.sha; }
    return put;
  };

  let res = await apply();
  if (res && res.conflict) res = await apply(); // retry once on SHA conflict
  if (res.ok) {
    showMsg(msg, add ? `Added ${sym} to ${BOOK_LABELS[book]}` : `Removed ${sym} from ${BOOK_LABELS[book]}`);
    document.getElementById('ticker-input').value = '';
    renderPortfolios();
  } else {
    showMsg(msg, res.error || 'Failed.', !res.soft);
  }
}

// ---------- load + render ----------
async function loadAll() {
  const accounts = await fetchJSON('./data/accounts.json', null);
  STATE.accounts = accounts;

  // Portfolios: canonical via API when connected (also grabs the SHA), else the
  // public baked copy that the Pages deploy publishes.
  if (isConnected()) {
    const got = await ghGetPortfolios(getRepo(), getToken());
    if (got.ok) { STATE.portfolios = normalizePortfolios(got.json); STATE.sha = got.sha; }
    else { STATE.portfolios = normalizePortfolios(await fetchJSON('./data/portfolios.json', {})); }
  } else {
    STATE.portfolios = normalizePortfolios(await fetchJSON('./data/portfolios.json', {}));
  }

  const stamp = (accounts && accounts.generated_at)
    ? 'Accounts as of ' + fmtTime(accounts.generated_at)
    : 'Loaded ' + new Date().toLocaleString();
  document.getElementById('last-updated').textContent = stamp;

  renderConnection();
  renderPortfolios();
  renderAccounts();
}

async function fetchJSON(url, fallback) {
  try {
    const r = await fetch(url + '?ts=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return fallback;
    return await r.json();
  } catch (e) { return fallback; }
}

function normalizePortfolios(raw) {
  const out = {};
  for (const [name, v] of Object.entries(raw || {})) {
    if (Array.isArray(v)) out[name] = { tickers: v };
    else out[name] = { tickers: (v && v.tickers) || [] };
  }
  return out;
}

function renderPortfolios() {
  const el = document.getElementById('portfolios-list');
  const order = ['stock', 'options', 'watchlist'];
  const names = order.filter(n => STATE.portfolios[n])
    .concat(Object.keys(STATE.portfolios).filter(n => !order.includes(n)));

  if (!names.length) {
    el.innerHTML = `<div class="empty-state">No portfolios found in <code>portfolios.json</code>.</div>`;
    return;
  }
  el.innerHTML = names.map(name => {
    const tickers = (STATE.portfolios[name].tickers || []);
    const editable = EDITABLE_BOOKS.includes(name);
    const chips = tickers.map(t => `
      <span class="ticker-chip">${escapeHtml(t)}${editable
        ? `<button class="ticker-x" data-book="${name}" data-remove="${escapeHtml(t)}" title="Remove ${escapeHtml(t)}">&times;</button>`
        : ''}</span>`).join('');
    const autoBadge = AUTO_REBUILT.has(name)
      ? `<span class="badge-auto" title="Rebuilt by the Saturday weekly review">auto-rebuilt weekly</span>` : '';
    return `
      <div class="portfolio-card">
        <div class="portfolio-card-head">
          <div>
            <div class="portfolio-name">${escapeHtml(BOOK_LABELS[name] || name)}
              <span class="muted-small">(${tickers.length})</span></div>
          </div>
          ${autoBadge}
        </div>
        <div class="portfolio-tickers">${chips || '<span class="muted-small">No tickers yet.</span>'}</div>
      </div>`;
  }).join('');
}

function renderAccounts() {
  const summaryEl = document.getElementById('accounts-summary');
  const listEl = document.getElementById('accounts-list');
  const acc = STATE.accounts;
  if (!acc || !acc.funds || !Object.keys(acc.funds).length) {
    summaryEl.innerHTML = '';
    listEl.innerHTML = `<div class="empty-state">No account snapshot yet. Run the
      <code>account_snapshot</code> routine to publish <code>memory/accounts.json</code>.</div>`;
    return;
  }
  const funds = acc.funds;

  // Which books share an Alpaca account (so we can flag + de-dupe equity totals).
  const byAccount = {};
  for (const [id, f] of Object.entries(funds)) {
    (byAccount[f.alpaca_account] = byAccount[f.alpaca_account] || []).push(id);
  }

  // Summary across UNIQUE accounts (conservative + options share one — don't double-count).
  let totalEq = 0, totalDay = 0; const seen = new Set();
  for (const f of Object.values(funds)) {
    if (!f.account || seen.has(f.alpaca_account)) continue;
    seen.add(f.alpaca_account);
    totalEq += num(f.account.equity);
    totalDay += num(f.account.equity) - num(f.account.last_equity);
  }
  const mkt = acc.market || {};
  const mktBadge = mkt.is_open ? '<span class="badge on">market open</span>' : '<span class="badge off">market closed</span>';
  summaryEl.innerHTML = `
    <div class="summary-tile"><div class="label">Total equity</div>
      <div class="value">${fmtMoney(totalEq)}</div>
      <div class="muted-small">${seen.size} Alpaca account${seen.size === 1 ? '' : 's'}</div></div>
    <div class="summary-tile"><div class="label">Day P&amp;L</div>
      <div class="value ${signClass(totalDay)}">${fmtSigned(totalDay)}</div>
      <div class="muted-small">${mktBadge}</div></div>`;

  const order = ['conservative', 'balanced', 'aggressive', 'options'];
  const ids = order.filter(n => funds[n]).concat(Object.keys(funds).filter(n => !order.includes(n)));
  listEl.innerHTML = ids.map(id => renderAccountCard(id, funds[id], byAccount)).join('');
}

function renderAccountCard(id, f, byAccount) {
  const shareIds = (byAccount[f.alpaca_account] || []).filter(x => x !== id);
  const nameOf = x => (STATE.accounts && STATE.accounts.funds[x] && STATE.accounts.funds[x].name) || BOOK_LABELS[x] || x;
  const shareBadge = shareIds.length
    ? `<span class="badge shared" title="Same Alpaca account as ${escapeHtml(shareIds.map(nameOf).join(', '))}">shares account · ${escapeHtml(shareIds.map(nameOf).join(', '))}</span>` : '';
  const kindBadge = `<span class="badge">${f.kind === 'options' ? 'options' : 'equity'}</span>`;
  const enBadge = f.enabled ? '<span class="badge on">enabled</span>' : '<span class="badge off">disabled</span>';
  const head = `<div class="account-head"><span class="account-name">${escapeHtml(f.name || id)}</span>
    ${kindBadge}${enBadge}${shareBadge}</div>`;

  if (f.error) {
    return `<div class="account-card">${head}<div class="account-error">⚠ ${escapeHtml(f.error)}</div></div>`;
  }
  const a = f.account || {};
  const day = num(a.equity) - num(a.last_equity);
  const dayPct = num(a.last_equity) ? day / num(a.last_equity) : null;
  const kpis = `
    <div class="kpis">
      <div class="kpi"><div class="k-label">Equity</div><div class="k-value">${fmtMoney(a.equity)}</div></div>
      <div class="kpi"><div class="k-label">Day P&amp;L</div>
        <div class="k-value ${signClass(day)}">${fmtSigned(day)}${dayPct != null ? ` <span class="muted-small">(${fmtPct(dayPct)})</span>` : ''}</div></div>
      <div class="kpi"><div class="k-label">Cash</div><div class="k-value">${fmtMoney(a.cash)}</div></div>
      <div class="kpi"><div class="k-label">Buying power</div><div class="k-value">${fmtMoney(a.buying_power)}</div></div>
    </div>`;

  const positions = f.positions || [];
  const posTable = positions.length ? `
    <div class="table-label">Positions (${positions.length})</div>
    <table><thead><tr>
      <th>Symbol</th><th>Qty</th><th>Avg</th><th>Price</th><th>Mkt value</th><th>Unreal P&amp;L</th><th>%</th>
    </tr></thead><tbody>
    ${positions.map(p => `<tr>
      <td class="sym">${escapeHtml(p.symbol || '')}</td>
      <td>${fmtNum(p.qty)}</td>
      <td>${fmtMoney(p.avg_entry_price)}</td>
      <td>${fmtMoney(p.current_price)}</td>
      <td>${fmtMoney(p.market_value)}</td>
      <td class="${signClass(p.unrealized_pl)}">${fmtSigned(p.unrealized_pl)}</td>
      <td class="${signClass(p.unrealized_plpc)}">${p.unrealized_plpc != null ? fmtPct(p.unrealized_plpc) : '—'}</td>
    </tr>`).join('')}
    </tbody></table>` : '<div class="muted-small">No open positions.</div>';

  const orders = f.open_orders || [];
  const ordTable = orders.length ? `
    <div class="table-label">Working orders (${orders.length})</div>
    <table><thead><tr>
      <th>Symbol</th><th>Side</th><th>Qty</th><th>Limit</th><th>Status</th>
    </tr></thead><tbody>
    ${orders.map(o => `<tr>
      <td class="sym">${escapeHtml(o.symbol || '')}</td>
      <td>${escapeHtml(String(o.side || ''))}</td>
      <td>${fmtNum(o.qty)}</td>
      <td>${o.limit_price != null ? fmtMoney(o.limit_price) : 'mkt'}</td>
      <td>${escapeHtml(String(o.status || ''))}</td>
    </tr>`).join('')}
    </tbody></table>` : '';

  return `<div class="account-card">${head}${kpis}${posTable}${ordTable}</div>`;
}

// ---------- helpers ----------
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }
function fmtMoney(n) {
  if (n == null || n === '' || !Number.isFinite(Number(n))) return '—';
  return '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtSigned(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  return (v > 0 ? '+' : v < 0 ? '−' : '') + '$' +
    Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(frac) {
  if (frac == null || !Number.isFinite(Number(frac))) return '—';
  const v = Number(frac) * 100;
  return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2) + '%';
}
function fmtNum(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 4 });
}
function fmtTime(iso) { try { return new Date(iso).toLocaleString(); } catch (e) { return iso; } }
function signClass(n) { const v = Number(n); return v > 0 ? 'pos' : v < 0 ? 'neg' : ''; }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function showMsg(el, text, isError = false) {
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? 'var(--neg)' : 'var(--text-muted)';
  setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 4500);
}
// UTF-8-safe base64 (GitHub Contents API content is base64)
function b64EncodeUtf8(str) { return btoa(unescape(encodeURIComponent(str))); }
function b64DecodeUtf8(b64) { return decodeURIComponent(escape(atob((b64 || '').replace(/\n/g, '')))); }

// ---------- wiring ----------
document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById(t.dataset.tab).classList.add('active');
  });
});
document.getElementById('refresh-btn').addEventListener('click', loadAll);
document.getElementById('connect-btn').addEventListener('click', openConnect);
document.getElementById('connect-cancel').addEventListener('click', closeConnect);
document.getElementById('token-save').addEventListener('click', saveToken);
document.getElementById('token-clear').addEventListener('click', clearToken);

const tickerInput = document.getElementById('ticker-input');
const bookSelect = document.getElementById('book-select');
document.getElementById('add-ticker-btn').addEventListener('click', () => mutate(bookSelect.value, tickerInput.value, true));
tickerInput.addEventListener('keydown', e => { if (e.key === 'Enter') mutate(bookSelect.value, tickerInput.value, true); });
document.addEventListener('click', e => {
  const btn = e.target.closest('.ticker-x');
  if (!btn) return;
  const sym = btn.getAttribute('data-remove');
  const book = btn.getAttribute('data-book');
  if (sym && confirm(`Remove ${sym} from ${BOOK_LABELS[book] || book}?`)) mutate(book, sym, false);
});

renderConnection();
loadAll();
