/**
 * telegramNotifier.js
 *
 * Minimal Telegram Bot API wrapper using Node's built-in fetch (Node 18+).
 * No extra dependency needed for sending; `node-fetch` (already a
 * dependency for trackPrices.js) covers getUpdates too if your Node
 * version is older.
 *
 * One-time setup:
 * 1. Message @BotFather on Telegram, /newbot, save the token
 * 2. Message your new bot once, then visit
 *    https://api.telegram.org/bot<TOKEN>/getUpdates to find your chat_id
 * 3. Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to .env
 */

import { config } from '../config.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

function apiUrl(method) {
  return `${TELEGRAM_API_BASE}/bot${config.telegramBotToken}/${method}`;
}

export async function sendMessage(text, { parseMode = 'Markdown' } = {}) {
  if (!config.telegramBotToken || !config.telegramChatId) return null;

  try {
    const res = await fetch(apiUrl('sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json();
    if (!data.ok) console.error('[telegram] sendMessage failed:', data.description);
    return data;
  } catch (err) {
    console.error('[telegram] sendMessage error:', err.message);
    return null;
  }
}

/** Alert for a launch that cleared the paper-buy score threshold. */
export function formatLaunchAlert({ mint_address, symbol, score, score_breakdown, market_cap_sol }) {
  const topSignals = Object.entries(score_breakdown || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${v.toFixed(1)}`)
    .join(', ');

  const marketCapLine =
    market_cap_sol != null ? `Market cap: ${market_cap_sol.toFixed(1)} SOL\n` : '';

  return [
    `*New paper-buy candidate* — score ${score}/100`,
    `${symbol ? symbol + ' — ' : ''}\`${mint_address}\``,
    `${marketCapLine}Top signals: ${topSignals}`,
    `[pump.fun](https://pump.fun/${mint_address}) | [Solscan](https://solscan.io/token/${mint_address})`,
  ].join('\n');
}

export async function sendLaunchAlert(launch) {
  return sendMessage(formatLaunchAlert(launch));
}

/** Alert for a launch vetoed by bundler detection before scoring. */
export function formatVetoAlert({ mint_address, reason }) {
  return `⚠️ *Vetoed before scoring* — \`${mint_address}\`\nReason: ${reason}`;
}

export async function sendVetoAlert(details) {
  return sendMessage(formatVetoAlert(details));
}

/** Alert for tracked-wallet buy/sell activity. */
export function formatWalletActivityAlert({ walletAddress, walletLabel, type, mintAddress, amount, signature }) {
  const label = walletLabel ? `${walletLabel} (\`${walletAddress.slice(0, 6)}...\`)` : `\`${walletAddress}\``;
  const action = type === 'buy' ? '🟢 BOUGHT' : type === 'sell' ? '🔴 SOLD' : '↕️ MOVED';
  return [
    `*Wallet activity* — ${label}`,
    `${action} ${amount ?? '?'} of \`${mintAddress}\``,
    `[Tx](https://solscan.io/tx/${signature})`,
  ].join('\n');
}

export async function sendWalletActivityAlert(event) {
  return sendMessage(formatWalletActivityAlert(event));
}

/**
 * Minimal long-polling handler for /track <address> [label] and
 * /untrack <address>. Call `runCommandPolling(supabase)` once, in its own
 * process (see src/scripts/telegramBot.js) — it loops forever by design.
 */
async function getUpdates(offset) {
  const res = await fetch(apiUrl('getUpdates') + `?timeout=30&offset=${offset}`);
  return res.json();
}

async function handleCommand(supabase, message) {
  const text = (message.text || '').trim();

  if (text.startsWith('/track')) {
    const parts = text.split(/\s+/);
    const address = parts[1];
    const label = parts.slice(2).join(' ') || null;
    if (!address) return 'Usage: /track <wallet_address> [label]';

    const { error } = await supabase
      .from('tracked_wallets')
      .upsert({ wallet_address: address, label, active: true }, { onConflict: 'wallet_address' });

    return error
      ? `Failed to track: ${error.message}`
      : `Now tracking \`${address}\`${label ? ` (${label})` : ''}`;
  }

  if (text.startsWith('/untrack')) {
    const address = text.split(/\s+/)[1];
    if (!address) return 'Usage: /untrack <wallet_address>';

    const { error } = await supabase
      .from('tracked_wallets')
      .update({ active: false })
      .eq('wallet_address', address);

    return error ? `Failed to untrack: ${error.message}` : `Stopped tracking \`${address}\``;
  }

  return null;
}

export async function runCommandPolling(supabase, { pollIntervalMs = 2000 } = {}) {
  let offset = 0;
  console.log('[telegram] command polling started (/track, /untrack)...');

  while (true) {
    try {
      const updates = await getUpdates(offset);
      if (updates.ok && updates.result.length) {
        for (const update of updates.result) {
          offset = update.update_id + 1;
          if (update.message && String(update.message.chat.id) === String(config.telegramChatId)) {
            const reply = await handleCommand(supabase, update.message);
            if (reply) await sendMessage(reply);
          }
        }
      }
    } catch (err) {
      console.error('[telegram] polling error:', err.message);
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }
}
