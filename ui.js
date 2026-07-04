'use strict';

// Shared UI helpers used by BOTH the dashboard (app.js) and the reports archive
// (reports.js): light/dark theme toggle, the inline PDF modal, and small
// formatters. Included before app.js / reports.js on each page.

const THEME_KEY = 'tm_theme';

function currentTheme() {
  try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; }
  catch (e) { return 'dark'; }
}
function applyTheme(theme) {
  if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  const btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = theme === 'light' ? '☀️' : '🌙';
}
function initTheme(onChange) {
  applyTheme(currentTheme());
  const btn = document.getElementById('theme-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const next = currentTheme() === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
    applyTheme(next);
    if (typeof onChange === 'function') onChange(next);
  });
}

// ----- inline PDF modal (markup lives in index.html / reports.html) -----
function openPdf(file, title) {
  const modal = document.getElementById('pdf-modal');
  if (!modal) { window.open(file, '_blank'); return; }
  modal.querySelector('#pdf-title').textContent = title || 'Report';
  modal.querySelector('#pdf-frame').src = file;
  const dl = modal.querySelector('#pdf-download');
  if (dl) { dl.href = file; dl.setAttribute('download', file.split('/').pop()); }
  modal.hidden = false;
  document.documentElement.classList.add('modal-open');
}
function closePdf() {
  const modal = document.getElementById('pdf-modal');
  if (!modal) return;
  modal.hidden = true;
  modal.querySelector('#pdf-frame').src = 'about:blank';
  document.documentElement.classList.remove('modal-open');
}
function initPdfModal() {
  const modal = document.getElementById('pdf-modal');
  if (!modal) return;
  modal.addEventListener('click', e => { if (e.target.closest('[data-close]')) closePdf(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.hidden) closePdf(); });
}

// ----- shared formatters -----
function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + ' MB';
  if (v >= 1e3) return Math.round(v / 1e3) + ' KB';
  return v + ' B';
}
function fmtDateLong(iso) {
  // iso = 'YYYY-MM-DD' → 'Mon DD, YYYY' (avoids TZ shifts from Date parsing)
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ----- CSV download -----
function downloadCSV(filename, headers, rows) {
  const cell = v => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.map(cell).join(',')];
  for (const r of rows) lines.push(r.map(cell).join(','));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
