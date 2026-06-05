# Trading Master — Dashboard

Public front-end for a private trading system. Shows the stock / options / watchlist
portfolios and the Alpaca **paper** account details, and lets the owner add/remove
tickers.

- **`main` is data-free** — it holds only the static shell (`index.html`,
  `style.css`, `app.js`). No balances or holdings live here.
- **The live site is served from the `gh-pages` branch**, which is built and
  published automatically by a workflow in the private data repo
  (`Prats08/yoda-trading-master` → `.github/workflows/deploy-dashboard.yml`).
  That branch carries the current `data/portfolios.json` and `data/accounts.json`.
- **Viewing is public.** **Editing** (add/remove tickers) requires the owner to
  paste a fine-grained GitHub token via the *Connect* button; it is stored only in
  the browser and writes go to the private data repo via the GitHub API.

Paper trading only. Nothing here places real-money trades.
