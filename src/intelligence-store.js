// Durable calls and observations. Delivery, dismissal and later outcomes are
// separate facts: a losing call or a dismissed message never disappears.
export const INTELLIGENCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS scout_preferences (user_id INTEGER PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rule_audit (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, at INTEGER NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS signal_calls (
 id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, target INTEGER NOT NULL, delivery_id INTEGER NOT NULL,
 token TEXT NOT NULL, pool TEXT, at INTEGER NOT NULL, delivery TEXT NOT NULL,
 snapshot TEXT NOT NULL, strategy TEXT NOT NULL, costs TEXT NOT NULL, last_check INTEGER, last_risk INTEGER,
 observation TEXT, issue TEXT, follow_until INTEGER NOT NULL,
 UNIQUE(target,delivery_id)
);
CREATE TABLE IF NOT EXISTS signal_outcomes (
 call_id INTEGER NOT NULL, horizon INTEGER NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL,
 data TEXT NOT NULL, PRIMARY KEY(call_id,horizon)
);
CREATE TABLE IF NOT EXISTS signal_events (
 id INTEGER PRIMARY KEY, call_id INTEGER NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL,
 text TEXT NOT NULL, delivery TEXT NOT NULL, UNIQUE(call_id,kind)
);
CREATE TABLE IF NOT EXISTS signal_feedback (
 call_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, at INTEGER NOT NULL, rating INTEGER NOT NULL,
 outcome TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS signal_due ON signal_calls(last_check,at);
CREATE TABLE IF NOT EXISTS creator_proofs (token TEXT PRIMARY KEY, signature TEXT NOT NULL, verified_at INTEGER NOT NULL);
`;
export const DEFAULT_PREFERENCES = Object.freeze({followHours:0, positionUsd:null, feeBps:30, slippageBps:100, quietStart:null, quietEnd:null});
export const HORIZONS = [15,60,360,1440];
export function validatePreferences(p) {
  if (!p || !Number.isInteger(p.followHours) || p.followHours<0 || p.followHours>168 ||
    p.positionUsd!==null && (!Number.isFinite(p.positionUsd) || p.positionUsd<1 || p.positionUsd>10000) ||
    ![p.feeBps,p.slippageBps].every(n=>Number.isInteger(n)&&n>=0&&n<=1000) ||
    !((p.quietStart===null&&p.quietEnd===null) || [p.quietStart,p.quietEnd].every(n=>Number.isInteger(n)&&n>=0&&n<24)&&p.quietStart!==p.quietEnd)) throw Error('Invalid preferences');
  return p;
}
export function quietNow(p,time) {
  if(p.quietStart===null)return false;
  const hour=new Date(time).getUTCHours();
  return p.quietStart<p.quietEnd ? hour>=p.quietStart&&hour<p.quietEnd : hour>=p.quietStart||hour<p.quietEnd;
}
export function intelligenceStore(db,safe) {
  const decode=row=>row?{...row,snapshot:JSON.parse(row.snapshot),strategy:JSON.parse(row.strategy),costs:JSON.parse(row.costs),observation:row.observation?JSON.parse(row.observation):null}:null;
  const preferences=user=>validatePreferences({...DEFAULT_PREFERENCES,...JSON.parse(db.prepare('SELECT data FROM scout_preferences WHERE user_id=?').get(user)?.data??'{}')});
  const get=(user,id)=>decode(db.prepare('SELECT * FROM signal_calls WHERE user_id=? AND id=?').get(user,id));
  return {
    creatorProof:safe(token=>db.prepare('SELECT signature FROM creator_proofs WHERE token=?').get(token)?.signature??null),
    creatorProofPut:safe((token,signature,time)=>{
      db.prepare('INSERT INTO creator_proofs VALUES (?,?,?) ON CONFLICT(token) DO UPDATE SET signature=excluded.signature,verified_at=excluded.verified_at').run(token,signature,time);
      db.prepare('DELETE FROM creator_proofs WHERE token IN (SELECT token FROM creator_proofs ORDER BY verified_at DESC LIMIT -1 OFFSET 2000)').run();
    }),
    preferences:safe(preferences),
    preferencesPut:safe((user,value,time)=>{
      validatePreferences(value);
      db.prepare('INSERT INTO scout_preferences VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data').run(user,JSON.stringify(value));
      db.prepare('INSERT INTO rule_audit (user_id,at,action,detail) VALUES (?,?,?,?)').run(user,time,'preferences',JSON.stringify(value));
      if(value.followHours===0)db.prepare('UPDATE signal_calls SET follow_until=0 WHERE user_id=?').run(user);
    }),
    auditAdd:safe((user,time,action,detail)=>db.prepare('INSERT INTO rule_audit (user_id,at,action,detail) VALUES (?,?,?,?)').run(user,time,action,JSON.stringify(detail))),
    auditList:safe(user=>db.prepare('SELECT * FROM rule_audit WHERE user_id=? ORDER BY id DESC LIMIT 10').all(user)),
    signalRecord:safe((user,target,deliveryId,snapshot,strategy,time)=>{
      const p=preferences(user);
      const row=db.prepare(`INSERT OR IGNORE INTO signal_calls
        (user_id,target,delivery_id,token,pool,at,delivery,snapshot,strategy,costs,follow_until)
        VALUES (?,?,?,?,?,?,'pending',?,?,?,?)`).run(user,target,deliveryId,snapshot.address,snapshot.selected?.address??null,time,
        JSON.stringify(snapshot),JSON.stringify(strategy),JSON.stringify({feeBps:p.feeBps,slippageBps:p.slippageBps}),p.followHours?time+p.followHours*3600000:0);
      return row.changes?Number(row.lastInsertRowid):db.prepare('SELECT id FROM signal_calls WHERE target=? AND delivery_id=?').get(target,deliveryId).id;
    }),
    signalDelivery:safe((id,state)=>{
      if(!['sent','failed','uncertain'].includes(state))throw Error('Invalid delivery');
      db.prepare("UPDATE signal_calls SET delivery=? WHERE id=? AND delivery='pending'").run(state,id);
    }),
    signalGet:safe(get),
    signalForDelivery:safe((user,target,id)=>decode(db.prepare('SELECT * FROM signal_calls WHERE user_id=? AND target=? AND delivery_id=?').get(user,target,id))),
    signalList:safe((user,limit=20,offset=0)=>db.prepare('SELECT * FROM signal_calls WHERE user_id=? ORDER BY id DESC LIMIT ? OFFSET ?').all(user,Math.min(100,Math.max(1,limit)),offset).map(decode)),
    signalCounts:safe(user=>db.prepare('SELECT delivery,COUNT(*) AS n FROM signal_calls WHERE user_id=? GROUP BY delivery').all(user)),
    signalDue:safe((time,limit=4,users=null)=>{
      const ids=users===null?null:[...users].filter(Number.isSafeInteger);if(ids&&!ids.length)return [];
      return db.prepare(`SELECT * FROM signal_calls s WHERE delivery='sent' ${ids?`AND user_id IN (${ids.map(()=>'?').join(',')})`:''}
      AND (follow_until>? OR ${HORIZONS.map(h=>`(s.at+${h*60000}<=? AND NOT EXISTS
        (SELECT 1 FROM signal_outcomes o WHERE o.call_id=s.id AND o.horizon=${h}))`).join(' OR ')})
      AND COALESCE(last_check,0)<=? ORDER BY COALESCE(last_check,0),at,id LIMIT ?`).all(...(ids??[]),time,...HORIZONS.map(()=>time),time-60000,limit).map(decode);
    }),
    signalObserve:safe((id,snapshot,issue,time)=>db.prepare('UPDATE signal_calls SET last_check=?,observation=COALESCE(?,observation),issue=?,last_risk=COALESCE(?,last_risk) WHERE id=?').run(time,snapshot?JSON.stringify(snapshot):null,issue,snapshot?.risk?time:null,id)),
    signalOutcome:safe((id,horizon,state,time,data)=>{
      if(!HORIZONS.includes(horizon)||!['observed','missed','unavailable'].includes(state))throw Error('Invalid outcome');
      return db.prepare('INSERT OR IGNORE INTO signal_outcomes VALUES (?,?,?,?,?)').run(id,horizon,state,time,JSON.stringify(data)).changes>0;
    }),
    signalOutcomes:safe(id=>db.prepare('SELECT * FROM signal_outcomes WHERE call_id=? ORDER BY horizon').all(id).map(r=>({...r,data:JSON.parse(r.data)}))),
    signalMetrics:safe(user=>db.prepare(`SELECT o.horizon,o.state,o.data FROM signal_outcomes o JOIN signal_calls s ON s.id=o.call_id WHERE s.user_id=? AND s.delivery='sent'`).all(user).map(r=>({...r,data:JSON.parse(r.data)}))),
    signalEvent:safe((id,kind,text,time)=>{
      const row=db.prepare("INSERT OR IGNORE INTO signal_events (call_id,kind,at,text,delivery) VALUES (?,?,?,?,'pending')").run(id,kind,time,text);
      return row.changes?Number(row.lastInsertRowid):null;
    }),
    signalEventDelivery:safe((id,state)=>{
      if(!['sent','failed','uncertain','suppressed'].includes(state))throw Error('Invalid event');
      db.prepare('UPDATE signal_events SET delivery=? WHERE id=?').run(state,id);
    }),
    signalEvents:safe((user,id)=>get(user,id)?db.prepare('SELECT * FROM signal_events WHERE call_id=? ORDER BY id DESC LIMIT 20').all(id):[]),
    signalStop:safe((user,id)=>db.prepare('UPDATE signal_calls SET follow_until=0 WHERE user_id=? AND id=?').run(user,id)),
    signalFeedback:safe((user,id,rating,outcome,time)=>{
      if(!get(user,id)||!Number.isInteger(rating)||rating<1||rating>5||!['no_trade','profit','loss','suspected_rug'].includes(outcome))return false;
      db.prepare('INSERT INTO signal_feedback VALUES (?,?,?,?,?) ON CONFLICT(call_id) DO UPDATE SET at=excluded.at,rating=excluded.rating,outcome=excluded.outcome').run(id,user,time,rating,outcome);return true;
    }),
    feedbackSummary:safe(user=>db.prepare('SELECT outcome,COUNT(*) AS n,AVG(rating) AS rating FROM signal_feedback WHERE user_id=? GROUP BY outcome').all(user)),
  };
}
