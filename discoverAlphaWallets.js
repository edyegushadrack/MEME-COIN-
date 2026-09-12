/**
 * discoverAlphaWallets.js
 *
 * The private alternative to a public KOL leaderboard. Instead of copying
 * addresses everyone else already watches, this mines YOUR scanner's own
 * detection history for wallets that show up as early buyers, repeatedly,
 * on tokens that later actually mooned. Nobody else can see this pattern
 * because it only exists in your own logged data.
 *
 * Requires at least a few weeks of `token_early_buyers` + `tokens` data
 * (peak_price populated) before this produces a meaningful result — same
 * "let real data accumulate first" rule as the backtest harness.
 */

/**
 * @param {Object} supabase
 * @param {Object} [options]
 * @param {number} [options.winMultiple] - only count a token as a "win" if
 *   peak_price / entry price at least this multiple. Default 3x.
 * @param {number} [options.earlyWindowSeconds] - only count a buy as
 *   "early" if it happened within this many seconds of pool creation.
 * @param {number} [options.minAppearances] - only surface wallets that
 *   showed up early on at least this many winning tokens (filters out
 *   one-off luck).
 */
async function discoverAlphaWallets(
  supabase,
  { winMultiple = 3, earlyWindowSeconds = 120, minAppearances = 3 } = {}
) {
  // Step 1: find "winning" tokens — ones whose peak price cleared the
  // multiple, using the entry/first-known price as the baseline.
  const { data: tokens, error: tokensError } = await supabase
    .from("tokens")
    .select("mint_address, peak_price, current_price, created_at")
    .not("peak_price", "is", null);

  if (tokensError) throw new Error(`discoverAlphaWallets: ${tokensError.message}`);

  // First price snapshot per token = the entry-price proxy.
  const winningMints = [];
  for (const t of tokens) {
    const { data: firstSnapshot } = await supabase
      .from("price_snapshots")
      .select("price")
      .eq("mint_address", t.mint_address)
      .order("recorded_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (firstSnapshot && firstSnapshot.price > 0) {
      const multiple = t.peak_price / firstSnapshot.price;
      if (multiple >= winMultiple) winningMints.push(t.mint_address);
    }
  }

  if (!winningMints.length) {
    return {
      winningTokenCount: 0,
      candidates: [],
      note: "No winning tokens found yet at this multiple — needs more logged data, or lower winMultiple.",
    };
  }

  // Step 2: pull early buyers on those winning tokens only.
  const { data: earlyBuys, error: buysError } = await supabase
    .from("token_early_buyers")
    .select("mint_address, buyer_address, seconds_after_launch")
    .in("mint_address", winningMints)
    .lte("seconds_after_launch", earlyWindowSeconds);

  if (buysError) throw new Error(`discoverAlphaWallets: ${buysError.message}`);

  // Step 3: exclude wallets already flagged as part of a bundled/common-
  // funding cluster elsewhere — being an "early buyer" via manipulation
  // isn't the same signal as genuine early conviction.
  const { data: vetoed } = await supabase
    .from("vetoed_tokens")
    .select("details")
    .in("mint_address", winningMints);

  const bundledBuyerAddresses = new Set();
  for (const v of vetoed || []) {
    const buyers = v.details?.bundler?.bundleResult?.buyerAddresses || [];
    buyers.forEach((b) => bundledBuyerAddresses.add(b));
  }

  // Step 4: tally appearances per wallet across distinct winning tokens.
  const tally = {};
  for (const buy of earlyBuys) {
    if (bundledBuyerAddresses.has(buy.buyer_address)) continue; // skip likely manipulation
    if (!tally[buy.buyer_address]) {
      tally[buy.buyer_address] = { wallet: buy.buyer_address, mints: new Set(), avgSecondsAfterLaunch: [] };
    }
    tally[buy.buyer_address].mints.add(buy.mint_address);
    tally[buy.buyer_address].avgSecondsAfterLaunch.push(buy.seconds_after_launch);
  }

  const candidates = Object.values(tally)
    .map((entry) => ({
      wallet: entry.wallet,
      winningTokensHit: entry.mints.size,
      avgSecondsAfterLaunch: Number(
        (
          entry.avgSecondsAfterLaunch.reduce((a, b) => a + b, 0) / entry.avgSecondsAfterLaunch.length
        ).toFixed(1)
      ),
    }))
    .filter((c) => c.winningTokensHit >= minAppearances)
    .sort((a, b) => b.winningTokensHit - a.winningTokensHit);

  return {
    winningTokenCount: winningMints.length,
    candidateCount: candidates.length,
    candidates,
  };
}

module.exports = { discoverAlphaWallets };
