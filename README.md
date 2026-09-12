# MEME-COIN- — Pre-Score Forensics & Bundler Detection

Loss-prevention pre-filter for the Solana meme coin scanner. Runs before the
scoring engine, as a hard veto layer rather than a soft score input.

## Files

- `contractForensics.js` — mint/freeze authority checks, deployer wallet
  history, and deployer rug-history cross-check against your own Supabase logs
- `bundlerDetection.js` — same-slot bundled buy detection and common-funding
  wallet clustering (catches fake early volume/holder count)
- `preScoreFilter.js` — glue layer combining both checks into a single
  veto/pass decision, called between token detection and the scoring engine
- `vetoed_tokens.sql` — Supabase table + indexes for logging every rejection
  and why, doubling as future backtest data for tuning thresholds

## Wiring it in

```js
const { preScoreFilter, logVetoedToken } = require('./preScoreFilter');

const filterResult = await preScoreFilter({ connection, supabase, tokenEvent });
if (filterResult.veto) {
  await logVetoedToken(supabase, filterResult);
  return; // don't send to scoreToken()
}
const score = await scoreToken(tokenEvent);
```

Run `vetoed_tokens.sql` in the Supabase SQL editor first.

Deployer-history and common-funding checks currently use raw
`getSignaturesForAddress` / `getParsedTransaction` RPC calls (no extra API
key needed). Swap in a Helius (or similar) indexer call for production
volume — the swap points are commented in each file.

## Backtesting

- `backtestEngine.js` — simulates one trade's exits (scaled take-profits,
  decay-triggered trailing stop, hard stop, time-based exit) against a
  historical price series
- `runBacktest.js` — pulls historical tokens + price history from Supabase
  and runs each through the engine. **Edit `fetchHistoricalTokens` and
  `fetchPriceSeries` to match your real table/column names** — they're
  written against a placeholder schema (`tokens.score`, `price_snapshots`)
- `expectancyStats.js` — aggregates trade results into win rate, avg
  win/loss, expectancy per trade, total return, and max drawdown

Run with different `scoreThreshold` values (60, 70, 80...) to see where
your scoring engine's output actually starts correlating with real
outcomes, before trusting it with live capital.
