import { Database } from 'bun:sqlite';
import migration from './migrations/001.sql' with { type: 'text' };
import { tokenTypes, type RecordUsage } from './types';

/**
 * Local memory of costly: imported usage, file read positions and push state, in one SQLite file.
 * This is the only place that knows about SQLite; everything else uses these methods.
 */
export class Store {
  private readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.db.exec(migration);
  }
  put(row: RecordUsage): boolean {
    const old = this.db.query('SELECT data FROM usage WHERE id=?').get(row.id) as { data: string } | null;
    if (old) {
      const prior = JSON.parse(old.data) as RecordUsage;
      // A later streaming chunk can complete usage. Identical repeats never reprice history.
      if (tokenTypes.every(t => row.tokens[t] >= prior.tokens[t]) && tokenTypes.some(t => row.tokens[t] > prior.tokens[t])) {
        this.db.query('UPDATE usage SET data=? WHERE id=?').run(JSON.stringify({ ...row, timestamp: prior.timestamp }), row.id);
      }
      return false;
    }
    return this.db.query('INSERT OR IGNORE INTO usage VALUES (?, ?, ?)').run(row.id, row.timestamp, JSON.stringify(row)).changes > 0;
  }
  /** Rows still waiting for a price. Priced rows are never repriced, so sent totals stay stable. */
  unpriced(): RecordUsage[] {
    return (this.db.query(`SELECT data FROM usage WHERE json_extract(data, '$.costBasis') = 'unpriced'`).all() as { data: string }[]).map(r => JSON.parse(r.data));
  }
  replace(row: RecordUsage) { this.db.query('UPDATE usage SET data=? WHERE id=?').run(JSON.stringify(row), row.id); }
  rows(from = 0, to = Number.MAX_SAFE_INTEGER): RecordUsage[] {
    return (this.db.query('SELECT data FROM usage WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp, id').all(from, to) as { data: string }[]).map(r => JSON.parse(r.data));
  }
  get(key: string): string | undefined { return (this.db.query('SELECT value FROM state WHERE key=?').get(key) as { value: string } | null)?.value; }
  set(key: string, value: string) { this.db.query('INSERT OR REPLACE INTO state VALUES (?, ?)').run(key, value); }
  /** State entries whose key starts with `prefix`. */
  states(prefix: string): { key: string; value: string }[] {
    return this.db.query('SELECT key, value FROM state WHERE substr(key, 1, length(?)) = ?').all(prefix, prefix) as { key: string; value: string }[];
  }
  /** Run `fn` all-or-nothing: if it throws, nothing it wrote is kept. `immediate` takes the write lock at once. */
  transaction<T>(fn: () => T, immediate = false): T {
    const run = this.db.transaction(fn);
    return immediate ? run.immediate() : run();
  }
  close() { this.db.close(); }
}
