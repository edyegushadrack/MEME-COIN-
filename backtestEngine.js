/**
 * backtestEngine.js
 *
 * Pure simulation logic — no network, no Supabase. Takes one token's
 * historical price series and simulates the exit rules discussed:
 * scaled take-profits, a decay-triggered trailing stop, and a hard
 * time-based exit. Returns one trade result. `runBacktest.js` calls this
 * once per historical token and aggregates the results.
 *
 * This is deliberately decoupled from data-fetching so you can test the
 * exit logic itself against synthetic price series before trusting it
 * against real (messier, gappier) historical data.
 */

/**
 * @param {Object} params
 * @param {Array<{timestamp: number, price: number}>} params.priceSeries
 *   Ordered oldest-to-newest. `timestamp` in ms.
 * @param {number} params.entryPrice
 * @param {number} params.entryTimestamp
 * @param {Object} [params.rules] - exit rule configuration
 * @param {Array<{multiple: number, sellFraction: number}>} [params.rules.scaledTakeProfits]
 *   e.g. [{multiple: 2, sellFraction: 0.4}, {multiple: 5, sellFraction: 0.3}]
 *   Sells that fraction of the ORIGINAL position when price first hits
 *   entryPrice * multiple. Remaining fraction rides the trailing stop.
 * @param {number} [params.rules.trailingStopPct] - e.g. 0.35 means exit the
 *   remainder if price drops 35% from its peak since entry.
 * @param {number} [params.rules.maxHoldMs] - hard time-based exit if the
 *   position hasn't hit any take-profit level within this window.
 * @param {number} [params.rules.hardStopPct] - e.g. 0.30 means exit
 *   everything immediately if price drops 30% below entry, regardless of
 *   whether any take-profit has fired yet (protects the un-scaled-out
 *   portion of a position that never took off).
 */
function simulateTrade({
  priceSeries,
  entryPrice,
  entryTimestamp,
  rules = {},
}) {
  const {
    scaledTakeProfits = [
      { multiple: 2, sellFraction: 0.4 },
      { multiple: 5, sellFraction: 0.3 },
    ],
    trailingStopPct = 0.35,
    maxHoldMs = 24 * 60 * 60 * 1000, // 24h default
    hardStopPct = 0.4,
  } = rules;

  let remainingFraction = 1.0;
  let peakPrice = entryPrice;
  let realizedPnlFraction = 0; // weighted sum of (multiple-1)*sellFraction, realized so far
  const firedTakeProfits = new Set();
  const events = [];

  const relevantSeries = priceSeries.filter((p) => p.timestamp >= entryTimestamp);

  for (const point of relevantSeries) {
    const { timestamp, price } = point;
    const elapsed = timestamp - entryTimestamp;
    if (price > peakPrice) peakPrice = price;

    // Hard stop: protects against a position that never took off
    if (remainingFraction > 0 && price <= entryPrice * (1 - hardStopPct) && firedTakeProfits.size === 0) {
      const pnlOnRemainder = (price / entryPrice - 1) * remainingFraction;
      realizedPnlFraction += pnlOnRemainder;
      events.push({ type: "hard_stop", timestamp, price });
      remainingFraction = 0;
      break;
    }

    // Scaled take-profits, in ascending multiple order
    for (const tp of [...scaledTakeProfits].sort((a, b) => a.multiple - b.multiple)) {
      if (firedTakeProfits.has(tp.multiple)) continue;
      if (price >= entryPrice * tp.multiple) {
        const sellFraction = Math.min(tp.sellFraction, remainingFraction);
        realizedPnlFraction += (tp.multiple - 1) * sellFraction;
        remainingFraction -= sellFraction;
        firedTakeProfits.add(tp.multiple);
        events.push({ type: "take_profit", multiple: tp.multiple, timestamp, price, sellFraction });
      }
    }

    // Trailing stop on whatever's left, only active once at least one TP fired
    if (remainingFraction > 0 && firedTakeProfits.size > 0) {
      const dropFromPeak = 1 - price / peakPrice;
      if (dropFromPeak >= trailingStopPct) {
        const pnlOnRemainder = (price / entryPrice - 1) * remainingFraction;
        realizedPnlFraction += pnlOnRemainder;
        events.push({ type: "trailing_stop", timestamp, price, sellFraction: remainingFraction });
        remainingFraction = 0;
        break;
      }
    }

    // Time-based exit: thesis failed if nothing's fired within the window
    if (remainingFraction > 0 && firedTakeProfits.size === 0 && elapsed >= maxHoldMs) {
      const pnlOnRemainder = (price / entryPrice - 1) * remainingFraction;
      realizedPnlFraction += pnlOnRemainder;
      events.push({ type: "time_exit", timestamp, price, sellFraction: remainingFraction });
      remainingFraction = 0;
      break;
    }
  }

  // Series ran out (token effectively went to zero / delisted / no more data)
  // with a position still open — mark remaining at last known price (or zero
  // if no more data at all, which for a dead meme coin is the honest default).
  if (remainingFraction > 0) {
    const lastPrice = relevantSeries.length ? relevantSeries[relevantSeries.length - 1].price : 0;
    const pnlOnRemainder = (lastPrice / entryPrice - 1) * remainingFraction;
    realizedPnlFraction += pnlOnRemainder;
    events.push({ type: "series_end", price: lastPrice, sellFraction: remainingFraction });
  }

  return {
    entryPrice,
    entryTimestamp,
    pnlFraction: realizedPnlFraction, // e.g. 0.8 = +80% on the whole position
    win: realizedPnlFraction > 0,
    events,
    exitReason: events.length ? events[events.length - 1].type : "no_data",
  };
}

module.exports = { simulateTrade };
