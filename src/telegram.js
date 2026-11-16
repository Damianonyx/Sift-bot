// Never propagate fetch errors or Telegram descriptions: they may contain
// request URLs with the bot token. Only known, non-sensitive codes escape.
export class TelegramError extends Error {
  constructor(code, retryAfter = 5) {
    super(`Telegram request failed (${code}).`);
    this.code = code;
    this.retryAfter = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 5;
  }
}

// A reply Telegram rejected for a reason a retry cannot fix (bad request,
// blocked bot, missing chat). Skipping it stops one update from stalling all
// later ones. 401/404/409 mean the bot itself is misconfigured and must stop
// the process; 429 is a rate limit; 5xx and network errors are transient.
export function isPermanentReplyError(error) {
  return error instanceof TelegramError && Number.isInteger(error.code) &&
    error.code >= 400 && error.code < 500 && ![401, 404, 409, 429].includes(error.code);
}

export function createTelegram(token, { fetchImpl = fetch } = {}) {
  return async function call(method, body = {}, signal) {
    if (!['getMe', 'getWebhookInfo', 'getUpdates', 'sendMessage'].includes(method)) {
      throw new TelegramError('UNSUPPORTED_METHOD');
    }
    try {
      const timeout = AbortSignal.timeout(method === 'getUpdates' ? 35_000 : 15_000);
      const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const payload = await response.json();
      if (!response.ok || payload?.ok !== true) {
        const candidate = payload?.error_code ?? response.status;
        const code = Number.isInteger(candidate) ? candidate : 'INVALID_RESPONSE';
        throw new TelegramError(code, payload?.parameters?.retry_after);
      }
      return payload.result;
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      throw new TelegramError(signal?.aborted ? 'STOPPED' : 'NETWORK_OR_RESPONSE');
    }
  };
}
