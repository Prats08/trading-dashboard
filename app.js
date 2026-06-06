'use strict';

// Read-only dashboard. Data is published to ./data/*.json by the deploy workflow.
// Portfolio tables come from portfolio_table.json (built by daily_report.build()
// + enrichment); accounts from accounts.json. No tokens, no writes.

const STATE = { table: null, accounts: null };
const BOOK_LABELS = { stock: 'Stock', options: 'Options', watchlist: 'Watchlist' };
let equityChart = null;  // Chart.js instance for the Accounts equity curve

// Per-book UI state (filter text, action filter, sort, expanded rows).
const UI = {
  stock:     { q: '', action: '', sort: { key: 'conviction', dir: -1 }, expanded: new Set() },
  options:   { q: '', action: '', sort: { key: 'conviction', dir: -1 }, expanded: new Set() },
  watchlist: { q: '', action: '', sort: { key: 'ticker', dir: 1 }, expanded: new Set() },
};

// ---------- load ----------
async function loadAll() {
  const [table, accounts] = await Promise.all([
    fetchJSON('./data/portfolio_table.json', null),
    fetchJSON('./data/accounts.json', null),
  ]);
  STATE.table = table;
  STATE.accounts = accounts;

  const ts = (table && table.generated_at) || (accounts && accounts.generated_at);
  document.getElementById('last-updated').textContent =
    ts ? 'Updated ' + fmtTime(ts) : 'Loaded ' + new Date().toLocaleString();

  ['stock', 'options', 'watchlist'].forEach(book => { renderToolbar(book); renderBookTable(book); });
  renderAccounts();
}

async function fetchJSON(url, fallback) {
  try {
    const r = await fetch(url + '?ts=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return fallback;
    return await r.json();
  } catch (e) { return fallback; }
}

// ---------- column definitions ----------
const STOCK_COLUMNS = [
  { key: 'ticker', label: 'Ticker', sort: 'ticker', cell: r => tickerCell(r) },
  { key: 'action', label: 'Action', sort: 'action', cell: r => actionBadge(r.action) },
  { key: 'conviction', label: 'Conv', sort: 'conviction', num: true, cell: r => convCell(r.conviction) },
  { key: 'goal', label: 'Goal', sort: 'goal', cell: r => goalPill(r.goal) },
  { key: 'current_price', label: 'Price', sort: 'current_price', num: true, cell: r => fmtMoney(r.current_price) },
  { key: 'pt30', label: '30d', sort: r => upside(r.price_target_30d, r.current_price), num: true, cell: r => targetCell(r.price_target_30d, r.current_price) },
  { key: 'pt90', label: '90d', sort: r => upside(r.price_target_90d, r.current_price), num: true, cell: r => targetCell(r.price_target_90d, r.current_price) },
  { key: 'chart', label: 'Chart', sort: 'chart_target_llm', num: true, cell: r => fmtMoney(r.chart_target_llm) },
  { key: 'stop_loss', label: 'Stop', sort: 'stop_loss', num: true, cell: r => fmtMoney(r.stop_loss) },
  { key: 'momentum_score', label: 'Mom', sort: 'momentum_score', num: true, cell: r => momCell(r.momentum_score) },
  { key: 'earn', label: 'Earnings', sort: 'next_earnings_days', num: true, cell: r => earningsCell(r) },
  { key: 'as_of', label: 'As of', sort: 'as_of', cell: r => `<span class="muted-small">${r.as_of || '—'}</span>` },
];

const OPTIONS_COLUMNS = [
  { key: 'ticker', label: 'Ticker', sort: 'ticker', cell: r => tickerCell(r) },
  { key: 'spot', label: 'Spot', sort: r => r.current_price ?? r.underlying_price, num: true, cell: r => fmtMoney(r.current_price ?? r.underlying_price) },
  { key: 'structure', label: 'Structure', sort: 'structure', cell: r => structureCell(r.structure) },
  { key: 'direction', label: 'Dir', sort: 'direction', cell: r => dirCell(r.direction) },
  { key: 'conviction', label: 'Conv', sort: 'conviction', num: true, cell: r => convCell(r.conviction) },
  { key: 'tier', label: 'Tier', sort: 'tier', cell: r => r.tier ? `<span class="pill">${escapeHtml(r.tier)}</span>` : '—' },
  { key: 'dte', label: 'DTE', sort: 'dte', num: true, cell: r => r.dte != null ? r.dte : '—' },
  { key: 'net_premium', label: 'Debit', sort: 'net_premium', num: true, cell: r => fmtMoney(r.net_premium) },
  { key: 'max_loss', label: 'Max loss', sort: 'max_loss', num: true, cell: r => fmtMoney(r.max_loss) },
  { key: 'breakeven', label: 'Breakeven', cell: r => beCell(r.breakeven) },
  { key: 'traded_today', label: 'Traded', sort: 'traded_today', cell: r => tradedCell(r) },
  { key: 'as_of', label: 'As of', sort: 'as_of', cell: r => `<span class="muted-small">${r.as_of || '—'}</span>` },
];

function columnsFor(book) { return book === 'options' ? OPTIONS_COLUMNS : STOCK_COLUMNS; }

// ---------- toolbar ----------
function renderToolbar(book) {
  const ui = UI[book];
  const el = document.getElementById('toolbar-' + book);
  const showAction = book !== 'options';
  const chips = showAction
    ? `<div class="chips">${['', 'BUY', 'SELL', 'HOLD'].map(a =>
        `<button class="chip${ui.action === a ? ' on' : ''}" data-action="${a}">${a || 'All'}</button>`).join('')}</div>`
    : '';
  el.innerHTML = `
    <input class="search" id="search-${book}" placeholder="Filter ticker or sector…"
           value="${escapeHtml(ui.q)}" autocomplete="off" spellcheck="false" />
    ${chips}
    <span class="muted-small count" id="count-${book}"></span>`;

  const inp = document.getElementById('search-' + book);
  inp.addEventListener('input', () => { ui.q = inp.value; renderBookTable(book); });
  el.querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => {
    ui.action = b.dataset.action; renderToolbar(book); renderBookTable(book);
  }));
}

