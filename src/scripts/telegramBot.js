import { Connection } from '@solana/web3.js';
import { config, assertConfig } from '../config.js';
import { supabase } from '../db/supabase.js';
import { startWalletMonitoring, resyncWalletMonitoring } from '../monitors/walletMonitor.js';
import { sendWalletActivityAlert, runCommandPolling } from '../notify/telegramNotifier.js';

assertConfig(['rpcUrl', 'telegramBotToken', 'telegramChatId']);

const connection = new Connection(config.rpcUrl, 'confirmed');

async function onWalletActivity(event) {
  await supabase.from('wallet_activity').insert({
    wallet_address: event.walletAddress,
    mint_address: event.mintAddress,
    activity_type: event.type,
    amount: event.amount,
    signature: event.signature,
    occurred_at: event.timestamp,
  });
  await sendWalletActivityAlert(event);
}

async function main() {
  console.log('Starting wallet monitor + Telegram bot...');

  let subscriptions = await startWalletMonitoring({ connection, supabase, onActivity: onWalletActivity });

  setInterval(async () => {
    subscriptions = await resyncWalletMonitoring({
      connection,
      supabase,
      onActivity: onWalletActivity,
      currentSubscriptions: subscriptions,
    });
  }, 3 * 60 * 1000);

  // Blocks forever, handling /track and /untrack
  await runCommandPolling(supabase);
}

main().catch((err) => {
  console.error('telegramBot fatal error:', err);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\nShutting down.');
  process.exit(0);
});
