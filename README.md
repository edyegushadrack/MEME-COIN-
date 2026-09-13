# MEME-COIN- (meme-scanner)

Detects new pump.fun launches, filters out structurally manipulated ones,
scores the rest for rug-risk/momentum signals, logs everything to Supabase,
and lets you backtest whether the scoring model actually works — all
before any real money is at risk. Also includes real-time wallet
monitoring and Telegram alerts, so your own scanner can be your signal
source instead of following someone else's calls.

## What this is NOT (yet)
No wallet, no swaps, no execution. This is detection → veto → scoring →
paper-trading → alerting. Execution gets added once the backtest shows the
scoring model has real edge — see "Next steps" below.

## Setup (all free tier)

1. **Create a new Supabase project** (free tier, keep it separate from any
   other project you run). In the SQL editor, run `schema.sql` — this
   includes the original `launches`/`price_snapshots` tables plus the
   wallet-monitoring and alpha-discovery additions.
2. **Copy `.env.example` to `.env`** and fill in:
   - `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` from your Supabase project's settings
   - `SOLANA_RPC_URL` — the public `https://api.mainnet-beta.solana.com`
     works to start; if you hit rate limits, a free Helius or QuickNode
     account gives a higher-limit RPC URL to drop in instead
   - `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` — message @BotFather to create
     a bot and get a token, then message your bot once and hit
     `https://api.telegram.org/bot<TOKEN>/getUpdates` to find your chat_id
3. **Install and run:**
   ```bash
   npm install
   npm run listen         # terminal 1 — detects + vetoes + scores + logs + alerts
   npm run track          # terminal 2 — snapshots prices every 5 min for open launches
   npm run wallet-bot      # terminal 3 — wallet monitoring + /track /untrack commands
   ```
4. **Let it run.** Realistically a few days to a week, so you accumulate
   enough logged launches with outcome data to make the backtest meaningful.
5. **Run the backtest:**
   ```bash
   npm run backtest
   ```
   This tells you, for several score thresholds, what the average/median
   return and win rate would have been if you'd paper-bought everything
   above that threshold. That's your evidence for whether the scoring
   model — and which threshold — actually has edge.
6. **Discover your own alpha wallets, once you have data:**
   ```bash
   npm run discover-wallets
   ```
   Mines your own logged history for wallets that repeatedly bought early
   on launches that later mooned — private to your own scanner's data, not
   a public leaderboard like Kolscan that thousands of other traders
   already watch. Feed promising wallets into `/track <address>` in
   Telegram to put them under real-time monitoring.

## Bundler / sniper detection

Before a launch is even scored, `bundlerDetection.js` checks whether many
distinct wallets bought within seconds of each other right after launch —
a strong signal of one actor faking early volume/holder count with
multiple wallets. If flagged, the launch is vetoed and skipped entirely
(logged via a Telegram alert), the same way an un-renounced mint/freeze
authority already disqualifies a launch in `scoreLaunch.js`.

## Tuning the scoring model

`src/scoring/scoreLaunch.js` has the weights. They're a reasonable starting
guess, not a fact. Once you have backtest data:
- If mint/freeze-authority-renounced tokens aren't actually outperforming,
  drop that weight.
- If buy velocity turns out to correlate strongly with 15-min returns,
  raise its weight and lower others.
- Add new signals as columns to `launches` + fields in `scoreLaunch.js` —
  e.g. dev wallet history, LP lock duration, if you find data sources for them.

## Next steps once the backtest shows real edge
- Add Raydium pool-creation detection (graduated tokens), not just pump.fun
- Add execution via Jupiter, starting with tiny position sizes
- Add stop-loss/take-profit/time-based exit rules
- Only then consider a dedicated funded hot wallet

## Known limitations to keep in mind
- The pump.fun price endpoint used here is the public frontend API — fine
  for a personal research project, but not a documented/stable contract.
  If it breaks, that's the first thing to check.
- Free RPC endpoints rate-limit under load; if `fetchOnChainSignals`
  errors frequently, that's your cue to move to a free Helius/QuickNode key.
- The buy-velocity and bundler-detection signals only count trades that
  arrive over the same WebSocket connection while your process is
  running — they're approximations, not ground-truth counts.
- `traderPublicKey` is assumed to be PumpPortal's field name for the
  buyer's wallet on trade events. If bundler detection never fires even on
  obviously bundled launches, verify this field name against a raw logged
  message first.
- Wallet monitoring (`walletMonitor.js`) classifies buy/sell by diffing
  token balances on the transaction; it can misfire on complex multi-hop
  swaps routed through several pools.