// ---------- table ----------
function renderBookTable(book) {
  const cols = columnsFor(book);
  const ui = UI[book];
  let rows = (STATE.table && STATE.table[book]) || [];
  const total = rows.length;

  const q = ui.q.trim().toUpperCase();
  if (q) rows = rows.filter(r =>
    (r.ticker || '').toUpperCase().includes(q) || (r.sector || '').toUpperCase().includes(q));
  if (book !== 'options' && ui.action)
    rows = rows.filter(r => (r.action || '').toUpperCase() === ui.action);
  rows = rows.slice().sort((a, b) => cmpRows(a, b, cols, ui.sort));

  const head = cols.map(c => {
    const active = ui.sort.key === c.key;
    const sortable = c.sort !== undefined;
    const arrow = active ? `<span class="arrow">${ui.sort.dir < 0 ? '▼' : '▲'}</span>` : '';
    return `<th class="${c.num ? 'num' : ''}${sortable ? ' sortable' : ''}${active ? ' active' : ''}"
                data-col="${c.key}">${c.label}${arrow}</th>`;
  }).join('');

  const body = rows.map(r => {
    const tds = cols.map(c => `<td class="${c.num ? 'num' : ''}">${c.cell(r)}</td>`).join('');
    const open = ui.expanded.has(r.ticker);
    const main = `<tr class="row${open ? ' open' : ''}" data-tk="${escapeHtml(r.ticker)}">
        <td class="caret">${open ? '▾' : '▸'}</td>${tds}</tr>`;
    const detail = open
      ? `<tr class="detail"><td colspan="${cols.length + 1}">${book === 'options' ? optionsDetail(r) : stockDetail(r)}</td></tr>`
      : '';
    return main + detail;
  }).join('');

  document.getElementById('table-' + book).innerHTML = rows.length
    ? `<table class="data-table"><thead><tr><th class="caret"></th>${head}</tr></thead><tbody>${body}</tbody></table>`
    : `<div class="empty-state">No matching rows.</div>`;

  const cnt = document.getElementById('count-' + book);
  if (cnt) cnt.textContent = q || (book !== 'options' && ui.action) ? `${rows.length} / ${total}` : `${total} tickers`;
}

