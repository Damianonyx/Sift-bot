import { createPumpFeed, readPumpConfig } from '../src/pump-feed.js';
import { createDiscoveryFeed } from '../src/discovery-feed.js';
import { createMarketData } from '../src/market.js';
import { createTelegram } from '../src/telegram.js';
import { readDiagnosticTarget, runLiveDiagnostic } from '../src/live-diagnostic.js';

const args = process.argv.slice(2);
if (args.length && !(args.length === 2 && args[0] === '--telegram')) {
  console.error('Usage: npm run check:live [-- --telegram YOUR_NUMERIC_USER_ID]');
  process.exit(1);
}

// CLI-only guard: even a transport that fails to honor AbortSignal cannot leave
// this one-shot diagnostic running indefinitely. No database or poller is opened.
const hardStop = setTimeout(() => {
  console.error('Live diagnostic reached its 55-second process limit. The incomplete check is not a pass.');
  process.exit(1);
}, 55_000);
const stop = new AbortController();
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => stop.abort());
const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(45_000)]);

try {
  const target = readDiagnosticTarget(process.env, args[1]);
  const pump = createPumpFeed(readPumpConfig(process.env));
  console.log('Read-only source check. No saved rules are evaluated or changed. Stop any other Sift process first to keep one PumpPortal connection.');
  const report = await runLiveDiagnostic({ pump, gecko: createDiscoveryFeed(), market: createMarketData(), signal,
    telegram: target ? { userId: target.userId, call: createTelegram(target.token) } : null,
    progress: (line) => console.log(line) });
  console.log(JSON.stringify(report, null, 2));
  console.log('A source or delivery check is not proof that your full strategy has a qualifying match.');
  clearTimeout(hardStop);
  process.exit(report.pumpToMarketVerified && (!target || report.telegram.state === 'accepted_by_telegram') && !report.deadlineReached ? 0 : 2);
} catch {
  console.error('Diagnostic configuration or runtime check failed. Check Node.js 24, SIFT_PUMPFUN_ENABLED and, when sending privately, the bot token and allowed numeric user ID. No raw credentials or provider errors are displayed.');
  clearTimeout(hardStop);
  process.exit(1);
}
