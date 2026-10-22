import { readConfig } from '../src/bot.js';
import { readAiConfig } from '../src/description-ai.js';
import { readPumpConfig } from '../src/pump-feed.js';
import { readMeteoraConfig } from '../src/meteora.js';

// Local checks only. Never contact Telegram, expose IDs/tokens or mutate data.
try {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Use Node.js 24 LTS for this private test build.');
  const { allowedUserIds } = readConfig(process.env);
  const ai = readAiConfig(process.env);
  const pump = readPumpConfig(process.env);
  const meteora = readMeteoraConfig(process.env);
  if (!allowedUserIds.size) throw new Error('Configure at least one private tester before the test week. /id bootstrap remains available with an empty allowlist.');
  console.log(`Private configuration ready: ${allowedUserIds.size} allowed tester(s). No credentials or IDs displayed.`);
  console.log(ai.enabled ? 'Optional AI configured: separately billed API usage; up to 20 requests per UTC day.' : 'AI API disabled; local description parsing is available without AI API calls.');
  console.log(pump.enabled ? 'Pump.fun candidates enabled via PumpPortal: free launch/migration events only. Connects for active scans or /sources diagnostics.' : 'Pump.fun event feed disabled. GeckoTerminal remains the candidate source.');
  console.log(meteora.enabled ? 'Meteora public DLMM/DAMM v2 feeds enabled: no key or paid fallback; first 20 pools per protocol.' : 'Meteora direct feeds disabled.');
  console.log('Before starting: stop any other polling process and preserve the existing .sift database.');
  console.log('Live source/Telegram acceptance is still required. Complete bundle coverage is unavailable; full-risk matches stay blocked.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
