/**
 * bundlerDetection.js
 *
 * Detects two related manipulation patterns at launch:
 *
 * 1. BUNDLED BUYS — many wallets buying in the same block/slot as pool
 *    creation. Real organic demand can't physically coordinate that tightly;
 *    this pattern means one actor (the deployer, usually) used multiple
 *    wallets to fake early volume and holder count, so your holder-count
 *    signal looks healthy when it's actually one entity.
 *
 * 2. COMMON-FUNDING CLUSTERS — "early buyers" that all received their SOL
 *    from the same funding wallet shortly before buying. Same problem as
 *    above, detected a different way: it catches cases where the buys are
 *    spread across a few blocks (so #1 wouldn't flag them) but the wallets
 *    are still all controlled by one entity.
 *
 * Integration point: run this once you have the pool-creation slot and a
 * window of the first N buy transactions (e.g. from your Raydium/pump.fun
 * listener). Feed the result into the scoring engine as a penalty, or use
 * a high bundle score as a hard veto alongside contractForensics vetoes.
 *
 * Requires: @solana/web3.js
 */

const { PublicKey } = require("@solana/web3.js");

/**
 * Given the pool creation slot and a list of buy transactions (each with
 * `slot` and `buyerAddress`), returns how many distinct buyers bought in
 * the same slot as pool creation, or within `slotWindow` slots after it.
 *
 * A real launch sees buys trickle in over seconds/minutes as people notice
 * it. A bundled launch sees a cluster of buys in the same 1-3 slots.
 */
function detectBundledBuys(poolCreationSlot, buyTransactions, { slotWindow = 2 } = {}) {
  const withinWindow = buyTransactions.filter(
    (tx) => tx.slot >= poolCreationSlot && tx.slot <= poolCreationSlot + slotWindow
  );

  const uniqueBuyers = new Set(withinWindow.map((tx) => tx.buyerAddress));

  // Heuristic thresholds — tune these against your own logged launches
  // once you have real data. Starting point: >=8 distinct buyers within
  // 2 slots of pool creation is very unlikely to be organic.
  const bundleScore = Math.min(100, uniqueBuyers.size * 12);

  return {
    poolCreationSlot,
    slotWindow,
    buysInWindow: withinWindow.length,
    uniqueBuyersInWindow: uniqueBuyers.size,
    bundleScore, // 0-100, higher = more likely bundled
    likelyBundled: uniqueBuyers.size >= 8,
    buyerAddresses: [...uniqueBuyers],
  };
}

/**
 * For a set of early buyer wallets, checks whether they were all funded
 * (received their first meaningful SOL balance) from the same source
 * wallet shortly before the buy — a strong signal they're all controlled
 * by one entity even if the buys themselves are spread across blocks.
 *
 * `connection` is a Solana web3.js Connection. This looks at each buyer's
 * transaction history for the most recent incoming SOL transfer before
 * their buy tx and records the sender.
 *
 * NOTE: this is RPC-heavy (N buyers x M transactions each). For production
 * volume, replace with an indexer call (Helius "wallet funding source" or
 * similar) rather than raw getSignaturesForAddress + getTransaction loops.
 */
async function detectCommonFunding(connection, buyerAddresses, { lookback = 10 } = {}) {
  const fundingSources = {};

  for (const addr of buyerAddresses) {
    try {
      const pubkey = new PublicKey(addr);
      const sigs = await connection.getSignaturesForAddress(pubkey, { limit: lookback });

      for (const sigInfo of sigs) {
        const tx = await connection.getParsedTransaction(sigInfo.signature, {
          maxSupportedTransactionVersion: 0,
        });
        if (!tx) continue;

        const transferIx = tx.transaction.message.instructions.find(
          (ix) =>
            ix.parsed &&
            ix.parsed.type === "transfer" &&
            ix.parsed.info &&
            ix.parsed.info.destination === addr
        );

        if (transferIx) {
          const source = transferIx.parsed.info.source;
          fundingSources[addr] = source;
          break; // most recent incoming transfer found, stop looking
        }
      }
    } catch (e) {
      fundingSources[addr] = null; // couldn't resolve, don't let it crash the batch
    }
  }

  // Group buyers by shared funding source
  const groupedBySource = {};
  for (const [buyer, source] of Object.entries(fundingSources)) {
    if (!source) continue;
    if (!groupedBySource[source]) groupedBySource[source] = [];
    groupedBySource[source].push(buyer);
  }

  const clusters = Object.entries(groupedBySource)
    .filter(([, buyers]) => buyers.length >= 2)
    .map(([source, buyers]) => ({ fundingSource: source, buyers, count: buyers.length }));

  const largestCluster = clusters.reduce((max, c) => (c.count > max ? c.count : max), 0);

  return {
    fundingSources,
    clusters,
    largestClusterSize: largestCluster,
    likelyCommonEntity: largestCluster >= 4,
  };
}

/**
 * Top-level combined check.
 */
async function runBundlerDetection({
  connection,
  poolCreationSlot,
  buyTransactions,
  checkFundingClusters = true,
}) {
  const bundleResult = detectBundledBuys(poolCreationSlot, buyTransactions);

  let fundingResult = null;
  if (checkFundingClusters && bundleResult.buyerAddresses.length > 0) {
    fundingResult = await detectCommonFunding(connection, bundleResult.buyerAddresses);
  }

  const veto = bundleResult.likelyBundled || (fundingResult && fundingResult.likelyCommonEntity);

  return {
    bundleResult,
    fundingResult,
    veto,
    checkedAt: new Date().toISOString(),
  };
}

module.exports = {
  detectBundledBuys,
  detectCommonFunding,
  runBundlerDetection,
};
