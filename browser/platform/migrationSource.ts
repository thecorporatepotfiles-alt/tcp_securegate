import type { MigrationFile } from '../../server/src/db/migrationSource.js';

// The same SQL files the server reads from disk, bundled at build time.
const files = import.meta.glob('../../server/src/db/migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export type { MigrationFile };

export function loadMigrations(): MigrationFile[] {
  return Object.entries(files)
    .map(([file, sql]) => ({ name: file.slice(file.lastIndexOf('/') + 1), sql }))
    .filter((m) => /^\d{4}_.+\.sql$/.test(m.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}
