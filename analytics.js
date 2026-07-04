'use strict';

// ---------------------------------------------------------------------------
// Google Analytics 4 visitor tracking. Shared by index.html and reports.html
// (included in <head>, right after the inline theme script). Fires one standard
// pageview per load — enough to answer "how many visits / unique visitors per
// day" in the GA dashboard.
//
// The Measurement ID is NOT a secret: gtag.js exposes it client-side on every
// GA-tracked site by design, so it's safe to commit to this public repo.
//
// TO SET IT UP (repo owner — you handle infra/config):
//   1. Create a GA4 property at https://analytics.google.com
//   2. Admin -> Data streams -> add a Web stream for the dashboard URL
//   3. Copy its Measurement ID (looks like G-XXXXXXXXXX)
//   4. Paste it into GA_MEASUREMENT_ID below, then commit + deploy.
// Until then the ID stays at the placeholder and this script is an inert no-op
// (no network calls, no console errors) — so local preview + deploy stay clean.
// ---------------------------------------------------------------------------

const GA_MEASUREMENT_ID = 'G-0D1XEV56L6';   // <-- paste your real GA4 ID here

if (GA_MEASUREMENT_ID && GA_MEASUREMENT_ID !== 'G-XXXXXXXXXX') {
  const s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_MEASUREMENT_ID;
  document.head.appendChild(s);

  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag('js', new Date());
  gtag('config', GA_MEASUREMENT_ID);
}
