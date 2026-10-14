import { readConfig } from '../src/bot.js';

// Local checks only. Never contact Telegram, expose IDs/tokens or mutate data.
try {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Use Node.js 24 LTS for this private test build.');
  const { allowedUserIds } = readConfig(process.env);
  if (!allowedUserIds.size) throw new Error('Configure at least one private tester before the test week. /id bootstrap remains available with an empty allowlist.');
  console.log(`Private configuration ready: ${allowedUserIds.size} allowed tester(s). No credentials or IDs displayed.`);
  console.log('Before starting: stop any other polling process and preserve the existing .sift database.');
  console.log('Live source/Telegram acceptance is still required. Complete bundle coverage is unavailable; full-risk matches stay blocked.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
