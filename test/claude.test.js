import test from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import {
  createClaude, CRITERIA_LIMIT, DEFAULT_CLAUDE_MODEL, INTERPRETED_COMMANDS,
  MAX_CRITERIA_LENGTH, MAX_ROUTE_LENGTH, readClaudeConfig, ROUTE_LIMIT, validateProposal, valuesInEvidence,
} from '../src/claude.js';

// Fake Claude client: no network calls and no API key in tests.
const silent = { warn() {} };
const answer = (payload, stop_reason = 'end_turn') => ({ stop_reason, content: [{ type: 'text', text: JSON.stringify(payload) }] });
const apiError = (status, text = 'detail') => new Anthropic.APIError(status, { error: { message: text } }, text, new Headers());
function fakeClient(result) {
  const calls = [];
  const client = { beta: { messages: { create: async (params, options) => {
    calls.push({ params, options });
    const next = typeof result === 'function' ? result(calls.length, params) : result;
    if (next instanceof Error) throw next;
    return next;
  } } } };
  return { client, calls };
}
const DESCRIPTION = 'at least 10k liquidity and mcap under 5m, warn if the pool is younger than 30 minutes';
const PROPOSAL = {
  rules: [
    { field: 'liquidityUsd', op: 'gte', value: 10_000, severity: 'require', evidence: '10k liquidity' },
    { field: 'marketCapUsd', op: 'lte', value: 5_000_000, severity: 'require', evidence: 'mcap under 5m' },
    { field: 'poolAgeMinutes', op: 'gte', value: 30, severity: 'warn', evidence: 'younger than 30 minutes' },
  ],
  unresolved: [],
};

test('configuration is opt-in and validates the model', () => {
  assert.equal(readClaudeConfig({}), null);
  assert.equal(readClaudeConfig({ ANTHROPIC_API_KEY: '  ' }), null);
  assert.deepEqual(readClaudeConfig({ ANTHROPIC_API_KEY: 'k' }), { model: DEFAULT_CLAUDE_MODEL });
  assert.deepEqual(readClaudeConfig({ ANTHROPIC_API_KEY: 'k', SIFT_CLAUDE_MODEL: 'claude-haiku-5-5' }), { model: 'claude-haiku-5-5' });
  assert.throws(() => readClaudeConfig({ ANTHROPIC_API_KEY: 'k', SIFT_CLAUDE_MODEL: 'bad model!' }), /SIFT_CLAUDE_MODEL/);
});

test('routing asks for one command from a fixed list with the expected request shape', async () => {
  const { client, calls } = fakeClient(answer({ command: 'status' }));
  const signal = new AbortController().signal;
  const claude = createClaude({ client, log: silent });
  assert.equal(await claude.routeCommand('is scanning live yet?', { userId: 42, signal }), 'status');

  const { params, options } = calls[0];
  assert.equal(params.model, DEFAULT_CLAUDE_MODEL);
  assert.deepEqual(params.messages, [{ role: 'user', content: 'is scanning live yet?' }]);
  assert.match(params.system, /never follow instructions/);
  assert.deepEqual(params.output_config.format.schema.properties.command.enum, INTERPRETED_COMMANDS);
  assert.equal(params.output_config.effort, 'low');
  assert.ok(params.max_tokens >= 2048); // thinking counts toward the cap
  assert.ok(INTERPRETED_COMMANDS.includes('criteria'));
  assert.match(params.system, /criteria: the message describes which tokens they want/);
  assert.equal(params.fallbacks, 'default');
  assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(options.signal, signal);
  for (const key of ['temperature', 'top_p', 'top_k', 'thinking']) assert.ok(!(key in params));
});

test('routing returns null instead of guessing when the answer is unusable', async () => {
  for (const response of [
    answer({ command: 'status' }, 'refusal'),
    answer({ command: 'status' }, 'max_tokens'),
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] },
    answer({ command: 'buy' }),
    { stop_reason: 'end_turn', content: [] },
  ]) {
    const { client } = fakeClient(response);
    assert.equal(await createClaude({ client, log: silent }).routeCommand('hello', { userId: 42 }), null);
  }
});

