import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Durable state in SQLite (built into Node, no packages): the Telegram update
// offset, and each tester's proposed (draft) and approved screening criteria.
// Values are JSON at this boundary; callers never see SQL.
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
      updated_at text not null
    );
  `);
  const statements = {
    getKv: db.prepare('select value from kv where key = ?'),
    setKv: db.prepare('insert into kv (key, value) values (?, ?) on conflict (key) do update set value = excluded.value'),
    getAgent: db.prepare('select draft, approved, version from agents where user_id = ?'),
    setDraft: db.prepare(`insert into agents (user_id, draft, updated_at) values (?, ?, ?)
      on conflict (user_id) do update set draft = excluded.draft, updated_at = excluded.updated_at`),
    clearDraft: db.prepare('update agents set draft = null, updated_at = ? where user_id = ? and draft is not null'),
    approve: db.prepare(`update agents set approved = draft, draft = null, version = version + 1, updated_at = ?
      where user_id = ? and draft is not null returning approved, version`),
  };
  const parse = (text) => (typeof text === 'string' ? JSON.parse(text) : null);

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
      return { draft: parse(row.draft), approved: parse(row.approved), version: row.version };
    },
    setDraft(userId, proposal) {
      statements.setDraft.run(userId, JSON.stringify(proposal), new Date().toISOString());
    },
    clearDraft(userId) {
      return statements.clearDraft.run(new Date().toISOString(), userId).changes > 0;
    },
    approveDraft(userId) {
      const row = statements.approve.get(new Date().toISOString(), userId);
      return row ? { approved: parse(row.approved), version: row.version } : null;
    },
    close() { db.close(); },
  };
}
