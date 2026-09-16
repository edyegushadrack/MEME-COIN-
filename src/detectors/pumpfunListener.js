import WebSocket from 'ws';
import { Connection } from '@solana/web3.js';
import { config } from '../config.js';
import { fetchOnChainSignals } from '../scoring/fetchOnChainSignals.js';
import { scoreLaunch } from '../scoring/scoreLaunch.js';
import { insertLaunch, supabase } from '../db/supabase.js';
import { detectBundledBuys } from './bundlerDetection.js';
import { subscribeToTokenTrades } from './bondingCurveWatcher.js';
import { sendLaunchAlert, sendVetoAlert } from '../notify/telegramNotifier.js';

// Tracks buys (count + individual buyer addresses/timestamps) per mint in
// the first 90s after detection, purely in memory.
const buyCounters = new Map();

// Per-mint on-chain log subscription IDs, so each can be unsubscribed
// individually once its 90s window closes.
const tradeSubscriptions = new Map();

// Hard cap on how many tokens we watch on-chain at once. pump.fun can
// launch tokens faster than a free-tier RPC can serve lookups for all of
// them, and unbounded concurrent subscriptions was the real cause of
// sustained 429s — not the per-request throttling. Watching a sampled
// subset properly beats watching everything badly: partial buyer data on
// some launches is far more useful than rate-limited garbage on all of
// them. Raise this if you move to a paid RPC tier.
const MAX_CONCURRENT_WATCHED_TOKENS = 5;

// Shared RPC connection for on-chain trade watching. New tokens are
// detected via PumpPortal's free subscribeNewToken (ws below); individual
// buy/sell activity is watched directly on-chain via this connection,
// since PumpPortal's subscribeTokenTrade requires a funded API key
// (0.02+ SOL) that this project doesn't have.
const connection = new Connection(config.rpcUrl, 'confirmed');

let ws;

function startBuyCounter(mint) {
  buyCounters.set(mint, { count: 0, startedAt: Date.now(), buys: [], watched: false });

  // Only subscribe on-chain if we have capacity. Tokens beyond the cap
  // still get detected, scored, and logged — they just won't have buyer
  // data. buys_first_90s will be 0 for them, which is why `watched` is
  // tracked and stored, so the backtest can tell "no buyers observed"
  // apart from "we weren't watching".
  if (tradeSubscriptions.size < MAX_CONCURRENT_WATCHED_TOKENS) {
    const counter = buyCounters.get(mint);
    counter.watched = true;

    const subId = subscribeToTokenTrades(connection, mint, (event) => {
      const c = buyCounters.get(mint);
      if (!c) return; // window already closed
      if (event.type !== 'buy') return; // only buys count toward buysFirst90s / early buyers
      c.count += 1;
      c.buys.push({
        address: event.buyer,
        secondsAfterLaunch: (Date.now() - c.startedAt) / 1000,
      });
    });
    tradeSubscriptions.set(mint, subId);
  }

  setTimeout(async () => {
    buyCounters.delete(mint);
    const subId = tradeSubscriptions.get(mint);
    if (subId != null) {
      await connection.removeOnLogsListener(subId).catch(() => {});
      tradeSubscriptions.delete(mint);
    }
  }, 90_000);
}

function wasWatched(mint) {
  return buyCounters.get(mint)?.watched ?? false;
}

function getBuyCount(mint) {
  return buyCounters.get(mint)?.count ?? 0;
}

function getBuys(mint) {
  return buyCounters.get(mint)?.buys ?? [];
}

export function startPumpfunListener() {
  ws = new WebSocket(config.pumpPortalWsUrl);

  ws.on('open', () => {
    console.log('[pumpfun] connected, subscribing to new token events');
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    // Trade activity is watched on-chain per-mint (see bondingCurveWatcher.js
    // + startBuyCounter above), not via PumpPortal — subscribeTokenTrade
    // requires a funded API key this project doesn't have.
  });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // New token creation event
    if (msg.mint && msg.txType === 'create') {
      startBuyCounter(msg.mint);
      handleNewLaunch(msg).catch((err) =>
        console.error('[pumpfun] handleNewLaunch error:', err.message)
      );
    }
  });

  ws.on('close', () => {
    console.warn('[pumpfun] connection closed, reconnecting in 5s');
    setTimeout(startPumpfunListener, 5000);
  });

  ws.on('error', (err) => {
    console.error('[pumpfun] websocket error:', err.message);
  });

  return ws;
}

