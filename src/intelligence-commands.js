import { commandFor } from './bot.js';
import { isSolanaAddress } from './market.js';
import { withCopyableCAs } from './telegram-format.js';
import { HORIZONS, validatePreferences } from './intelligence-store.js';
import { formatPosition } from './position-size.js';
import { formatHolders } from './holders.js';

const pct=n=>Number.isFinite(n)?`${n.toFixed(2)}%`:'unknown';
export function performanceSummary(agents,user) {
  const counts=agents.signalCounts(user),metrics=agents.signalMetrics(user),feedback=agents.feedbackSummary(user);
  return ['Sift · All recorded calls',counts.length?counts.map(r=>`${r.delivery}: ${r.n}`).join(' · '):'No calls recorded by this version yet.',
    ...HORIZONS.map(h=>{
      const rows=metrics.filter(r=>r.horizon===h),valid=rows.filter(r=>r.state==='observed'&&Number.isFinite(r.data.netPct));
      return `${h}m: ${valid.length} observed; ${rows.filter(r=>r.state==='missed').length} missed; ${rows.filter(r=>r.state==='unavailable').length} unavailable.\n`+
        (valid.length?`Paper wins ${valid.filter(r=>r.data.netPct>0).length}/${valid.length}; mean net ${pct(valid.reduce((s,r)=>s+r.data.netPct,0)/valid.length)}.`:'No return estimate yet.');
    }),
    'Every new delivery attempt is retained, including failures and losses. Returns cover confirmed sends only. Pending/uncertain delivery is not counted as a delivered call. Missing horizons are shown separately, not removed from the record or treated as zero. Older pre-upgrade calls have no reconstructed baseline.',
    'Paper estimates use provider prices from the same pool, without an executable fill. Per-leg fee and slippage assumptions are frozen at the call. Network fees, MEV and market impact are excluded; these are not actual tester profits. Sampled drawdown can miss moves between checks. No profit or rug-free claim.',
    feedback.length?'Tester self-reports (unverified): '+feedback.map(r=>`${r.outcome}: ${r.n}, average rating ${r.rating.toFixed(1)}/5`).join('; '):'No tester self-reports yet.',
    'Use /calls for recent call IDs, /performance ID for details, /feedback ID 1-5 no_trade|profit|loss|suspected_rug to record your experience.',
  ].join('\n\n');
}
export function createIntelligenceCommands({agents,quotes,holders,now=Date.now}) {
  return async(update,allowed,signal)=>{
    const cb=update?.callback_query;
    if(typeof cb?.data==='string'&&cb.data.startsWith('evidence:')) {
      const id=cb.from?.id,ack=callbackNotice=>({callbackQueryId:cb.id,callbackNotice});
      if(typeof cb.id!=='string'||cb.from?.is_bot||cb.message?.chat?.type!=='private'||cb.message.chat.id!==id||!allowed.has(id))return ack('Private tester controls only.');
      const m=/^evidence:([1-9]\d*):(\d+):(\d+)$/.exec(cb.data);
      if(!m||Number(m[1])!==id)return ack('This evidence belongs to another tester.');
      const row=agents.discoveryAlert(id,Number(m[2])),page=Number(m[3]);
      if(!row||!Number.isSafeInteger(page))return ack('Saved evidence unavailable.');
      const pages=row.payload.evidence??[row.payload.text];
      if(page>=pages.length)return ack('Page unavailable.');
      return withCopyableCAs({chat_id:id,text:`Saved evidence · ${page+1}/${pages.length}\nThis is the original observation, not a fresh check.\n\n${pages[page]}`,
        link_preview_options:{is_disabled:true},reply_markup:{inline_keyboard:[[
          ...(page>0?[{text:'Previous',callback_data:`evidence:${id}:${row.id}:${page-1}`}]:[]),
          ...(page+1<pages.length?[{text:'Next',callback_data:`evidence:${id}:${row.id}:${page+1}`}]:[]),
        ]].filter(r=>r.length)},...ack('Saved evidence.')},[row.token]);
    }
    const c=commandFor(update);if(!c||!allowed.has(c.userId))return null;
    const id=c.userId,args=c.args.split(/\s+/),reply=text=>({chat_id:id,text,link_preview_options:{is_disabled:true}});
    if(c.command==='performance') {
      if(!c.args)return reply(performanceSummary(agents,id));
      const row=/^[1-9]\d*$/.test(c.args)&&agents.signalGet(id,Number(c.args));
      if(!row)return reply('Call unavailable for your account. Use /calls for IDs.');
      const lines=[`Sift · Call #${row.id} · ${row.delivery}\nCA: ${row.token}\nCalled: ${new Date(row.at).toISOString()}\nDestination: ${row.target===id?'private chat':row.target}`,
        `Fixed pool: ${row.pool??'unknown'}\nFrozen paper costs per leg: ${row.costs.feeBps/100}% fee, ${row.costs.slippageBps/100}% slippage.\nSampled peak-to-trough drawdown: ${pct(row.observation?.sampledDrawdown)}`,
        ...agents.signalOutcomes(row.id).map(o=>`${o.horizon}m: ${o.state}${o.state==='observed'?`; gross ${pct(o.data.grossPct)}, paper net ${pct(o.data.netPct)}`:''}`),
        `Last attempt: ${row.last_check?new Date(row.last_check).toISOString():'none'}\nLatest issue: ${row.issue??'none recorded'}\nFollow-up notifications: ${row.follow_until>now()?'enabled until '+new Date(row.follow_until).toISOString():'off or ended'}`,
        ...agents.signalEvents(id,row.id).slice(0,4).map(e=>`${e.delivery} · ${e.text}`),
        'Historical paper observations; not executable returns or verified tester trades. /followstop ID stops notifications.'];
      return withCopyableCAs(reply(lines.join('\n\n').slice(0,4000)),[row.token]);
    }
    if(c.command==='calls') {
      const page=c.args?Number(c.args):1;
      if(!Number.isSafeInteger(page)||page<1||page>1000000)return reply('Use /calls PAGE, starting at 1.');
      const rows=agents.signalList(id,10,(page-1)*10);
      return reply(`Sift calls · page ${page}\n\n`+(rows.length?rows.map(r=>`#${r.id} · ${r.delivery} · ${new Date(r.at).toISOString()}\nCA: ${r.token}`).join('\n\n'):'No calls on this page.')+`\n\nUse /calls ${page+1} for older calls or /performance ID for details.`);
    }
    if(c.command==='audit')return reply('Your latest rule and configuration changes\n\n'+(agents.auditList(id).map(r=>`${new Date(r.at).toISOString()} · ${r.action}\n${r.detail}`).join('\n\n').slice(0,3700)||'None recorded.'));
    if(c.command==='size') {
      const p=agents.preferences(id),usd=args[1]?Number(args[1]):p.positionUsd;
      if(!quotes||!isSolanaAddress(args[0])||args.length>2||!Number.isFinite(usd)||usd<1||usd>10000)return reply('Send /size <CA> <USDC amount from 1 to 10000>. This requests entry and exit quotes without a wallet or a trade. /preferences position AMOUNT saves your sizing amount.');
      const value=await quotes.check(args[0],usd,{signal,slippageBps:p.slippageBps});
      return signal?.aborted||!allowed.has(id)?null:withCopyableCAs(reply(formatPosition(value,args[0],usd)),[args[0]]);
    }
    if(c.command==='holders') {
      if(!holders||!isSolanaAddress(c.args))return reply('Send /holders <CA> for a bounded finalized sample of the largest token accounts.');
      const value=await holders.check(c.args,{signal});
      return signal?.aborted||!allowed.has(id)?null:withCopyableCAs(reply(formatHolders(value,c.args)),[c.args]);
    }
    if(c.command==='preferences') {
      const p=agents.preferences(id);
      if(!c.args)return reply(`Sift preferences\nFollow-ups for future calls: ${p.followHours} hours (0 = off).\nPosition size: ${p.positionUsd??'not set'} USDC.\nPaper costs per leg: fee ${p.feeBps} bps, slippage ${p.slippageBps} bps.\nQuiet hours UTC: ${p.quietStart===null?'off':p.quietStart+'–'+p.quietEnd}.\n\nCommands:\n/preferences follow HOURS (0–168)\n/preferences position AMOUNT (1–10000 USDC)\n/preferences paper FEE_BPS SLIPPAGE_BPS (0–1000 each)\n/preferences quiet START_HOUR END_HOUR (UTC)\n/preferences quiet off\n\nFollow-ups recheck captured rules, liquidity, and limited risk/holder evidence; they are private even for a group call. They never change screening rules. Quiet hours suppress new discovery/follow-up notifications; explicit /watch monitors retain their own controls. Performance observations remain recorded. No paid APIs enabled here.`);
      const next={...p};let valid=true;
      if(args[0]==='follow'&&args.length===2)next.followHours=Number(args[1]);
      else if(args[0]==='position'&&args.length===2)next.positionUsd=Number(args[1]);
      else if(args[0]==='paper'&&args.length===3){next.feeBps=Number(args[1]);next.slippageBps=Number(args[2]);}
      else if(args[0]==='quiet'&&args[1]==='off'&&args.length===2){next.quietStart=null;next.quietEnd=null;}
      else if(args[0]==='quiet'&&args.length===3){next.quietStart=Number(args[1]);next.quietEnd=Number(args[2]);}
      else valid=false;
      try{validatePreferences(next);}catch{valid=false;}
      if(!valid)return reply('Invalid preference. Send /preferences for exact formats. Nothing changed.');
      return agents.process(update.update_id,()=>{agents.preferencesPut(id,next,now());return reply('Preferences saved. Existing paper cost assumptions and screening rules are unchanged. Follow-up duration applies to future calls; setting it to 0 stops existing follow-up notifications.');});
    }
    if(c.command==='followstop') {
      if(!/^[1-9]\d*$/.test(c.args)||!agents.signalGet(id,Number(c.args)))return reply('Use /followstop ID with one of your /calls IDs.');
      return agents.process(update.update_id,()=>{agents.signalStop(id,Number(c.args));return reply('Follow-up notifications stopped for this call. The original record and performance observations remain.');});
    }
    if(c.command==='feedback')return agents.process(update.update_id,()=>reply(args.length===3&&agents.signalFeedback(id,Number(args[0]),Number(args[1]),args[2],now())?
      'Feedback saved as your unverified self-report. It does not change recorded price outcomes or classify a token as a confirmed rug.':'Use /feedback CALL_ID RATING OUTCOME. Rating: 1–5. Outcome: no_trade, profit, loss or suspected_rug.'));
    return null;
  };
}
