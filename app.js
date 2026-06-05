'use strict';

// Read-only dashboard. Data is published to ./data/*.json by the deploy workflow;
// the page just fetches and renders it. No tokens, no writes.

const STATE = { portfolios: {}, accounts: null };
const BOOK_LABELS = { stock: 'Stock', options: 'Options', watchlist: 'Watchlist' };
const AUTO_REBUILT = new Set(['options', 'watchlist']); // rebuilt by the weekly review

// ---------- load ----------
async function loadAll() {
  const [portfolios, accounts] = await Promise.all([
    fetchJSON('./data/portfolios.json', {}),
    fetchJSON('./data/accounts.json', null),
  ]);
  STATE.portfolios = normalizePortfolios(portfolios);
  STATE.accounts = accounts;

  const stamp = (accounts && accounts.generated_at)
    ? 'Accounts as of ' + fmtTime(accounts.generated_at)
    : 'Loaded ' + new Date().toLocaleString();
  document.getElementById('last-updated').textContent = stamp;

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

// ---------- portfolios (read-only) ----------
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
    const chips = tickers.map(t => `<span class="ticker-chip">${escapeHtml(t)}</span>`).join('');
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

// ---------- accounts ----------
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

loadAll();
