/**
 * bundlerDetection.js
 *
 * Adapted to work with what pumpfunListener.js actually captures: buyer
 * addresses and the timestamp of each buy within the first 90s after
 * launch (via PumpPortal's `subscribeTokenTrade` messages). This is
 * simpler than a slot-based check but uses real data your listener
 * already receives, instead of data that would need extra RPC calls.
 *
 * Detects the same manipulation pattern either way: many distinct wallets
 * buying within seconds of each other right after launch is very unlikely
 * to be organic — it means one actor used multiple wallets to fake early
 * volume and holder count.
 */

/**
 * @param {Array<{address: string, secondsAfterLaunch: number}>} buys
 * @param {Object} [options]
 * @param {number} [options.windowSeconds] - buys within this many seconds
 *   of each other (not just of launch) count as "clustered"
 * @param {number} [options.minUniqueBuyersToFlag] - unique buyers within
 *   the tightest cluster needed to call it likely-bundled
 */
export function detectBundledBuys(buys, { windowSeconds = 5, minUniqueBuyersToFlag = 8 } = {}) {
  if (!buys.length) {
    return { buyCount: 0, uniqueBuyers: 0, maxClusterSize: 0, likelyBundled: false };
  }

  const sorted = [...buys].sort((a, b) => a.secondsAfterLaunch - b.secondsAfterLaunch);
  const uniqueAddresses = new Set(buys.map((b) => b.address));

  // Slide a window across the sorted buys, find the densest cluster of
  // distinct addresses within `windowSeconds` of each other.
  let maxClusterSize = 0;
  let clusterAddresses = [];
  for (let i = 0; i < sorted.length; i++) {
    const windowStart = sorted[i].secondsAfterLaunch;
    const inWindow = sorted.filter(
      (b) => b.secondsAfterLaunch >= windowStart && b.secondsAfterLaunch <= windowStart + windowSeconds
    );
    const distinctInWindow = new Set(inWindow.map((b) => b.address));
    if (distinctInWindow.size > maxClusterSize) {
      maxClusterSize = distinctInWindow.size;
      clusterAddresses = [...distinctInWindow];
    }
  }

  return {
    buyCount: buys.length,
    uniqueBuyers: uniqueAddresses.size,
    maxClusterSize,
    clusterAddresses,
    likelyBundled: maxClusterSize >= minUniqueBuyersToFlag,
  };
}
