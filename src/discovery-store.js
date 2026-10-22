import { createHash } from 'node:crypto';
import { intelligenceStore } from './intelligence-store.js';

export const DISCOVERY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS discovery_scans (
    user_id INTEGER PRIMARY KEY, state TEXT NOT NULL, criteria_key TEXT NOT NULL,
    last_run INTEGER, checked INTEGER NOT NULL DEFAULT 0, matched INTEGER NOT NULL DEFAULT 0,
    suppressed INTEGER NOT NULL DEFAULT 0, issue TEXT
  );
  CREATE TABLE IF NOT EXISTS discovery_checks (
    user_id INTEGER NOT NULL, criteria_key TEXT NOT NULL, token TEXT NOT NULL,
    checked_at INTEGER NOT NULL, result TEXT NOT NULL,
    PRIMARY KEY (user_id, criteria_key, token)
  );
  CREATE TABLE IF NOT EXISTS discovery_alerts (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, criteria_key TEXT NOT NULL,
    token TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL,
    UNIQUE (user_id, criteria_key, token)
  );
  CREATE TABLE IF NOT EXISTS discovery_mutes (
    user_id INTEGER NOT NULL, token TEXT NOT NULL, PRIMARY KEY (user_id, token)
  );
`;

export function criteriaKey(agent) {
  // Renaming an agent or approving identical rules does not cause repeat alerts.
  return createHash('sha256').update(JSON.stringify([...agent.rules].sort((a, b) => a.field.localeCompare(b.field)))).digest('hex');
}

export function discoveryStore(db, safe) {
  const ledger=intelligenceStore(db,safe);
  const scan = (id) => db.prepare('SELECT * FROM discovery_scans WHERE user_id=?').get(id) ??
    { user_id: id, state: 'stopped', criteria_key: '', last_run: null, checked: 0, matched: 0, suppressed: 0, issue: null };
  return {
    discoveryGet: safe(scan),
    discoveryActive: safe(() => db.prepare("SELECT * FROM discovery_scans WHERE state='active'").all()),
    discoverySet: safe((id, state, key, issue = null) => {
      if (!['active', 'paused', 'stopped'].includes(state)) throw new Error('Invalid scan state');
      db.prepare(`INSERT INTO discovery_scans (user_id,state,criteria_key,issue) VALUES (?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET state=excluded.state,criteria_key=excluded.criteria_key,issue=excluded.issue`)
        .run(id, state, key, issue);
    }),
    discoveryRecord: safe((id, key, token, checkedAt, result) => {
      db.prepare(`INSERT INTO discovery_checks VALUES (?,?,?,?,?)
        ON CONFLICT(user_id,criteria_key,token) DO UPDATE SET checked_at=excluded.checked_at,result=excluded.result`)
        .run(id, key, token, checkedAt, JSON.stringify(result));
    }),
    discoveryComplete: safe((id, key, { checked, matched, suppressed, issue }, time) => {
      db.prepare(`UPDATE discovery_scans SET last_run=?,checked=?,matched=?,suppressed=?,issue=?
        WHERE user_id=? AND criteria_key=? AND state='active'`).run(time, checked, matched, suppressed, issue, id, key);
    }),
    discoverySeen: safe((id, key, token) => Boolean(db.prepare('SELECT 1 FROM discovery_alerts WHERE user_id=? AND criteria_key=? AND token=?').get(id, key, token))),
    discoveryMuted: safe((id, token) => Boolean(db.prepare('SELECT 1 FROM discovery_mutes WHERE user_id=? AND token=?').get(id, token))),
    discoveryReserve: safe((id, key, token, time, payload) => {
      db.exec('SAVEPOINT reserve_signal');
      try {
      const result = db.prepare(`INSERT OR IGNORE INTO discovery_alerts (user_id,criteria_key,token,created_at,state,payload)
        SELECT ?,?,?,?,'pending',? WHERE EXISTS
        (SELECT 1 FROM discovery_scans WHERE user_id=? AND criteria_key=? AND state='active')
        AND NOT EXISTS (SELECT 1 FROM discovery_mutes WHERE user_id=? AND token=?)`)
        .run(id, key, token, time, JSON.stringify(payload), id, key, id, token);
      const eventId=result.changes ? Number(result.lastInsertRowid) : null;
      if(eventId!==null && payload.snapshot && payload.strategy)ledger.signalRecord(id,id,eventId,payload.snapshot,payload.strategy,time);
      db.exec('RELEASE reserve_signal');return eventId;
      } catch(error){db.exec('ROLLBACK TO reserve_signal');db.exec('RELEASE reserve_signal');throw error;}
    }),
    discoveryDelivery: safe((id, eventId, state) => {
      if (!['sent', 'failed', 'uncertain', 'dismissed'].includes(state)) throw new Error('Invalid delivery state');
      db.prepare('UPDATE discovery_alerts SET state=? WHERE id=? AND user_id=?').run(state, eventId, id);
      if(state!=='dismissed') db.prepare("UPDATE signal_calls SET delivery=? WHERE user_id=? AND target=? AND delivery_id=? AND delivery='pending'").run(state,id,id,eventId);
    }),
    discoveryAlert: safe((id, eventId) => {
      const row = db.prepare('SELECT * FROM discovery_alerts WHERE id=? AND user_id=?').get(eventId, id);
      return row ? { ...row, payload: JSON.parse(row.payload) } : null;
    }),
    discoveryHistory: safe((id) => db.prepare('SELECT id,token,created_at,state FROM discovery_alerts WHERE user_id=? ORDER BY id DESC LIMIT 5').all(id)),
    discoveryIssues: safe((id) => db.prepare("SELECT COUNT(*) AS count FROM discovery_alerts WHERE user_id=? AND state IN ('pending','failed','uncertain')").get(id).count),
    discoveryMute: safe((id, token) => db.prepare('INSERT OR IGNORE INTO discovery_mutes VALUES (?,?)').run(id, token)),
    discoveryUnmute: safe((id, token) => db.prepare('DELETE FROM discovery_mutes WHERE user_id=? AND token=?').run(id, token)),
  };
}
