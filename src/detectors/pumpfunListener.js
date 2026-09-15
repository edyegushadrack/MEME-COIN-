import WebSocket from 'ws';
import { config } from '../config.js';
import { fetchOnChainSignals } from '../scoring/fetchOnChainSignals.js';
import { scoreLaunch } from '../scoring/scoreLaunch.js';
import { insertLaunch, supabase } from '../db/supabase.js';
import { detectBundledBuys } from './bundlerDetection.js';
import { sendLaunchAlert, sendVetoAlert } from '../notify/telegramNotifier.js';

// Tracks buys (count + individual buyer addresses/timestamps) per mint in
// the first 90s after detection, purely in memory.
const buyCounters = new Map();

// Module-level reference to the live socket, so handleNewLaunch can send
// subscribe/unsubscribe messages for individual tokens as they're detected
// and as their 90s tracking window closes.
let ws;

function startBuyCounter(mint) {
  buyCounters.set(mint, { count: 0, startedAt: Date.now(), buys: [] });
  setTimeout(() => buyCounters.delete(mint), 90_000);
}

function recordBuy(mint, traderAddress) {
  const counter = buyCounters.get(mint);
  if (!counter) return;
  counter.count += 1;
  if (traderAddress) {
    counter.buys.push({
      address: traderAddress,
      secondsAfterLaunch: (Date.now() - counter.startedAt) / 1000,
    });
  }
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
    // NOTE: subscribeTokenTrade requires specific mint addresses in `keys`
    // — an empty array subscribes to nothing. Trades are subscribed to
    // per-token, dynamically, in handleNewLaunch below as each token is
    // detected, and unsubscribed once its 90s tracking window closes.
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
      ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [msg.mint] }));
      handleNewLaunch(msg).catch((err) =>
        console.error('[pumpfun] handleNewLaunch error:', err.message)
      );
    }

    // Trade event on a token we're currently tracking in the buy-velocity window.
    if (msg.mint && msg.txType === 'buy') {
      recordBuy(msg.mint, msg.traderPublicKey);
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
  // since buy velocity is one of the signals. This trades a little latency
  // for a materially better signal.
  await new Promise((resolve) => setTimeout(resolve, 90_000));

  // Done tracking this one — unsubscribe so we're not holding an
  // ever-growing list of per-token trade subscriptions open indefinitely.
  ws.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: [msg.mint] }));

  const buys = getBuys(msg.mint);

  // Bundler/sniper check: many distinct wallets buying within seconds of
  // each other right after launch is very unlikely to be organic — it's
  // usually one actor faking early volume/holder count with many wallets.
  // This is a hard veto, done BEFORE scoring, same reasoning as the
  // authority-renounced disqualifier already in scoreLaunch.js: a
  // structurally manipulated launch shouldn't be rescued by a good score
  // on other signals.
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
