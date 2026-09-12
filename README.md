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

## Telegram alerts + wallet monitoring

- `telegramNotifier.js` — Telegram Bot API wrapper (plain fetch, no extra
  dependency) plus `/track <address> [label]` and `/untrack <address>`
  commands to manage watched wallets straight from Telegram
- `walletMonitor.js` — real-time Solana wallet subscriptions via
  `connection.onLogs`, classifies buy/sell by diffing token balances,
  auto re-syncs every few minutes to pick up new tracked wallets
- `tracked_wallets.sql` — schema for the wallet list + activity log
- `telegramIntegration.js` — orchestrator wiring wallet monitoring into
  Telegram alerts; also exposes `notifyTokenPassed()` for the existing
  scoring pipeline to call once a token clears the veto filter + score
  threshold, so your own scanner becomes the "signal source" instead of
  someone else's Telegram calls

### One-time setup

1. Message @BotFather on Telegram, `/newbot`, save the token
2. Message your new bot once, then hit
   `https://api.telegram.org/bot<TOKEN>/getUpdates` to find your chat_id
3. Add to `.env`: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `SOLANA_RPC_URL`
4. Run `tracked_wallets.sql` in the meme-scanner Supabase project
5. `npm install @solana/web3.js @supabase/supabase-js` if not already present
6. Run `node telegramIntegration.js` alongside your main scanner process

## Private alpha-wallet discovery (not a public leaderboard)

- `token_early_buyers.sql` — logs every early buyer on every detected
  token (not just wallets already tracked). Needs to be wired into the
  detection handler to start capturing data going forward.
- `discoverAlphaWallets.js` — mines that history for wallets that show up
  early, repeatedly, on tokens that actually mooned (default: 3x+, within
  2 minutes of launch, on 3+ separate winners). Cross-checks against
  bundler-detection data to exclude wallets that only look "early" because
  they were part of a manipulated bundle.

This is the private alternative to public KOL leaderboards (Kolscan, etc.)
— those rank wallets everyone can already see, which makes following them
a crowded trade. This ranks wallets by a pattern only your own scanner's
detection history can see. Needs a few weeks of logged data before it's
useful — same rule as the backtesting harness.

Feed discovered wallets into `/track <address>` (see Telegram section
above) to put them under real-time monitoring.
