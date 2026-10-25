import { DatabaseSync } from 'node:sqlite';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { HORIZONS } from './intelligence-store.js';
import { paperResult } from './paper-results.js';

export class CallReplayError extends Error {
  constructor(){super('Recorded-call replay could not read the requested Sift database or arguments. No data was changed.');}
}

/** Recompute illustrative returns from saved prices and the costs captured at
 * call time. This does not discover historical candidates or simulate fills. */
export function replayRecordedCall(row,outcomes,{now=Date.now()}={}) {
  const horizons=HORIZONS.map(horizon=>{
    const due=row.at+horizon*60000,recorded=outcomes.find(o=>o.horizon===horizon);
    if(!recorded)return {horizon,due,state:row.delivery!=='sent'?'not_tracked':now<due?'not_due':'unrecorded',paper:null};
    if(recorded.state!=='observed')return {horizon,due,state:recorded.state,recordedAt:recorded.at,evidence:recorded.data,paper:null};
    const data=recorded.data;
    const timingValid=Number.isSafeInteger(recorded.at)&&Number.isSafeInteger(data?.fetchedAt)&&data.fetchedAt>=due&&data.fetchedAt<=recorded.at&&
      recorded.at<=due+300000&&recorded.at<=now;
    const paper=timingValid&&row.delivery==='sent'?paperResult(row.snapshot.selected?.priceUsd,data.price,row.costs):null;
    return {horizon,due,state:paper?'observed':'invalid_observation',recordedAt:recorded.at,evidence:data,paper:paper||null};
  });
  return {id:row.id,userId:row.user_id,target:row.target,delivery:row.delivery,token:row.token,pool:row.pool,at:row.at,
    snapshot:row.snapshot,strategy:row.strategy,costs:row.costs,horizons};
}

/** Consistent, read-only, explicitly user-scoped page. No application startup,
 * schema changes, current preferences, network requests or Telegram calls. */
export function replayRecordedCalls({directory='.sift',userId,after=0,limit=100,now=Date.now()}={}) {
  let db;
  try {
    if(!Number.isSafeInteger(userId)||userId<=0||!Number.isSafeInteger(after)||after<0||
      !Number.isInteger(limit)||limit<1||limit>1000||!Number.isSafeInteger(now)||now<0)throw new Error();
    const path=join(directory,'agents.sqlite'),info=lstatSync(path);
    if(!info.isFile()||info.isSymbolicLink())throw new Error();
    db=new DatabaseSync(path,{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN;');
    const decode=row=>({...row,snapshot:JSON.parse(row.snapshot),strategy:JSON.parse(row.strategy),costs:JSON.parse(row.costs)});
    const rows=db.prepare('SELECT * FROM signal_calls WHERE user_id=? AND id>? ORDER BY id LIMIT ?').all(userId,after,limit+1);
    const hasMore=rows.length>limit,selected=rows.slice(0,limit);
    const calls=selected.map(row=>replayRecordedCall(decode(row),db.prepare('SELECT * FROM signal_outcomes WHERE call_id=? ORDER BY horizon').all(row.id)
      .map(o=>({...o,data:JSON.parse(o.data)})),{now}));
    const totals=db.prepare('SELECT delivery,COUNT(*) AS count FROM signal_calls WHERE user_id=? GROUP BY delivery').all(userId);
    db.exec('COMMIT;');
    return {format:'sift-recorded-call-replay/v1',generatedAt:now,userId,scope:'recorded_calls_only',
      notice:'Private saved observations. Paper returns use frozen illustrative costs; they are not fills, actual profits, or a historical discovery backtest. Missing observations are never zero returns.',
      networkRequests:0,telegramMessagesSent:0,totals,calls,page:{after,limit,hasMore,nextAfter:hasMore?selected.at(-1).id:null}};
  } catch {throw new CallReplayError();}
  finally {db?.close();}
}
