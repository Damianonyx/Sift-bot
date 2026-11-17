import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Durable state in SQLite (built into Node, no packages): the Telegram update
// offset, each tester's draft and approved screening criteria plus their
// scanning switch, pools the scanner has already seen, the watch list of
// young tokens it keeps re-checking, and an alert ledger that makes delivery
// at-least-once with bounded retries and exactly one alert per tester and
// token. Values are JSON at this boundary; callers never see SQL.
export const MAX_ALERT_ATTEMPTS = 5;

export function openStore(location) {
  let file = location;
  if (location !== ':memory:') {
    mkdirSync(location, { recursive: true });
    file = path.join(location, 'sift.sqlite');
  }
  const db = new DatabaseSync(file);
  db.exec(`
    pragma journal_mode = wal;
    create table if not exists kv (key text primary key, value text not null);
    create table if not exists agents (
      user_id integer primary key,
      draft text,
      approved text,
      version integer not null default 0,
      scanning integer not null default 0,
      updated_at text not null
    );
    create table if not exists seen_pools (
      pool_address text primary key,
      first_seen text not null
    );
    create table if not exists alerts (
      id integer primary key autoincrement,
      user_id integer not null,
      token_address text not null,
      pool_address text not null,
      message text not null,
      created_at text not null,
      attempts integer not null default 0,
      sent_at text
    );
    create unique index if not exists alerts_once_per_token on alerts (user_id, token_address);
    create table if not exists candidates (
      token_address text primary key,
      pool_address text not null,
      name text not null,
      dex_id text not null,
      discovered_at text not null,
      expires_at text not null,
      last_checked text
    );
    create index if not exists candidates_due on candidates (last_checked);
  `);
  // Databases created before the scanner milestone lack the scanning column.
  const columns = db.prepare("select name from pragma_table_info('agents')").all().map((c) => c.name);
  if (!columns.includes('scanning')) {
    db.exec('alter table agents add column scanning integer not null default 0');
  }

  const statements = {
    getKv: db.prepare('select value from kv where key = ?'),
    setKv: db.prepare('insert into kv (key, value) values (?, ?) on conflict (key) do update set value = excluded.value'),
    getAgent: db.prepare('select draft, approved, version, scanning from agents where user_id = ?'),
    setDraft: db.prepare(`insert into agents (user_id, draft, updated_at) values (?, ?, ?)
      on conflict (user_id) do update set draft = excluded.draft, updated_at = excluded.updated_at`),
    clearDraft: db.prepare('update agents set draft = null, updated_at = ? where user_id = ? and draft is not null'),
    approve: db.prepare(`update agents set approved = draft, draft = null, version = version + 1, updated_at = ?
      where user_id = ? and draft is not null returning approved, version`),
    setScanning: db.prepare('update agents set scanning = ?, updated_at = ? where user_id = ? and approved is not null'),
    scanningAgents: db.prepare('select user_id, approved, version from agents where scanning = 1 and approved is not null'),
    wasSeen: db.prepare('select 1 from seen_pools where pool_address = ?'),
    markSeen: db.prepare('insert or ignore into seen_pools (pool_address, first_seen) values (?, ?)'),
    pruneSeen: db.prepare('delete from seen_pools where first_seen < ?'),
    createAlert: db.prepare(`insert or ignore into alerts (user_id, token_address, pool_address, message, created_at)
      values (?, ?, ?, ?, ?)`),
    // Only for testers whose scanning is on, so /scan off also stops alerts
    // that were already queued; stale alerts are never delivered late.
    pendingAlerts: db.prepare(`select a.id, a.user_id, a.token_address, a.message from alerts a
      join agents g on g.user_id = a.user_id
      where a.sent_at is null and a.attempts < ? and g.scanning = 1 and a.created_at >= ?
      order by a.id limit 20`),
    recordAttempt: db.prepare('update alerts set attempts = attempts + 1 where id = ?'),
    markSent: db.prepare('update alerts set sent_at = ? where id = ?'),
    abandonAlert: db.prepare('update alerts set attempts = ? where id = ?'),
    addCandidate: db.prepare(`insert or ignore into candidates
      (token_address, pool_address, name, dex_id, discovered_at, expires_at, last_checked) values (?, ?, ?, ?, ?, ?, ?)`),
    dueCandidates: db.prepare(`select token_address, pool_address, name, dex_id, discovered_at from candidates
      where expires_at > ? order by last_checked is not null, last_checked limit ?`),
    markChecked: db.prepare('update candidates set last_checked = ? where token_address = ?'),
    expireCandidates: db.prepare('delete from candidates where expires_at <= ?'),
    countCandidates: db.prepare('select count(*) as n from candidates'),
    stats: db.prepare(`select
      (select count(*) from agents where approved is not null) as withCriteria,
      (select count(*) from agents where scanning = 1) as scanning,
      (select count(*) from alerts where sent_at is not null) as alertsSent`),
  };
  const parse = (text) => (typeof text === 'string' ? JSON.parse(text) : null);
  const nowIso = () => new Date().toISOString();

  return {
    getOffset() {
      const value = Number(statements.getKv.get('offset')?.value);
      return Number.isSafeInteger(value) && value > 0 ? value : 0;
    },
    setOffset(offset) {
      if (Number.isSafeInteger(offset) && offset > 0) statements.setKv.run('offset', String(offset));
    },
    getAgent(userId) {
      const row = statements.getAgent.get(userId);
      if (!row) return null;
      return { draft: parse(row.draft), approved: parse(row.approved), version: row.version, scanning: row.scanning === 1 };
    },
    setDraft(userId, proposal) {
      statements.setDraft.run(userId, JSON.stringify(proposal), nowIso());
    },
    clearDraft(userId) {
      return statements.clearDraft.run(nowIso(), userId).changes > 0;
    },
    approveDraft(userId) {
      const row = statements.approve.get(nowIso(), userId);
      return row ? { approved: parse(row.approved), version: row.version } : null;
    },
    // Only testers with approved criteria can scan; returns false otherwise.
    setScanning(userId, on) {
      return statements.setScanning.run(on ? 1 : 0, nowIso(), userId).changes > 0;
    },
    scanningAgents() {
      return statements.scanningAgents.all().map((row) => ({
        userId: row.user_id, approved: parse(row.approved), version: row.version,
      }));
    },
    wasSeen(poolAddress) { return statements.wasSeen.get(poolAddress) !== undefined; },
    markSeen(poolAddress, at) { statements.markSeen.run(poolAddress, at); },
    pruneSeen(beforeIso) { statements.pruneSeen.run(beforeIso); },
    // False when this tester was already alerted for this token.
    createAlert(userId, tokenAddress, poolAddress, message) {
      return statements.createAlert.run(userId, tokenAddress, poolAddress, message, nowIso()).changes > 0;
    },
    pendingAlerts(sinceIso) { return statements.pendingAlerts.all(MAX_ALERT_ATTEMPTS, sinceIso); },
    recordAttempt(id) { statements.recordAttempt.run(id); },
    markSent(id) { statements.markSent.run(nowIso(), id); },
    abandonAlert(id) { statements.abandonAlert.run(MAX_ALERT_ATTEMPTS, id); },
    setLastScan(info) { statements.setKv.run('lastScan', JSON.stringify(info)); },
    getLastScan() { return parse(statements.getKv.get('lastScan')?.value); },
    // Young tokens the scanner keeps re-checking until they match or expire.
    // Returns false when the token is already on the watch list.
    addCandidate({ tokenAddress, poolAddress, name, dexId, discoveredAt, expiresAt, lastChecked = null }) {
      return statements.addCandidate.run(tokenAddress, poolAddress, name, dexId, discoveredAt, expiresAt, lastChecked).changes > 0;
    },
    // Least recently checked first; never-checked tokens before all others.
    dueCandidates(nowIso, limit) {
      return statements.dueCandidates.all(nowIso, limit).map((row) => ({
        tokenAddress: row.token_address, poolAddress: row.pool_address, name: row.name,
        dexId: row.dex_id, discoveredAt: row.discovered_at,
      }));
    },
    markChecked(tokenAddresses, atIso) {
      for (const token of tokenAddresses) statements.markChecked.run(atIso, token);
    },
    expireCandidates(nowIso) { statements.expireCandidates.run(nowIso); },
    countCandidates() { return statements.countCandidates.get().n; },
    stats() { return { ...statements.stats.get(), watching: statements.countCandidates.get().n }; },
    // Runs fn inside one transaction (much faster for batch writes).
    transaction(fn) {
      db.exec('begin');
      try {
        const result = fn();
        db.exec('commit');
        return result;
      } catch (error) {
        db.exec('rollback');
        throw error;
      }
    },
    close() { db.close(); },
  };
}
