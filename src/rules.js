// Screening rules: a typed schema evaluated by plain code against metrics that
// carry provenance (live or unknown, with a timestamp). The evidence
// principles from the README are enforced here: an unknown value can never
// satisfy a required rule, and market cap and FDV are separate fields.

export const FIELDS = {
  marketCapUsd: { label: 'market cap', unit: 'usd' },
  fdvUsd: { label: 'fully diluted valuation', unit: 'usd' },
  liquidityUsd: { label: 'selected-pool liquidity', unit: 'usd' },
  volume1hUsd: { label: 'selected-pool 1h volume', unit: 'usd' },
  txns1h: { label: 'selected-pool 1h trades', unit: 'count' },
  poolAgeMinutes: { label: 'selected-pool age', unit: 'minutes' },
};
export const OPS = { gte: '≥', lte: '≤' };
export const MAX_RULES = 12;

export function isValidRule(rule) {
  return Boolean(rule) && typeof rule === 'object' &&
    Object.hasOwn(FIELDS, rule.field) && Object.hasOwn(OPS, rule.op) &&
    Number.isFinite(rule.value) && rule.value >= 0 && rule.value <= 1e15 &&
    ['require', 'warn'].includes(rule.severity) &&
    typeof rule.evidence === 'string' && rule.evidence.length >= 1 && rule.evidence.length <= 200;
}

// metrics: { [field]: { value: number|null, source: 'live'|'unknown', asOf } }.
// Verdict: 'fail' if any required rule fails; otherwise 'unknown' if any
// required rule could not be checked; otherwise 'pass'. Warn-only rules are
// reported but never change the verdict.
export function evaluate(rules, metrics) {
  const checks = rules.map((rule) => {
    const metric = metrics[rule.field] ?? { value: null, source: 'unknown', asOf: null };
    let outcome = 'unknown';
    if (metric.source !== 'unknown' && Number.isFinite(metric.value)) {
      const passed = rule.op === 'gte' ? metric.value >= rule.value : metric.value <= rule.value;
      outcome = passed ? 'pass' : 'fail';
    }
    return { rule, metric, outcome };
  });
  const required = checks.filter((c) => c.rule.severity === 'require');
  const verdict = required.some((c) => c.outcome === 'fail') ? 'fail'
    : required.some((c) => c.outcome === 'unknown') ? 'unknown' : 'pass';
  return { verdict, checks };
}

const quote = (evidence) => `"${evidence.length > 80 ? `${evidence.slice(0, 79)}…` : evidence}"`;

export function formatValue(field, value) {
  const rounded = Math.round(value).toLocaleString('en-US');
  const { unit } = FIELDS[field];
  return unit === 'usd' ? `$${rounded}` : unit === 'minutes' ? `${rounded} min` : `${rounded} trades`;
}

const ruleText = (rule) =>
  `${rule.severity === 'warn' ? 'warn if not' : 'require'} ${FIELDS[rule.field].label} ${OPS[rule.op]} ${formatValue(rule.field, rule.value)}`;

export function formatProposal({ rules, unresolved }) {
  const lines = ['Proposed screening rules — nothing is active yet.', ''];
  rules.forEach((rule, i) => lines.push(`${i + 1}. ${ruleText(rule)} — ${quote(rule.evidence)}`));
  if (unresolved.length) {
    lines.push('', 'Not understood or not supported (kept for your review, never activated):');
    unresolved.forEach((item) => lines.push(`• ${quote(item)}`));
  }
  lines.push('', 'Reply /approve to activate exactly these rules, or /discard to drop them.');
  return lines.join('\n');
}

export function formatApproved({ approved, version }) {
  const lines = [`Criteria v${version} is active (${approved.rules.length} rule${approved.rules.length === 1 ? '' : 's'}).`, ''];
  approved.rules.forEach((rule, i) => lines.push(`${i + 1}. ${ruleText(rule)}`));
  if (approved.unresolved?.length) {
    const n = approved.unresolved.length;
    lines.push('', `${n} unresolved item${n === 1 ? ' was' : 's were'} NOT activated. Send /criteria to review.`);
  }
  lines.push('', 'Check any Solana token against these rules with /check <token address>.');
  return lines.join('\n');
}

export function formatSaved(agent) {
  const lines = [`Saved criteria: v${agent.version}.`, ''];
  agent.approved.rules.forEach((rule, i) => lines.push(`${i + 1}. ${ruleText(rule)} — ${quote(rule.evidence)}`));
  if (agent.approved.unresolved?.length) {
    lines.push('', 'Unresolved items that were never activated:');
    agent.approved.unresolved.forEach((item) => lines.push(`• ${quote(item)}`));
  }
  lines.push('', 'Describe new rules after /criteria to propose a replacement.');
  return lines.join('\n');
}

const MARKS = { pass: '✓', fail: '✗', unknown: '?' };
const time = (asOf) => (asOf ? `${new Date(asOf).toISOString().slice(11, 16)} UTC` : 'no timestamp');
const checkLine = ({ rule, metric, outcome }) => outcome === 'unknown'
  ? `${MARKS.unknown} ${ruleText(rule)} — unknown (not provided by the data source for this pool)`
  : `${MARKS[outcome]} ${ruleText(rule)} — ${formatValue(rule.field, metric.value)} (${metric.source}, ${time(metric.asOf)})`;

export function formatEvaluation({ verdict, checks }, { version, address, pool, checkedAt }) {
  const headers = {
    pass: `PASSES your criteria v${version}.`,
    fail: `Does NOT pass your criteria v${version}.`,
    unknown: `NOT CONFIRMED against criteria v${version}: required data is unknown.`,
  };
  const required = checks.filter((c) => c.rule.severity === 'require');
  const warnings = checks.filter((c) => c.rule.severity === 'warn');
  const lines = [headers[verdict], '', `Token: ${address}`,
    `Pool: ${pool.base}/${pool.quote} on ${pool.dexId} — best liquidity of ${pool.poolCount} Solana pool${pool.poolCount === 1 ? '' : 's'} via DexScreener`,
    pool.url, '', ...required.map(checkLine)];
  if (warnings.length) lines.push('', 'Warning-only checks:', ...warnings.map(checkLine));
  lines.push('', `Checked ${checkedAt}. Unknown values never satisfy required rules.`,
    'Matching your rules does not make a token safe or profitable.');
  return lines.join('\n');
}

// A discovery alert: a brand-new pool whose live values satisfied every
// required rule. Unknown-verdict pools never alert, so an alert can only
// carry known, timestamped values.
export function formatAlert({ checks }, { version, pool, checkedAt }) {
  const required = checks.filter((c) => c.rule.severity === 'require');
  const warnings = checks.filter((c) => c.rule.severity === 'warn');
  const lines = [
    `Sift alert: a new pool matches your criteria v${version}.`, '',
    `${pool.name} on ${pool.dexId}`,
    `Token: ${pool.tokenAddress}`,
    pool.url, '',
    ...required.map(checkLine),
  ];
  if (warnings.length) lines.push('', 'Warning-only checks:', ...warnings.map(checkLine));
  lines.push('', `Found ${checkedAt} in GeckoTerminal's newest Solana pools. One alert per token; /scan off stops alerts.`,
    'Matching your rules does not make a token safe or profitable. New pools are where most scams live: verify before acting.');
  return lines.join('\n');
}
