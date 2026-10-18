import { setTimeout as delay } from 'node:timers/promises';
import { isSolanaAddress } from './market.js';
import { base58Bytes } from './evidence-utils.js';

export const PUMP_STREAM_URL = 'wss://pumpportal.fun/api/data';
export const PUMP_SOURCE_URL = 'https://pumpportal.fun/data-api/real-time/';
export const PUMP_TTL_MS = 20 * 60_000;
export const PUMP_CAPACITY = 200;
const MAX_MESSAGE_BYTES = 64 * 1024;
const SILENCE_MS = 90_000;
const DIAGNOSTIC_MS = 30_000;

export function readPumpConfig(env) {
  const value = env.SIFT_PUMPFUN_ENABLED ?? 'true';
  if (!['true', 'false'].includes(value)) throw new Error('SIFT_PUMPFUN_ENABLED must be true or false.');
  return { enabled: value === 'true' };
}

// Provider events supply candidate identities only. Virtual reserves, creator
// labels, marketCapSol and completion flags are NOT market or risk evidence.
export function normalisePumpEvent(raw, receivedAt) {
  if (!raw || !['create', 'migrate'].includes(raw.txType) || !isSolanaAddress(raw.mint) ||
      base58Bytes(raw.signature, 64)?.length !== 64 || !Number.isSafeInteger(receivedAt)) return null;
  if (raw.pool !== undefined && raw.pool !== (raw.txType === 'create' ? 'pump' : 'pump-amm')) return null;
  return { address: raw.mint, provenance: [{ source: 'pumpportal', kind: raw.txType,
    receivedAt, signature: raw.signature, sourceUrl: PUMP_SOURCE_URL }] };
}

