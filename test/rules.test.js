import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, formatEvaluation, formatProposal, isValidRule } from '../src/rules.js';

const rule = (over = {}) => ({ field: 'liquidityUsd', op: 'gte', value: 10_000, severity: 'require', evidence: '10k liquidity', ...over });
const live = (value) => ({ value, source: 'live', asOf: '2026-11-16T19:00:00.000Z' });
const UNKNOWN = { value: null, source: 'unknown', asOf: '2026-11-16T19:00:00.000Z' };

test('rule validation rejects unknown fields, ops, severities and bad values', () => {
  assert.equal(isValidRule(rule()), true);
  assert.equal(isValidRule(rule({ value: 0 })), true);
  for (const bad of [
    rule({ field: 'holders' }), rule({ op: 'eq' }), rule({ severity: 'block' }),
    rule({ value: -1 }), rule({ value: NaN }), rule({ value: Infinity }), rule({ value: 1e16 }),
    rule({ value: '10000' }), rule({ evidence: '' }), rule({ evidence: 'x'.repeat(201) }), null, 'rule',
  ]) {
    assert.equal(isValidRule(bad), false, JSON.stringify(bad));
  }
});

test('evaluation compares live values and an unknown never satisfies a required rule', () => {
  const rules = [rule(), rule({ field: 'marketCapUsd', op: 'lte', value: 5_000_000, evidence: 'under 5m mcap' })];
  assert.equal(evaluate(rules, { liquidityUsd: live(23_411), marketCapUsd: live(900_000) }).verdict, 'pass');
  assert.equal(evaluate(rules, { liquidityUsd: live(9_999), marketCapUsd: live(900_000) }).verdict, 'fail');
  // Required data missing: the verdict is unknown, never pass.
  assert.equal(evaluate(rules, { liquidityUsd: live(23_411), marketCapUsd: UNKNOWN }).verdict, 'unknown');
  assert.equal(evaluate(rules, { liquidityUsd: live(23_411) }).verdict, 'unknown'); // absent metric = unknown
  // A definite failure outranks missing data.
  assert.equal(evaluate(rules, { liquidityUsd: live(1), marketCapUsd: UNKNOWN }).verdict, 'fail');
  // Zero is a real value, not unknown: 0 volume fails a minimum-volume rule.
  const volume = [rule({ field: 'volume1hUsd', value: 5_000, evidence: '5k volume' })];
  assert.equal(evaluate(volume, { volume1hUsd: live(0) }).checks[0].outcome, 'fail');
});

test('warn-only rules are reported but never change the verdict', () => {
  const rules = [rule(), rule({ field: 'poolAgeMinutes', op: 'gte', value: 30, severity: 'warn', evidence: 'younger than 30 minutes' })];
  const result = evaluate(rules, { liquidityUsd: live(50_000), poolAgeMinutes: live(5) });
  assert.equal(result.verdict, 'pass');
  assert.equal(result.checks.find((c) => c.rule.severity === 'warn').outcome, 'fail');
});

test('formatting quotes evidence, labels provenance, and separates mcap from FDV', () => {
  const proposal = {
    rules: [rule(), rule({ field: 'fdvUsd', op: 'lte', value: 2_000_000, evidence: 'fdv under 2m' })],
    unresolved: ['dev wallet must be clean'],
  };
  const text = formatProposal(proposal);
  assert.match(text, /nothing is active yet/i);
  assert.match(text, /"10k liquidity"/);
  assert.match(text, /fully diluted valuation ≤ \$2,000,000/);
  assert.match(text, /"dev wallet must be clean"/);
  assert.match(text, /\/approve/);

  const evaluation = evaluate(proposal.rules, { liquidityUsd: live(23_411), fdvUsd: UNKNOWN });
  const reply = formatEvaluation(evaluation, {
    version: 1, address: 'So1...', checkedAt: '2026-11-16T19:05:00.000Z',
    pool: { base: 'BONK', quote: 'SOL', dexId: 'meteora', url: 'https://dexscreener.com/solana/x', poolCount: 30 },
  });
  assert.match(reply, /NOT CONFIRMED/);
  assert.match(reply, /\$23,411 \(live, 19:00 UTC\)/);
  assert.match(reply, /\? .*fully diluted valuation.*unknown/);
  assert.match(reply, /best liquidity of 30 Solana pools/);
  assert.match(reply, /Unknown values never satisfy required rules/);
  assert.match(reply, /does not make a token safe or profitable/);
});
