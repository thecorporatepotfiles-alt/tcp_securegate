import fs from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { setFileStore, setSqlJs } from '../shims/better-sqlite3';

setSqlJs(await initSqlJs());

// Node-only stand-in for database files, so the server suite's restart scenario also runs through sql.js.
setFileStore({
  read: (file) => (fs.existsSync(file) ? new Uint8Array(fs.readFileSync(file)) : null),
  write: (file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  },
});