function cmpRows(a, b, cols, sort) {
  const col = cols.find(c => c.key === sort.key);
  const acc = col && typeof col.sort === 'function' ? col.sort
            : (r => r[(col && typeof col.sort === 'string') ? col.sort : sort.key]);
  let av = acc(a), bv = acc(b);
  const an = av == null || av === '', bn = bv == null || bv === '';
  if (an && bn) return 0;
  if (an) return 1;           // nulls always last, regardless of direction
  if (bn) return -1;
  if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sort.dir;
  return String(av).localeCompare(String(bv)) * sort.dir;
}

// delegated: sort on header click, expand on row click
document.addEventListener('click', e => {
  const host = e.target.closest('[data-book]');
  if (!host) return;
  const book = host.dataset.book, ui = UI[book];
  const th = e.target.closest('th.sortable');
  if (th) {
    const key = th.dataset.col;
    if (ui.sort.key === key) ui.sort.dir = -ui.sort.dir;
    else ui.sort = { key, dir: th.classList.contains('num') ? -1 : 1 };
    renderBookTable(book);
    return;
  }
  const row = e.target.closest('tr.row');
  if (row) {
    const tk = row.dataset.tk;
    ui.expanded.has(tk) ? ui.expanded.delete(tk) : ui.expanded.add(tk);
    renderBookTable(book);
  }
});

// ---------- expandable detail ----------
function stockDetail(r) {
  const grid = `<div class="detail-grid">
    ${kv('Sector', [r.sector, r.industry].filter(Boolean).join(' · '))}
    ${kv('Beta', r.beta)}
    ${kv('MA alignment', (r.ma_alignment || '').replace(/_/g, ' '))}
    ${kv('Chart target (calc)', r.chart_target_calc != null ? fmtMoney(r.chart_target_calc) : '')}
    ${kv('Debate', r.debate_winner)}
    ${kv('Target horizon', r.price_target_horizon_days ? r.price_target_horizon_days + 'd' : '')}
    ${kv('Next earnings', r.next_earnings_days != null ? r.next_earnings_days + 'd' : '')}
    ${kv('Agreement', r.target_agreement && r.target_agreement.flag)}
  </div>`;
  const bullets = Array.isArray(r.bullets) && r.bullets.length
    ? `<ul class="bullets">${r.bullets.map(b => `<li>${escapeHtml(b)}</li>`).join('')}</ul>` : '';
  return `<div class="detail-body">${grid}${bullets}
    ${block('Summary', r.summary)}${block('Chart', r.chart_analysis)}
    ${block('Target reasoning', r.target_reasoning)}${block('News', r.news_summary_brief)}</div>`;
}

function optionsDetail(r) {
  const legs = Array.isArray(r.legs) && r.legs.length ? `
    <table class="legs"><thead><tr><th>Action</th><th>Type</th><th class="num">Strike</th><th>Expiry</th><th class="num">Premium</th></tr></thead>
    <tbody>${r.legs.map(l => `<tr>
      <td>${escapeHtml(l.action || '')}</td><td>${escapeHtml(l.type || '')}</td>
      <td class="num">${l.strike != null ? fmtMoney(l.strike) : '—'}</td>
      <td>${escapeHtml(l.expiry || '')}</td>
      <td class="num">${l.premium != null ? fmtMoney(l.premium) : '—'}</td></tr>`).join('')}</tbody></table>` : '';
  const grid = `<div class="detail-grid">
    ${kv('Sector', [r.sector, r.industry].filter(Boolean).join(' · '))}
    ${kv('Max profit', typeof r.max_profit === 'number' ? fmtMoney(r.max_profit) : r.max_profit)}
    ${kv('Max loss', r.max_loss != null ? fmtMoney(r.max_loss) : '')}
    ${kv('Breakeven', (r.breakeven || []).map(x => fmtMoney(x)).join(', '))}
    ${kv('IV (ATM)', r.iv_atm != null ? (r.iv_atm * 100).toFixed(1) + '%' : '')}
    ${kv('IV rank', r.iv_rank_hint)}
    ${kv('Horizon', r.horizon_bucket)}
    ${kv('PM alignment', r.alignment_with_pm_target)}
  </div>`;
  return `<div class="detail-body">${grid}${legs}
    ${block('Thesis', r.thesis)}${block('Risk', r.risk_note)}${block('Manager note', r.manager_note)}</div>`;
}

