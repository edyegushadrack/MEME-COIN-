import { getAllLaunchesWithSnapshots } from '../db/supabase.js';

// Test the scoring model at several thresholds to see which one would
// actually have produced good outcomes, rather than trusting a threshold
// picked in advance without evidence.
const THRESHOLDS_TO_TEST = [30, 40, 50, 60, 65, 70, 80];

// Which time horizon to judge outcomes at. 15 min is a reasonable early
// checkpoint for pump.fun-style launches; change this once you see how your
// data actually distributes.
const EVAL_MINUTES = 15;

function findSnapshotNear(snapshots, targetMinutes, toleranceMinutes = 5) {
  return snapshots
    .filter((s) => Math.abs(s.minutes_after_launch - targetMinutes) <= toleranceMinutes)
    .sort(
      (a, b) =>
        Math.abs(a.minutes_after_launch - targetMinutes) -
        Math.abs(b.minutes_after_launch - targetMinutes)
    )[0];
}

function getEntryPrice(snapshots) {
  return snapshots.sort((a, b) => a.minutes_after_launch - b.minutes_after_launch)[0];
}

async function main() {
  const launches = await getAllLaunchesWithSnapshots();
  console.log(`Loaded ${launches.length} logged launches.\n`);

  const withData = launches.filter((l) => l.price_snapshots?.length >= 2);
  console.log(
    `${withData.length} have enough price history to evaluate (need at least 2 snapshots).\n`
  );

  if (withData.length === 0) {
    console.log(
      'No evaluable data yet. Run `npm run listen` and `npm run track` together for a while first.'
    );
    return;
  }

  for (const threshold of THRESHOLDS_TO_TEST) {
    const candidates = withData.filter((l) => l.score >= threshold);
    if (candidates.length === 0) {
      console.log(`Threshold ${threshold}: no launches qualified.`);
      continue;
    }

    const outcomes = candidates
      .map((l) => {
        const entry = getEntryPrice(l.price_snapshots);
        const later = findSnapshotNear(l.price_snapshots, EVAL_MINUTES);
        if (!entry || !later || !entry.price_usd) return null;
        return (later.price_usd - entry.price_usd) / entry.price_usd; // return as fraction
      })
      .filter((r) => r !== null);

    if (outcomes.length === 0) {
      console.log(`Threshold ${threshold}: ${candidates.length} candidates, none had enough price data yet.`);
      continue;
    }

    const avgReturn = outcomes.reduce((a, b) => a + b, 0) / outcomes.length;
    const winRate = outcomes.filter((r) => r > 0).length / outcomes.length;
    const median = outcomes.sort((a, b) => a - b)[Math.floor(outcomes.length / 2)];

    console.log(
      `Threshold ${threshold}: n=${outcomes.length} | avg return=${(avgReturn * 100).toFixed(1)}% | ` +
      `median=${(median * 100).toFixed(1)}% | win rate=${(winRate * 100).toFixed(0)}% (at +${EVAL_MINUTES}min)`
    );
  }

  console.log(
    '\nNote: small n at high thresholds is expected early on — don\'t trust a threshold ' +
    'until you have at least 30-50 outcomes behind it. Keep the listener + tracker running.'
  );
}

main();
