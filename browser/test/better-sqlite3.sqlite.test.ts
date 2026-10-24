import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database, { setFileStore, SqliteError, type FileStore } from '../shims/better-sqlite3';
import { openDatabase } from '../../server/src/db/connection';

// The real native library (require bypasses the vitest alias that points 'better-sqlite3' at the shim).
const Native = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3');

/** Loose common surface of the shim and the native library, for side-by-side checks. */
interface AnyDb {
  prepare(sql: string): {
    run(...p: unknown[]): unknown;
    get(...p: unknown[]): unknown;
    all(...p: unknown[]): unknown[];
    iterate(...p: unknown[]): IterableIterator<unknown>;
    reader: boolean;
    source: string;
  };
  exec(sql: string): unknown;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  transaction<F extends (...args: never[]) => unknown>(fn: F): F;
  readonly inTransaction: boolean;
  close(): unknown;
}

const SCHEMA = `
  CREATE TABLE p (id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, n INTEGER CHECK (n >= 0), CONSTRAINT named_chk CHECK (n < 100));
  CREATE TABLE c (id INTEGER PRIMARY KEY, p_id INTEGER REFERENCES p(id), v);
  CREATE TABLE k (a TEXT, b TEXT, PRIMARY KEY (a, b));
  CREATE TABLE tp (code TEXT PRIMARY KEY, x);
  CREATE TABLE wr (a TEXT PRIMARY KEY, b) WITHOUT ROWID;
  CREATE TABLE ux (a, b, UNIQUE (a, b));
  CREATE TABLE nr (a, b);
  CREATE UNIQUE INDEX nr_lower ON nr (lower(a));
  CREATE TABLE st (a INTEGER) STRICT;
  CREATE TABLE ao (id INTEGER PRIMARY KEY, v);
  CREATE TRIGGER ao_no_update BEFORE UPDATE ON ao BEGIN SELECT RAISE(ABORT, 'ao rows are append-only'); END;
  CREATE TRIGGER ao_no_delete BEFORE DELETE ON ao BEGIN SELECT RAISE(FAIL, 'ao rows cannot be deleted'); END;
  CREATE TABLE rb (v);
  CREATE TRIGGER rb_rollback BEFORE INSERT ON rb WHEN NEW.v < 0 BEGIN SELECT RAISE(ROLLBACK, 'negative rolls back'); END;
  INSERT INTO p (id, code, n) VALUES (1, 'A', 1);
  INSERT INTO c (p_id) VALUES (1);
  INSERT INTO k VALUES ('x', 'y');
  INSERT INTO tp VALUES ('a', 1);
  INSERT INTO wr VALUES ('a', 1);
  INSERT INTO ux VALUES (1, 2);
  INSERT INTO nr VALUES ('Q', 1);
  INSERT INTO ao VALUES (1, 1);
`;

function open(kind: 'shim' | 'native'): AnyDb {
  const db = (kind === 'shim' ? new Database(':memory:') : new Native(':memory:')) as unknown as AnyDb;
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

/** Normalised outcome of fn: its value, or the error's class, code and message. */
function outcome(fn: () => unknown): unknown {
  try {
    const value = fn();
    return { value: JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)) ?? null) };
  } catch (e) {
    const err = e as Error & { code?: string };
    return { error: err.constructor.name, name: err.name, code: err.code, message: err.message };
  }
}

/** Run the same scenario on a fresh shim and native database and require identical outcomes. */
function expectSameAsNative(fn: (db: AnyDb) => unknown) {
  const shim = open('shim');
  const native = open('native');
  try {
    const expected = outcome(() => fn(native));
    expect(outcome(() => fn(shim))).toEqual(expected);
    return expected;
  } finally {
    shim.close();
    native.close();
  }
}

