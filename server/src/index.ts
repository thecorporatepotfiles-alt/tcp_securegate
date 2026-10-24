import { loadConfig } from './config.js';
import { openDatabase } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { createApp } from './app.js';
import { startScheduler } from './services/scheduler.js';
import { ensureBaseline, seedDemo } from './seed/demo.js';

const config = loadConfig();
const db = openDatabase(config.databaseFile);
const { applied } = migrate(db);
if (applied.length) console.log(`[db] applied migrations: ${applied.join(', ')}`);
ensureBaseline(db);
if (config.mode === 'demo' && config.autoSeed) {
  const result = seedDemo(db, config);
  if (result.seeded) console.log(`[seed] demo dataset created (${result.summary})`);
}

const app = createApp({ db, config });
const stop = startScheduler(db, config);
const server = app.listen(config.port, config.host, () => {
  console.log(`TCP SecureGate (${config.mode} mode) listening on http://${config.host}:${config.port}`);
  if (config.mode === 'demo') console.log('Demonstration mode: synthetic data only, simulated verification.');
});

function shutdown() {
  stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
