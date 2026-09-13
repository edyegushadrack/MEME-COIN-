import { supabase } from '../db/supabase.js';

/**
 * Mines YOUR OWN scanner's history for wallets that repeatedly buy early
 * on launches that actually mooned — a private alternative to a public
 * leaderboard like Kolscan, which thousands of other traders already
 * watch. Needs `token_early_buyers` data accumulating (see schema) and a
 * few weeks of price history before this produces anything meaningful.
 */
async function discoverAlphaWallets({ winMultiple = 3, earlyWindowSeconds = 120, minAppearances = 3 } = {}) {
  const { data: launches, error: launchesError } = await supabase
    .from('launches')
    .select('id, mint_address, price_snapshots(price_usd, minutes_after_launch)');

  if (launchesError) throw new Error(`discoverAlphaWallets: ${launchesError.message}`);

  const winningMints = [];
  for (const l of launches) {
    const snapshots = l.price_snapshots || [];
    if (snapshots.length < 2) continue;

    const sorted = [...snapshots].sort((a, b) => a.minutes_after_launch - b.minutes_after_launch);
    const entryPrice = sorted[0].price_usd;
    const peakPrice = Math.max(...sorted.map((s) => s.price_usd || 0));

    if (entryPrice > 0 && peakPrice / entryPrice >= winMultiple) {
      winningMints.push(l.mint_address);
    }
  }

  if (!winningMints.length) {
    console.log('No winning launches found yet at this multiple — needs more logged data, or a lower winMultiple.');
    return { winningLaunchCount: 0, candidates: [] };
  }

  const { data: earlyBuys, error: buysError } = await supabase
    .from('token_early_buyers')
    .select('mint_address, buyer_address, seconds_after_launch')
    .in('mint_address', winningMints)
    .lte('seconds_after_launch', earlyWindowSeconds);

  if (buysError) throw new Error(`discoverAlphaWallets: ${buysError.message}`);

  const tally = {};
  for (const buy of earlyBuys) {
    if (!tally[buy.buyer_address]) {
      tally[buy.buyer_address] = { wallet: buy.buyer_address, mints: new Set(), seconds: [] };
    }
    tally[buy.buyer_address].mints.add(buy.mint_address);
    tally[buy.buyer_address].seconds.push(buy.seconds_after_launch);
  }

  const candidates = Object.values(tally)
    .map((c) => ({
      wallet: c.wallet,
      winningLaunchesHit: c.mints.size,
      avgSecondsAfterLaunch: Number((c.seconds.reduce((a, b) => a + b, 0) / c.seconds.length).toFixed(1)),
    }))
    .filter((c) => c.winningLaunchesHit >= minAppearances)
    .sort((a, b) => b.winningLaunchesHit - a.winningLaunchesHit);

  console.log(`Winning launches (>= ${winMultiple}x): ${winningMints.length}`);
  console.log(`Candidate alpha wallets (>= ${minAppearances} early hits): ${candidates.length}\n`);
  candidates.forEach((c) =>
    console.log(`${c.wallet} — ${c.winningLaunchesHit} winning launches, avg ${c.avgSecondsAfterLaunch}s after launch`)
  );

  return { winningLaunchCount: winningMints.length, candidates };
}

discoverAlphaWallets().catch((err) => {
  console.error('discoverAlphaWallets error:', err);
  process.exit(1);
});
