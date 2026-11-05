import test from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { respond, WELCOME } from '../src/bot.js';
import {
  createInterpreter, DEFAULT_CLAUDE_MODEL, INTERPRETED_COMMANDS, MAX_INTERPRET_LENGTH, readInterpreterConfig,
} from '../src/interpret.js';

// Fake Claude client: no network calls and no API key in tests.
const silent = { warn() {} };
const answer = (text, stop_reason = 'end_turn') => ({ stop_reason, content: [{ type: 'text', text }] });
function fakeClient(result) {
  const calls = [];
  const client = { beta: { messages: { create: async (params, options) => {
    calls.push({ params, options });
    if (result instanceof Error) throw result;
    return result;
  } } } };
  return { client, calls };
}

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
  assert.equal(await createInterpreter({ client, log: silent })('is scanning live yet?', signal), 'status');

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
    assert.equal(await createInterpreter({ client, log: silent })('hello'), null);
  }
});

test('interpreter never sends empty or over-long text', async () => {
  const { client, calls } = fakeClient(answer('{"command":"help"}'));
  const interpret = createInterpreter({ client, log: silent });
  assert.equal(await interpret('   '), null);
  assert.equal(await interpret('x'.repeat(MAX_INTERPRET_LENGTH + 1)), null);
  assert.equal(calls.length, 0);
});

test('API failures are logged by status only and do not throw', async () => {
  const secretText = 'my private message';
  const failure = new Anthropic.APIError(500, { error: { message: secretText } }, secretText, new Headers());
  for (const error of [failure, new Error(secretText)]) {
    const logs = [];
    const { client } = fakeClient(error);
    assert.equal(await createInterpreter({ client, log: { warn: (m) => logs.push(m) } })(secretText), null);
    assert.equal(logs.length, 1);
    assert.ok(!logs[0].includes(secretText));
  }
});

test('testers get fixed replies for plain-language requests', async () => {
  const seen = [];
  const interpret = async (text) => { seen.push(text); return { hi: 'start', 'what is my id': 'id', 'find me coins': 'unsupported' }[text] ?? null; };
  assert.equal((await respond(update('hi'), allowed, interpret)).text, WELCOME);
  assert.match((await respond(update('what is my id'), allowed, interpret)).text, /user ID: 42/);
  assert.match((await respond(update('find me coins'), allowed, interpret)).text, /not available yet/);
  // Interpreter unavailable: same fixed fallback as before.
  assert.match((await respond(update('something else'), allowed, interpret)).text, /not available yet/);
  assert.deepEqual(seen, ['hi', 'what is my id', 'find me coins', 'something else']);
});

test('slash commands, unlisted accounts and groups never reach Claude', async () => {
  let calls = 0;
  const interpret = async () => { calls += 1; return 'start'; };
  assert.match((await respond(update('/status'), allowed, interpret)).text, /Plain-language commands: available/);
  assert.match((await respond(update('hi', 57), allowed, interpret)).text, /does not have tester access/);
  assert.equal(await respond(update('hi', 42, 'group'), allowed, interpret), null);
  assert.equal(calls, 0);
});

test('help and status say whether plain-language commands are on', async () => {
  assert.match((await respond(update('/status'), allowed, null)).text, /Plain-language commands: off/);
  assert.doesNotMatch((await respond(update('/help'), allowed, null)).text, /plain words/);
  assert.match((await respond(update('/help'), allowed, async () => null)).text, /plain words/);
});
