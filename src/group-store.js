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
`;

export function groupStore(db, safe) {
  const get = chat => db.prepare('SELECT * FROM group_targets WHERE chat_id=?').get(chat) ?? null;
  const chatId = chat => { if (!Number.isSafeInteger(chat) || chat >= 0) throw Error('Invalid group'); return chat; };
  return {
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
      return true;
    }),
    groupState: safe((chat, state, issue = null) => {
      if (!['active', 'paused', 'stopped'].includes(state)) throw Error('Invalid group state');
      db.prepare('UPDATE group_targets SET state=?,issue=?,revision=revision+1 WHERE chat_id=?').run(state, issue, chatId(chat));
    }),
    groupReserve: safe((chat, owner, key, token, time) => {
      const row = db.prepare(`INSERT OR IGNORE INTO group_deliveries (chat_id,criteria_key,token,created_at,state)
        SELECT ?,?,?,?,'pending' WHERE EXISTS
        (SELECT 1 FROM group_targets WHERE chat_id=? AND owner_id=? AND criteria_key=? AND state='active')`)
        .run(chat, key, token, time, chat, owner, key);
      return row.changes ? Number(row.lastInsertRowid) : null;
    }),
    groupDelivery: safe((event, state) => {
      if (!['sent', 'failed', 'uncertain'].includes(state)) throw Error('Invalid delivery state');
      db.prepare('UPDATE group_deliveries SET state=? WHERE id=?').run(state, event);
    }),
    groupIssues: safe(chat => db.prepare("SELECT COUNT(*) AS n FROM group_deliveries WHERE chat_id=? AND state!='sent'").get(chat).n),
  };
}
