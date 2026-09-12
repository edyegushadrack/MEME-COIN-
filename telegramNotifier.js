/**
 * telegramNotifier.js
 *
 * Minimal Telegram Bot API wrapper using plain fetch (Node 18+ has fetch
 * built in, no extra dependency needed). Two jobs: push formatted alerts
 * out, and (optionally) poll for incoming commands like /track <address>.
 *
 * Setup, one-time, outside this code:
 * 1. Message @BotFather on Telegram, /newbot, get a bot token
 * 2. Add the bot to a private chat/group with yourself, or just message it
 *    directly, then hit https://api.telegram.org/bot<TOKEN>/getUpdates to
 *    find your chat_id
 * 3. Put both in your .env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 *
 * Requires: Node 18+ (built-in fetch). No npm install needed for this file.
 */

const TELEGRAM_API_BASE = "https://api.telegram.org";

function apiUrl(botToken, method) {
  return `${TELEGRAM_API_BASE}/bot${botToken}/${method}`;
}

async function sendMessage(botToken, chatId, text, { parseMode = "Markdown" } = {}) {
  const res = await fetch(apiUrl(botToken, "sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error("Telegram sendMessage failed:", data.description);
  }
  return data;
}

/** Formats a scanner token alert (score passed threshold, forensics clean). */
function formatTokenAlert({ mintAddress, score, vetoReasons = [], links = {} }) {
  const lines = [
    `*New token alert* — score ${score}/100`,
    `Mint: \`${mintAddress}\``,
  ];
  if (vetoReasons.length) {
    lines.push(`⚠️ Veto flags present: ${vetoReasons.join(", ")}`);
  }
  if (links.pumpfun) lines.push(`[pump.fun](${links.pumpfun})`);
  if (links.solscan) lines.push(`[Solscan](${links.solscan})`);
  return lines.join("\n");
}

/** Formats a tracked-wallet buy/sell alert. */
function formatWalletActivityAlert({ walletAddress, walletLabel, type, mintAddress, amount, signature }) {
  const label = walletLabel ? `${walletLabel} (\`${walletAddress.slice(0, 6)}...\`)` : `\`${walletAddress}\``;
  const action = type === "buy" ? "🟢 BOUGHT" : type === "sell" ? "🔴 SOLD" : "↕️ MOVED";
  return [
    `*Wallet activity* — ${label}`,
    `${action} ${amount ?? "?"} of \`${mintAddress}\``,
    `[Tx](https://solscan.io/tx/${signature})`,
  ].join("\n");
}

async function sendTokenAlert(botToken, chatId, tokenAlertData) {
  return sendMessage(botToken, chatId, formatTokenAlert(tokenAlertData));
}

async function sendWalletActivityAlert(botToken, chatId, walletEventData) {
  return sendMessage(botToken, chatId, formatWalletActivityAlert(walletEventData));
}

/**
 * Minimal long-polling command handler for /track <address> [label] and
 * /untrack <address>. Run this in a loop (see the `runCommandPolling`
 * export) alongside your main scanner process, or as a separate small
 * process — either works since it only touches the `tracked_wallets` table.
 */
async function getUpdates(botToken, offset) {
  const res = await fetch(
    apiUrl(botToken, "getUpdates") + `?timeout=30&offset=${offset}`
  );
  return res.json();
}

async function handleCommand(supabase, message) {
  const text = (message.text || "").trim();
  if (text.startsWith("/track")) {
    const parts = text.split(/\s+/);
    const address = parts[1];
    const label = parts.slice(2).join(" ") || null;
    if (!address) return "Usage: /track <wallet_address> [label]";

    const { error } = await supabase
      .from("tracked_wallets")
      .upsert({ wallet_address: address, label, active: true }, { onConflict: "wallet_address" });

    return error ? `Failed to track: ${error.message}` : `Now tracking \`${address}\`${label ? ` (${label})` : ""}`;
  }

  if (text.startsWith("/untrack")) {
    const address = text.split(/\s+/)[1];
    if (!address) return "Usage: /untrack <wallet_address>";

    const { error } = await supabase
      .from("tracked_wallets")
      .update({ active: false })
      .eq("wallet_address", address);

    return error ? `Failed to untrack: ${error.message}` : `Stopped tracking \`${address}\``;
  }

  return null; // not a recognized command, ignore
}

async function runCommandPolling(botToken, chatId, supabase, { pollIntervalMs = 2000 } = {}) {
  let offset = 0;
  console.log("Telegram command polling started (/track, /untrack)...");

  // Intentionally a simple infinite loop with await — run this as its own
  // process or in the background of your main app, not blocking the
  // scanner's own event loop.
  while (true) {
    try {
      const updates = await getUpdates(botToken, offset);
      if (updates.ok && updates.result.length) {
        for (const update of updates.result) {
          offset = update.update_id + 1;
          if (update.message && String(update.message.chat.id) === String(chatId)) {
            const reply = await handleCommand(supabase, update.message);
            if (reply) await sendMessage(botToken, chatId, reply);
          }
        }
      }
    } catch (e) {
      console.error("Telegram polling error:", e.message);
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }
}

module.exports = {
  sendMessage,
  sendTokenAlert,
  sendWalletActivityAlert,
  formatTokenAlert,
  formatWalletActivityAlert,
  runCommandPolling,
};
