import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { validateRules, assertApprovable } from './rules.js';
import { DISCOVERY_SCHEMA, discoveryStore } from './discovery-store.js';
import { WATCH_SCHEMA, watchStore } from './watch-store.js';
import { GROUP_SCHEMA, groupStore } from './group-store.js';
import { validDescription } from './description-data.js';
import { INTELLIGENCE_SCHEMA, intelligenceStore } from './intelligence-store.js';

export class AgentStoreError extends Error {
  constructor() { super('Saved agent data could not be accessed. Sift stopped to preserve existing settings.'); }
}

function validateState(state) {
  if (!state || !Number.isSafeInteger(state.revision) || state.revision < 0) throw new AgentStoreError();
  for (const [kind, agent] of [['draft', state.draft], ['approved', state.approved]]) {
    if (agent === null) continue;
    if (!agent || typeof agent.name !== 'string' || agent.name.length > 32 || /[\p{Cc}\p{Cf}]/u.test(agent.name) ||
        !Array.isArray(agent.pendingRequirements) || agent.pendingRequirements.length > 2 ||
        agent.pendingRequirements.some((text) => typeof text !== 'string' || !text.length || text.length > 800)) {
      throw new AgentStoreError();
    }
    validateRules(agent.rules, { requireStrict: false });
    if (agent.sourceDescription !== undefined && !validDescription(agent.sourceDescription)) throw new AgentStoreError();
    if (agent.interpretation !== undefined && (kind !== 'draft' || !validDescription(agent.sourceDescription) ||
        !['Local parser','AI interpretation'].includes(agent.interpretation?.engine) ||
        !Array.isArray(agent.interpretation.unresolved) || agent.interpretation.unresolved.length>1 ||
        agent.interpretation.unresolved.some(text=>!validDescription(text)) ||
        agent.pendingRequirements.length!==1 || agent.pendingRequirements[0]!==agent.sourceDescription)) throw new AgentStoreError();
    if (kind === 'approved') {
      if (!agent.name.trim()) throw new AgentStoreError();
      assertApprovable(agent);
    } else if (!Number.isInteger(agent.step) || agent.step < 0 || agent.step > 6 || (agent.step > 0 && !agent.name.trim())) {
      throw new AgentStoreError();
    }
  }
  return state;
}

export function openAgentStore({ directory = '.sift', memory = false } = {}) {
  let db;
  try {
    if (!memory) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = memory ? ':memory:' : join(directory, 'agents.sqlite');
    db = new DatabaseSync(path);
    if (!memory) chmodSync(path, 0o600);
    db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS agents (
        user_id INTEGER PRIMARY KEY, revision INTEGER NOT NULL,
        draft TEXT, approved TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_receipts (
        update_id INTEGER PRIMARY KEY, response TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT OR IGNORE INTO runtime VALUES ('offset', 0);
      CREATE TABLE IF NOT EXISTS ai_requests (update_id INTEGER PRIMARY KEY, day TEXT NOT NULL);
    `);
    db.exec(DISCOVERY_SCHEMA);
    db.exec(WATCH_SCHEMA);
    db.exec(GROUP_SCHEMA);
    db.exec(INTELLIGENCE_SCHEMA);
  } catch { try { db?.close(); } catch {} throw new AgentStoreError(); }
  const safe = (fn) => (...args) => {
    try { return fn(...args); } catch (error) {
      if (error instanceof AgentStoreError) throw error;
      throw new AgentStoreError();
    }
  };
  const userId = (id) => {
    if (!Number.isSafeInteger(id) || id <= 0) throw new AgentStoreError();
    return id;
  };
  return {
    ...discoveryStore(db, safe),
    ...watchStore(db, safe),
    ...groupStore(db, safe),
    ...intelligenceStore(db, safe),
    aiReserve: safe((updateId, day) => {
      if (!Number.isSafeInteger(updateId) || updateId<0 || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new AgentStoreError();
      db.exec('BEGIN IMMEDIATE');
      try {
        const result=db.prepare(`INSERT OR IGNORE INTO ai_requests SELECT ?,? WHERE
          (SELECT COUNT(*) FROM ai_requests WHERE day=?)<20`).run(updateId,day,day);
        db.exec('COMMIT');return Boolean(result.changes);
      } catch(error) {db.exec('ROLLBACK');throw error;}
    }),
    get: safe((id) => {
      const row = db.prepare('SELECT * FROM agents WHERE user_id = ?').get(userId(id));
      if (!row) return { revision: 0, draft: null, approved: null };
      return validateState({ revision: row.revision, draft: row.draft ? JSON.parse(row.draft) : null,
        approved: row.approved ? JSON.parse(row.approved) : null });
    }),
    put: safe((id, state) => {
      validateState(state);
      const previous = db.prepare('SELECT approved FROM agents WHERE user_id=?').get(userId(id));
      if ((previous?.approved ?? null) !== (state.approved ? JSON.stringify(state.approved) : null)) {
        db.prepare('INSERT INTO rule_audit (user_id,at,action,detail) VALUES (?,?,?,?)').run(id,Date.now(),'approved_rules',JSON.stringify({before:previous?.approved?JSON.parse(previous.approved):null,after:state.approved}));
      }
      if (previous?.approved && previous.approved !== JSON.stringify(state.approved)) {
        db.prepare("UPDATE discovery_scans SET state='paused',issue='RULES_CHANGED' WHERE user_id=? AND state='active'").run(id);
        db.prepare("UPDATE group_targets SET state='paused',issue='RULES_CHANGED',revision=revision+1 WHERE owner_id=? AND state!='stopped' AND chat_id NOT IN (SELECT chat_id FROM group_settings WHERE strategy IS NOT NULL)").run(id);
      }
      db.prepare(`INSERT INTO agents VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision, draft=excluded.draft, approved=excluded.approved`)
        .run(userId(id), state.revision, state.draft ? JSON.stringify(state.draft) : null,
          state.approved ? JSON.stringify(state.approved) : null);
    }),
    // Agent mutations and their reply are committed together. Retrying an
    // update after a failed Telegram send must not advance the wizard twice.
    receipt: safe((updateId) => {
      const row = db.prepare('SELECT response FROM agent_receipts WHERE update_id=?').get(updateId);
      return row ? JSON.parse(row.response) : null;
    }),
    process: safe((updateId, action) => {
      if (!Number.isSafeInteger(updateId + 1) || updateId < 0) throw new AgentStoreError();
      db.exec('BEGIN IMMEDIATE');
      try {
        const receipt = db.prepare('SELECT response FROM agent_receipts WHERE update_id = ?').get(updateId);
        const response = receipt ? JSON.parse(receipt.response) : action();
        if (response instanceof Promise) throw new AgentStoreError();
        if (!receipt) db.prepare('INSERT INTO agent_receipts VALUES (?, ?)').run(updateId, JSON.stringify(response));
        db.exec('COMMIT');
        return response;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }),
    offset: safe(() => db.prepare("SELECT value FROM runtime WHERE key='offset'").get().value),
    acknowledge: safe((updateId) => {
      if (!Number.isSafeInteger(updateId + 1) || updateId < 0) throw new AgentStoreError();
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare("UPDATE runtime SET value=MAX(value, ?) WHERE key='offset'").run(updateId + 1);
        db.prepare('DELETE FROM agent_receipts WHERE update_id <= ?').run(updateId);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }),
    close: safe(() => db.close()),
  };
}
