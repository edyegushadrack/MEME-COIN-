/**
 * Scores a launch 0-100. Higher = fewer red flags / more momentum.
 * This is a STARTING model — the whole point of paper-trading first is to
 * log the breakdown alongside real outcomes, then come back and re-weight
 * these numbers based on what actually correlated with survival vs. rugs.
 *
 * Every weight below is a guess, not a fact. Treat it as v0.
 */

const WEIGHTS = {
  mintAuthorityRenounced: 20,   // hard-ish requirement — can't mint more supply later
  freezeAuthorityRenounced: 15, // can't freeze your wallet's tokens
  lpLockedOrBurned: 20,         // liquidity can't be pulled out from under buyers
  lpSizeSol: 15,                // scaled, see below
  holderConcentration: 15,      // scaled inversely, see below
  buyVelocity: 15,              // scaled, see below
  hasSocials: 5,                // weak signal, cheap to check, small weight
};

function scaleLpSize(solAmount) {
  if (solAmount == null) return 0;
  if (solAmount >= 50) return 1;
  if (solAmount <= 2) return 0;
  return (solAmount - 2) / 48; // linear ramp between 2 and 50 SOL
}

function scaleHolderConcentration(top10Pct) {
  if (top10Pct == null) return 0.5; // unknown — neutral, not zero
  if (top10Pct <= 20) return 1;
  if (top10Pct >= 70) return 0;
  return 1 - (top10Pct - 20) / 50; // linear falloff between 20% and 70%
}

function scaleBuyVelocity(buysFirst90s) {
  if (buysFirst90s == null) return 0;
  if (buysFirst90s >= 30) return 1;
  return buysFirst90s / 30;
}

export function scoreLaunch(signals) {
  const breakdown = {};
  let total = 0;

  breakdown.mintAuthorityRenounced = signals.mintAuthorityRenounced ? WEIGHTS.mintAuthorityRenounced : 0;
  breakdown.freezeAuthorityRenounced = signals.freezeAuthorityRenounced ? WEIGHTS.freezeAuthorityRenounced : 0;
  breakdown.lpLockedOrBurned = signals.lpLockedOrBurned ? WEIGHTS.lpLockedOrBurned : 0;
  breakdown.lpSizeSol = scaleLpSize(signals.lpSolAmount) * WEIGHTS.lpSizeSol;
  breakdown.holderConcentration = scaleHolderConcentration(signals.top10HolderPct) * WEIGHTS.holderConcentration;
  breakdown.buyVelocity = scaleBuyVelocity(signals.buysFirst90s) * WEIGHTS.buyVelocity;
  breakdown.hasSocials = signals.hasSocials ? WEIGHTS.hasSocials : 0;

  total = Object.values(breakdown).reduce((a, b) => a + b, 0);

  // Hard disqualifiers regardless of score — these are the classic rug patterns
  const disqualified =
    signals.mintAuthorityRenounced === false && signals.freezeAuthorityRenounced === false;

  return {
    score: disqualified ? 0 : Math.round(total),
    breakdown,
    disqualified,
  };
}
