import { readConfig, replyFor, verifyBotIdentity } from './bot.js';
import { createTelegram, TelegramError } from './telegram.js';
import { isAuthenticated, SECRET_HEADER } from './webhook-auth.js';

const MAX_BODY_BYTES = 1024 * 1024;
const json = (body, status = 200, extraHeaders = {}) => Response.json(body, {
  status, headers: { 'cache-control': 'no-store', ...extraHeaders },
});

async function readUpdate(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('INVALID_BODY');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error('BODY_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const update = JSON.parse(new TextDecoder().decode(bytes));
  if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) {
    throw new Error('INVALID_UPDATE');
  }
  return update;
}

export function createWorker({ fetchImpl = fetch } = {}) {
  return {
    async fetch(request, env) {
      const { pathname } = new URL(request.url);
      if (pathname === '/health' && request.method === 'GET') {
        // Liveness only: this does not claim Telegram or configuration is ready.
        return json({ service: 'sift-bot', status: 'deployed' });
      }
      if (!['/telegram', '/ready'].includes(pathname)) return json({ error: 'Not found' }, 404);
      const method = pathname === '/ready' ? 'GET' : 'POST';
      if (request.method !== method) return json({ error: 'Method not allowed' }, 405, { allow: method });

      let config;
      try { config = readConfig(env); }
      catch { return json({ error: 'Configuration required' }, 503); }
      const { token, allowedUserIds } = config;
      if (!await isAuthenticated(token, request.headers.get(SECRET_HEADER))) {
        return json({ error: 'Unauthorized' }, 401);
      }
      const call = createTelegram(token, { fetchImpl });
      if (pathname === '/ready') {
        try {
          verifyBotIdentity(await call('getMe'));
          if (!allowedUserIds.size) return json({ error: 'Tester access required' }, 503);
          return json({ service: 'sift-bot', ready: true });
        } catch { return json({ error: 'Bot identity could not be verified' }, 503); }
      }
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return json({ error: 'JSON required' }, 415);
      }
      let update;
      try { update = await readUpdate(request); }
      catch (error) {
        const large = error.message === 'BODY_TOO_LARGE';
        return json({ error: large ? 'Body too large' : 'Invalid update' }, large ? 413 : 400);
      }
      const reply = replyFor(update, allowedUserIds);
      if (reply) {
        try { await call('sendMessage', reply); }
        catch (error) {
          // A blocked chat cannot receive a reply. Other failures remain
          // unacknowledged so Telegram can retry under its delivery policy.
          if (!(error instanceof TelegramError) || error.code !== 403) {
            return json({ error: 'Reply unavailable; retry required' }, 503);
          }
        }
      }
      return json({ ok: true });
    },
  };
}

export default createWorker();
