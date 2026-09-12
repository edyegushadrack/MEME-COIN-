/**
 * runBacktest.js
 *
 * Orchestrates the backtest: pulls historical tokens (with the score your
 * scoring engine gave them at detection time) and their price history from
 * Supabase, filters to tokens that would have passed your score threshold,
 * runs each through backtestEngine.simulateTrade(), and hands the array of
 * trade results to expectancyStats.js.
 *
 * *** ADAPTER SECTION — EDIT THIS TO MATCH YOUR ACTUAL SCHEMA ***
 * I don't have your live Supabase schema, so the two fetch functions below
 * are written against a reasonable guess (a `tokens` table with a `score`
 * column set at detection time, and a `price_snapshots` table for the
 * time series). Adjust table/column names to match what your scanner
 * actually logs — the rest of the pipeline (simulateTrade, expectancy
 * stats) doesn't care about the schema, only these two functions do.
 */

const { simulateTrade } = require("./backtestEngine");
const { computeExpectancy } = require("./expectancyStats");

/**
 * Fetches tokens that were scored at detection time and have enough
 * elapsed time since to have a meaningful price history (e.g. detected
 * more than 48h ago, so the backtest isn't cut off mid-trade).
 *
 * EDIT: adjust to your `tokens` table's real columns. If your scanner
 * doesn't yet store the score it gave each token AT DETECTION TIME
 * (as opposed to a live/current score), this is the first schema gap to
 * close — the backtest is only honest if it uses the score you would have
 * actually seen at the moment of the entry decision, not a score computed
 * with hindsight.
 */
async function fetchHistoricalTokens(supabase, { minAgeHours = 48, limit = 500 } = {}) {
  const cutoff = new Date(Date.now() - minAgeHours * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("tokens")
    .select("mint_address, score, created_at")
    .lt("created_at", cutoff)
    .not("score", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`fetchHistoricalTokens: ${error.message}`);
  return data;
}

/**
 * Fetches the price time series for one token.
 *
 * EDIT: adjust to your `price_snapshots` (or equivalent) table's real
 * columns and table name.
 */
async function fetchPriceSeries(supabase, mintAddress) {
  const { data, error } = await supabase
    .from("price_snapshots")
    .select("price, recorded_at")
    .eq("mint_address", mintAddress)
    .order("recorded_at", { ascending: true });

  if (error) throw new Error(`fetchPriceSeries: ${error.message}`);

  return data.map((row) => ({
    timestamp: new Date(row.recorded_at).getTime(),
    price: row.price,
  }));
}

/**
 * Runs the full backtest.
 *
 * @param {Object} params
 * @param {Object} params.supabase
 * @param {number} params.scoreThreshold - only "trade" tokens that scored
 *   at or above this at detection time. Run this multiple times with
 *   different thresholds (e.g. 60, 70, 80) to see where the score actually
 *   starts correlating with real outcomes.
 * @param {Object} [params.exitRules] - passed straight to simulateTrade
 */
async function runBacktest({ supabase, scoreThreshold = 70, exitRules = {} }) {
  const tokens = await fetchHistoricalTokens(supabase);
  const eligible = tokens.filter((t) => t.score >= scoreThreshold);

  const trades = [];
  const skipped = [];

  for (const token of eligible) {
    const priceSeries = await fetchPriceSeries(supabase, token.mint_address);

    if (!priceSeries.length) {
      skipped.push({ mint_address: token.mint_address, reason: "no_price_data" });
      continue;
    }

    const entryPrice = priceSeries[0].price;
    const entryTimestamp = priceSeries[0].timestamp;

    const result = simulateTrade({
      priceSeries,
      entryPrice,
      entryTimestamp,
      rules: exitRules,
    });

    trades.push({
      mintAddress: token.mint_address,
      scoreAtDetection: token.score,
      ...result,
    });
  }

  const stats = computeExpectancy(trades);

  return {
    scoreThreshold,
    totalCandidates: tokens.length,
    eligibleCount: eligible.length,
    tradedCount: trades.length,
    skippedCount: skipped.length,
    skipped,
    trades,
    stats,
  };
}

module.exports = { runBacktest, fetchHistoricalTokens, fetchPriceSeries };
