'use strict';

// Reports archive page. Reads ./data/reports.json (built by
// scripts/build_reports_manifest.py) and lists the last 30 days of reports with
// type filter + search, an inline PDF viewer and download. Gated by auth.js.

const RSTATE = { reports: [], type: '', q: '' };

async function fetchJSON(url, fallback) {
  try {
    const r = await fetch(url + '?ts=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return fallback;
    return await r.json();
  } catch (e) { return fallback; }
}

function typeBadge(t) {
  return t === 'weekly'
    ? '<span class="rtype weekly">Weekly review</span>'
    : '<span class="rtype daily">Daily report</span>';
}

function renderReports() {
  const list = document.getElementById('reports-list');
  const q = RSTATE.q.trim().toLowerCase();
  let rows = RSTATE.reports;
  if (RSTATE.type) rows = rows.filter(r => r.type === RSTATE.type);
  if (q) rows = rows.filter(r =>
    (r.title || '').toLowerCase().includes(q) || (r.date || '').includes(q));

  document.getElementById('reports-count').textContent =
    `${rows.length}${rows.length === RSTATE.reports.length ? '' : ' / ' + RSTATE.reports.length} report${rows.length === 1 ? '' : 's'}`;

  if (!RSTATE.reports.length) {
    list.innerHTML = `<div class="empty-state">No reports published yet. The daily report and
      weekly review routines write PDFs into <code>memory/daily_reports/</code>.</div>`;
    return;
  }
  if (!rows.length) { list.innerHTML = '<div class="empty-state">No matching reports.</div>'; return; }

  list.innerHTML = `<div class="report-cards">${rows.map(r => `
    <div class="report-card">
      <div class="report-main">
        ${typeBadge(r.type)}
        <div class="report-title">${esc(r.title)}</div>
        <div class="muted-small">${fmtDateLong(r.date)} · ${fmtBytes(r.size_bytes)}</div>
      </div>
      <div class="report-actions">
        <button class="btn-primary" data-view="${esc(r.file)}" data-title="${esc(r.title)}">View</button>
        <a class="btn-ghost" href="${esc(r.file)}" download>Download</a>
      </div>
    </div>`).join('')}</div>`;
}

function wireReports() {
  const search = document.getElementById('reports-search');
  search.addEventListener('input', () => { RSTATE.q = search.value; renderReports(); });

  document.getElementById('reports-chips').addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    RSTATE.type = chip.dataset.type;
    document.querySelectorAll('#reports-chips .chip').forEach(c => c.classList.toggle('on', c === chip));
    renderReports();
  });

  document.getElementById('reports-list').addEventListener('click', e => {
    const btn = e.target.closest('[data-view]');
    if (btn) openPdf(btn.dataset.view, btn.dataset.title);
  });
}

async function loadReports() {
  const manifest = await fetchJSON('./data/reports.json', { reports: [] });
  RSTATE.reports = (manifest && manifest.reports) || [];
  const upd = document.getElementById('reports-updated');
  if (upd && manifest && manifest.generated_at) upd.textContent = 'Updated ' + fmtDateLong(manifest.generated_at);
  renderReports();
}

initTheme();
initPdfModal();
wireReports();
window.__unlocked.then(loadReports);