async function logEarlyBuyers(mintAddress, buys) {
  if (!buys.length) return;
  const rows = buys.map((b) => ({
    mint_address: mintAddress,
    buyer_address: b.address,
    seconds_after_launch: b.secondsAfterLaunch,
  }));
  const { error } = await supabase.from('token_early_buyers').upsert(rows, {
    onConflict: 'mint_address,buyer_address',
    ignoreDuplicates: true,
  });
  if (error) console.error('[pumpfun] logEarlyBuyers error:', error.message);
}

async function handleNewLaunch(msg) {
  // Give the token ~90s to accumulate initial buy activity before scoring,
  // since buy velocity is one of the signals. Unsubscribe happens
  // automatically via the setTimeout in startBuyCounter, not here.
  await new Promise((resolve) => setTimeout(resolve, 90_000));

  const buys = getBuys(msg.mint);

  // Bundler/sniper check: many distinct wallets buying within seconds of
  // each other right after launch is very unlikely to be organic — it's
  // usually one actor faking early volume/holder count with many wallets.
  // This is a hard veto, done BEFORE scoring, same reasoning as the
  // authority-renounced disqualifier already in scoreLaunch.js.
  const bundlerCheck = detectBundledBuys(buys);
  if (bundlerCheck.likelyBundled) {
    console.log(
      `[pumpfun] ${msg.symbol ?? msg.mint} VETOED — bundled buys detected (${bundlerCheck.maxClusterSize} wallets clustered)`
    );
    await sendVetoAlert({
      mint_address: msg.mint,
      reason: `bundled_buys (${bundlerCheck.maxClusterSize} wallets within a few seconds of each other)`,
    });
    return; // skip scoring and logging entirely for a structurally bad launch
  }

  const onChainSignals = await fetchOnChainSignals(msg.mint);

  const signals = {
    ...onChainSignals,
    lpSolAmount: msg.vSolInBondingCurve ?? null,
    lpLockedOrBurned: true, // pump.fun bonding curve LP is program-controlled by default
    buysFirst90s: getBuyCount(msg.mint),
    hasSocials: Boolean(msg.twitter || msg.telegram || msg.website),
    marketCapSol: msg.marketCapSol ?? null,
  };

  const { score, breakdown, disqualified } = scoreLaunch(signals);

  if (score < config.minScoreToLog && !disqualified) return; // skip logging pure noise below floor

  const launch = await insertLaunch({
    source: 'pumpfun',
    mint_address: msg.mint,
    name: msg.name ?? null,
    symbol: msg.symbol ?? null,
    mint_authority_renounced: signals.mintAuthorityRenounced,
    freeze_authority_renounced: signals.freezeAuthorityRenounced,
    lp_sol_amount: signals.lpSolAmount,
    lp_locked_or_burned: signals.lpLockedOrBurned,
    top10_holder_pct: signals.top10HolderPct,
    buys_first_90s: signals.buysFirst90s,
    trade_data_watched: wasWatched(msg.mint),
    has_socials: signals.hasSocials,
    market_cap_sol: signals.marketCapSol,
    score,
    score_breakdown: breakdown,
    paper_bought: score >= config.minScoreToPaperBuy,
    paper_entry_price: null, // filled in by the price tracker's first snapshot
    raw_payload: msg,
  });

  // Log every early buyer, win or lose — this is what discoverAlphaWallets.js
  // later mines for wallets that repeatedly show up early on winners.
  await logEarlyBuyers(msg.mint, buys);

  console.log(
    `[pumpfun] ${msg.symbol ?? msg.mint} scored ${score}${
      score >= config.minScoreToPaperBuy ? ' -> PAPER BUY' : ''
    }`
  );

  if (launch && score >= config.minScoreToPaperBuy) {
    await sendLaunchAlert(launch);
  }
}
