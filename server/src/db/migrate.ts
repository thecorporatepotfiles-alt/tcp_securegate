import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { DB } from './connection.js';

function migrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) return path.resolve(process.env.MIGRATIONS_DIR);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, 'migrations'), path.join(here, 'db', 'migrations')];
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) throw new Error(`Migrations directory not found (looked in ${candidates.join(', ')})`);
  return found;
}

export interface MigrationResult {
  applied: string[];
  current: string[];
}

export function migrate(db: DB): MigrationResult {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const dir = migrationsDir();
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  const appliedRows = db.prepare('SELECT version, checksum FROM schema_migrations').all() as {
    version: string;
    checksum: string;
  }[];
  const applied = new Map(appliedRows.map((r) => [r.version, r.checksum]));
  const newlyApplied: string[] = [];

  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');
    const previous = applied.get(file);
    if (previous) {
      if (previous !== checksum) {
        throw new Error(`Migration ${file} was modified after being applied. Create a new migration instead.`);
      }
      continue;
    }
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)').run(
        file,
        checksum,
        new Date().toISOString(),
      );
    })();
    newlyApplied.push(file);
  }
  return { applied: newlyApplied, current: files };
}

/** Drop every table, index and trigger. Used only by the demo reset. */
export function dropAll(db: DB): void {
  const objects = db
    .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','trigger','view')")
    .all() as { type: string; name: string }[];
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      for (const o of objects.filter((o) => o.type === 'trigger')) db.exec(`DROP TRIGGER IF EXISTS "${o.name}"`);
      for (const o of objects.filter((o) => o.type === 'view')) db.exec(`DROP VIEW IF EXISTS "${o.name}"`);
      for (const o of objects.filter((o) => o.type === 'table')) db.exec(`DROP TABLE IF EXISTS "${o.name}"`);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
