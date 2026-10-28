import { criteriaKey } from './discovery-store.js';
import { describeRule } from './rules.js';

// Inspect saved observations only. No provider requests, strategy edits or
// inferred results for candidates which were never checked.
export function explainDiscovery(agents, id) {
  const saved = agents.get(id), scan = agents.discoveryGet(id);
  const lines = ['Sift · Why no alerts?', `Private discovery: ${scan.state}.`];
  if (saved.draft) {
    lines.push(saved.draft.pendingRequirements.length
      ? 'Your draft still has unresolved instructions. Use /mapextras to review supported mappings or /agent to edit it. Mapping does not approve or start discovery.'
      : 'Your draft awaits review. Use /agent; approval and /scan activation are separate.');
    if (saved.approved) lines.push('Existing approved rules remain separate from this draft. The draft has not replaced them.');
  }
  if (!saved.approved) {
    lines.push('No approved strategy is available. No qualifying discovery alert can be sent yet.');
  } else {
    const key = criteriaKey(saved.approved);
    if (scan.criteria_key !== key) lines.push('The saved scan is not using these approved rules. Use /scan to review the current strategy.');
    if (saved.approved.rules.some(r => r.field === 'liquidityProtection' && r.mode === 'require' && r.scope === 'all')) {
      lines.push('Required all-pools protection: complete pool coverage is not established. This requirement remains UNKNOWN and blocks every qualifying alert.');
    }
    if (saved.approved.rules.some(r => r.field === 'buyingCoordination' && r.mode === 'require')) {
      lines.push('Required bundle/coordination coverage: observed evidence can exclude a token, but complete coverage is unavailable. This requirement remains UNKNOWN when no exclusion is found and cannot qualify a token.');
    }
    const observations = agents.discoveryDiagnostics(id,key);
    if (!observations.length) lines.push('No saved candidate checks for these approved rules yet. /sources can check feed access; it does not start scanning.');
    else {
      lines.push(`Latest saved check per token, up to 20 tokens: ${observations.length} shown. This can span multiple cycles; it is not a complete candidate history or a fresh check.\nNewest observation: ${new Date(observations[0].checked_at).toISOString()}.`);
      let matches=0, unavailable=0;
      const counts=new Map(saved.approved.rules.map(r=>[r.field,{rule:r,fail:0,unknown:0}]));
      for(const row of observations) {
        if(row.result.matches===true) matches++;
        if(row.result.issue) unavailable++;
        for(const check of row.result.checks??[]) {
          const entry=counts.get(check.field);
          if(entry && ['fail','unknown'].includes(check.state)) entry[check.state]++;
        }
      }
      lines.push(`Passed required rules: ${matches}. Checks with a source issue: ${unavailable}.`);
      for(const entry of counts.values()) {
        if(entry.fail || entry.unknown) lines.push(`${describeRule(entry.rule)}\n${entry.fail} failed; ${entry.unknown} unknown.${entry.rule.mode==='warn'?' Warning only; does not block a match.':''}`);
      }
      if(matches) lines.push('A passing observation need not produce a new delivery: previously attempted calls, muted tokens, quiet hours, posting limits or delivery failures can prevent one. See /alerts, /calls and /preferences.');
    }
  }
  lines.push('This report is private discovery only. /groups shows group destinations. Your rules, risk thresholds and scan state are unchanged.');
  return {chat_id:id,text:lines.join('\n\n'),link_preview_options:{is_disabled:true}};
}
