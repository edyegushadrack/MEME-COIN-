import fetch from 'node-fetch';
import { getOpenLaunchesForTracking, insertPriceSnapshot } from '../db/supabase.js';

const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
const MAX_TRACKING_AGE_MINUTES = 120; // stop tracking after 2 hours

async function fetchPumpfunPrice(mintAddress) {
  // Public pump.fun frontend data endpoint — no key required, used only for
  // read-only price lookups on tokens we've already detected.
  try {
    const res = await fetch(`https://frontend-api.pump.fun/coins/${mintAddress}`);
    if (!res.ok) return null;
    const data = await res.json();
    return {
      priceUsd: data.usd_market_cap && data.total_supply
        ? data.usd_market_cap / data.total_supply
        : null,
      marketCapUsd: data.usd_market_cap ?? null,
    };
  } catch {
    return null;
  }
}

async function snapshotAll() {
  const launches = await getOpenLaunchesForTracking(MAX_TRACKING_AGE_MINUTES);
  console.log(`[tracker] snapshotting ${launches.length} launches`);

  for (const launch of launches) {
    const price = await fetchPumpfunPrice(launch.mint_address);
    if (!price || price.priceUsd == null) continue;

    const minutesAfterLaunch =
      (Date.now() - new Date(launch.detected_at).getTime()) / 60000;

    await insertPriceSnapshot({
      launch_id: launch.id,
      minutes_after_launch: minutesAfterLaunch,
      price_usd: price.priceUsd,
      market_cap_usd: price.marketCapUsd,
    });
  }
}

async function main() {
  console.log('[tracker] starting price tracking loop (every 5 min, 2hr window)');
  await snapshotAll();
  setInterval(snapshotAll, SNAPSHOT_INTERVAL_MS);
}

main();
