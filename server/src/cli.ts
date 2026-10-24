import path from 'node:path';
import { loadConfig } from './config.js';
import { openDatabase } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { ensureBaseline, resetDemo, seedDemo } from './seed/demo.js';
import { hashPassword } from './lib/crypto.js';
import { writeAudit } from './services/audit.js';
import { PASSWORD_RULE } from './services/admin.js';

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
  case 'bootstrap': {
    // Creates the organization, an HQ location and the first System Administrator
    // on an empty database (production onboarding). Usage: bootstrap <username> <password> [org name]
    const [username, password, orgName] = process.argv.slice(3);
    migrate(db);
    ensureBaseline(db);
    if (db.prepare('SELECT 1 FROM organizations').get()) {
      console.error('An organization already exists; bootstrap only runs on an empty database.');
      process.exit(1);
    }
    if (!username || !PASSWORD_RULE.safeParse(password).success) {
      console.error('Usage: bootstrap <username> <password (min 10 chars, letters and digits)> [organization name]');
      process.exit(1);
    }
    const now = new Date().toISOString();
    db.transaction(() => {
      const org = Number(db.prepare("INSERT INTO organizations (code, name, created_at) VALUES ('ORG', ?, ?)").run(orgName ?? 'Establishment', now).lastInsertRowid);
      const hq = Number(db.prepare("INSERT INTO locations (organization_id, code, name, kind, is_active, created_at, updated_at) VALUES (?, 'HQ', 'Headquarters', 'HQ', 1, ?, ?)").run(org, now, now).lastInsertRowid);
      const id = Number(
        db
          .prepare(
            `INSERT INTO users (organization_id, username, display_name, role_code, password_hash, all_locations, primary_location_id, is_active, password_changed_at, created_at, updated_at)
             VALUES (?, ?, 'System Administrator', 'SYSTEM_ADMIN', ?, 1, ?, 1, ?, ?, ?)`,
          )
          .run(org, username.toLowerCase(), hashPassword(password), hq, now, now, now).lastInsertRowid,
      );
      db.prepare('INSERT INTO user_locations (user_id, location_id) VALUES (?, ?)').run(id, hq);
      writeAudit(db, null, { action: 'system.bootstrap', entityType: 'user', entityId: id, entityRef: username, metadata: { organization: orgName ?? 'Establishment' } }, null, org);
    })();
    console.log(`Created organization, HQ location and System Administrator "${username}".`);
    break;
  }
  case 'backup': {
    const target = path.resolve(process.argv[3] ?? path.join(config.dataDir, `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`));
    await db.backup(target);
    console.log(`Backup written to ${target}`);
    break;
  }
  default:
    console.log('Usage: tsx server/src/cli.ts <migrate|seed|reset|bootstrap <user> <password> [org]|backup [file]>');
    process.exit(1);
}
db.close();
