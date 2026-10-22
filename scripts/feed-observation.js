import { createPumpFeed, readPumpConfig } from '../src/pump-feed.js';
import { createDiscoveryFeed } from '../src/discovery-feed.js';
import { createMeteora, readMeteoraConfig } from '../src/meteora.js';
import { createCandidateSources, formatPumpObservation } from '../src/candidate-sources.js';

// The same bounded read used by /sources. No Telegram, market screening,
// persistence, trading or paid APIs. Stop another Sift process before using
// this standalone command so there is only one PumpPortal connection.
const hardStop = setTimeout(() => { console.error('Feed observation incomplete: process deadline.'); process.exit(2); }, 20_000);
const stop = new AbortController();
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => stop.abort());
const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(15_000)]);
let feed;
try {
  feed = createCandidateSources({ pump: createPumpFeed(readPumpConfig(process.env)), gecko: createDiscoveryFeed(),
    meteora: createMeteora(readMeteoraConfig(process.env)) });
  const batch = await feed.read({ signal, diagnostic: true });
  const pump = batch.sources.find((s) => s.source === 'pumpportal');
  const observed = batch.pumpObservation?.outcome === 'events_received' && pump?.state === 'receiving';
  const report = { checkedAt: new Date(batch.fetchedAt).toISOString(), sources: batch.sources,
    observation: batch.pumpObservation, candidateCount: batch.candidates.length, deferred: batch.deferred,
    partial: batch.partial, pumpEventDeliveryObserved: observed,
    samples: batch.candidates.filter((c) => c.provenance.some((p) => p.source === 'pumpportal')).slice(0, 3),
    approvedRuleMatchVerified: false };
  console.log(formatPumpObservation(batch.pumpObservation));
  console.log(JSON.stringify(report, null, 2));
  console.log('Event receipt is not proof of complete launch coverage, market-data accuracy or a qualifying match.');
  process.exitCode = observed && batch.sources.every((s) => ['responded', 'receiving', 'disabled'].includes(s.state)) ? 0 : 2;
} catch {
  console.error('Feed observation unavailable or interrupted. No delivery verdict was made.');
  process.exitCode = 2;
} finally { feed?.close(); clearTimeout(hardStop); }
