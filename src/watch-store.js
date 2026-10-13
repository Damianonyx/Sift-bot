import { isSolanaAddress } from './market.js';
import { validateRules } from './rules.js';

export const WATCH_LIMIT = 3;
export const TOTAL_WATCH_LIMIT = 20;
export const REVIEW_TTL = 10 * 60_000;
export const WATCH_SCHEMA = `
  CREATE TABLE IF NOT EXISTS watches (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, token TEXT NOT NULL,
    state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, started_at INTEGER, ends_at INTEGER,
    last_check INTEGER, config TEXT NOT NULL, baseline TEXT,
    observation TEXT, issue TEXT
  );
  CREATE TABLE IF NOT EXISTS watch_events (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, watch_id INTEGER NOT NULL,
    kind TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL, text TEXT NOT NULL,
    UNIQUE(watch_id, kind)
  );
`;

export function watchStore(db, safe) {
  const decode = (row) => {
    if (!row) return null;
    const value = { ...row, config: JSON.parse(row.config), baseline: row.baseline ? JSON.parse(row.baseline) : null,
      observation: row.observation ? JSON.parse(row.observation) : null };
    if (!Number.isSafeInteger(value.user_id) || value.user_id <= 0 || !isSolanaAddress(value.token) ||
        !['review','active','paused','stopped','expired'].includes(value.state) || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
        !Number.isFinite(value.config.dropPercent) || value.config.dropPercent <= 0 || value.config.dropPercent > 100 ||
        !Number.isInteger(value.config.hours) || value.config.hours < 1 || value.config.hours > 168 ||
        !Number.isSafeInteger(value.created_at)) throw new Error('Invalid saved monitor');
    validateRules(value.config.rules, { requireStrict: Boolean(value.config.rules?.length) });
    if (['active','paused'].includes(value.state) || value.baseline) {
      if (!Number.isSafeInteger(value.started_at) || !Number.isSafeInteger(value.ends_at) || value.ends_at <= value.started_at ||
          value.baseline?.address !== value.token || !isSolanaAddress(value.baseline?.selected?.address) ||
          !Number.isFinite(value.baseline?.selected?.liquidityUsd) || value.baseline.selected.liquidityUsd <= 0 ||
          !Number.isSafeInteger(value.last_check) || !Number.isSafeInteger(value.baseline.fetchedAt)) throw new Error('Invalid saved monitor baseline');
    }
    return value;
  };
  const get = (user, id) => decode(db.prepare('SELECT * FROM watches WHERE user_id=? AND id=?').get(user, id));
  const open = (now) => db.prepare(`SELECT * FROM watches WHERE
    (state IN ('active','paused') AND ends_at>?) OR (state='review' AND created_at>?) ORDER BY id`).all(now, now - REVIEW_TTL).map(decode);
  return {
    watchGet: safe(get),
    watchOpen: safe(open),
    watchList: safe((user) => db.prepare(`SELECT * FROM watches WHERE user_id=?
      ORDER BY CASE WHEN state IN ('active','paused','review') THEN 0 ELSE 1 END,id DESC LIMIT 8`).all(user).map(decode)),
    watchActive: safe(() => db.prepare("SELECT * FROM watches WHERE state='active' ORDER BY id").all().map(decode)),
    watchCreate: safe((user, token, config, now) => {
      if (!Number.isSafeInteger(user) || user <= 0 || !isSolanaAddress(token) ||
          !Number.isFinite(config.dropPercent) || config.dropPercent <= 0 || config.dropPercent > 100 ||
          !Number.isInteger(config.hours) || config.hours < 1 || config.hours > 168) throw new Error('Invalid watch');
      validateRules(config.rules, { requireStrict: Boolean(config.rules?.length) });
      const existing = open(now);
      if (existing.filter((row) => row.user_id === user).length >= WATCH_LIMIT || existing.length >= TOTAL_WATCH_LIMIT) return null;
      if (existing.some((row) => row.user_id === user && row.token === token)) return null;
      const result = db.prepare('INSERT INTO watches (user_id,token,state,created_at,config) VALUES (?,?,?,?,?)')
        .run(user, token, 'review', now, JSON.stringify(config));
      return get(user, Number(result.lastInsertRowid));
    }),
    watchStart: safe((user, id, revision, snapshot, now) => {
      const row = get(user, id);
      const pool = snapshot?.selected;
      if (!row || row.state !== 'review' || row.revision !== revision || now - row.created_at >= REVIEW_TTL) return null;
      if (snapshot.address !== row.token || !pool || !isSolanaAddress(pool.address) || !Number.isFinite(pool.liquidityUsd) || pool.liquidityUsd <= 0 ||
          !Number.isFinite(snapshot.fetchedAt) || snapshot.fetchedAt > now || now - snapshot.fetchedAt > 120_000) return null;
      db.prepare(`UPDATE watches SET state='active',revision=revision+1,started_at=?,ends_at=?,baseline=?,last_check=?,observation=? WHERE user_id=? AND id=?`)
        .run(now, now + row.config.hours * 3_600_000, JSON.stringify(snapshot), snapshot.fetchedAt, JSON.stringify(snapshot), user, id);
      return get(user, id);
    }),
    watchControl: safe((user, id, revision, action, now) => {
      const row = get(user, id);
      if (!row || row.revision !== revision) return null;
      let state = row.state, end = row.ends_at;
      if (action === 'stop' && ['review','active','paused'].includes(state)) state = 'stopped';
      else if (action === 'pause' && state === 'active' && end > now) state = 'paused';
      else if (action === 'resume' && state === 'paused' && end > now) state = 'active';
      else if (action === 'extend' && ['active','paused'].includes(state) && end > now && end + 86_400_000 <= row.started_at + 168 * 3_600_000) end += 86_400_000;
      else return null;
      db.prepare('UPDATE watches SET state=?,ends_at=?,revision=revision+1 WHERE user_id=? AND id=?').run(state, end, user, id);
      return get(user, id);
    }),
    watchAllControl: safe((user, action) => {
      const states = action === 'pause' ? "state='active'" : "state IN ('active','paused','review')";
      db.prepare(`UPDATE watches SET state=?,revision=revision+1 WHERE user_id=? AND ${states}`)
        .run(action === 'pause' ? 'paused' : 'stopped', user);
    }),
    watchObserve: safe((user, id, revision, snapshot, issue, now) => db.prepare(`UPDATE watches SET last_check=?,observation=?,issue=?
      WHERE user_id=? AND id=? AND revision=? AND state='active' AND ends_at>?`)
      .run(now, snapshot ? JSON.stringify(snapshot) : null, issue, user, id, revision, now).changes > 0),
    watchExpire: safe((now) => {
      const rows = db.prepare("SELECT * FROM watches WHERE state IN ('active','paused') AND ends_at<=?").all(now).map(decode);
      db.prepare("UPDATE watches SET state='expired',revision=revision+1 WHERE state IN ('active','paused') AND ends_at<=?").run(now);
      db.prepare("UPDATE watches SET state='expired',revision=revision+1 WHERE state='review' AND created_at<=?").run(now - REVIEW_TTL);
      return rows;
    }),
    watchReserve: safe((user, id, kind, time, text) => {
      if (text.length > 3900) throw new Error('Watch report too long');
      const result = db.prepare(`INSERT OR IGNORE INTO watch_events (user_id,watch_id,kind,created_at,state,text)
        SELECT ?,?,?,?,'pending',? WHERE EXISTS (SELECT 1 FROM watches WHERE user_id=? AND id=?)`)
        .run(user, id, kind, time, text, user, id);
      return result.changes ? Number(result.lastInsertRowid) : null;
    }),
    watchDelivery: safe((user, eventId, state) => {
      if (!['sent','failed','uncertain','suppressed'].includes(state)) throw new Error('Invalid delivery state');
      db.prepare('UPDATE watch_events SET state=? WHERE user_id=? AND id=?').run(state, user, eventId);
    }),
    watchHistory: safe((user) => db.prepare('SELECT id,watch_id,kind,created_at,state FROM watch_events WHERE user_id=? ORDER BY id DESC LIMIT 5').all(user)),
    watchEvent: safe((user, id) => db.prepare('SELECT * FROM watch_events WHERE user_id=? AND id=?').get(user, id) ?? null),
    watchIssues: safe((user) => db.prepare("SELECT COUNT(*) AS count FROM watch_events WHERE user_id=? AND state<>'sent'").get(user).count),
  };
}
