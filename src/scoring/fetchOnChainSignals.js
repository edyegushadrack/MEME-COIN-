import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../config.js';

const connection = new Connection(config.rpcUrl, 'confirmed');

/**
 * Pulls mint authority / freeze authority / top holder concentration for a
 * given mint address. Wrapped in try/catch per-field since a free RPC will
 * occasionally rate-limit or timeout — we don't want one failed field to
 * throw away the whole scoring pass.
 */
export async function fetchOnChainSignals(mintAddress) {
  const signals = {
    mintAuthorityRenounced: null,
    freezeAuthorityRenounced: null,
    top10HolderPct: null,
  };

  try {
    const mintPubkey = new PublicKey(mintAddress);
    const info = await connection.getParsedAccountInfo(mintPubkey);
    const parsed = info?.value?.data?.parsed?.info;
    if (parsed) {
      signals.mintAuthorityRenounced = parsed.mintAuthority === null;
      signals.freezeAuthorityRenounced = parsed.freezeAuthority === null;
    }
  } catch (err) {
    console.warn(`[signals] mint/freeze lookup failed for ${mintAddress}:`, err.message);
  }

  try {
    const mintPubkey = new PublicKey(mintAddress);
    const largest = await connection.getTokenLargestAccounts(mintPubkey);
    const supplyInfo = await connection.getTokenSupply(mintPubkey);
    const totalSupply = Number(supplyInfo?.value?.uiAmount ?? 0);
    if (totalSupply > 0 && largest?.value?.length) {
      const top10 = largest.value
        .slice(0, 10)
        .reduce((sum, acc) => sum + Number(acc.uiAmount ?? 0), 0);
      signals.top10HolderPct = (top10 / totalSupply) * 100;
    }
  } catch (err) {
    console.warn(`[signals] holder concentration lookup failed for ${mintAddress}:`, err.message);
  }

  return signals;
}
