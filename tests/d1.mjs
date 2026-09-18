import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
export function database(legacySql = '') {
  const sqlite = new DatabaseSync(':memory:');
  if (legacySql) sqlite.exec(legacySql);
  sqlite.exec(readFileSync(new URL('../migrations/0001_bookings.sql', import.meta.url), 'utf8'));
  return { sqlite, prepare(sql) {
    const statement = sqlite.prepare(sql);
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async first() { return statement.get(...args) || null; },
      async all() { return { results: statement.all(...args) }; },
      async run() { const result = statement.run(...args); return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; }
    };
  }};
}