describe('better-sqlite3 shim (sql.js)', () => {
  it('is what the server gets for better-sqlite3 under this config', () => {
    const db = openDatabase(':memory:');
    expect(db).toBeInstanceOf(Database);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  describe('error codes match native better-sqlite3', () => {
    const cases: [string, string, string][] = [
      ['unique', "INSERT INTO p (code, n) VALUES ('A', 2)", 'SQLITE_CONSTRAINT_UNIQUE'],
      ['integer primary key', "INSERT INTO p (id, code, n) VALUES (1, 'B', 2)", 'SQLITE_CONSTRAINT_PRIMARYKEY'],
      ['composite primary key', "INSERT INTO k VALUES ('x', 'y')", 'SQLITE_CONSTRAINT_PRIMARYKEY'],
      ['text primary key', "INSERT INTO tp VALUES ('a', 2)", 'SQLITE_CONSTRAINT_PRIMARYKEY'],
      ['without rowid primary key', "INSERT INTO wr VALUES ('a', 2)", 'SQLITE_CONSTRAINT_PRIMARYKEY'],
      ['composite unique', 'INSERT INTO ux VALUES (1, 2)', 'SQLITE_CONSTRAINT_UNIQUE'],
      ['unique expression index', "INSERT INTO nr VALUES ('q', 2)", 'SQLITE_CONSTRAINT_UNIQUE'],
      ['explicit rowid', "INSERT INTO nr (rowid, a) VALUES (1, 'z')", 'SQLITE_CONSTRAINT_ROWID'],
      ['not null', "INSERT INTO p (code, n) VALUES (NULL, 2)", 'SQLITE_CONSTRAINT_NOTNULL'],
      ['check', "INSERT INTO p (code, n) VALUES ('C', -1)", 'SQLITE_CONSTRAINT_CHECK'],
      ['named check', "INSERT INTO p (code, n) VALUES ('C', 200)", 'SQLITE_CONSTRAINT_CHECK'],
      ['foreign key (child)', 'INSERT INTO c (p_id) VALUES (99)', 'SQLITE_CONSTRAINT_FOREIGNKEY'],
      ['foreign key (parent)', 'DELETE FROM p WHERE id = 1', 'SQLITE_CONSTRAINT_FOREIGNKEY'],
      ['RAISE(ABORT) trigger', 'UPDATE ao SET v = 2', 'SQLITE_CONSTRAINT_TRIGGER'],
      ['RAISE(FAIL) trigger', 'DELETE FROM ao', 'SQLITE_CONSTRAINT_TRIGGER'],
      ['RAISE(ROLLBACK) trigger', 'INSERT INTO rb VALUES (-1)', 'SQLITE_CONSTRAINT_TRIGGER'],
      ['strict datatype', "INSERT INTO st VALUES ('abc')", 'SQLITE_CONSTRAINT_DATATYPE'],
    ];
    it.each(cases)('%s', (_label, sql, code) => {
      const result = expectSameAsNative((db) => db.prepare(sql).run());
      expect(result).toMatchObject({ error: 'SqliteError', name: 'SqliteError', code });
    });

    it('generic errors from prepare() and exec()', () => {
      expect(expectSameAsNative((db) => db.prepare('SELEC 1'))).toMatchObject({ code: 'SQLITE_ERROR' });
      expect(expectSameAsNative((db) => db.prepare('SELECT * FROM missing'))).toMatchObject({ code: 'SQLITE_ERROR' });
      expect(expectSameAsNative((db) => db.exec('SELECT 1; SELEC 2'))).toMatchObject({ code: 'SQLITE_ERROR' });
      expectSameAsNative((db) => db.exec('COMMIT'));
      expectSameAsNative((db) => db.prepare(''));
      expectSameAsNative((db) => db.prepare('-- only a comment'));
      expectSameAsNative((db) => db.prepare('SELECT 1; SELECT 2'));
      expectSameAsNative((db) => db.prepare('SELECT 1 AS one; -- trailing comment').get());
    });

    it('SqliteError looks like better-sqlite3’s', () => {
      const db = new Database();
      const err = outcome(() => db.exec('SELEC')) as Record<string, unknown>;
      expect(err).toEqual({ error: 'SqliteError', name: 'SqliteError', code: 'SQLITE_ERROR', message: 'near "SELEC": syntax error' });
      try {
        db.exec('SELEC');
      } catch (e) {
        expect(e).toBeInstanceOf(SqliteError);
        expect(e).toBeInstanceOf(Error);
        expect(Object.keys(e as object)).toEqual(['code']);
        expect(String(e)).toBe('SqliteError: near "SELEC": syntax error');
      }
      expect(Database.SqliteError).toBe(SqliteError);
      db.close();
    });
  });

  describe('parameter binding matches native better-sqlite3', () => {
    const cases: [string, string, unknown[]][] = [
      ['anonymous', 'SELECT ? AS a, ? AS b', [1, 'x']],
      ['array expansion', 'SELECT ? AS a, ? AS b, ? AS c', [[1, 2], 3]],
      ['named (all prefixes)', 'SELECT @a AS a, :b AS b, $c AS c', [{ a: 1, b: 'x', c: null }]],
      ['named, repeated and extra keys', 'SELECT @a AS a, @a + 1 AS b', [{ a: 1, z: 2 }]],
      ['named with null prototype', 'SELECT @a AS a', [Object.assign(Object.create(null), { a: 5 })]],
      ['mixed anonymous and named', 'SELECT ? AS x, @a AS a, ? AS y', [1, { a: 2 }, 3]],
      ['undefined binds null', 'SELECT ? AS v, @w AS w', [undefined, { w: undefined }]],
      ['bigint', 'SELECT ? AS v, typeof(?) AS t', [10n, 2n ** 40n]],
      ['floats and NaN', 'SELECT ? AS a, ? AS b', [1.5, NaN]],
      ['blob', 'SELECT hex(?) AS h, typeof(?) AS t', [new Uint8Array([1, 2, 255]), Buffer.from([7])]],
      ['parameters inside literals are ignored', "SELECT '?', \"@x\", [?y], `$z`, ? AS v -- ?\n/* :c */", [1]],
      ['boolean is rejected', 'SELECT ? AS v', [true]],
      ['Date is rejected', 'SELECT ? AS v', [new Date(0)]],
      ['nested array is rejected', 'SELECT ? AS a, ? AS b', [[1, [2]]]],
      ['too many', 'SELECT ? AS v', [1, 2]],
      ['too few', 'SELECT ?, ?', [1]],
      ['none for one', 'SELECT ? AS v', []],
      ['missing named parameter', 'SELECT @a AS a, @b AS b', [{ a: 1 }]],
      ['prefixed key is not a match', 'SELECT @a AS a', [{ '@a': 1 }]],
      ['named object missing entirely', 'SELECT @a AS a', []],
      ['named parameter given anonymously', 'SELECT @a AS a', [1]],
      ['object for anonymous parameter', 'SELECT ? AS a', [{ a: 1 }]],
      ['two named objects', 'SELECT @a AS a, @b AS b', [{ a: 1 }, { b: 2 }]],
      ['numbered parameters', 'SELECT ?2 AS a, ?1 AS b', [{ 1: 'one', 2: 'two' }]],
      ['numbered parameters given anonymously', 'SELECT ?2 AS a, ?1 AS b', [1, 2]],
    ];
    it.each(cases)('%s', (_label, sql, params) => {
      expectSameAsNative((db) => db.prepare(sql).get(...params));
    });
  });

  describe('statement results match native better-sqlite3', () => {
    it('run() changes and lastInsertRowid', () => {
      expectSameAsNative((db) => [
        db.prepare("INSERT INTO nr VALUES ('i1', 1)").run(),
        db.prepare("UPDATE nr SET b = 2 WHERE a = 'nothing'").run(),
        db.prepare('UPDATE nr SET b = 3').run(),
        db.prepare('CREATE TABLE IF NOT EXISTS z (a)').run(),
        db.prepare('SELECT 1').run(),
        db.prepare("INSERT INTO nr VALUES ('i2', 1) RETURNING rowid").run(),
        db.prepare("WITH v(x) AS (VALUES ('w1'), ('w2')) INSERT INTO nr SELECT x, 0 FROM v").run(),
        db.prepare("DELETE FROM nr WHERE a LIKE 'w%'").run(),
        db.prepare('PRAGMA foreign_keys = ON').run(),
      ]);
    });

    it('get(), all(), RETURNING, duplicate columns, blobs and reader flags', () => {
      expectSameAsNative((db) => [
        db.prepare('SELECT * FROM p WHERE id = ?').get(1),
        db.prepare('SELECT * FROM p WHERE id = ?').get(42),
        db.prepare('SELECT a, b FROM nr ORDER BY rowid').all(),
        db.prepare("INSERT INTO nr VALUES ('r', 1) RETURNING a, b").get(),
        db.prepare('SELECT 1 AS a, 2 AS a').get(),
        (db.prepare("SELECT x'0102' AS v").get() as { v: Uint8Array }).v.constructor.name,
        ['SELECT 1', 'DELETE FROM nr WHERE 0', 'PRAGMA foreign_keys', "INSERT INTO nr VALUES (1, 1) RETURNING a", 'PRAGMA foreign_keys = ON'].map(
          (sql) => db.prepare(sql).reader,
        ),
        db.prepare('  SELECT 1  ').source,
      ]);
      expectSameAsNative((db) => db.prepare('UPDATE nr SET b = 2').get());
    });

    it('pragma() including simple mode and WAL on a memory database', () => {
      expectSameAsNative((db) => [
        db.pragma('foreign_keys'),
        db.pragma('foreign_keys', { simple: true }),
        db.pragma('foreign_keys = ON'),
        db.pragma('foreign_keys = ON', { simple: true }),
        db.pragma('journal_mode = WAL'),
        db.pragma('journal_mode', { simple: true }),
        db.pragma('table_info(p)').length,
        db.pragma('user_version = 3', { simple: true }),
        db.pragma('user_version', { simple: true }),
      ]);
      expectSameAsNative((db) => db.pragma('foreign_keys', { simple: 1 as unknown as boolean }));
    });

    it('pluck() and raw()', () => {
      const db = new Database();
      expect(db.prepare('SELECT 1 AS a, 2 AS b').pluck().get()).toBe(1);
      expect(db.prepare('SELECT 1 AS a, 2 AS b').raw().all()).toEqual([[1, 2]]);
      expect(() => db.prepare('CREATE TABLE t (a)').pluck()).toThrow(TypeError);
      db.close();
    });
  });

  describe('transactions', () => {
    it('commit, rollback and nested savepoints behave like native', () => {
      expectSameAsNative((db) => {
        db.exec('CREATE TABLE x (a)');
        const insert = db.prepare('INSERT INTO x VALUES (?)');
        const count = () => (db.prepare('SELECT count(*) AS n FROM x').get() as { n: number }).n;
        const states: unknown[] = [db.inTransaction];
        const outer = db.transaction((a: number) => {
          insert.run(a);
          states.push(db.inTransaction);
          try {
            db.transaction(() => {
              insert.run(a + 1);
              throw new Error('inner fails');
            })();
          } catch (e) {
            states.push((e as Error).message, db.inTransaction, count());
          }
          db.transaction(() => insert.run(a + 2))();
          return count();
        });
        states.push(outer(10), db.inTransaction, count());
        try {
          outer.immediate(20);
          db.transaction(() => {
            insert.run(30);
            outer.deferred(40);
            throw new Error('outer fails');
          })();
        } catch (e) {
          states.push((e as Error).message);
        }
        states.push(db.inTransaction, db.prepare('SELECT a FROM x ORDER BY a').all());
        return states;
      });
    });

    it('arguments, this, variants, promises and SQL-level BEGIN/COMMIT', () => {
      expectSameAsNative((db) => {
        const tx = db.transaction(function (this: unknown, a: number, b: number) {
          return [a, b, this === undefined || (this as { tag?: string }).tag, db.inTransaction];
        }) as unknown as ((a: number, b: number) => unknown) & Record<string, unknown>;
        const res: unknown[] = [tx(1, 2), tx.call({ tag: 'ctx' }, 3, 4)];
        res.push(['default', 'deferred', 'immediate', 'exclusive'].map((k) => typeof tx[k]), tx.database === db, tx.default === tx);
        res.push(outcome(() => db.transaction(async () => 1)()), db.inTransaction);
        db.exec('BEGIN');
        res.push(db.inTransaction);
        db.prepare("INSERT INTO nr VALUES ('in-sql-tx', 1)").run();
        db.transaction(() => db.prepare("INSERT INTO nr VALUES ('savepoint', 1)").run())();
        res.push(db.inTransaction);
        db.exec('COMMIT');
        res.push(db.inTransaction, db.prepare("SELECT count(*) AS n FROM nr WHERE a IN ('in-sql-tx', 'savepoint')").get());
        return res;
      });
    });

    it('a RAISE(ROLLBACK) inside a transaction ends it without a second rollback', () => {
      expectSameAsNative((db) => {
        const res: unknown[] = [];
        res.push(outcome(() => db.transaction(() => {
          db.prepare('INSERT INTO rb VALUES (1)').run();
          db.prepare('INSERT INTO rb VALUES (-1)').run();
        })()));
        res.push(db.inTransaction, db.prepare('SELECT count(*) AS n FROM rb').get());
        return res;
      });
    });

    it('a constraint failure at COMMIT rolls back', () => {
      expectSameAsNative((db) => {
        db.exec('CREATE TABLE d (p_id INTEGER REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED)');
        const res = [outcome(() => db.transaction(() => db.prepare('INSERT INTO d VALUES (77)').run())())];
        res.push(db.inTransaction, db.prepare('SELECT count(*) AS n FROM d').get());
        return res;
      });
    });
  });

  describe('serialize()', () => {
    it('round-trips through bytes and keeps pragmas and cached statements usable', () => {
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      db.pragma('recursive_triggers = ON');
      db.exec(SCHEMA);
      const count = db.prepare('SELECT count(*) AS n FROM p');
      db.prepare("INSERT INTO p (code, n) VALUES ('B', 2)").run();
      const bytes = db.serialize();
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(bytes.subarray(0, 15))).toBe('SQLite format 3');
      // export() reopened the connection: connection-level pragmas must be back.
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.pragma('recursive_triggers', { simple: true })).toBe(1);
      expect(db.pragma('journal_mode', { simple: true })).toBe('memory');
      expect(() => db.prepare('INSERT INTO c (p_id) VALUES (99)').run()).toThrow(expect.objectContaining({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' }));
      expect(count.get()).toEqual({ n: 2 });
      expect(db.prepare("INSERT INTO p (code, n) VALUES ('C', 3)").run().lastInsertRowid).toBe(3);

      const copy = new Database(bytes);
      expect([copy.name, copy.memory, copy.open]).toEqual([':memory:', true, true]);
      expect(copy.prepare('SELECT code FROM p ORDER BY id').all()).toEqual([{ code: 'A' }, { code: 'B' }]);
      expect(copy.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all()).toHaveLength(3);
      expect(() => copy.prepare('UPDATE ao SET v = 9').run()).toThrow(/append-only/);
      copy.close();

      const viaBuffer = new Database(Buffer.from(bytes));
      expect(viaBuffer.prepare('SELECT count(*) AS n FROM p').get()).toEqual({ n: 2 });
      viaBuffer.close();
      db.close();
    });

    it('opens bytes of a database written by native better-sqlite3 (including WAL mode)', () => {
      const native = new Native(':memory:');
      native.exec("CREATE TABLE t (a); INSERT INTO t VALUES ('from native')");
      const bytes = native.serialize();
      native.close();
      const walHeader = new Uint8Array(bytes);
      walHeader[18] = walHeader[19] = 2;
      for (const b of [bytes, walHeader]) {
        const db = new Database(b);
        expect(db.prepare('SELECT a FROM t').get()).toEqual({ a: 'from native' });
        db.close();
      }
    });

    it('refuses to run inside a transaction or while iterating', () => {
      const db = new Database();
      db.exec('CREATE TABLE t (a); INSERT INTO t VALUES (1), (2)');
      db.exec('BEGIN');
      expect(() => db.serialize()).toThrow(/transaction is open/);
      db.exec('ROLLBACK');
      const it = db.prepare('SELECT a FROM t').iterate();
      it.next();
      expect(() => db.serialize()).toThrow('This database connection is busy executing a query');
      it.return!();
      expect(db.serialize().length).toBeGreaterThan(0);
      db.close();
    });
  });

  describe('iterate() and re-entrancy', () => {
    it('iterates lazily and matches native results and busy rules', () => {
      expectSameAsNative((db) => {
        db.exec("INSERT INTO nr VALUES ('i1', 1), ('i2', 2), ('i3', 3)");
        const sql = 'SELECT a, b FROM nr ORDER BY rowid';
        const stmt = db.prepare(sql);
        const seen: unknown[] = [];
        for (const row of stmt.iterate()) {
          // Same SQL text through another Statement while the first is mid-iteration.
          seen.push(row, db.prepare(sql).all().length, db.prepare('SELECT ? AS echo').get((row as { a: string }).a));
        }
        const it = stmt.iterate();
        const first = it.next();
        const busy = [
          outcome(() => stmt.get()),
          outcome(() => db.prepare('INSERT INTO nr VALUES (1, 1)').run()),
          outcome(() => db.exec('SELECT 1')),
          outcome(() => db.pragma('foreign_keys')),
          outcome(() => db.transaction(() => 1)()),
          outcome(() => db.close()),
          db.inTransaction,
        ];
        it.return!();
        // Breaking out of a for-of releases the statement.
        for (const row of stmt.iterate()) if (row) break;
        return [seen, first, busy, stmt.all(), Object.prototype.toString.call(it), it.next()];
      });
    });

    it('re-entrant use of one SQL text uses separate compiled statements', () => {
      const db = new Database();
      db.exec('CREATE TABLE t (a); INSERT INTO t VALUES (1), (2), (3)');
      const sql = 'SELECT a FROM t WHERE a >= ? ORDER BY a';
      const pairs: [number, number[]][] = [];
      for (const row of db.prepare(sql).iterate(1) as Iterable<{ a: number }>) {
        const inner = db.prepare(sql).iterate(row.a) as IterableIterator<{ a: number }>;
        pairs.push([row.a, [...inner].map((r) => r.a)]);
      }
      expect(pairs).toEqual([
        [1, [1, 2, 3]],
        [2, [2, 3]],
        [3, [3]],
      ]);
      // An error mid-iteration releases the statement too.
      db.exec('CREATE TABLE u (v); INSERT INTO u VALUES (1), (0)');
      const div = db.prepare("SELECT 1 / v AS r, CASE WHEN v = 0 THEN json('bad') END AS j FROM u");
      expect(() => [...div.iterate()]).toThrow(SqliteError);
      expect(div.busy).toBe(false);
      expect(() => db.exec('SELECT 1')).not.toThrow();
      db.close();
    });

    it('evicts beyond the statement cache size and still runs every statement', () => {
      const db = new Database();
      db.exec('CREATE TABLE t (a)');
      const stmts = Array.from({ length: 450 }, (_, i) => db.prepare(`INSERT INTO t VALUES (${i}) RETURNING a`));
      const results = stmts.map((s) => (s.get() as { a: number }).a);
      expect(results).toEqual(Array.from({ length: 450 }, (_, i) => i));
      expect(stmts[0].run().lastInsertRowid).toBe(451);
      db.close();
    });
  });

  describe('lifecycle', () => {
    it('close() matches native better-sqlite3', () => {
      expectSameAsNative((db) => {
        const stmt = db.prepare('SELECT 1 AS x');
        const tx = db.transaction(() => 1);
        const handle = db as AnyDb & { open: boolean; serialize(): unknown };
        const res: unknown[] = [handle.open, db.close() === db, handle.open, db.inTransaction, db.close() === db];
        for (const fn of [() => db.prepare('SELECT 1'), () => db.exec('SELECT 1'), () => db.pragma('foreign_keys'), () => stmt.get(), () => stmt.run(), () => tx(), () => handle.serialize()]) {
          res.push(outcome(fn));
        }
        return res;
      });
    });

    it('constructor forms, properties and argument validation', () => {
      const memory = new Database(':memory:');
      const unnamed = new Database();
      const empty = new Database('');
      expect([memory.name, memory.memory, memory.readonly, memory.open, memory.inTransaction]).toEqual([':memory:', true, false, true, false]);
      expect([unnamed.name, unnamed.memory, empty.name, empty.memory]).toEqual(['', true, '', true]);
      expect(() => new Database(':memory:', { readonly: true })).toThrow('In-memory/temporary databases cannot be readonly');
      expect(() => memory.prepare(1 as unknown as string)).toThrow('Expected first argument to be a string');
      expect(() => memory.transaction(1 as unknown as () => void)).toThrow('Expected first argument to be a function');
      expect(memory.exec('') === memory).toBe(true);
      const ro = new Database(memory.serialize(), { readonly: true });
      expect(() => ro.exec('CREATE TABLE t (a)')).toThrow(SqliteError);
      for (const db of [memory, unnamed, empty, ro]) db.close();
    });

    describe('file names', () => {
      let saved: FileStore | null = null;
      const files = new Map<string, Uint8Array>();
      const memoryStore: FileStore = { read: (f) => files.get(f), write: (f, d) => void files.set(f, d) };
      beforeEach(() => {
        // The suite setup installs a Node file store; capture it by swapping in a probe.
        saved = null;
        setFileStore({
          read: (f) => {
            throw new Error(`unexpected read of ${f}`);
          },
          write: () => {},
        });
      });
      afterEach(() => {
        setFileStore(saved);
      });

      it('throw unless a file store is installed', () => {
        setFileStore(null);
        expect(() => new Database('/tmp/whatever.db')).toThrow(new Error('The browser edition supports in-memory databases only'));
      });

      it('persist through an installed store on close()', () => {
        setFileStore(memoryStore);
        const first = new Database('demo.db');
        expect([first.name, first.memory]).toEqual(['demo.db', false]);
        first.pragma('journal_mode = WAL');
        first.exec("CREATE TABLE t (a); INSERT INTO t VALUES ('kept')");
        first.exec("BEGIN; INSERT INTO t VALUES ('uncommitted')");
        first.close();
        const second = new Database('demo.db');
        expect(second.prepare('SELECT a FROM t').all()).toEqual([{ a: 'kept' }]);
        second.close();
        expect(() => new Database('missing.db', { fileMustExist: true })).toThrow(expect.objectContaining({ code: 'SQLITE_CANTOPEN' }));
      });
    });
  });
});
