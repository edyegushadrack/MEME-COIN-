import 'dotenv/config';

export const config = {
  rpcUrl: process.env.SOLANA_RPC_URL,
  wsUrl: process.env.SOLANA_WS_URL,
  pumpPortalWsUrl: process.env.PUMPPORTAL_WS_URL,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_SERVICE_KEY,
  minScoreToLog: Number(process.env.MIN_SCORE_TO_LOG_AS_CANDIDATE ?? 40),
  minScoreToPaperBuy: Number(process.env.MIN_SCORE_TO_PAPER_BUY ?? 65),
  paperPositionSizeSol: Number(process.env.PAPER_POSITION_SIZE_SOL ?? 0.5),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
};

export function assertConfig(keys) {
  const missing = keys.filter((k) => !config[k]);
  if (missing.length) {
    throw new Error(`Missing required config: ${missing.join(', ')}. Check your .env file.`);
  }
}
