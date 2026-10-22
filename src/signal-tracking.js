import { HORIZONS, quietNow } from './intelligence-store.js';
import { watchMarketCheck, usableWatchSnapshot } from './watch.js';
import { evaluateAgent, describeRule } from './rules.js';
import { attachRisk } from './risk.js';
import { TelegramError } from './telegram.js';
import { AgentStoreError } from './agent-store.js';
import { withCopyableCAs } from './telegram-format.js';

export function paperResult(entry,exit,costs) {
  if(!Number.isFinite(entry)||entry<=0||!Number.isFinite(exit)||exit<0)return null;
  const factor=(1-costs.feeBps/10000)*(1-costs.slippageBps/10000);
  const grossPct=(exit/entry-1)*100,netPct=(exit/entry*factor*factor-1)*100;
  return Number.isFinite(grossPct)&&Number.isFinite(netPct)?{grossPct,netPct}:null;
}
export function followChanges(row,current,time) {
  const previous=row.observation??row.snapshot,events=[];
  const evaluation=evaluateAgent(row.strategy,current,{now:time});
  for(const rule of evaluation.checks)if(rule.state!=='pass')events.push([`rule_${rule.field}_${rule.state}`,`${rule.state.toUpperCase()} · ${describeRule(rule)}`]);
  const before=row.snapshot.selected?.liquidityUsd,after=current.selected?.liquidityUsd;
  // Observations, not a user screening threshold or an assertion of withdrawal.
  if(Number.isFinite(before)&&before>0&&Number.isFinite(after)&&after<before) {
    const drop=(1-after/before)*100;
    for(const threshold of [25,50,75])if(drop>=threshold)events.push([`liquidity_${threshold}`,`USD liquidity is ${drop.toFixed(2)}% below the call snapshot. Prices and balances both affect this; no withdrawal or broken lock is proved.`]);
  }
  const old=(previous.lastKnownRisk??previous.risk)?.developerHolding,next=current.risk?.developerHolding;
  if(old?.wallet&&old.wallet===next?.wallet&&/^\d+$/.test(old.amount??'')&&/^\d+$/.test(next.amount??'')&&old.amount!==next.amount)events.push([
    `creator_balance_${next.slot}`,`Signing creator balance changed: ${old.amount} → ${next.amount} raw units. A balance decrease alone is not a sale.`]);
  const baselineEvents=new Set((row.snapshot.risk?.events??[]).map(e=>e.kind+':'+e.link));
  for(const event of current.risk?.events??[])if(!baselineEvents.has(event.kind+':'+event.link))events.push([`creator_${event.kind}_${event.signature??event.link}`,`Newly found creator ${event.kind}: ${event.amount} raw units. Transaction may predate the call; first observed here during this check.\n${event.link}`]);
  const unlock=current.risk?.liquidityProtection?.unlockAt;
  if(Number.isSafeInteger(unlock)&&unlock<=time+7*86400000)events.push(['unlock_7d',`A previously observed lock ends within seven days or has elapsed: ${new Date(unlock).toISOString()}. Re-check current protection; expiry alone does not prove withdrawal.`]);
  const previousHolders=previous.lastKnownHolders??previous.holders;
  if(current.holders?.state==='observed'&&previousHolders?.state==='observed') {
    const change=current.holders.topAccountPercent-previousHolders.topAccountPercent;
    if(Math.abs(change)>=5)events.push([`account_concentration_${current.holders.slot}`,`Top token-account share changed by ${change.toFixed(2)} percentage points. Samples include pool/locker/exchange accounts and do not identify insiders.`]);
  }
  return events;
}
export function createSignalTracker({agents,market,risk,holders,call,allowedUserIds,now=Date.now,wait}) {
  let deliveryAfter=0;
  return {async cycle({signal}={}) {
    const sent=new Map(),cache=new Map();
    const rows=agents.signalDue(now(),4,allowedUserIds);
    const riskTarget=[...rows].filter(r=>r.follow_until>now()).sort((a,b)=>(a.last_risk??0)-(b.last_risk??0)||a.id-b.id)[0]?.id;
    for(const row of rows) {
      if(signal?.aborted)return;
      if(!allowedUserIds.has(row.user_id))continue;
      const time=now(),prior=agents.signalOutcomes(row.id);
      for(const horizon of HORIZONS)if(time>row.at+horizon*60000+300000&&!prior.some(o=>o.horizon===horizon))
        agents.signalOutcome(row.id,horizon,'missed',time,{reason:'No observation within five minutes after the fixed horizon. No backfill or invented zero.'});
      if(row.follow_until<=time&&agents.signalOutcomes(row.id).length===4)continue;
      let snapshot=null,issue=null;
      try {
        const key=row.token+':'+row.pool;
        if(!cache.has(key))cache.set(key,watchMarketCheck(market,row.token,{signal,poolAddress:row.pool},wait));
        snapshot=await cache.get(key);
        if(!usableWatchSnapshot(snapshot,row.token,now(),row.pool))throw Error('Unknown snapshot');
        if(row.follow_until>time) {
          if(row.id===riskTarget&&risk)snapshot=await attachRisk(snapshot,risk,{signal});
          if(row.id===riskTarget&&holders)snapshot={...snapshot,holders:await holders.check(row.token,{signal})};
        }
      } catch(error){if(error instanceof AgentStoreError)throw error;if(signal?.aborted)return;issue='Market observation unavailable';snapshot=null;}
      if(signal?.aborted||!allowedUserIds.has(row.user_id))continue;
      const completed=now();
      for(const horizon of HORIZONS) {
        const due=row.at+horizon*60000;
        if(completed<due||prior.some(o=>o.horizon===horizon))continue;
        const value=snapshot&&paperResult(row.snapshot.selected?.priceUsd,snapshot.selected?.priceUsd,row.costs);
        const late=completed>due+300000;
        agents.signalOutcome(row.id,horizon,late?'missed':value?'observed':'unavailable',completed,
          late?{reason:'Observation arrived outside the fixed horizon window.'}:{...value,price:snapshot?.selected?.priceUsd??null,
            fetchedAt:snapshot?.fetchedAt??null,providerTime:null,costs:row.costs,reason:value?null:'Entry or exit price unavailable; not a zero return.'});
      }
      const old=row.observation??row.snapshot,price=snapshot?.selected?.priceUsd,base=row.snapshot.selected?.priceUsd;
      if(snapshot&&Number.isFinite(price)&&price>=0&&Number.isFinite(base)&&base>0) {
        const peak=Math.max(old.sampledPeak??base,price),drawdown=peak>0?(1-price/peak)*100:0;
        snapshot={...snapshot,sampledPeak:peak,sampledDrawdown:Math.max(old.sampledDrawdown??0,drawdown)};
      }
      const current=agents.signalGet(row.user_id,row.id);
      const p=agents.preferences(row.user_id);
      const oldRisk=old.lastKnownRisk??old.risk;
      const lastKnownRisk=snapshot?.risk?{...snapshot.risk,
        developerHolding:snapshot.risk.developerHolding?.wallet?snapshot.risk.developerHolding:oldRisk?.developerHolding,
        liquidityProtection:Number.isSafeInteger(snapshot.risk.liquidityProtection?.unlockAt)?snapshot.risk.liquidityProtection:oldRisk?.liquidityProtection,
      }:oldRisk;
      agents.signalObserve(row.id,snapshot?{...snapshot,lastKnownRisk,
        lastKnownHolders:snapshot.holders?.state==='observed'?snapshot.holders:old.lastKnownHolders??old.holders}:null,issue,completed);
      if(!current||current.follow_until<=completed||p.followHours===0)continue;
      const events=snapshot?followChanges(row,snapshot,completed):[['source_unavailable','Follow-up market data is unavailable; current criteria and risk state are unknown.']];
      if(row.last_check&&completed-row.last_check>180000)events.unshift(['gap','Follow-up observations were interrupted for over three minutes. Events during the gap may be missed.']);
      for(const [kind,body] of events) {
        if(signal?.aborted||!allowedUserIds.has(row.user_id)||agents.signalGet(row.user_id,row.id)?.follow_until<=now())break;
        const text=`Sift · Follow-up #${row.id}\nCA: ${row.token}\n\n${body}\n\nObserved: ${new Date(completed).toISOString()}\nFixed pool: ${row.pool}\nSampled evidence only. /performance ${row.id} shows saved observations; /followstop ${row.id} stops these notifications.`;
        const event=agents.signalEvent(row.id,kind,text,completed);if(event===null)continue;
        if(quietNow(p,completed)||now()<deliveryAfter||(sent.get(row.user_id)??0)>=3){agents.signalEventDelivery(event,'suppressed');continue;}
        sent.set(row.user_id,(sent.get(row.user_id)??0)+1);
        try{await call('sendMessage',withCopyableCAs({chat_id:row.user_id,text,link_preview_options:{is_disabled:true}},[row.token]),signal);agents.signalEventDelivery(event,'sent');}
        catch(error){if(error instanceof AgentStoreError)throw error;agents.signalEventDelivery(event,error instanceof TelegramError&&Number.isInteger(error.code)?'failed':'uncertain');
          if(error instanceof TelegramError&&[401,404].includes(error.code))throw error;
          if(error instanceof TelegramError&&error.code===429)deliveryAfter=now()+error.retryAfter*1000;
          if(error instanceof TelegramError&&error.code===403)agents.preferencesPut(row.user_id,{...p,followHours:0},now());}
      }
    }
  }};
}