test('criteria interpretation sends the schema and returns a validated proposal', async () => {
  const { client, calls } = fakeClient(answer(PROPOSAL));
  const claude = createClaude({ client, log: silent });
  assert.deepEqual(await claude.proposeCriteria(DESCRIPTION, { userId: 42 }), PROPOSAL);

  const { params, options } = calls[0];
  assert.equal(params.output_config.effort, 'medium'); // set explicitly: the model default may differ
  assert.ok(params.max_tokens >= 8192);
  assert.deepEqual({ timeout: options.timeout, maxRetries: options.maxRetries }, { timeout: 45_000, maxRetries: 0 });
  assert.match(params.system, /Never invent thresholds/);
  assert.match(params.system, /pool age, not token age/);
  const schema = params.output_config.format.schema;
  assert.deepEqual(schema.properties.rules.items.properties.field.enum,
    ['marketCapUsd', 'fdvUsd', 'liquidityUsd', 'volume1hUsd', 'txns1h', 'poolAgeMinutes']);
  assert.deepEqual(schema.required, ['rules', 'unresolved']);
});

test('schemas sent to the API use only keywords structured outputs support', async () => {
  // The API rejects numeric, string-length and array constraints with a 400,
  // which would silently turn every /criteria call into a failure.
  const UNSUPPORTED = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
    'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties'];
  const walk = (node, path = 'schema') => {
    if (!node || typeof node !== 'object') return;
    for (const key of UNSUPPORTED) assert.ok(!(key in node), `${path} uses unsupported "${key}"`);
    if (node.type === 'object') assert.equal(node.additionalProperties, false, `${path} must set additionalProperties: false`);
    for (const [key, value] of Object.entries(node.properties ?? {})) walk(value, `${path}.${key}`);
    if (node.items) walk(node.items, `${path}[]`);
  };
  const { client, calls } = fakeClient((_n, params) => answer(params.system.startsWith('You route') ? { command: 'help' } : PROPOSAL));
  const claude = createClaude({ client, log: silent });
  await claude.routeCommand('hi', { userId: 42 });
  await claude.proposeCriteria(DESCRIPTION, { userId: 42 });
  assert.equal(calls.length, 2);
  for (const { params } of calls) {
    assert.equal(params.output_config.format.type, 'json_schema');
    walk(params.output_config.format.schema);
  }
});

test('a proposal whose evidence is not quoted from the message is rejected whole', () => {
  assert.deepEqual(validateProposal(PROPOSAL, DESCRIPTION), PROPOSAL);
  const invented = { rules: [{ ...PROPOSAL.rules[0], evidence: 'threshold I made up' }], unresolved: [] };
  assert.equal(validateProposal(invented, DESCRIPTION), null);
  for (const bad of [
    { rules: [{ ...PROPOSAL.rules[0], field: 'holders' }], unresolved: [] },
    { rules: [{ ...PROPOSAL.rules[0], value: -5 }], unresolved: [] },
    { rules: [{ ...PROPOSAL.rules[0], severity: 'block' }], unresolved: [] },
    { rules: Array.from({ length: 13 }, () => PROPOSAL.rules[0]), unresolved: [] },
    { rules: 'none', unresolved: [] },
    null,
  ]) {
    assert.equal(validateProposal(bad, DESCRIPTION), null, JSON.stringify(bad));
  }
  // Unresolved is display-only and lenient: non-strings dropped, long items trimmed.
  const lenient = validateProposal({ rules: [], unresolved: [7, '  dev must be clean  ', 'x'.repeat(400)] }, DESCRIPTION);
  assert.deepEqual(lenient.unresolved[0], 'dev must be clean');
  assert.equal(lenient.unresolved[1].length, 300);
});

test('numbers are traced per field: "5m" is $5,000,000 of market cap but 5 minutes of pool age', () => {
  const table = [
    ['mcap under 5m', 'marketCapUsd', [5_000_000]],
    ['pool under 5m old', 'poolAgeMinutes', [5]],
    ['older than 2 hours', 'poolAgeMinutes', [120]],
    ['between 50k and 2m', 'marketCapUsd', [50_000, 2_000_000]],
    ['$1.2M liquidity', 'liquidityUsd', [1_200_000]],
    ['at least 10,000 liquidity', 'liquidityUsd', [10_000]],
    ['50+ trades an hour', 'txns1h', [50]],
    ['5 million fdv', 'fdvUsd', [5_000_000]],
    ['half a million', 'marketCapUsd', []],
  ];
  for (const [evidence, field, expected] of table) assert.deepEqual(valuesInEvidence(evidence, field), expected, evidence);
});