export function createPumpFeed({ enabled = true, socketFactory = (url) => new WebSocket(url), now = Date.now,
  wait = delay } = {}) {
  let socket = null, state = enabled ? 'idle' : 'disabled', stopped = false;
  let connectedAt = null, lastEventAt = null, nextConnectAt = 0, failures = 0, leaseUntil = 0;
  let rejected = 0, dropped = 0, expired = 0, interruptions = 0;
  let messagesReceived = 0, controlMessages = 0, lastMessageAt = null;
  const queue = new Map();
  let turn = 0;

  function prune() {
    for (const [mint, entry] of queue) {
      if (now() - entry.candidate.provenance[0].receivedAt >= PUMP_TTL_MS) {
        queue.delete(mint); expired++;
      }
    }
  }
  function disconnect(nextState) {
    const old = socket;
    socket = null;
    state = nextState;
    connectedAt = null;
    queue.clear(); // A failed/restarted stream never presents an old batch as live.
    try { old?.close(); } catch { /* Transport details must not escape. */ }
  }
  function failed(current) {
    if (socket !== current) return;
    interruptions++;
    failures = Math.min(failures + 1, 5);
    nextConnectAt = now() + Math.min(300_000, 10_000 * 2 ** (failures - 1));
    disconnect('unavailable');
  }
  function connect() {
    if (!enabled || stopped || socket || now() < nextConnectAt) return;
    let current;
    try { current = socketFactory(PUMP_STREAM_URL); }
    catch {
      failures = Math.min(failures + 1, 5);
      interruptions++;
      nextConnectAt = now() + Math.min(300_000, 10_000 * 2 ** (failures - 1));
      state = 'unavailable';
      return;
    }
    socket = current;
    state = 'connecting';
    connectedAt = now();
    current.addEventListener('open', () => {
      if (socket !== current) return;
      try {
        // Deliberately fixed, free subscriptions. No key, wallet, trades or
        // account subscriptions are accepted through configuration or user input.
        current.send(JSON.stringify({ method: 'subscribeNewToken' }));
        current.send(JSON.stringify({ method: 'subscribeMigration' }));
        state = 'connected';
        connectedAt = now();
      } catch { failed(current); }
    });
    current.addEventListener('message', ({ data }) => {
      if (socket !== current) return;
      messagesReceived++;
      lastMessageAt = now();
      if (typeof data !== 'string' || Buffer.byteLength(data) > MAX_MESSAGE_BYTES) {
        rejected++; failed(current); return;
      }
      let raw;
      try { raw = JSON.parse(data); } catch { rejected++; failed(current); return; }
      if (raw?.error || raw?.errors || (typeof raw?.message === 'string' &&
          /error|unauthor|invalid|limit|denied|required|insufficient|funds/i.test(raw.message))) {
        failed(current); return;
      }
      // A subscription acknowledgement is not proof that events are arriving.
      if (typeof raw?.message === 'string' && raw.txType === undefined) { controlMessages++; return; }
      const candidate = normalisePumpEvent(raw, now());
      if (!candidate) { rejected++; return; }
      state = 'receiving';
      lastEventAt = now();
      failures = 0;
      prune();
      const previous = queue.get(candidate.address);
      if (previous) {
        // Duplicate creation events cannot extend retention or reset priority.
        // A first migration is new evidence of a new discovery opportunity.
        if (previous.candidate.provenance[0].kind === 'create' && raw.txType === 'migrate') {
          queue.set(candidate.address, { candidate, lastSelected: 0 });
        }
        return;
      }
      if (queue.size >= PUMP_CAPACITY) { dropped++; return; }
      queue.set(candidate.address, { candidate, lastSelected: 0 });
    });
    current.addEventListener('error', () => failed(current));
    current.addEventListener('close', () => failed(current));
  }

  const service = {
    status() {
      prune();
      return { source: 'pumpportal', sourceUrl: PUMP_SOURCE_URL, state, checkedAt: lastEventAt,
        candidateCount: queue.size, rejected, dropped, expired, interruptions,
        messagesReceived, controlMessages, lastMessageAt,
        retryAt: state === 'unavailable' ? nextConnectAt : null };
    },
    // Called by the runtime once per second; /sources grants a short diagnostic
    // lease, but does not turn on a user's scan or send any matching alerts.
    tick(active = false) {
      if (!enabled || stopped) return;
      if (!active && now() >= leaseUntil) {
        if (state !== 'idle') disconnect('idle');
        return;
      }
      if (socket && (state === 'connecting' ? now() - connectedAt > 10_000 :
          now() - Math.max(lastEventAt ?? 0, connectedAt) > SILENCE_MS)) failed(socket);
      connect();
    },
    async read({ signal, diagnostic = false } = {}) {
      if (signal?.aborted) throw new Error('Pump feed stopped.');
      if (diagnostic && enabled && !stopped) {
        leaseUntil = now() + DIAGNOSTIC_MS;
        service.tick();
      }
      prune();
      const health = service.status();
      return { candidates: state === 'receiving' ? [...queue.values()]
        .sort((a, b) => a.lastSelected - b.lastSelected ||
          a.candidate.provenance[0].receivedAt - b.candidate.provenance[0].receivedAt)
        .map((entry) => structuredClone(entry.candidate)) : [], fetchedAt: now(),
      sourceUrl: PUMP_SOURCE_URL, health,
      partial: enabled && (state !== 'receiving' || rejected > 0 || dropped > 0 || interruptions > 0) };
    },
    selected(candidates) {
      for (const candidate of candidates) {
        const entry = queue.get(candidate.address);
        if (entry) entry.lastSelected = ++turn;
      }
    },
    close() { stopped = true; disconnect(enabled ? 'stopped' : 'disabled'); },
    async run({ signal, shouldListen }) {
      try {
        while (!signal.aborted) {
          service.tick(Boolean(shouldListen()));
          await wait(1000, undefined, { signal });
        }
      } catch (error) { if (!signal.aborted) throw error; }
      finally { service.close(); }
    },
  };
  return service;
}
