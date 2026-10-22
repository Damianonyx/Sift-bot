// Deliberately explicit grammar. Unrecognized or contradictory wording remains
// unresolved; an AI model cannot silently relax scope or unknown handling.
export function parsePolicyDescription(text) {
  const rules=[],unresolved=[],market=[];let developer=null,buying=null,partial=false,transfers=false,suspicions=false;
  for(const raw of text.split(/(?:;|\n|\.\s+(?=[A-Za-z]))+/).filter(x=>x.trim())) {
    const original=raw.trim(),clause=original.replace(/\.$/,'').toLowerCase();
    const lp=/^(require|warn|flag) (100)% (selected[- ]pool|all[- ]pools?|across all pools) liquidity protection(?:[,:] verified locks)? with (?:at least )?(?:six|6) (?:utc calendar )?months remaining(?:,? or verified lp burn(?:s|ing)(?: where valid for that pool type)?)$/.exec(clause);
    if(lp){rules.push({field:'liquidityProtection',mode:lp[1]==='require'?'require':'warn',policy:'evidence-v2',scope:lp[3].startsWith('selected')?'selected':'all'});continue;}
    if(/^(?:the identified |the signing |require |warn |flag )?dev(?:eloper)? (?:must )?still hold(?:s)? tokens$/.test(clause)) {
      if(developer)unresolved.push(original);else developer={field:'developerHolding',mode:/^(warn|flag) /.test(clause)?'warn':'require',policy:'evidence-v2'};continue;
    }
    if(/^allow partial (?:developer )?sales,? but flag them$/.test(clause)){partial=true;continue;}
    if(/^report transfers separately from sales$/.test(clause)){transfers=true;continue;}
    if(/^(?:require |warn |flag )?exclude confirmed (?:coordinated buying or bundles|bundles or coordinated buying)$/.test(clause)) {
      if(buying)unresolved.push(original);else buying={field:'buyingCoordination',mode:/^(warn|flag) /.test(clause)?'warn':'require',policy:'evidence-v2'};continue;
    }
    if(/^flag (?:suspected cases|suspicions)$/.test(clause)){suspicions=true;continue;}
    if(/^unknown required checks must not qualify$/.test(clause))continue;
    market.push(original);
  }
  // Activity clauses are one inseparable policy; never invent an action for sales.
  if(developer&&partial&&transfers)rules.push(developer);
  else if(developer||partial||transfers)unresolved.push('Developer policy needs: still holds tokens; allow partial sales but flag them; report transfers separately from sales.');
  if(buying&&suspicions)rules.push(buying);
  else if(buying||suspicions)unresolved.push('Buying policy needs: exclude confirmed coordinated buying or bundles; flag suspected cases.');
  if(new Set(rules.map(r=>r.field)).size!==rules.length)return {rules:[],market:[],unresolved:[text]};
  return {rules,market,unresolved};
}
