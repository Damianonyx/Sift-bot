import { evaluateAgent, describeRule, formatRuleEvaluation } from './rules.js';
import { formatTokenReport } from './token-report.js';
import { formatRiskReport } from './risk.js';
import { formatCandidateSource } from './candidate-sources.js';

const usd=n=>Number.isFinite(n)?'$'+n.toLocaleString('en-US',{maximumFractionDigits:2}):'unknown';
export function promotionLabel(snapshot) {
  const boosts=snapshot.selected?.activeBoosts;
  return boosts>0?`Paid visibility: ${boosts} active DEX Screener boosts reported; not a ranking signal.`:
    boosts===0?'DEX Screener reports 0 active boosts; other paid promotion is unknown.':'Paid promotion: unknown; popularity is not proof of quality.';
}
export function signalCard(agent,snapshot,{now=Date.now(),batch,candidate}={}) {
  const result=evaluateAgent(agent,snapshot,{now});
  const warnings=result.checks.filter(r=>r.mode==='warn'&&r.state!=='pass');
  return [`Discovery match · ${agent.name}`,`CA: ${snapshot.address}`,
    `Market cap ${usd(snapshot.selected?.marketCap)} · liquidity ${usd(snapshot.selected?.liquidityUsd)}`,
    'Available data passes all required rules.\n'+result.checks.filter(r=>r.mode==='require').map(r=>`${r.state.toUpperCase()} · ${describeRule(r)}`).join('\n'),
    warnings.length?'Warnings:\n'+warnings.map(r=>`${r.state.toUpperCase()} · ${describeRule(r)}`).join('\n'):'Warning rules: no failures observed.',
    snapshot.risk?formatRiskReport(snapshot.risk,{compact:true}):'Risk checks were not requested. Locks, creator activity and bundles are not established by this match.',
    promotionLabel(snapshot),
    ...(candidate&&batch?[formatCandidateSource(candidate,batch)]:[]),
    `Chart: https://dexscreener.com/solana/${snapshot.selected?.address}`,
    `Market fetched: ${new Date(snapshot.fetchedAt).toISOString()}\nProvider update time: unknown.`,
    'View evidence for the saved snapshot, sources and coverage. Matching your rules does not establish safety.',
  ].join('\n\n');
}
export function evidencePages(agent,snapshot,batch,candidate) {
  const parts=[formatTokenReport(snapshot,{hasApprovedRules:true,discovery:true}),formatRuleEvaluation(agent,snapshot,{discovery:true}),
    formatCandidateSource(candidate,batch),promotionLabel(snapshot),snapshot.risk?formatRiskReport(snapshot.risk):'Risk evidence was not requested.'];
  // Telegram counts UTF-16 units; never split a surrogate pair or exceed 4096.
  const pages=[];let page='';
  for(const part of parts)for(const line of part.split('\n')) {
    for(let start=0;start<line.length||start===0;) {
      let end=Math.min(line.length,start+3500);if(end<line.length&&/[\uD800-\uDBFF]/.test(line[end-1]))end--;
      const piece=line.slice(start,end);if(page.length+piece.length+1>3600){pages.push(page);page='';}
      page+=(page?'\n':'')+piece;start=end;if(!line.length)break;
    }
  }
  if(page)pages.push(page);return pages;
}
