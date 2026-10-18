import { DiscoveryFeedError, FEED_URL } from './discovery-feed.js';

export const CANDIDATE_LIMIT = 20;
export const DISCOVERY_COVERAGE = 'Solana · GeckoTerminal first new-pools page plus Pump.fun launch/migration events via PumpPortal when enabled. Up to 20 distinct candidates per cycle. DEX Screener supplies market checks; unindexed coins cannot pass missing required metrics. Stream gaps, queue limits and downtime can miss launches. Provider update time is unknown.';

export function formatSourceHealth(sources) {
  return sources.map((source) => {
    if (source.source === 'pumpportal') {
      const states = { disabled: 'disabled', idle: 'idle', stopped: 'stopped', connecting: 'connecting',
        connected: 'connected; waiting for launch/migration events', receiving: 'events received', unavailable: 'unavailable; reconnect pending' };
      return `Pump.fun via PumpPortal: ${states[source.state] ?? 'unknown'}; ${source.candidateCount ?? 0} queued.\n` +
        `Session gaps: ${source.interruptions ?? 0}; dropped at capacity: ${source.dropped ?? 0}; invalid events: ${source.rejected ?? 0}; expired: ${source.expired ?? 0}.` +
        (source.checkedAt === null ? '' : `\nLast event received: ${new Date(source.checkedAt).toISOString()}`);
    }
    return `GeckoTerminal: ${source.state === 'responded' ? 'last request succeeded' : source.state === 'unavailable' ? 'unavailable' : 'not checked this session'}.`;
  }).join('\n\n');
}

export function createCandidateSources({ gecko, pump, now = Date.now }) {
  let lastGecko = null;
  function status() {
    const sources = [{ source: 'geckoterminal', ...(lastGecko ?? gecko.status()) }, pump.status()];
    const expected = sources.filter((s) => s.state !== 'disabled');
    const ready = expected.map((s) => s.state === 'responded' || s.state === 'receiving');
    return { state: ready.every(Boolean) ? 'responded' :
      ready.some(Boolean) ? 'partial' : sources.every((s) => ['not_checked', 'idle', 'disabled'].includes(s.state)) ? 'not_checked' : 'unavailable', sources };
  }
  return {
    status,
    run: (options) => pump.run(options),
    close: () => pump.close(),
    selected: (candidates) => pump.selected(candidates),
    async read({ signal, diagnostic = false } = {}) {
      if (signal?.aborted) throw new DiscoveryFeedError('STOPPED');
      const [g, p] = await Promise.allSettled([gecko.read({ signal }), pump.read({ signal, diagnostic })]);
      if (signal?.aborted) throw new DiscoveryFeedError('STOPPED');
      lastGecko = g.status === 'fulfilled' ? { state: 'responded', checkedAt: g.value.fetchedAt } :
        { state: 'unavailable', checkedAt: now() };
      // The HTTP feed may take seconds. Re-read the event queue after it settles
      // so a stream failure during that wait cannot supply a stale success.
      let pumpBatch = null;
      if (p.status === 'fulfilled') {
        try { pumpBatch = await pump.read({ signal }); } catch { /* Report partial/unavailable below. */ }
      }
      if (signal?.aborted) throw new DiscoveryFeedError('STOPPED');
      const pumpReady = pumpBatch?.health.state === 'receiving';
      if (g.status !== 'fulfilled' && !pumpReady) throw new DiscoveryFeedError('SOURCES_UNAVAILABLE');
      const geckoBatch = g.status === 'fulfilled' ? g.value : null;
      const geckoCandidates = (geckoBatch?.candidates ?? []).map((candidate) => ({ ...candidate,
        provenance: [{ source: 'geckoterminal', sourceUrl: FEED_URL, receivedAt: geckoBatch.fetchedAt, cached: geckoBatch.cached === true }] }));
      const pumpCandidates = pumpBatch?.candidates ?? [];
      const merged = new Map();
      // Interleave before applying the shared cap: a busy launch stream must
      // not starve the other feed. Merge provenance for overlapping mints.
      for (let i = 0; i < Math.max(geckoCandidates.length, pumpCandidates.length); i++) {
        for (const candidate of [pumpCandidates[i], geckoCandidates[i]]) {
          if (!candidate) continue;
          const previous = merged.get(candidate.address);
          if (previous) previous.provenance.push(...candidate.provenance);
          else merged.set(candidate.address, structuredClone(candidate));
        }
      }
      const candidates = [...merged.values()].slice(0, CANDIDATE_LIMIT);
      return { candidates, fetchedAt: now(), sources: status().sources,
        deferred: Math.max(0, merged.size - candidates.length), invalidPools: geckoBatch?.invalidPools ?? 0,
        partial: !geckoBatch || !pumpBatch || pumpBatch.partial || Boolean(geckoBatch.invalidPools) || merged.size > CANDIDATE_LIMIT };
    },
  };
}

export function formatCandidateSource(candidate, batch) {
  if (!candidate?.provenance) return `Candidate source: ${batch.sourceUrl}\nFeed fetched: ${new Date(batch.fetchedAt).toISOString()}${batch.cached ? ' (Sift feed cache)' : ''}`;
  return candidate.provenance.map((source) => source.source === 'pumpportal'
    ? `Candidate: Pump.fun ${source.kind === 'create' ? 'launch' : 'migration'} reported by PumpPortal.\nReceived: ${new Date(source.receivedAt).toISOString()} (not a fresh market snapshot).\nEvent: https://solscan.io/tx/${source.signature}\n${source.sourceUrl}`
    : `Candidate: GeckoTerminal new pools.\nFetched: ${new Date(source.receivedAt).toISOString()}${source.cached ? ' (feed cache)' : ''}\n${source.sourceUrl}`).join('\n');
}
