/**
 * expectancyStats.js
 *
 * Turns an array of trade results (from runBacktest.js) into the numbers
 * that actually answer "does this system have an edge": win rate, average
 * win/loss size, expectancy per trade, total return, and a simple max
 * drawdown on the equity curve if you traded every eligible signal at
 * equal size.
 */

function computeExpectancy(trades) {
  if (!trades.length) {
    return {
      tradeCount: 0,
      winRate: null,
      avgWinPct: null,
      avgLossPct: null,
      expectancyPct: null,
      totalReturnPct: null,
      maxDrawdownPct: null,
      note: "No trades to analyze — check score threshold or historical data availability.",
    };
  }

  const wins = trades.filter((t) => t.pnlFraction > 0);
  const losses = trades.filter((t) => t.pnlFraction <= 0);

  const winRate = wins.length / trades.length;
  const avgWinPct = wins.length
    ? (wins.reduce((sum, t) => sum + t.pnlFraction, 0) / wins.length) * 100
    : 0;
  const avgLossPct = losses.length
    ? (losses.reduce((sum, t) => sum + t.pnlFraction, 0) / losses.length) * 100
    : 0;

  // Expectancy per trade, expressed as % return per unit risked, assuming
  // equal position size across all trades (the simplifying assumption —
  // real position sizing, e.g. fractional-Kelly, comes after this number
  // looks good enough to act on).
  const expectancyPct = winRate * avgWinPct + (1 - winRate) * avgLossPct;

  // Simple equal-weighted equity curve to get a max drawdown figure.
  let equity = 1.0;
  let peak = 1.0;
  let maxDrawdownPct = 0;
  const equityCurve = [];

  for (const t of trades) {
    equity *= 1 + t.pnlFraction;
    equityCurve.push(equity);
    if (equity > peak) peak = equity;
    const drawdown = (peak - equity) / peak;
    if (drawdown > maxDrawdownPct) maxDrawdownPct = drawdown;
  }

  const totalReturnPct = (equity - 1) * 100;

  const exitReasonBreakdown = trades.reduce((acc, t) => {
    acc[t.exitReason] = (acc[t.exitReason] || 0) + 1;
    return acc;
  }, {});

  return {
    tradeCount: trades.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRate: Number((winRate * 100).toFixed(1)),
    avgWinPct: Number(avgWinPct.toFixed(1)),
    avgLossPct: Number(avgLossPct.toFixed(1)),
    expectancyPct: Number(expectancyPct.toFixed(2)),
    totalReturnPct: Number(totalReturnPct.toFixed(1)),
    maxDrawdownPct: Number((maxDrawdownPct * 100).toFixed(1)),
    exitReasonBreakdown,
    equityCurve,
  };
}

module.exports = { computeExpectancy };
