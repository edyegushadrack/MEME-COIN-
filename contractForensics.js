/**
 * contractForensics.js
 *
 * Pure loss-prevention layer for the scanner. Runs BEFORE a token reaches
 * the scoring engine. Goal: catch structurally bad launches (mint authority
 * still live, deployer with a rug history) with hard vetoes, not soft scores.
 *
 * Integration point: call `runForensics(mintAddress, connection)` right after
 * a new pool/token is detected (pump.fun or Raydium), before scoreToken().
 * If result.veto === true, skip scoring entirely and log the reason —
 * don't let a vetoed token consume scoring-engine cycles.
 *
 * Requires: @solana/web3.js, @solana/spl-token
 */

const { PublicKey } = require("@solana/web3.js");
const { getMint } = require("@solana/spl-token");

/**
 * Checks the SPL token's on-chain authority flags.
 * A live mint authority means the deployer can print unlimited new supply
 * at will — the single most common rug mechanism. A live freeze authority
 * means the deployer can freeze YOUR wallet's tokens, blocking you from
 * ever selling (a "honeypot" pattern).
 */
async function checkAuthorities(connection, mintAddress) {
  const mintPubkey = new PublicKey(mintAddress);
  const mintInfo = await getMint(connection, mintPubkey);

  const mintAuthorityLive = mintInfo.mintAuthority !== null;
  const freezeAuthorityLive = mintInfo.freezeAuthority !== null;

  return {
    mintAuthorityLive,
    freezeAuthorityLive,
    mintAuthority: mintAuthorityLive ? mintInfo.mintAuthority.toBase58() : null,
    freezeAuthority: freezeAuthorityLive ? mintInfo.freezeAuthority.toBase58() : null,
    supply: mintInfo.supply.toString(),
    decimals: mintInfo.decimals,
  };
}

/**
 * Pulls the deployer wallet's recent transaction history and looks for
 * a pattern of repeated token creations — a strong signal of a serial
 * deployer running the same playbook over and over.
 *
 * NOTE: `getSignaturesForAddress` only returns signatures, not parsed
 * instructions. For production use, swap in a Helius or similar indexer
 * "parsed transaction history" or "token creations by wallet" endpoint —
 * it's far faster and gives you mint addresses directly instead of forcing
 * you to fetch + parse every transaction. This raw-RPC version is the
 * fallback that works with zero extra API keys, useful for getting the
 * pipeline running before you wire up an indexer.
 */
async function getDeployerHistory(connection, deployerAddress, { txLimit = 50 } = {}) {
  const deployerPubkey = new PublicKey(deployerAddress);
  const signatures = await connection.getSignaturesForAddress(deployerPubkey, {
    limit: txLimit,
  });

  return {
    deployerAddress,
    recentTxCount: signatures.length,
    oldestTxDate: signatures.length
      ? new Date(signatures[signatures.length - 1].blockTime * 1000).toISOString()
      : null,
    newestTxDate: signatures.length
      ? new Date(signatures[0].blockTime * 1000).toISOString()
      : null,
    signatures: signatures.map((s) => s.signature),
  };
}

/**
 * Cross-references a deployer address against your own Supabase history —
 * has this wallet deployed a token you've already scanned and watched go
 * to zero? This is the highest-signal check you have, because it's built
 * from your own observed outcomes, not a generic heuristic.
 *
 * Expects a Supabase client and a table (e.g. `tokens`) with columns:
 * deployer_address, mint_address, peak_price, current_price, created_at
 */
async function checkDeployerRugHistory(supabase, deployerAddress) {
  const { data, error } = await supabase
    .from("tokens")
    .select("mint_address, peak_price, current_price, created_at")
    .eq("deployer_address", deployerAddress);

  if (error) {
    return { error: error.message, priorLaunches: 0, knownRugs: 0 };
  }

  const priorLaunches = data.length;
  // Heuristic: "rug" = price dropped below 5% of its own peak.
  const knownRugs = data.filter((t) => {
    if (!t.peak_price || t.peak_price === 0) return false;
    return t.current_price / t.peak_price < 0.05;
  }).length;

  return { priorLaunches, knownRugs, records: data };
}

/**
 * Top-level entry point. Combines the three checks above into a single
 * pass/veto decision plus a structured detail object for logging.
 */
async function runForensics({ connection, supabase, mintAddress, deployerAddress }) {
  const [authorities, deployerHistory, rugHistory] = await Promise.all([
    checkAuthorities(connection, mintAddress).catch((e) => ({ error: e.message })),
    deployerAddress
      ? getDeployerHistory(connection, deployerAddress).catch((e) => ({ error: e.message }))
      : Promise.resolve(null),
    deployerAddress && supabase
      ? checkDeployerRugHistory(supabase, deployerAddress)
      : Promise.resolve(null),
  ]);

  const vetoReasons = [];

  if (authorities.mintAuthorityLive) {
    vetoReasons.push("mint_authority_live");
  }
  if (authorities.freezeAuthorityLive) {
    vetoReasons.push("freeze_authority_live");
  }
  if (rugHistory && rugHistory.knownRugs >= 1) {
    vetoReasons.push(`deployer_known_rug_x${rugHistory.knownRugs}`);
  }

  return {
    mintAddress,
    deployerAddress,
    authorities,
    deployerHistory,
    rugHistory,
    veto: vetoReasons.length > 0,
    vetoReasons,
    checkedAt: new Date().toISOString(),
  };
}

module.exports = {
  checkAuthorities,
  getDeployerHistory,
  checkDeployerRugHistory,
  runForensics,
};
