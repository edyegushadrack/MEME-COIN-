/**
 * bondingCurveWatcher.js
 *
 * Replaces PumpPortal's subscribeTokenTrade (which requires a funded API
 * key, 0.02+ SOL) with direct on-chain watching via the RPC connection we
 * already have (Helius, free tier). Same underlying technique already
 * proven working in monitors/walletMonitor.js — connection.onLogs on a
 * specific account — just applied to each token's bonding-curve PDA
 * instead of a wallet address.
 *
 * IMPORTANT: this subscribes PER-MINT to that mint's own bonding-curve
 * account, not to the whole pump.fun program. Subscribing to the whole
 * program would fire on every trade for every token on the platform
 * globally (extremely high volume), burning through RPC credits fast for
 * data we don't need. Per-mint subscriptions only fire for transactions
 * touching that specific token, exactly like watching one wallet.
 *
 * Program ID and instruction discriminators confirmed against official
 * Pump.fun program documentation (Solana Tracker's Anchor IDL reference).
 */

import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

export const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// Simple concurrency limiter: at most N getParsedTransaction calls in
// flight at once, queueing the rest. Prevents bursting past the Helius
// free tier's per-second rate limit when many bonding curves are active
// at the same time — each individual subscription is cheap, but dozens
// firing close together adds up fast without this.
const MAX_CONCURRENT_LOOKUPS = 4;
let activeLookups = 0;
const queue = [];

function runQueued() {
  if (activeLookups >= MAX_CONCURRENT_LOOKUPS || queue.length === 0) return;
  activeLookups++;
  const { task, resolve, reject } = queue.shift();
  task()
    .then(resolve, reject)
    .finally(() => {
      activeLookups--;
      runQueued();
    });
}

function withConcurrencyLimit(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    runQueued();
  });
}

async function getParsedTransactionWithRetry(connection, signature, { retries = 3 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await withConcurrencyLimit(() =>
        connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 })
      );
    } catch (err) {
      const isRateLimit = err.message?.includes('429') || err.message?.includes('Too Many Requests');
      if (isRateLimit && attempt < retries) {
        const delay = 500 * 2 ** attempt; // 500ms, 1s, 2s, 4s
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

function matchesDiscriminator(dataBuffer, discriminator) {
  return dataBuffer.length >= 8 && dataBuffer.subarray(0, 8).equals(discriminator);
}

/** Derives a token's bonding-curve PDA — the account whose activity we subscribe to. */
export function bondingCurvePda(mintAddress) {
  const mint = new PublicKey(mintAddress);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMP_PROGRAM_ID
  )[0];
}

/**
 * Parses a confirmed transaction that touched a bonding-curve account and,
 * if it's a buy or sell instruction, returns the trade details. Returns
 * null for anything else (e.g. a create, or an unrelated instruction).
 */
async function parseTradeTransaction(connection, signature, mintAddress) {
  const tx = await getParsedTransactionWithRetry(connection, signature);
  if (!tx || !tx.meta || tx.meta.err) return null;

  const allInstructions = [
    ...tx.transaction.message.instructions,
    ...(tx.meta.innerInstructions || []).flatMap((i) => i.instructions),
  ];

  let tradeType = null;
  for (const ix of allInstructions) {
    if (!ix.programId || ix.programId.toBase58() !== PUMP_PROGRAM_ID.toBase58()) continue;
    if (!ix.data) continue; // pump.fun is an unknown program to web3.js's parser,
    // so its instructions come back as PartiallyDecodedInstruction with base58 `data`.
    const raw = Buffer.from(bs58.decode(ix.data));
    if (matchesDiscriminator(raw, BUY_DISCRIMINATOR)) {
      tradeType = 'buy';
      break;
    }
    if (matchesDiscriminator(raw, SELL_DISCRIMINATOR)) {
      tradeType = 'sell';
      break;
    }
  }

  if (!tradeType) return null;

  const buyer =
    tx.transaction.message.accountKeys.find((a) => a.signer)?.pubkey?.toBase58() ??
    tx.transaction.message.accountKeys[0]?.pubkey?.toBase58();
  if (!buyer) return null;

  // Token amount: net change in the trader's own balance of this specific mint.
  const { preTokenBalances = [], postTokenBalances = [] } = tx.meta;
  const pre = preTokenBalances.find((b) => b.mint === mintAddress && b.owner === buyer);
  const post = postTokenBalances.find((b) => b.mint === mintAddress && b.owner === buyer);
  const preAmount = pre ? pre.uiTokenAmount.uiAmount || 0 : 0;
  const postAmount = post ? post.uiTokenAmount.uiAmount || 0 : 0;
  const amount = Math.abs(postAmount - preAmount);

  return { mintAddress, buyer, type: tradeType, amount, signature };
}

/**
 * Subscribes to one mint's bonding-curve account. Calls onTrade(event)
 * for each buy/sell detected. Returns the subscription ID so the caller
 * can unsubscribe (connection.removeOnLogsListener) once the tracking
 * window closes — same lifecycle pattern as walletMonitor.js.
 */
export function subscribeToTokenTrades(connection, mintAddress, onTrade) {
  const curveAddress = bondingCurvePda(mintAddress);

  return connection.onLogs(
    curveAddress,
    async (logInfo) => {
      if (logInfo.err) return;
      try {
        const event = await parseTradeTransaction(connection, logInfo.signature, mintAddress);
        if (event) onTrade(event);
      } catch (err) {
        console.error(`[bondingCurveWatcher] parse error for ${mintAddress}:`, err.message);
      }
    },
    'confirmed'
  );
}
