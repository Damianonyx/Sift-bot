// Small, read-only client for fixed public data origins. Errors never contain
// response bodies, URLs supplied by a provider, credentials or raw exceptions.
export class PublicDataError extends Error {
  constructor(code, retryAfter = 0) { super(`Public data unavailable (${code}).`); this.code = code; this.retryAfter = retryAfter; }
}

export function createPublicJson({ origin, fetchImpl = fetch, now = Date.now, intervalMs = 1000 } = {}) {
  let nextAt = 0, busy = false;
  return async (path, { signal } = {}) => {
    if (signal?.aborted) throw new PublicDataError('STOPPED');
    const url = new URL(path, origin);
    if (url.origin !== origin || url.username || url.password) throw new PublicDataError('INVALID_REQUEST');
    if (busy || now() < nextAt) throw new PublicDataError('COOLDOWN', Math.max(1, Math.ceil((nextAt - now()) / 1000)));
    busy = true; nextAt = now() + intervalMs;
    try {
      const timeout = AbortSignal.timeout(8000);
      const response = await fetchImpl(url.href, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 429) {
          const header = response.headers.get('retry-after');
          const seconds = /^\d+$/.test(header ?? '') ? Number(header) : (Date.parse(header) - now()) / 1000;
          const retry = Number.isFinite(seconds) && seconds > 0 ? Math.min(86400, Math.ceil(seconds)) : 60;
          nextAt = now() + retry * 1000;
          throw new PublicDataError('RATE_LIMITED', retry);
        }
        throw new PublicDataError(response.status === 404 ? 'NOT_INDEXED' : 'SOURCE_UNAVAILABLE');
      }
      if (!response.body) throw new PublicDataError('INVALID_RESPONSE');
      const reader = response.body.getReader();
      let size = 0; const chunks = [];
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new PublicDataError('OVERSIZED_RESPONSE'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      if (signal?.aborted) throw new PublicDataError('STOPPED');
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      throw signal?.aborted ? new PublicDataError('STOPPED') :
        error instanceof PublicDataError ? error : new PublicDataError('NETWORK_OR_RESPONSE');
    } finally { busy = false; }
  };
}

export function nonnegative(value) {
  if (typeof value === 'string' && /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) value = Number(value);
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