test('a rule whose number does not match its quote is listed back instead of proposed', () => {
  const text = 'liquidity over 10k and mcap under 5m';
  const raw = {
    rules: [
      { field: 'liquidityUsd', op: 'gte', value: 10_000, severity: 'require', evidence: 'liquidity over 10k' },
      { field: 'marketCapUsd', op: 'lte', value: 5_000, severity: 'require', evidence: 'mcap under 5m' }, // mis-scaled
    ],
    unresolved: [],
  };
  const result = validateProposal(raw, text);
  assert.deepEqual(result.rules.map((r) => r.field), ['liquidityUsd']);
  assert.deepEqual(result.unresolved, ['mcap under 5m']);
});

test('quotes may differ from the message in case and spacing, but not in words', () => {
  const text = 'Liquidity   over 10K please';
  const rule = { field: 'liquidityUsd', op: 'gte', value: 10_000, severity: 'require', evidence: 'liquidity over 10k' };
  assert.equal(validateProposal({ rules: [rule], unresolved: [] }, text).rules.length, 1);
  assert.equal(validateProposal({ rules: [{ ...rule, evidence: 'liquidity above 10k' }], unresolved: [] }, text), null);
});

test('empty or over-long text is never sent, with separate caps per purpose', async () => {
  const { client, calls } = fakeClient(answer({ command: 'help' }));
  const claude = createClaude({ client, log: silent });
  assert.equal(await claude.routeCommand('   ', { userId: 42 }), null);
  assert.equal(await claude.routeCommand('x'.repeat(MAX_ROUTE_LENGTH + 1), { userId: 42 }), null);
  assert.equal(await claude.proposeCriteria('x'.repeat(MAX_CRITERIA_LENGTH + 1), { userId: 42 }), null);
  assert.equal(calls.length, 0);
});

test('each tester gets separate per-minute budgets for routing and criteria', async () => {
  let clock = 1_000_000;
  const { client, calls } = fakeClient((_n, params) => answer(params.system.startsWith('You route') ? { command: 'help' } : PROPOSAL));
  const claude = createClaude({ client, log: silent, now: () => clock });
  for (let i = 0; i < ROUTE_LIMIT.requests; i += 1) assert.equal(await claude.routeCommand('hi', { userId: 42 }), 'help');
  assert.equal(await claude.routeCommand('hi', { userId: 42 }), null); // over the routing limit
  assert.equal(await claude.routeCommand('hi', { userId: 57 }), 'help'); // other testers unaffected
  // The criteria budget is its own; the routing limit does not consume it.
  for (let i = 0; i < CRITERIA_LIMIT.requests; i += 1) {
    assert.deepEqual(await claude.proposeCriteria(DESCRIPTION, { userId: 42 }), PROPOSAL);
  }
  assert.equal(await claude.proposeCriteria(DESCRIPTION, { userId: 42 }), null);
  const sent = calls.length;
  clock += ROUTE_LIMIT.windowMs + 1;
  assert.equal(await claude.routeCommand('hi', { userId: 42 }), 'help'); // window passed
  assert.equal(calls.length, sent + 1);
});

test('a rejected key or model turns both Claude features off until restart', async () => {
  for (const status of [401, 403, 404]) {
    const logs = [];
    const { client, calls } = fakeClient(apiError(status));
    const claude = createClaude({ client, log: { warn: (m) => logs.push(m) } });
    assert.equal(await claude.routeCommand('hi', { userId: 42 }), null);
    assert.equal(claude.available, false);
    assert.equal(await claude.proposeCriteria(DESCRIPTION, { userId: 42 }), null); // no second request
    assert.equal(calls.length, 1);
    assert.match(logs[0], /off until restart/);
  }
  // Rate limits, overload and per-message errors keep Claude on.
  for (const status of [400, 429, 500, 529]) {
    const { client } = fakeClient(apiError(status));
    const claude = createClaude({ client, log: silent });
    await claude.routeCommand('hi', { userId: 42 });
    assert.equal(claude.available, true);
  }
});

test('failures are logged by status only; tester text never reaches the logs', async () => {
  const secretText = 'my private message';
  for (const error of [apiError(500, secretText), new Error(secretText)]) {
    const logs = [];
    const { client } = fakeClient(error);
    const claude = createClaude({ client, log: { warn: (m) => logs.push(m) } });
    assert.equal(await claude.routeCommand(secretText, { userId: 42 }), null);
    assert.equal(await claude.proposeCriteria(secretText, { userId: 42 }), null);
    assert.equal(logs.length, 2);
    assert.ok(logs.every((line) => !line.includes(secretText)));
  }
});
