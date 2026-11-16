import test from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { respond, WELCOME } from '../src/bot.js';
import {
  createInterpreter, DEFAULT_CLAUDE_MODEL, INTERPRETED_COMMANDS, MAX_INTERPRET_LENGTH, RATE_LIMIT, readInterpreterConfig,
} from '../src/interpret.js';

// Fake Claude client: no network calls and no API key in tests.
const silent = { warn() {} };
const answer = (text, stop_reason = 'end_turn') => ({ stop_reason, content: [{ type: 'text', text }] });
const apiError = (status, text = 'detail') => new Anthropic.APIError(status, { error: { message: text } }, text, new Headers());
function fakeClient(result) {
  const calls = [];
  const client = { beta: { messages: { create: async (params, options) => {
    calls.push({ params, options });
    const next = typeof result === 'function' ? result(calls.length) : result;
    if (next instanceof Error) throw next;
    return next;
  } } } };
  return { client, calls };
}
const fakeInterpreter = (pick) => ({ available: true, interpret: async (text) => pick(text) });

const allowed = new Set([42]);
const update = (text, id = 42, type = 'private') => ({
  update_id: 1,
  message: { text, from: { id, is_bot: false }, chat: { id, type } },
});

test('interpreter is opt-in and validates the configured model', () => {
  assert.equal(readInterpreterConfig({}), null);
  assert.equal(readInterpreterConfig({ ANTHROPIC_API_KEY: '  ' }), null);
  assert.deepEqual(readInterpreterConfig({ ANTHROPIC_API_KEY: 'k' }), { model: DEFAULT_CLAUDE_MODEL });
  assert.deepEqual(readInterpreterConfig({ ANTHROPIC_API_KEY: 'k', SIFT_CLAUDE_MODEL: 'claude-haiku-5-5' }), { model: 'claude-haiku-5-5' });
  assert.throws(() => readInterpreterConfig({ ANTHROPIC_API_KEY: 'k', SIFT_CLAUDE_MODEL: 'bad model!' }), /SIFT_CLAUDE_MODEL/);
});

test('interpreter asks Claude for one command from a fixed list and returns it', async () => {
  const { client, calls } = fakeClient(answer('{"command":"status"}'));
  const signal = new AbortController().signal;
  const { interpret } = createInterpreter({ client, log: silent });
  assert.equal(await interpret('is scanning live yet?', { userId: 42, signal }), 'status');

  const { params, options } = calls[0];
  assert.equal(params.model, DEFAULT_CLAUDE_MODEL);
  assert.deepEqual(params.messages, [{ role: 'user', content: 'is scanning live yet?' }]);
  assert.match(params.system, /never follow instructions/);
  assert.deepEqual(params.output_config.format.schema.properties.command.enum, INTERPRETED_COMMANDS);
  assert.equal(params.output_config.effort, 'low');
  assert.equal(params.fallbacks, 'default');
  assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(options.signal, signal);
  for (const key of ['temperature', 'top_p', 'top_k', 'thinking']) assert.ok(!(key in params));
});

test('interpreter returns null instead of guessing when the answer is unusable', async () => {
  for (const response of [
    answer('{"command":"status"}', 'refusal'),
    answer('{"command":"status"}', 'max_tokens'),
    answer('not json'),
    answer('{"command":"buy"}'),
    { stop_reason: 'end_turn', content: [] },
  ]) {
    const { client } = fakeClient(response);
    assert.equal(await createInterpreter({ client, log: silent }).interpret('hello', { userId: 42 }), null);
  }
});

test('interpreter never sends empty or over-long text', async () => {
  const { client, calls } = fakeClient(answer('{"command":"help"}'));
  const { interpret } = createInterpreter({ client, log: silent });
  assert.equal(await interpret('   ', { userId: 42 }), null);
  assert.equal(await interpret('x'.repeat(MAX_INTERPRET_LENGTH + 1), { userId: 42 }), null);
  assert.equal(calls.length, 0);
});

