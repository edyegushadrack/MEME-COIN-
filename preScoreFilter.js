/**
 * preScoreFilter.js
 *
 * The glue layer. Call this BETWEEN your pool/token detector and your
 * existing scoreToken() function. It runs contract forensics + bundler
 * detection and returns a single veto/pass decision, so your scoring
 * engine only ever sees tokens that passed the loss-prevention layer.
 *
 * This is intentionally a hard filter, not a soft score input — per the
 * earlier discussion, contract-level red flags (live mint authority,
 * known-rug deployer, bundled fake volume) are near-certain losses, not
 * "slightly lower odds." Mixing them into the 0-100 score would let a
 * strong social/momentum score paper over a structurally bad contract.
 *
 * Usage in your existing detector loop:
 *
 *   const { preScoreFilter } = require('./preScoreFilter');
 *   const filterResult = await preScoreFilter({ connection, supabase, tokenEvent });
 *   if (filterResult.veto) {
 *     await logVetoedToken(supabase, filterResult); // cheap insert, don't score
 *     return;
 *   }
 *   const score = await scoreToken(tokenEvent); // your existing scoring engine
 */

const { runForensics } = require("./contractForensics");
const { runBundlerDetection } = require("./bundlerDetection");

/**
 * @param {Object} params
 * @param {import('@solana/web3.js').Connection} params.connection
 * @param {Object} params.supabase - Supabase client
 * @param {Object} params.tokenEvent - shape depends on your detector, expected:
 *   {
 *     mintAddress: string,
 *     deployerAddress: string,
 *     poolCreationSlot: number,
 *     earlyBuyTransactions: [{ slot: number, buyerAddress: string }]
 *   }
 */
async function preScoreFilter({ connection, supabase, tokenEvent }) {
  const { mintAddress, deployerAddress, poolCreationSlot, earlyBuyTransactions = [] } = tokenEvent;

  const [forensics, bundler] = await Promise.all([
    runForensics({ connection, supabase, mintAddress, deployerAddress }),
    poolCreationSlot != null
      ? runBundlerDetection({
          connection,
          poolCreationSlot,
          buyTransactions: earlyBuyTransactions,
        })
      : Promise.resolve(null),
  ]);

  const veto = forensics.veto || (bundler && bundler.veto);

  const vetoReasons = [
    ...forensics.vetoReasons,
    ...(bundler && bundler.veto
      ? [
          bundler.bundleResult.likelyBundled ? "bundled_buys_detected" : null,
          bundler.fundingResult && bundler.fundingResult.likelyCommonEntity
            ? "common_funding_cluster"
            : null,
        ].filter(Boolean)
      : []),
  ];

  return {
    mintAddress,
    veto,
    vetoReasons,
    forensics,
    bundler,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Logs a vetoed token to Supabase so you keep a record of what got
 * filtered and why — this is also your future backtest data for tuning
 * veto thresholds (e.g. is `uniqueBuyers.size >= 8` actually the right
 * bundling cutoff, or too aggressive/lenient?).
 *
 * Expects a `vetoed_tokens` table with columns:
 * mint_address, veto_reasons (text[]), checked_at, details (jsonb)
 */
async function logVetoedToken(supabase, filterResult) {
  const { error } = await supabase.from("vetoed_tokens").insert({
    mint_address: filterResult.mintAddress,
    veto_reasons: filterResult.vetoReasons,
    checked_at: filterResult.checkedAt,
    details: {
      forensics: filterResult.forensics,
      bundler: filterResult.bundler,
    },
  });

  if (error) {
    console.error("Failed to log vetoed token:", error.message);
  }
}

module.exports = { preScoreFilter, logVetoedToken };
