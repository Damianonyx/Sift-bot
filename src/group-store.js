import { assertApprovable } from './rules.js';
import { criteriaKey } from './discovery-store.js';
import { intelligenceStore } from './intelligence-store.js';
export const GROUP_SCHEMA = `
  CREATE TABLE IF NOT EXISTS group_targets (
    chat_id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, criteria_key TEXT NOT NULL,
    state TEXT NOT NULL, revision INTEGER NOT NULL, expires_at INTEGER NOT NULL, issue TEXT
  );
  CREATE TABLE IF NOT EXISTS group_deliveries (
    id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, criteria_key TEXT NOT NULL,
    token TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL,
    UNIQUE(chat_id, criteria_key, token)
  );
  CREATE TABLE IF NOT EXISTS group_settings (
    chat_id INTEGER PRIMARY KEY, strategy TEXT, interval_minutes INTEGER NOT NULL DEFAULT 0,
    max_per_cycle INTEGER NOT NULL DEFAULT 3, last_attempt INTEGER, last_check INTEGER, issue TEXT,
    checked INTEGER NOT NULL DEFAULT 0, matched INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS group_evidence (delivery_id INTEGER PRIMARY KEY, pages TEXT NOT NULL);
`;

export function groupStore(db, safe) {
  const ledger=intelligenceStore(db,safe);
  const get = chat => db.prepare('SELECT * FROM group_targets WHERE chat_id=?').get(chat) ?? null;
  const chatId = chat => { if (!Number.isSafeInteger(chat) || chat >= 0) throw Error('Invalid group'); return chat; };
  return {
    groupSettings:safe(chat=>{
      const row=db.prepare('SELECT * FROM group_settings WHERE chat_id=?').get(chat);
      return row?{...row,strategy:row.strategy?JSON.parse(row.strategy):null}:{strategy:null,interval_minutes:0,max_per_cycle:3,last_attempt:null};
    }),
    groupTargets:safe(()=>db.prepare("SELECT t.* FROM group_targets t JOIN group_settings s ON s.chat_id=t.chat_id WHERE t.state='active' AND s.strategy IS NOT NULL").all()),
    groupConfigure:safe((chat,owner,{strategy,interval,max},time)=>{
      const row=get(chat);if(!row||row.owner_id!==owner)return false;
      if(!Number.isInteger(interval)||interval<0||interval>1440||!Number.isInteger(max)||max<1||max>3)throw Error('Invalid cadence');
      if(strategy)assertApprovable(strategy);
      db.prepare(`INSERT INTO group_settings (chat_id,strategy,interval_minutes,max_per_cycle) VALUES (?,?,?,?)
        ON CONFLICT(chat_id) DO UPDATE SET strategy=excluded.strategy,interval_minutes=excluded.interval_minutes,max_per_cycle=excluded.max_per_cycle`).run(chat,strategy?JSON.stringify(strategy):null,interval,max);
      db.prepare("UPDATE group_targets SET state='review',criteria_key=?,expires_at=?,revision=revision+1 WHERE chat_id=?").run(strategy?criteriaKey(strategy):row.criteria_key,time+600000,chat);
      db.prepare('INSERT INTO rule_audit (user_id,at,action,detail) VALUES (?,?,?,?)').run(owner,time,'group_configuration',JSON.stringify({chat,strategy,interval,max}));
      return true;
    }),
    groupComplete:safe((chat,time,checked,matched,issue)=>db.prepare('UPDATE group_settings SET last_check=?,checked=?,matched=?,issue=? WHERE chat_id=?').run(time,checked,matched,issue,chat)),
    groupEvidence:safe((chat,id)=>{
      const row=db.prepare('SELECT e.pages FROM group_evidence e JOIN group_deliveries d ON d.id=e.delivery_id WHERE d.chat_id=? AND d.id=?').get(chat,id);
      return row?JSON.parse(row.pages):null;
    }),
    groupGet: safe(get),
    groupList: safe(owner => db.prepare('SELECT * FROM group_targets WHERE owner_id=? ORDER BY chat_id LIMIT 20').all(owner)),
    groupStage: safe((chat, owner, key, time) => {
      chatId(chat);
      if (!Number.isSafeInteger(owner) || owner <= 0 || !/^[a-f0-9]{64}$/.test(key)) throw Error('Invalid owner');
      const previous = get(chat);
      if (previous && previous.owner_id !== owner && previous.state !== 'stopped') return false;
      const count = db.prepare("SELECT COUNT(*) AS n FROM group_targets WHERE owner_id=? AND state!='stopped' AND chat_id!=?").get(owner, chat).n;
      if (count >= 3) return false;
      db.prepare(`INSERT INTO group_targets VALUES (?, ?, ?, 'review', 1, ?, NULL)
        ON CONFLICT(chat_id) DO UPDATE SET owner_id=excluded.owner_id,criteria_key=excluded.criteria_key,
        state='review',revision=group_targets.revision+1,expires_at=excluded.expires_at,issue=NULL`)
        .run(chat, owner, key, time + 600_000);
      // Reconnection intentionally returns to following the owner's private rules.
      db.prepare('DELETE FROM group_settings WHERE chat_id=?').run(chat);
      return true;
    }),
    groupState: safe((chat, state, issue = null) => {
      if (!['active', 'paused', 'stopped'].includes(state)) throw Error('Invalid group state');
      db.prepare('UPDATE group_targets SET state=?,issue=?,revision=revision+1 WHERE chat_id=?').run(state, issue, chatId(chat));
      const row=get(chat);if(row)db.prepare('INSERT INTO rule_audit (user_id,at,action,detail) VALUES (?,?,?,?)').run(row.owner_id,Date.now(),'group_state',JSON.stringify({chat,state,issue}));
    }),
    groupReserve: safe((chat, owner, key, token, time, payload=null) => {
      db.exec('SAVEPOINT reserve_group');try {
      const row = db.prepare(`INSERT OR IGNORE INTO group_deliveries (chat_id,criteria_key,token,created_at,state)
        SELECT ?,?,?,?,'pending' WHERE EXISTS
        (SELECT 1 FROM group_targets WHERE chat_id=? AND owner_id=? AND criteria_key=? AND state='active')`)
        .run(chat, key, token, time, chat, owner, key);
      const event=row.changes?Number(row.lastInsertRowid):null;
      if(event!==null) {
        db.prepare('INSERT INTO group_settings (chat_id,last_attempt) VALUES (?,?) ON CONFLICT(chat_id) DO UPDATE SET last_attempt=excluded.last_attempt').run(chat,time);
        if(payload?.snapshot&&payload.strategy)ledger.signalRecord(owner,chat,event,payload.snapshot,payload.strategy,time);
        if(payload?.pages)db.prepare('INSERT INTO group_evidence VALUES (?,?)').run(event,JSON.stringify(payload.pages));
      }
      db.exec('RELEASE reserve_group');return event;
      }catch(error){db.exec('ROLLBACK TO reserve_group');db.exec('RELEASE reserve_group');throw error;}
    }),
    groupDelivery: safe((event, state) => {
      if (!['sent', 'failed', 'uncertain'].includes(state)) throw Error('Invalid delivery state');
      db.prepare('UPDATE group_deliveries SET state=? WHERE id=?').run(state, event);
      db.prepare("UPDATE signal_calls SET delivery=? WHERE target=(SELECT chat_id FROM group_deliveries WHERE id=?) AND delivery_id=? AND delivery='pending'").run(state,event,event);
    }),
    groupIssues: safe(chat => db.prepare("SELECT COUNT(*) AS n FROM group_deliveries WHERE chat_id=? AND state!='sent'").get(chat).n),
  };
}
