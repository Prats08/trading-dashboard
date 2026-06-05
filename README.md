# Trading Master — Dashboard

Public, **read-only** front-end for a private trading system. Shows the stock / options /
watchlist portfolios and the Alpaca **paper** account details.

- **`main` is data-free** — it holds only the static shell (`index.html`, `style.css`, `app.js`).
  No balances or holdings live here.
- **The live site is served from the `gh-pages` branch**, built and published automatically by a
  workflow in the private data repo (`Prats08/yoda-trading-master` →
  `.github/workflows/deploy-dashboard.yml`). That branch carries the current
  `data/portfolios.json` and `data/accounts.json`.
- **Viewing is public and needs no token.** The page is read-only — tickers are managed by the
  trading system, not here.

Paper trading only. Nothing here places real-money trades.