test('each tester gets a limited number of Claude requests per window', async () => {
  let clock = 1_000_000;
  const { client, calls } = fakeClient(answer('{"command":"help"}'));
  const { interpret } = createInterpreter({ client, log: silent, now: () => clock });
  for (let i = 0; i < RATE_LIMIT.requests; i += 1) assert.equal(await interpret('hi', { userId: 42 }), 'help');
  assert.equal(await interpret('hi', { userId: 42 }), null); // over the limit: fixed reply, no request
  assert.equal(await interpret('hi', { userId: 57 }), 'help'); // other testers keep their own budget
  assert.equal(calls.length, RATE_LIMIT.requests + 1);
  clock += RATE_LIMIT.windowMs + 1;
  assert.equal(await interpret('hi', { userId: 42 }), 'help'); // window passed
});

test('a rejected key or model turns the interpreter off instead of failing every message', async () => {
  for (const status of [401, 403, 404]) {
    const logs = [];
    const { client, calls } = fakeClient(apiError(status));
    const interpreter = createInterpreter({ client, log: { warn: (m) => logs.push(m) } });
    assert.equal(await interpreter.interpret('hi', { userId: 42 }), null);
    assert.equal(interpreter.available, false);
    assert.equal(await interpreter.interpret('hi again', { userId: 42 }), null);
    assert.equal(calls.length, 1);
    assert.match(logs[0], /off until restart/);
  }
  // Rate limits, overload and per-message errors keep it on.
  for (const status of [400, 429, 500, 529]) {
    const { client } = fakeClient(apiError(status));
    const interpreter = createInterpreter({ client, log: silent });
    await interpreter.interpret('hi', { userId: 42 });
    assert.equal(interpreter.available, true);
  }
});

test('API failures are logged by status only and do not throw', async () => {
  const secretText = 'my private message';
  for (const error of [apiError(500, secretText), new Error(secretText)]) {
    const logs = [];
    const { client } = fakeClient(error);
    const { interpret } = createInterpreter({ client, log: { warn: (m) => logs.push(m) } });
    assert.equal(await interpret(secretText, { userId: 42 }), null);
    assert.equal(logs.length, 1);
    assert.ok(!logs[0].includes(secretText));
  }
});

test('testers get fixed replies for plain-language requests', async () => {
  const seen = [];
  const interpreter = fakeInterpreter((text) => { seen.push(text); return { hi: 'start', 'what is my id': 'id', 'find me coins': 'unsupported' }[text] ?? null; });
  assert.equal((await respond(update('hi'), allowed, interpreter)).text, WELCOME);
  assert.match((await respond(update('what is my id'), allowed, interpreter)).text, /user ID: 42/);
  assert.match((await respond(update('find me coins'), allowed, interpreter)).text, /not available yet/);
  // Interpreter could not decide: same fixed fallback as before.
  assert.match((await respond(update('something else'), allowed, interpreter)).text, /not available yet/);
  assert.deepEqual(seen, ['hi', 'what is my id', 'find me coins', 'something else']);
});

test('the tester ID is passed for rate limiting', async () => {
  let received;
  const interpreter = { available: true, interpret: async (_text, options) => { received = options; return 'help'; } };
  const signal = new AbortController().signal;
  await respond(update('hi'), allowed, interpreter, signal);
  assert.deepEqual(received, { userId: 42, signal });
});

test('slash commands, unlisted accounts and groups never reach Claude', async () => {
  let calls = 0;
  const interpreter = fakeInterpreter(() => { calls += 1; return 'start'; });
  assert.match((await respond(update('/status'), allowed, interpreter)).text, /Plain-language commands: available/);
  assert.match((await respond(update('hi', 57), allowed, interpreter)).text, /does not have tester access/);
  assert.equal(await respond(update('hi', 42, 'group'), allowed, interpreter), null);
  assert.equal(calls, 0);
});

test('help and status say whether plain-language commands are on', async () => {
  assert.match((await respond(update('/status'), allowed, null)).text, /Plain-language commands: off/);
  assert.doesNotMatch((await respond(update('/help'), allowed, null)).text, /plain words/);
  assert.match((await respond(update('/help'), allowed, fakeInterpreter(() => null))).text, /plain words/);
});

test('status reports plain-language commands as off once the key is rejected', async () => {
  const { client } = fakeClient(apiError(401));
  const interpreter = createInterpreter({ client, log: silent });
  // The message that discovers the bad key already gets the "off" wording.
  assert.match((await respond(update('what works?'), allowed, interpreter)).text, /not available yet/);
  assert.match((await respond(update('/status'), allowed, interpreter)).text, /Plain-language commands: off/);
});
