/**
 * walletMonitor.js
 *
 * Watches Solana wallets in real time (a friend's, a KOL's, one you
 * discovered yourself) and reports buy/sell activity by diffing token
 * balances around each transaction the wallet appears in.
 *
 * Uses `connection.onLogs(publicKey, callback)` — a push-based WebSocket
 * subscription, not polling, so activity shows up within about a second.
 *
 * This is intentionally NOT foreign-keyed to `launches` — a tracked
 * wallet can buy tokens your scanner never detected/scored (below your
 * score floor, or on a source you don't cover yet), and that's still
 * useful information, not an error case.
 */

import { PublicKey } from '@solana/web3.js';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export async function classifyTransaction(connection, signature, walletAddress) {
  const tx = await connection.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
  });
  if (!tx || !tx.meta) return null;

  const { preTokenBalances = [], postTokenBalances = [] } = tx.meta;
  const relevantPre = preTokenBalances.filter((b) => b.owner === walletAddress);
  const relevantPost = postTokenBalances.filter((b) => b.owner === walletAddress);

  const seenMints = new Set([...relevantPre, ...relevantPost].map((b) => b.mint));
  const changes = [];

  for (const mint of seenMints) {
    const pre = relevantPre.find((b) => b.mint === mint);
    const post = relevantPost.find((b) => b.mint === mint);
    const preAmount = pre ? pre.uiTokenAmount.uiAmount || 0 : 0;
    const postAmount = post ? post.uiTokenAmount.uiAmount || 0 : 0;
    const delta = postAmount - preAmount;
    if (delta !== 0) changes.push({ mint, delta });
  }

  if (!changes.length) return null;

  const nonWsol = changes.filter((c) => c.mint !== WSOL_MINT);
  const primary = (nonWsol.length ? nonWsol : changes).sort(
    (a, b) => Math.abs(b.delta) - Math.abs(a.delta)
  )[0];

  return {
    signature,
    walletAddress,
    mintAddress: primary.mint,
    amount: Math.abs(primary.delta),
    type: primary.delta > 0 ? 'buy' : 'sell',
    timestamp: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
  };
}

export function subscribeWallet(connection, walletAddress, onActivity) {
  const pubkey = new PublicKey(walletAddress);

  return connection.onLogs(
    pubkey,
    async (logInfo) => {
      if (logInfo.err) return;
      try {
        const event = await classifyTransaction(connection, logInfo.signature, walletAddress);
        if (event) onActivity(event);
      } catch (err) {
        console.error(`[walletMonitor] failed to classify ${logInfo.signature}:`, err.message);
      }
    },
    'confirmed'
  );
}

export async function startWalletMonitoring({ connection, supabase, onActivity }) {
  const { data: wallets, error } = await supabase
    .from('tracked_wallets')
    .select('wallet_address, label')
    .eq('active', true);

  if (error) throw new Error(`startWalletMonitoring: ${error.message}`);

  const subscriptions = new Map();
  for (const w of wallets) {
    const subId = subscribeWallet(connection, w.wallet_address, (event) =>
      onActivity({ ...event, walletLabel: w.label })
    );
    subscriptions.set(w.wallet_address, subId);
  }

  console.log(`[walletMonitor] watching ${subscriptions.size} wallet(s)`);
  return subscriptions;
}

export async function resyncWalletMonitoring({ connection, supabase, onActivity, currentSubscriptions }) {
  const { data: wallets, error } = await supabase
    .from('tracked_wallets')
    .select('wallet_address, label')
    .eq('active', true);

  if (error) {
    console.error('[walletMonitor] resync error:', error.message);
    return currentSubscriptions;
  }

  const activeAddresses = new Set(wallets.map((w) => w.wallet_address));

  for (const [address, subId] of currentSubscriptions.entries()) {
    if (!activeAddresses.has(address)) {
      await connection.removeOnLogsListener(subId);
      currentSubscriptions.delete(address);
      console.log(`[walletMonitor] stopped watching ${address}`);
    }
  }

  for (const w of wallets) {
    if (!currentSubscriptions.has(w.wallet_address)) {
      const subId = subscribeWallet(connection, w.wallet_address, (event) =>
        onActivity({ ...event, walletLabel: w.label })
      );
      currentSubscriptions.set(w.wallet_address, subId);
      console.log(`[walletMonitor] started watching ${w.wallet_address}`);
    }
  }

  return currentSubscriptions;
}
