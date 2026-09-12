/**
 * telegramIntegration.js
 *
 * Wires together: wallet monitoring, Telegram alerts, and (optionally) your
 * existing scanner's score-passed events. Run this alongside your main
 * scanner process — it's independent enough to run as its own file/process
 * if that's simpler for your deployment.
 *
 * ENV VARS REQUIRED (add to your .env):
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_CHAT_ID
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (same meme-scanner project)
 *   SOLANA_RPC_URL  (your existing RPC endpoint, or a public one for a first test)
 */

const { Connection } = require("@solana/web3.js");
const { createClient } = require("@supabase/supabase-js");
const {
  sendWalletActivityAlert,
  sendTokenAlert,
  runCommandPolling,
} = require("./telegramNotifier");
const { startWalletMonitoring, resyncWalletMonitoring } = require("./walletMonitor");

async function main() {
  const {
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    SOLANA_RPC_URL,
  } = process.env;

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in env");
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const connection = new Connection(SOLANA_RPC_URL, "confirmed");

  // Wallet activity -> log to Supabase + Telegram alert
  const onWalletActivity = async (event) => {
    await supabase.from("wallet_activity").insert({
      wallet_address: event.walletAddress,
      mint_address: event.mintAddress,
      activity_type: event.type,
      amount: event.amount,
      signature: event.signature,
      occurred_at: event.timestamp,
    });

    await sendWalletActivityAlert(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, event);
  };

  let subscriptions = await startWalletMonitoring({ connection, supabase, onActivity: onWalletActivity });

  // Re-sync every 3 minutes to pick up /track and /untrack changes
  setInterval(async () => {
    subscriptions = await resyncWalletMonitoring({
      connection,
      supabase,
      onActivity: onWalletActivity,
      currentSubscriptions: subscriptions,
    });
  }, 3 * 60 * 1000);

  // Start listening for /track and /untrack commands (blocks forever by design)
  runCommandPolling(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, supabase);
}

/**
 * Call this from your EXISTING scoring pipeline, right after a token
 * clears both the preScoreFilter veto check and your score threshold —
 * this is the "your own signal system" alert from earlier in the
 * conversation, separate from wallet monitoring.
 *
 * Example, inside your existing detector loop:
 *   const { notifyTokenPassed } = require('./telegramIntegration');
 *   if (!filterResult.veto && score >= 70) {
 *     await notifyTokenPassed({ mintAddress, score, vetoReasons: [] });
 *   }
 */
async function notifyTokenPassed({ mintAddress, score, vetoReasons = [] }) {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
  return sendTokenAlert(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, {
    mintAddress,
    score,
    vetoReasons,
    links: {
      pumpfun: `https://pump.fun/${mintAddress}`,
      solscan: `https://solscan.io/token/${mintAddress}`,
    },
  });
}

module.exports = { main, notifyTokenPassed };

if (require.main === module) {
  main().catch((e) => {
    console.error("telegramIntegration fatal error:", e);
    process.exit(1);
  });
}
