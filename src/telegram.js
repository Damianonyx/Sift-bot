// Never propagate fetch errors or Telegram descriptions: they may contain
// request URLs with the bot token. Only known, non-sensitive codes escape.
export class TelegramError extends Error {
  constructor(code, retryAfter = 5) {
    super(`Telegram request failed (${code}).`);
    this.code = code;
    this.retryAfter = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 5;
  }
}

export function createTelegram(token, { fetchImpl = fetch } = {}) {
  return async function call(method, body = {}, signal) {
    if (!['getMe', 'getWebhookInfo', 'getUpdates', 'sendMessage', 'answerCallbackQuery'].includes(method)) {
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
