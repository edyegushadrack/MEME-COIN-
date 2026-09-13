import { startPumpfunListener } from '../detectors/pumpfunListener.js';

console.log('Starting meme-scanner detection loop...');
console.log('This only detects, scores, and logs. No trades are executed.');

startPumpfunListener();

process.on('SIGINT', () => {
  console.log('\nShutting down.');
  process.exit(0);
});
