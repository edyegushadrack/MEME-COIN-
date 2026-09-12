/**
 * walletMonitor.js
 *
 * Watches a list of Solana wallet addresses in real time (your friend's,
 * a KOL's, anyone's) and detects buy/sell activity by diffing token
 * balances before and after each transaction the wallet appears in.
 *
 * Uses `connection.onLogs(publicKey, callback)` — a WebSocket subscription
 * that fires whenever the given address appears in a transaction. This is
 * push-based, not polling, so alerts arrive within roughly a second of the
 * transaction landing, which matters if you want this to feel like the
 * "someone tells me where to buy" signal from a friend, just automated
 * and backed by your own logic.
 *
 * Requires: @solana/web3.js
 */

const { Connection, PublicKey } = require("@solana/web3.js");

/**
 * Pulls the wallet's SPL token balance changes for a given transaction
 * signature. Compares preTokenBalances vs postTokenBalances for the
 * specific wallet's owner, and infers buy/sell/unknown from the direction
 * of the largest balance change (ignoring SOL/wrapped-SOL itself, since
 * that's the payment side, not the token being bought/sold).
 */
async function classifyTransaction(connection, signature, walletAddress) {
  const tx = await connection.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
  });
  if (!tx || !tx.meta) return null;

  const { preTokenBalances = [], postTokenBalances = [] } = tx.meta;

  const relevantPre = preTokenBalances.filter((b) => b.owner === walletAddress);
  const relevantPost = postTokenBalances.filter((b) => b.owner === walletAddress);

  const changes = [];
  const seenMints = new Set([...relevantPre, ...relevantPost].map((b) => b.mint));

  for (const mint of seenMints) {
    const pre = relevantPre.find((b) => b.mint === mint);
    const post = relevantPost.find((b) => b.mint === mint);

    const preAmount = pre ? pre.uiTokenAmount.uiAmount || 0 : 0;
    const postAmount = post ? post.uiTokenAmount.uiAmount || 0 : 0;
    const delta = postAmount - preAmount;

    if (delta !== 0) {
      changes.push({ mint, preAmount, postAmount, delta });
    }
  }

  if (!changes.length) return null;

  // Ignore wrapped SOL (So111...1112) when picking the "main" change — that's
  // the payment side of the trade, not the token being bought or sold.
  const WSOL_MINT = "So11111111111111111111111111111111111111112";
  const nonWsolChanges = changes.filter((c) => c.mint !== WSOL_MINT);
  const primary = (nonWsolChanges.length ? nonWsolChanges : changes).sort(
    (a, b) => Math.abs(b.delta) - Math.abs(a.delta)
  )[0];

  return {
    signature,
    walletAddress,
    mintAddress: primary.mint,
    amount: Math.abs(primary.delta),
    type: primary.delta > 0 ? "buy" : "sell",
    timestamp: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
  };
}

/**
 * Subscribes to one wallet's activity. Calls `onActivity(event)` for each
 * classified buy/sell. Returns the subscription ID so you can unsubscribe
 * later (e.g. when a wallet is /untrack-ed).
 */
function subscribeWallet(connection, walletAddress, onActivity) {
  const pubkey = new PublicKey(walletAddress);

  const subscriptionId = connection.onLogs(
    pubkey,
    async (logInfo) => {
      if (logInfo.err) return; // skip failed transactions
      try {
        const event = await classifyTransaction(connection, logInfo.signature, walletAddress);
        if (event) onActivity(event);
      } catch (e) {
        console.error(`walletMonitor: failed to classify ${logInfo.signature}:`, e.message);
      }
    },
    "confirmed"
  );

  return subscriptionId;
}

/**
 * Loads the active tracked-wallet list from Supabase and subscribes to
 * all of them. Returns a map of walletAddress -> subscriptionId so the
 * caller can manage the lifecycle (e.g. re-sync every few minutes to pick
 * up wallets added via /track without restarting the whole process).
 */
async function startWalletMonitoring({ connection, supabase, onActivity }) {
  const { data: wallets, error } = await supabase
    .from("tracked_wallets")
    .select("wallet_address, label")
    .eq("active", true);

  if (error) throw new Error(`startWalletMonitoring: ${error.message}`);

  const subscriptions = new Map();

  for (const w of wallets) {
    const subId = subscribeWallet(connection, w.wallet_address, (event) =>
      onActivity({ ...event, walletLabel: w.label })
    );
    subscriptions.set(w.wallet_address, subId);
  }

  console.log(`walletMonitor: watching ${subscriptions.size} wallet(s)`);
  return subscriptions;
}

/**
 * Call periodically (e.g. every 2-5 minutes via setInterval) to pick up
 * wallets added or removed via the /track and /untrack Telegram commands
 * without restarting the scanner process.
 */
async function resyncWalletMonitoring({ connection, supabase, onActivity, currentSubscriptions }) {
  const { data: wallets, error } = await supabase
    .from("tracked_wallets")
    .select("wallet_address, label")
    .eq("active", true);

  if (error) {
    console.error("resyncWalletMonitoring:", error.message);
    return currentSubscriptions;
  }

  const activeAddresses = new Set(wallets.map((w) => w.wallet_address));

  // Unsubscribe wallets no longer active
  for (const [address, subId] of currentSubscriptions.entries()) {
    if (!activeAddresses.has(address)) {
      await connection.removeOnLogsListener(subId);
      currentSubscriptions.delete(address);
      console.log(`walletMonitor: stopped watching ${address}`);
    }
  }

  // Subscribe newly added wallets
  for (const w of wallets) {
    if (!currentSubscriptions.has(w.wallet_address)) {
      const subId = subscribeWallet(connection, w.wallet_address, (event) =>
        onActivity({ ...event, walletLabel: w.label })
      );
      currentSubscriptions.set(w.wallet_address, subId);
      console.log(`walletMonitor: started watching ${w.wallet_address}`);
    }
  }

  return currentSubscriptions;
}

module.exports = {
  classifyTransaction,
  subscribeWallet,
  startWalletMonitoring,
  resyncWalletMonitoring,
};
