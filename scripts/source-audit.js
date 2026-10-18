import { setTimeout as wait } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { createMeteora, METEORA_PROTOCOLS, normaliseMeteoraPool } from '../src/meteora.js';
import { createPublicJson } from '../src/public-json.js';
import { createMarketData } from '../src/market.js';
import { createSourceAudit } from '../src/source-audit.js';

// Bounded public samples, no secrets, Telegram sends, wallet, AI, database or
// paid endpoints. Exit success means observations were collected, not accuracy.
const hardStop = setTimeout(() => { console.error('Source sampling incomplete: process deadline.'); process.exit(2); }, 85_000);
const signal = AbortSignal.timeout(75_000);
const report = { startedAt: new Date().toISOString(), purpose: 'Sample provider identities and discrepancies; not accuracy certification', feeds: [], samples: [] };
try {
  const meteora = createMeteora();
  const feed = await meteora.read({ signal });
  report.feeds = feed.sources;
  report.candidateCount = new Set(feed.candidates.map((c) => c.address)).size;
  for (const [source, { origin }] of Object.entries(METEORA_PROTOCOLS)) {
    try {
      // Liquid pools make a useful complement to the newest, often unindexed
      // candidates. The diagnostic alone uses this top-TVL sample selection.
      const raw = await createPublicJson({ origin })('/pools?page=1&page_size=1&sort_by=tvl:desc', { signal });
      const pool = normaliseMeteoraPool(raw?.data?.[0], source, Date.now());
      const market = createMarketData();
      let snapshot;
      for (const mint of pool.tokens) {
        snapshot = await market.check(mint, { signal, poolAddress: pool.address });
        if (snapshot.selected) break;
        await wait(3100, undefined, { signal });
      }
      report.samples.push({ selection: `${source}: highest API TVL pool`, source, directPool: pool,
        audit: await createSourceAudit().check(snapshot, { signal }) });
    } catch (error) { report.samples.push({ selection: source, state: error.code ?? 'UNAVAILABLE' }); }
  }
  // The CA previously used in the user's manual /liquidity and /watch checks.
  const pumpMint = '7GUnr7krtQhJwd6ASY2VUprd9t4c64zcgCsjdmZepump';
  try {
    const snapshot = await createMarketData().check(pumpMint, { signal });
    report.samples.push({ selection: 'Previously checked Pump.fun token', audit: await createSourceAudit().check(snapshot, { signal }) });
  } catch (error) { report.samples.push({ selection: 'Previously checked Pump.fun token', state: error.code ?? 'UNAVAILABLE' }); }
  report.completedAt = new Date().toISOString();
  report.complete = report.feeds.every((s) => s.state === 'responded') && report.samples.every((s) =>
    s.audit?.gecko?.state === 'responded' && (!s.source || s.audit.meteora.some((p) => p.source === s.source && p.state === 'responded')));
  await writeFile('source-audit-results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.complete ? 0 : 2;
} catch {
  console.error('Public source sampling incomplete; no raw provider errors displayed.');
  process.exitCode = 2;
} finally { clearTimeout(hardStop); }
