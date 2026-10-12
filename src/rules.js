export const RULE_FIELDS = ['marketCap', 'liquidityUsd', 'volume1h', 'poolAgeMinutes'];
const validNumber = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;

export function validateRules(rules, { requireStrict = true } = {}) {
  if (!Array.isArray(rules) || (requireStrict && !rules.length) || rules.length > RULE_FIELDS.length) {
    throw new Error('Choose at least one required condition before approval.');
  }
  const seen = new Set();
  for (const rule of rules) {
    if (!rule || !RULE_FIELDS.includes(rule.field) || seen.has(rule.field) ||
        !['require', 'warn'].includes(rule.mode)) throw new Error('A screening rule is unsupported or incomplete.');
    seen.add(rule.field);
    if (rule.field === 'marketCap') {
      if (!validNumber(rule.min) || !validNumber(rule.max) || rule.min > rule.max) {
        throw new Error('Market cap needs a valid minimum and maximum.');
      }
    } else if (!validNumber(rule.value)) throw new Error('Each condition needs a valid threshold.');
  }
  if (requireStrict && !rules.some((r) => r.mode === 'require')) throw new Error('Choose at least one required condition before approval.');
}

const money = (value) => '$' + value.toLocaleString('en-US', { maximumFractionDigits: 6 });
export function describeRule(rule) {
  const descriptions = {
    marketCap: () => `Market cap (provider estimate): ${money(rule.min)}–${money(rule.max)}`,
    liquidityUsd: () => `Selected pool liquidity: at least ${money(rule.value)}`,
    volume1h: () => `Selected pool volume over 1h: at least ${money(rule.value)}`,
    poolAgeMinutes: () => `Selected pool age: at most ${rule.value} minutes (not token creation or trading start)`,
  };
  return `${rule.mode === 'require' ? 'Required' : 'Warning only'} · ${descriptions[rule.field]()}`;
}

export function evaluateRules(rules, snapshot) {
  validateRules(rules);
  const pool = snapshot?.selected;
  const age = pool && validNumber(pool.createdAt) && validNumber(snapshot.fetchedAt) &&
    pool.createdAt <= snapshot.fetchedAt ? (snapshot.fetchedAt - pool.createdAt) / 60000 : null;
  const metrics = {
    marketCap: pool?.marketCap,
    liquidityUsd: pool?.liquidityUsd,
    volume1h: pool?.windows?.find((w) => w.window === 'h1')?.volume,
    poolAgeMinutes: age,
  };
  const checks = rules.map((rule) => {
    const value = metrics[rule.field];
    let state = 'unknown';
    if (validNumber(value)) {
      const passes = rule.field === 'marketCap' ? value >= rule.min && value <= rule.max :
        rule.field === 'poolAgeMinutes' ? value <= rule.value : value >= rule.value;
      state = passes ? 'pass' : 'fail';
    }
    return { ...rule, valueObserved: validNumber(value) ? value : null, state };
  });
  return { matches: checks.filter((r) => r.mode === 'require').every((r) => r.state === 'pass'), checks };
}

export function assertApprovable(agent) {
  if (!Array.isArray(agent.pendingRequirements) || agent.pendingRequirements.length) {
    throw new Error('Approval blocked: extra requirements still need clarification and supported checks.');
  }
  validateRules(agent.rules);
}

export function evaluateAgent(agent, snapshot) {
  const result = evaluateRules(agent.rules, snapshot);
  const unresolved = !Array.isArray(agent.pendingRequirements) || agent.pendingRequirements.length > 0;
  return { ...result, matches: result.matches && !unresolved, unresolved };
}

export function formatRuleEvaluation(approved, snapshot, { discovery = false } = {}) {
  const result = evaluateAgent(approved, snapshot);
  return [
    `Your approved rules · ${approved.name}`,
    result.matches ? 'Available data passes all required rules.' : 'Required rules are not all satisfied; unknown results cannot pass.',
    ...result.checks.map((rule) => `${rule.state.toUpperCase()} · ${describeRule(rule)}`),
    ...(result.unresolved ? ['UNKNOWN · Additional requirements remain unresolved; this cannot qualify.'] : []),
    discovery ? 'Evaluated at the market-data retrieval time shown above.' : 'Manual evaluation of this submitted CA. Use /scan to review discovery status.',
  ].join('\n');
}