function kv(k, v) {
  return (v != null && v !== '') ? `<div class="kv"><span class="dk">${k}</span><span class="dv">${escapeHtml(String(v))}</span></div>` : '';
}
function block(label, v) {
  return v ? `<div class="detail-block"><div class="dk">${label}</div><div class="dv">${escapeHtml(v)}</div></div>` : '';
}

// ---------- cell helpers ----------
function tickerCell(r) {
  return `<div class="tk"><span class="tk-sym">${escapeHtml(r.ticker)}</span>${
    r.sector ? `<span class="tk-sec">${escapeHtml(r.sector)}</span>` : ''}</div>`;
}
function actionBadge(a) {
  const A = (a || '').toUpperCase();
  return A ? `<span class="act ${A}">${A}</span>` : '<span class="muted-small">—</span>';
}
function convCell(c) {
  if (c == null) return '<span class="muted-small">—</span>';
  const pct = Math.max(0, Math.min(10, c)) * 10;
  return `<span class="conv" title="${c}/10"><span class="conv-fill" style="width:${pct}%"></span><span class="conv-n">${c}</span></span>`;
}
function goalPill(g) { return g ? `<span class="pill goal">${escapeHtml(g.replace(/_/g, ' '))}</span>` : '<span class="muted-small">—</span>'; }
function structureCell(s) { return s ? `<span class="pill struct">${escapeHtml(s.replace(/_/g, ' '))}</span>` : '<span class="muted-small">—</span>'; }
function dirCell(d) {
  if (!d) return '<span class="muted-small">—</span>';
  const cls = d === 'bullish' ? 'pos' : d === 'bearish' ? 'neg' : '';
  return `<span class="${cls}">${escapeHtml(d)}</span>`;
}
function upside(t, p) { return (t != null && p) ? (t - p) / p : null; }
function targetCell(t, p) {
  if (t == null) return '<span class="muted-small">—</span>';
  const u = upside(t, p), cls = u == null ? '' : u > 0 ? 'pos' : u < 0 ? 'neg' : '';
  return `<span class="${cls}">${fmtMoney(t)}${u != null ? ` <span class="up">${fmtPct(u)}</span>` : ''}</span>`;
}
function momCell(m) {
  if (m == null) return '<span class="muted-small">—</span>';
  const tone = m >= 75 ? 'mom-strong' : m >= 50 ? 'mom-mid' : m >= 25 ? 'mom-soft' : 'mom-weak';
  return `<span class="mom ${tone}">${m}</span>`;
}
function earningsCell(r) {
  const days = r.next_earnings_days, w = r.earnings_window;
  if (days == null || days < 0 || w === 'distant' || w === 'post-earnings') return '<span class="muted-small">—</span>';
  const tone = w === 'imminent' ? 'eps-imminent' : w === 'near' ? 'eps-near' : 'eps-approaching';
  return `<span class="pill ${tone}">EPS ${days}d</span>`;
}
function tradedCell(r) {
  return r.traded_today ? `<span class="pos">✓ ${escapeHtml(r.trade_status || 'yes')}</span>` : '<span class="muted-small">—</span>';
}
function beCell(be) { return Array.isArray(be) && be.length ? be.map(x => fmtMoney(x)).join(', ') : '<span class="muted-small">—</span>'; }

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
  const byAccount = {};
  for (const [id, f] of Object.entries(funds)) (byAccount[f.alpaca_account] = byAccount[f.alpaca_account] || []).push(id);

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

  renderEquityChart(acc.equity_history);
}

