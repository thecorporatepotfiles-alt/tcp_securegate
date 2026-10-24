import path from 'node:path';
import { loadConfig } from './config.js';
import { openDatabase } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { ensureBaseline, resetDemo, seedDemo } from './seed/demo.js';

const cmd = process.argv[2];
const config = loadConfig();
const db = openDatabase(config.databaseFile);

switch (cmd) {
  case 'migrate': {
    const r = migrate(db);
    ensureBaseline(db);
    console.log(r.applied.length ? `Applied: ${r.applied.join(', ')}` : 'Database schema is up to date.');
    break;
  }
  case 'seed': {
    if (config.mode !== 'demo') {
      console.error('Refusing to seed synthetic demo data outside demo mode.');
      process.exit(1);
    }
    migrate(db);
    ensureBaseline(db);
    const r = seedDemo(db, config);
    console.log(r.seeded ? `Demo dataset created: ${r.summary}` : 'Demo dataset already present — nothing to do (seed is idempotent).');
    break;
  }
  case 'reset': {
    if (config.mode !== 'demo') {
      console.error('Refusing to reset outside demo mode.');
      process.exit(1);
    }
    const r = resetDemo(db, config, 'cli');
    console.log(`Demo dataset reset: ${r}`);
    break;
  }
  case 'backup': {
    const target = path.resolve(process.argv[3] ?? path.join(config.dataDir, `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`));
    await db.backup(target);
    console.log(`Backup written to ${target}`);
    break;
  }
  default:
    console.log('Usage: tsx server/src/cli.ts <migrate|seed|reset|backup [file]>');
    process.exit(1);
}
db.close();
