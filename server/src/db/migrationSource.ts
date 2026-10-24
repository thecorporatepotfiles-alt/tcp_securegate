import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface MigrationFile {
  name: string;
  sql: string;
}

function migrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) return path.resolve(process.env.MIGRATIONS_DIR);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, 'migrations'), path.join(here, 'db', 'migrations')];
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) throw new Error(`Migrations directory not found (looked in ${candidates.join(', ')})`);
  return found;
}

/**
 * Migration files in apply order. The browser edition substitutes this module
 * with one that bundles the same SQL files at build time.
 */
export function loadMigrations(): MigrationFile[] {
  const dir = migrationsDir();
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((name) => ({ name, sql: fs.readFileSync(path.join(dir, name), 'utf8') }));
}