// Each fund's equity over time vs SPY (rebased to the same starting capital).
function renderEquityChart(hist) {
  const card = document.getElementById('equity-chart-card');
  const cap = document.getElementById('equity-chart-caption');
  const canvas = document.getElementById('equity-chart');
  if (!card || !canvas) return;
  if (equityChart) { equityChart.destroy(); equityChart = null; }

  const byFund = hist && hist.by_fund ? hist.by_fund : null;
  if (typeof Chart === 'undefined' || !byFund || Object.keys(byFund).length === 0) {
    card.hidden = true; return;
  }

  const fundIds = Object.keys(byFund);
  const n = fundIds[0] ? byFund[fundIds[0]].length : 0;
  if (n < 2) { card.hidden = true; return; }

  // Find first funded value across all funds (sum them for a total base).
  let baseIdx = -1;
  for (let i = 0; i < n; i++) {
    const vals = fundIds.map(fid => byFund[fid][i]);
    if (vals.every(v => v > 0)) { baseIdx = i; break; }
  }
  if (baseIdx < 0) { card.hidden = true; return; }
  const base = fundIds.map(fid => byFund[fid][baseIdx]).reduce((a, b) => a + b, 0);
  if (!base) { card.hidden = true; return; }
  card.hidden = false;

  // Fund colors: balanced cyan, aggressive red, options amber/gold
  const fundColors = {
    balanced:     { borderColor: '#22d3ee', bgColor: 'rgba(34,211,238,0.15)' },
    aggressive:   { borderColor: '#ef4444', bgColor: 'rgba(239,68,68,0.15)' },
    options:      { borderColor: '#f59e0b', bgColor: 'rgba(245,158,11,0.15)' },
  };

  const datasets = fundIds.map(fid => {
    const colors = fundColors[fid] || { borderColor: '#808080', bgColor: 'rgba(128,128,128,0.1)' };
    return {
      label: fid.charAt(0).toUpperCase() + fid.slice(1), data: byFund[fid],
      borderColor: colors.borderColor, backgroundColor: colors.bgColor,
      fill: true, tension: 0.25, pointRadius: 0, borderWidth: 1.5, order: 10,
    };
  });

  let benchRet = null;
  const bench = hist.benchmark;
  if (bench && Array.isArray(bench.close) && bench.close.length === n && bench.close[baseIdx]) {
    const c0 = bench.close[baseIdx];
    const spyStart = 100_000;  // rebased to $100k baseline per fund
    datasets.push({
      label: (bench.symbol || 'SPY') + ' (same start)',
      data: bench.close.map(c => spyStart * c / c0),  // growth of $100k in SPY
      borderColor: '#a1a1aa', borderDash: [5, 4],
      fill: false, tension: 0.25, pointRadius: 0, borderWidth: 1.5, order: 5,
    });
    benchRet = bench.close[bench.close.length - 1] / c0 - 1;
  }

  // Total portfolio return (sum of funds / base)
  const portEnd = fundIds.map(fid => byFund[fid][n - 1]).reduce((a, b) => a + b, 0);
  const portRet = portEnd / base - 1;
  const parts = [`<span class="${signClass(portRet)}">Portfolio ${fmtPct(portRet)}</span>`];
  if (benchRet != null) {
    parts.push(`<span class="muted-small">SPY ${fmtPct(benchRet)}</span>`);
    const diff = portRet - benchRet;
    parts.push(`<span class="${signClass(diff)}">${diff >= 0 ? '+' : ''}${(diff * 100).toFixed(1)} pts vs SPY</span>`);
  }
  cap.innerHTML = parts.join(' &middot; ');

  equityChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels: hist.timestamps, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#a1a1aa', boxWidth: 12, usePointStyle: true } },
        tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${fmtMoneyPlain(ctx.parsed.y)}` } },
      },
      scales: {
        x: { ticks: { color: '#71717a', maxTicksLimit: 8, autoSkip: true }, grid: { color: 'rgba(63,63,70,0.35)' } },
        y: { ticks: { color: '#71717a', callback: v => fmtMoneyShort(v) }, grid: { color: 'rgba(63,63,70,0.35)' } },
      },
    },
  });
}

function renderAccountCard(id, f, byAccount) {
  const shareIds = (byAccount[f.alpaca_account] || []).filter(x => x !== id);
  const nameOf = x => (STATE.accounts && STATE.accounts.funds[x] && STATE.accounts.funds[x].name) || BOOK_LABELS[x] || x;
  const shareBadge = shareIds.length
    ? `<span class="badge shared" title="Same Alpaca account as ${escapeHtml(shareIds.map(nameOf).join(', '))}">shares account · ${escapeHtml(shareIds.map(nameOf).join(', '))}</span>` : '';
  const kindBadge = `<span class="badge">${f.kind === 'options' ? 'options' : 'equity'}</span>`;
  const enBadge = f.enabled ? '<span class="badge on">enabled</span>' : '<span class="badge off">disabled</span>';
  const head = `<div class="account-head"><span class="account-name">${escapeHtml(f.name || id)}</span>${kindBadge}${enBadge}${shareBadge}</div>`;

  if (f.error) return `<div class="account-card">${head}<div class="account-error">⚠ ${escapeHtml(f.error)}</div></div>`;
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
    <table class="data-table"><thead><tr>
      <th>Symbol</th><th class="num">Qty</th><th class="num">Avg</th><th class="num">Price</th><th class="num">Mkt value</th><th class="num">Unreal P&amp;L</th><th class="num">%</th>
    </tr></thead><tbody>
    ${positions.map(p => `<tr>
      <td class="sym">${escapeHtml(p.symbol || '')}</td>
      <td class="num">${fmtNum(p.qty)}</td><td class="num">${fmtMoney(p.avg_entry_price)}</td>
      <td class="num">${fmtMoney(p.current_price)}</td><td class="num">${fmtMoney(p.market_value)}</td>
      <td class="num ${signClass(p.unrealized_pl)}">${fmtSigned(p.unrealized_pl)}</td>
      <td class="num ${signClass(p.unrealized_plpc)}">${p.unrealized_plpc != null ? fmtPct(p.unrealized_plpc) : '—'}</td>
    </tr>`).join('')}</tbody></table>` : '<div class="muted-small">No open positions.</div>';

  const orders = f.open_orders || [];
  const ordTable = orders.length ? `
    <div class="table-label">Working orders (${orders.length})</div>
    <table class="data-table"><thead><tr><th>Symbol</th><th>Side</th><th class="num">Qty</th><th class="num">Limit</th><th>Status</th></tr></thead><tbody>
    ${orders.map(o => `<tr>
      <td class="sym">${escapeHtml(o.symbol || '')}</td><td>${escapeHtml(String(o.side || ''))}</td>
      <td class="num">${fmtNum(o.qty)}</td><td class="num">${o.limit_price != null ? fmtMoney(o.limit_price) : 'mkt'}</td>
      <td>${escapeHtml(String(o.status || ''))}</td></tr>`).join('')}</tbody></table>` : '';

  return `<div class="account-card">${head}${kpis}${posTable}${ordTable}</div>`;
}

// ---------- format helpers ----------
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }
function fmtMoney(n) {
  if (n == null || n === '' || !Number.isFinite(Number(n))) return '<span class="muted-small">—</span>';
  return '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtSigned(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  return (v > 0 ? '+' : v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
// Plain (non-HTML) money strings for chart tooltips/axes.
function fmtMoneyPlain(n) {
  if (!Number.isFinite(Number(n))) return '—';
  return '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function fmtMoneyShort(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (Math.abs(v) >= 1e3) return '$' + Math.round(v / 1e3) + 'k';
  return '$' + Math.round(v);
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
    // Chart.js can't measure a canvas whose panel was display:none at creation;
    // resize once the Accounts panel is actually visible.
    if (t.dataset.tab === 'accounts' && equityChart) equityChart.resize();
  });
});
document.getElementById('refresh-btn').addEventListener('click', loadAll);

loadAll();
