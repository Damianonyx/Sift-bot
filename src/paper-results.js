// These are frozen illustrative costs, not quotes, fills or actual trading P&L.
export function paperResult(entry, exit, costs) {
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(exit) || exit < 0 ||
      !costs || ![costs.feeBps, costs.slippageBps].every(n => Number.isInteger(n) && n >= 0 && n <= 1000)) return null;
  const factor=(1-costs.feeBps/10000)*(1-costs.slippageBps/10000);
  const grossPct=(exit/entry-1)*100,netPct=(exit/entry*factor*factor-1)*100;
  return Number.isFinite(grossPct)&&Number.isFinite(netPct)?{grossPct,netPct}:null;
}
