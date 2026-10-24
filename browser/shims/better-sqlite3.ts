/**
 * better-sqlite3 compatible facade over sql.js (SQLite compiled to WebAssembly),
 * covering the API subset the server uses so it runs unmodified in a browser.
 *
 * Semantics follow better-sqlite3 12.x: parameter binding and its errors,
 * SqliteError codes, run() results, transaction()/savepoints, pragma(), the
 * "busy" rules while an iterator is open, and errors after close(). Databases
 * are in-memory (optionally opened from / serialized to bytes); file names
 * work only through an installed FileStore.
 *
 * Known differences: sql.js binds int32-valued numbers as INTEGER (native: REAL)
 * and has no int64 binding (bigints beyond int32 bind as REAL, beyond 2^53 as
 * TEXT); Statement#readonly is a heuristic; serialize() drops TEMP objects and
 * re-applies only pragmas set through pragma(); SQLite is not in defensive mode.
 */
import type { Database as SqlJsDatabase, SqlJsStatic, SqlValue, Statement as SqlJsStatement } from 'sql.js';

let sqlJs: SqlJsStatic | null = null;

/** Register the initialised sql.js module (`await initSqlJs(...)`) before opening a database. */
export function setSqlJs(SQL: SqlJsStatic): void {
  sqlJs = SQL;
}

export function getSqlJs(): SqlJsStatic {
  if (!sqlJs) throw new Error('sql.js is not initialised: call setSqlJs(await initSqlJs()) before opening a database');
  return sqlJs;
}

/**
 * Optional synchronous byte store that lets file names open: the file is read
 * once when opened and written back on close(). Unset (the default, and the
 * browser edition), any file name throws.
 */
export interface FileStore {
  read(filename: string): Uint8Array | null | undefined;
  write(filename: string, data: Uint8Array): void;
}

let fileStore: FileStore | null = null;

/** Install (or with null remove) the file store; returns the previous one. */
export function setFileStore(store: FileStore | null): FileStore | null {
  const previous = fileStore;
  fileStore = store;
  return previous;
}

export class SqliteError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}
Object.defineProperty(SqliteError.prototype, 'name', { value: 'SqliteError', writable: true, configurable: true });

const CACHE_SIZE = 200;
const NOT_OPEN = 'The database connection is not open';
const DB_BUSY = 'This database connection is busy executing a query';
const NESTED_BEGIN = 'cannot start a transaction within a transaction';
const TOO_MANY = 'Too many parameter values were provided';
const BIND_TYPES = 'SQLite3 can only bind numbers, strings, bigints, buffers, and null';
const VACUUM_IN_TX = 'cannot VACUUM from within a transaction';
const VACUUM_BUSY = 'cannot VACUUM - SQL statements in progress';
const SAVEPOINT = 'SAVEPOINT `\t_bs3.\t`';
const RELEASE = 'RELEASE `\t_bs3.\t`';
const ROLLBACK_TO = 'ROLLBACK TO `\t_bs3.\t`';
const LAST_ROWID = 'SELECT last_insert_rowid()';
/** Text that may follow the single statement passed to prepare(). */
const ONLY_TRIVIA = /^(?:\s|;|--[^\n]*(?:\n|$)|\/\*[\s\S]*?(?:\*\/|$))*$/;
/** Pragmas stored in the database file: never re-applied after serialize(). */
const PERSISTENT_PRAGMAS = new Set(['user_version', 'application_id', 'schema_version', 'page_size', 'auto_vacuum', 'encoding']);

const PRIMARY_CODES: Record<number, string> = {
  1: 'SQLITE_ERROR', 2: 'SQLITE_INTERNAL', 3: 'SQLITE_PERM', 4: 'SQLITE_ABORT', 5: 'SQLITE_BUSY', 6: 'SQLITE_LOCKED',
  7: 'SQLITE_NOMEM', 8: 'SQLITE_READONLY', 9: 'SQLITE_INTERRUPT', 10: 'SQLITE_IOERR', 11: 'SQLITE_CORRUPT',
  12: 'SQLITE_NOTFOUND', 13: 'SQLITE_FULL', 14: 'SQLITE_CANTOPEN', 15: 'SQLITE_PROTOCOL', 16: 'SQLITE_EMPTY',
  17: 'SQLITE_SCHEMA', 18: 'SQLITE_TOOBIG', 19: 'SQLITE_CONSTRAINT', 20: 'SQLITE_MISMATCH', 21: 'SQLITE_MISUSE',
  22: 'SQLITE_NOLFS', 23: 'SQLITE_AUTH', 24: 'SQLITE_FORMAT', 25: 'SQLITE_RANGE', 26: 'SQLITE_NOTADB',
};

type TaggedError = Error & { sqliteRc?: number };

const isNestedBegin = (e: unknown) => e instanceof Error && e.message === NESTED_BEGIN;

const TRIGGER = 'SQLITE_CONSTRAINT_TRIGGER';
const PRIMARYKEY = 'SQLITE_CONSTRAINT_PRIMARYKEY';
const UNIQUE = 'SQLITE_CONSTRAINT_UNIQUE';

/** Columns of the tables whose name, followed by '.', starts ?1 (constraint messages name columns "table.column"). */
const TABLE_COLUMNS = `SELECT t.schema, t.name, t.wr, t.strict, c.name, c.type, c.pk, c."notnull"
  FROM pragma_table_list AS t, pragma_table_info(t.name, t.schema) AS c
  WHERE t.type = 'table' AND substr(?1, 1, length(t.name) + 1) = t.name || '.'`;
/** Key columns of the unique indexes that ?1 may name ("t.a, t.b", or "index 'x'" for expression indexes). */
const UNIQUE_INDEXES = `SELECT t.schema, t.name, il.name, il.origin, ii.name
  FROM pragma_table_list AS t, pragma_index_list(t.name, t.schema) AS il, pragma_index_info(il.name, t.schema) AS ii
  WHERE t.type = 'table' AND il."unique" AND (?1 GLOB 'index ''*' OR substr(?1, 1, length(t.name) + 1) = t.name || '.')
  ORDER BY t.schema, t.name, il.seq, ii.seqno`;
/** A table declares a CHECK constraint whose name or expression text is ?1 ('' for any). */
const HAS_CHECK = `SELECT 1 FROM (SELECT sql FROM main.sqlite_schema WHERE type = 'table'
  UNION ALL SELECT sql FROM temp.sqlite_schema WHERE type = 'table') WHERE instr(upper(sql), 'CHECK') AND instr(sql, ?1) LIMIT 1`;
const FOREIGN_KEYS_ENFORCED = `SELECT 1 FROM pragma_foreign_keys WHERE foreign_keys AND EXISTS
  (SELECT 1 FROM pragma_table_list AS t, pragma_foreign_key_list(t.name, t.schema) WHERE t.type = 'table')`;

const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_INT64 = -(2n ** 63n);
const MAX_INT64 = 2n ** 63n - 1n;

const NodeBuffer = (globalThis as { Buffer?: { from(b: ArrayBufferLike, offset: number, length: number): Uint8Array } }).Buffer;

/** better-sqlite3 returns blobs as Buffers under Node; keep Uint8Array elsewhere. */
function out(v: SqlValue): unknown {
  return NodeBuffer && v instanceof Uint8Array ? NodeBuffer.from(v.buffer, v.byteOffset, v.byteLength) : v;
}

function toSqlValue(v: unknown): SqlValue {
  switch (typeof v) {
    case 'number':
    case 'string':
      return v;
    case 'bigint':
      if (v < MIN_INT64 || v > MAX_INT64) throw new RangeError('The bound string, buffer, or bigint is too big');
      // sql.js has no int64 binding: exact as a number when safe, otherwise as text.
      return v >= MIN_SAFE && v <= MAX_SAFE ? Number(v) : v.toString();
    case 'undefined':
      return null;
    case 'object':
      if (v === null) return null;
      // better-sqlite3 binds any ArrayBufferView (Node's Buffer check) as a blob of its bytes.
      if (ArrayBuffer.isView(v)) return v instanceof Uint8Array ? v : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  throw new TypeError(BIND_TYPES);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function booleanOption(options: object, key: string): boolean {
  if (!(key in options)) return false;
  const value = (options as Record<string, unknown>)[key];
  if (typeof value !== 'boolean') throw new TypeError(`Expected the "${key}" option to be a boolean`);
  return value;
}

interface SqlInfo {
  /** Parameter slots in index order: the named key (prefix removed) or null for anonymous. Null when unknown. */
  slots: (string | null)[] | null;
  /** INSERT/UPDATE/DELETE: better-sqlite3 reports changes only for statements that changed rows. */
  dml: boolean;
  /** Best-effort stand-in for sqlite3_stmt_readonly(), which sql.js does not expose. */
  readonly: boolean;
}

const ID_CHAR = /[\w$\u0080-￿]/;
const READONLY_FIRST = new Set(['SELECT', 'VALUES', 'WITH', 'EXPLAIN', 'BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE']);

/**
 * sql.js exposes neither sqlite3_bind_parameter_count/name nor
 * sqlite3_stmt_readonly, so derive them from the SQL text using SQLite's own
 * tokenizer and numbering rules (verified against the compiled statement).
 */
function analyzeSql(sql: string): SqlInfo {
  const slots: (string | null)[] = [];
  const named = new Set<string>();
  const n = sql.length;
  const idEnd = (j: number) => {
    while (j < n && ID_CHAR.test(sql[j])) j++;
    return j;
  };
  let first = '';
  let depth = 0;
  let dml = false;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      for (;;) {
        const k = sql.indexOf(c, j);
        if (k < 0) j = n;
        else if (sql[k + 1] === c) {
          j = k + 2;
          continue;
        } else j = k + 1;
        break;
      }
      i = j;
    } else if (c === '[') {
      const k = sql.indexOf(']', i + 1);
      i = k < 0 ? n : k + 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      const k = sql.indexOf('\n', i + 2);
      i = k < 0 ? n : k + 1;
    } else if (c === '/' && sql[i + 1] === '*') {
      const k = sql.indexOf('*/', i + 2);
      i = k < 0 ? n : k + 2;
    } else if (c === '?') {
      let j = i + 1;
      while (j < n && sql[j] >= '0' && sql[j] <= '9') j++;
      if (j === i + 1) slots.push(null);
      else {
        // ?NNN takes index NNN and is named "?NNN" unless that index already has a name.
        const index = Number(sql.slice(i + 1, j));
        while (slots.length < index) slots.push(null);
        if (slots[index - 1] === null) slots[index - 1] = sql.slice(i + 1, j);
      }
      i = j;
    } else if (c === ':' || c === '@' || c === '$') {
      let j = idEnd(i + 1);
      if (j === i + 1) {
        i++;
        continue;
      }
      // Tcl-style variable suffixes accepted by SQLite's tokenizer: $a::b and $a(x)
      for (;;) {
        if (sql[j] === ':' && sql[j + 1] === ':') j = idEnd(j + 2);
        else if (sql[j] === '(') {
          const k = sql.indexOf(')', j);
          j = k < 0 ? n : k + 1;
          break;
        } else break;
      }
      const name = sql.slice(i, j);
      if (!named.has(name)) {
        named.add(name);
        slots.push(name.slice(1));
      }
      i = j;
    } else if (ID_CHAR.test(c)) {
      const j = idEnd(i + 1);
      const word = sql.slice(i, j).toUpperCase();
      if (!first) first = word;
      else if (first === 'WITH' && depth === 0 && (word === 'INSERT' || word === 'UPDATE' || word === 'DELETE')) dml = true;
      i = j;
    } else {
      if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
  }
  if (first === 'INSERT' || first === 'UPDATE' || first === 'DELETE' || first === 'REPLACE') dml = true;
  return { slots, dml, readonly: !dml && READONLY_FIRST.has(first) };
}

/** Confirm the statement has exactly `count` parameters (binding past the last one fails with SQLITE_RANGE). */
function parameterCountIs(raw: SqlJsStatement, count: number): boolean {
  try {
    try {
      raw.bind(new Array<SqlValue>(count + 1).fill(0));
      return false;
    } catch {
      /* expected: parameter count + 1 does not exist */
    }
    if (count > 0) raw.bind(new Array<SqlValue>(count).fill(0));
    return true;
  } catch {
    return false;
  } finally {
    raw.reset();
  }
}

/** Fallback when parameter analysis disagrees with SQLite: bind the way sql.js does. */
function bindLeniently(raw: SqlJsStatement, params: unknown[]): void {
  const anonymous: SqlValue[] = [];
  let named: Record<string, SqlValue> | null = null;
  for (const arg of params) {
    if (Array.isArray(arg)) anonymous.push(...arg.map(toSqlValue));
    else if (isPlainObject(arg)) {
      named = {};
      for (const [k, v] of Object.entries(arg)) for (const p of '@:$') named[p + k] = toSqlValue(v);
    } else anonymous.push(toSqlValue(arg));
  }
  raw.bind(named ?? anonymous);
}

interface Entry {
  info: SqlInfo;
  reader: boolean;
  /** Compiled statement ready for use; null while checked out (e.g. by an open iterator). */
  idle: SqlJsStatement | null;
}

/** Owns the sql.js database and its compiled statements. */
class Connection {
  db: SqlJsDatabase | null;
  /** Open iterators (better-sqlite3's "busy" rule). */
  iterators = 0;
  /** Iterators whose statement is mid-execution (stepped to a row, not yet finished). */
  active = 0;
  /** LRU of compiled statements keyed by SQL text. */
  private readonly cache = new Map<string, Entry>();
  /** Transaction control and last_insert_rowid() statements (never iterated, never evicted). */
  private readonly control = new Map<string, SqlJsStatement>();
  /** Connection-level pragmas set through pragma(), re-applied after sql.js reopens the database. */
  private readonly pragmas = new Map<string, string>();

  constructor(SQL: SqlJsStatic, bytes: Uint8Array | null) {
    const db = new SQL.Database(bytes);
    const handleError = SQL.Database.prototype.handleError as (this: SqlJsDatabase, rc: number) => null;
    // sql.js discards SQLite's result code; keep it so errors can carry better-sqlite3's codes.
    (db as unknown as { handleError(rc: number): null }).handleError = function (this: SqlJsDatabase, rc: number) {
      if (rc === 0) return null;
      try {
        return handleError.call(this, rc);
      } catch (e) {
        if (e instanceof Error) (e as TaggedError).sqliteRc = rc;
        throw e;
      }
    };
    this.db = db;
    try {
      this.applyPragmas(); // also the first read of opened bytes (e.g. "file is not a database")
    } catch (e) {
      this.close();
      throw e;
    }
  }

  ensureOpen(): SqlJsDatabase {
    if (!this.db) throw new TypeError(NOT_OPEN);
    return this.db;
  }

  ensureNoIterators(): void {
    if (this.iterators > 0) throw new TypeError(DB_BUSY);
  }

  /** The cache entry for sql (compiling it, which reports SQL errors as prepare() would). */
  entry(sql: string): Entry {
    let e = this.cache.get(sql);
    if (e) {
      this.cache.delete(sql);
      this.cache.set(sql, e);
      return e;
    }
    e = this.compile(sql);
    this.cache.set(sql, e);
    if (this.cache.size > CACHE_SIZE) {
      const [oldest, evicted] = this.cache.entries().next().value!;
      this.cache.delete(oldest);
      evicted.idle?.free();
    }
    return e;
  }

  /** Take a compiled statement for exclusive use; a fresh one if the cached one is busy (re-entrancy). */
  checkout(sql: string): SqlJsStatement {
    const e = this.entry(sql);
    if (!e.idle) return this.prepareRaw(sql);
    const raw = e.idle;
    e.idle = null;
    return raw;
  }

  release(sql: string, raw: SqlJsStatement): void {
    if (!this.db) return; // closed: sql.js already freed it
    raw.reset();
    const e = this.cache.get(sql);
    if (e && !e.idle) e.idle = raw;
    else raw.free();
  }

  private prepareRaw(sql: string): SqlJsStatement {
    try {
      return this.ensureOpen().prepare(sql);
    } catch (e) {
      throw this.translate(e);
    }
  }

  private compile(sql: string): Entry {
    const raw = this.prepareRaw(sql);
    try {
      const first = raw.getSQL();
      if (first.length < sql.length && sql.startsWith(first) && !ONLY_TRIVIA.test(sql.slice(first.length))) {
        throw new RangeError('The supplied SQL string contains more than one statement');
      }
      const info = analyzeSql(sql);
      if (!parameterCountIs(raw, info.slots!.length)) info.slots = null;
      return { info, reader: raw.getColumnNames().length > 0, idle: raw };
    } catch (e) {
      raw.free();
      throw e;
    }
  }

  private controlStatement(sql: string): SqlJsStatement {
    let s = this.control.get(sql);
    if (!s) {
      s = this.prepareRaw(sql);
      this.control.set(sql, s);
    }
    return s;
  }

  /** Step a control statement; raw sql.js errors propagate (callers translate). */
  private stepControl(sql: string): void {
    const s = this.controlStatement(sql);
    try {
      s.step();
    } finally {
      s.reset();
    }
  }

  run(sql: string): void {
    try {
      this.stepControl(sql);
    } catch (e) {
      throw this.translate(e);
    }
  }

  lastInsertRowid(): number {
    const s = this.controlStatement(LAST_ROWID);
    try {
      s.step();
      return s.get()[0] as number;
    } finally {
      s.reset();
    }
  }

  /**
   * sql.js has no sqlite3_get_autocommit(): BEGIN fails exactly when a transaction is open. While a
   * statement is mid-execution the ROLLBACK undoing that BEGIN would abort it (e.g. an INSERT ...
   * RETURNING being iterated), so VACUUM is used instead: it then fails in both states, with different messages.
   */
  inTransaction(): boolean {
    if (!this.db) return false;
    if (this.active > 0) {
      try {
        this.stepControl('VACUUM');
      } catch (e) {
        if (e instanceof Error && e.message === VACUUM_IN_TX) return true;
        if (e instanceof Error && e.message === VACUUM_BUSY) return false;
        throw this.translate(e);
      }
      return false;
    }
    try {
      this.stepControl('BEGIN');
    } catch (e) {
      if (isNestedBegin(e)) return true;
      throw this.translate(e);
    }
    this.run('ROLLBACK');
    return false;
  }

  /** better-sqlite3's transaction wrapper, starting with BEGIN or (when nested) a savepoint. */
  transaction(begin: string, fn: (...args: unknown[]) => unknown, self: unknown, args: unknown[]): unknown {
    this.ensureOpen();
    this.ensureNoIterators();
    let nested = false;
    try {
      this.stepControl(begin);
    } catch (e) {
      if (!isNestedBegin(e)) throw this.translate(e);
      nested = true;
    }
    if (nested) this.run(SAVEPOINT);
    try {
      const result = fn.apply(self, args);
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        throw new TypeError('Transaction function cannot return a promise');
      }
      // Native runs COMMIT/ROLLBACK as statements, so an iterator left open makes them throw "busy".
      this.ensureNoIterators();
      this.run(nested ? RELEASE : 'COMMIT');
      return result;
    } catch (ex) {
      if (this.inTransaction()) {
        this.ensureNoIterators();
        this.run(nested ? ROLLBACK_TO : 'ROLLBACK');
        if (nested) this.run(RELEASE);
      }
      throw ex;
    }
  }

  /** Execute a statement (through the cache) and return its column names and rows. */
  query(sql: string): { names: string[]; rows: SqlValue[][] } {
    const raw = this.checkout(sql);
    try {
      const rows: SqlValue[][] = [];
      let names: string[] = [];
      while (raw.step()) {
        if (!rows.length) names = raw.getColumnNames();
        rows.push(raw.get());
      }
      return { names, rows };
    } catch (e) {
      throw this.translate(e);
    } finally {
      this.release(sql, raw);
    }
  }

  recordPragma(schema: string | undefined, name: string, source: string): void {
    if (!PERSISTENT_PRAGMAS.has(name)) this.pragmas.set(`${schema ?? 'main'}.${name}`, source);
  }

  private applyPragmas(): void {
    const db = this.ensureOpen();
    try {
      // Behave like an in-memory database (sql.js really uses a file in its in-memory filesystem).
      db.exec('PRAGMA journal_mode = MEMORY');
      for (const source of this.pragmas.values()) db.exec(`PRAGMA ${source}`);
    } catch (e) {
      throw this.translate(e);
    }
  }

  private dropStatements(): void {
    for (const e of this.cache.values()) e.idle?.free();
    this.cache.clear();
    for (const s of this.control.values()) s.free();
    this.control.clear();
  }

  /** sql.js export() closes and reopens the database: statements are freed and pragmas reset. */
  export(): Uint8Array {
    const db = this.ensureOpen();
    this.dropStatements();
    let bytes: Uint8Array;
    try {
      bytes = db.export();
    } catch (e) {
      throw this.translate(e);
    }
    this.applyPragmas();
    return bytes;
  }

  close(): void {
    const db = this.db;
    if (!db) return;
    this.dropStatements();
    this.db = null;
    db.close();
  }

  translate(e: unknown): unknown {
    if (typeof e === 'string') {
      return e === 'Nothing to prepare' ? new RangeError('The supplied SQL string contains no statements') : new Error(e);
    }
    const rc = e instanceof Error ? (e as TaggedError).sqliteRc : undefined;
    if (rc === undefined) return e;
    return new SqliteError((e as Error).message, this.codeFor(rc, (e as Error).message));
  }

  /** Recover the extended result code better-sqlite3 reports, from the primary code and message. */
  private codeFor(rc: number, message: string): string {
    if (rc === 19) return this.constraintCode(message);
    if (rc === 4 && message === 'abort due to ROLLBACK') return 'SQLITE_ABORT_ROLLBACK';
    return PRIMARY_CODES[rc] ?? 'SQLITE_ERROR';
  }

  /**
   * A constraint's message names a column, index or CHECK that the schema must contain. Anything else
   * came from RAISE() in a trigger, whose text is free-form and may imitate those messages.
   */
  private constraintCode(message: string): string {
    let m: RegExpExecArray | null;
    if (message.startsWith('UNIQUE constraint failed: ')) return this.uniqueCode(message.slice(26));
    if ((m = /^NOT NULL constraint failed: (.+)$/s.exec(message))) {
      return this.hasColumn(m[1], (c) => c.notnull) ? 'SQLITE_CONSTRAINT_NOTNULL' : TRIGGER;
    }
    if ((m = /^cannot store \S+ value in \S+ column (.+)$/s.exec(message))) {
      return this.hasColumn(m[1], (c) => c.strict) ? 'SQLITE_CONSTRAINT_DATATYPE' : TRIGGER;
    }
    if ((m = /^CHECK constraint failed(?:: (.+))?$/s.exec(message))) {
      return this.lookup(HAS_CHECK, [m[1] ?? ''])?.length !== 0 ? 'SQLITE_CONSTRAINT_CHECK' : TRIGGER;
    }
    if (message === 'FOREIGN KEY constraint failed') {
      return this.lookup(FOREIGN_KEYS_ENFORCED, [])?.length !== 0 ? 'SQLITE_CONSTRAINT_FOREIGNKEY' : TRIGGER;
    }
    if (message === 'constraint failed') return 'SQLITE_CONSTRAINT';
    return TRIGGER;
  }

  /** Rows of a schema query, or null if it fails (then the message is taken at its word). */
  private lookup(sql: string, params: SqlValue[]): SqlValue[][] | null {
    try {
      return this.ensureOpen().exec(sql, params)[0]?.values ?? [];
    } catch {
      return null;
    }
  }

  private columns(target: string): ColumnInfo[] | null {
    return (
      this.lookup(TABLE_COLUMNS, [target])?.map(([schema, table, wr, strict, name, type, pk, notnull]) => ({
        schema: schema as string,
        table: table as string,
        wr: !!wr,
        strict: !!strict,
        name: name as string,
        type: type as string,
        pk: pk as number,
        notnull: !!notnull,
      })) ?? null
    );
  }

  /** target is "table.column" for a column satisfying test. */
  private hasColumn(target: string, test: (c: ColumnInfo) => boolean): boolean {
    const columns = this.columns(target);
    return !columns || columns.some((c) => `${c.table}.${c.name}` === target && test(c));
  }

  /**
   * SQLite names a failed unique index "t.a, t.b" (key columns in order) or "index 'x'" (expression
   * index), and a rowid clash after the INTEGER PRIMARY KEY column or as "t.rowid" when there is none.
   */
  private uniqueCode(target: string): string {
    const rows = this.lookup(UNIQUE_INDEXES, [target]) as [string, string, string, string, string | null][] | null;
    const columns = this.columns(target);
    if (!rows || !columns) return UNIQUE;
    const indexes = new Map<string, { table: string; name: string; origin: string; keys: (string | null)[] }>();
    for (const [schema, table, name, origin, key] of rows) {
      const id = `${schema}\0${name}`;
      let index = indexes.get(id);
      if (!index) indexes.set(id, (index = { table: `${schema}\0${table}`, name, origin, keys: [] }));
      index.keys.push(key);
    }
    let code: string | null = null;
    const pkIndexed = new Set<string>();
    for (const { table, name, origin, keys } of indexes.values()) {
      if (origin === 'pk') pkIndexed.add(table);
      const tableName = table.slice(table.indexOf('\0') + 1);
      const text = keys.includes(null) ? `index '${name.replaceAll("'", "''")}'` : keys.map((k) => `${tableName}.${k}`).join(', ');
      if (text === target) code = origin === 'pk' ? PRIMARYKEY : (code ?? UNIQUE);
    }
    if (code) return code;
    const tables = new Map<string, ColumnInfo[]>();
    for (const c of columns) {
      const id = `${c.schema}\0${c.table}`;
      if (!tables.has(id)) tables.set(id, []);
      tables.get(id)!.push(c);
    }
    for (const [id, cols] of tables) {
      const { table, wr } = cols[0];
      if (wr) continue;
      // An INTEGER PRIMARY KEY is the rowid unless it needed an index (e.g. declared DESC).
      const pk = cols.filter((c) => c.pk > 0);
      const alias = pk.length === 1 && pk[0].type.toUpperCase() === 'INTEGER' && !pkIndexed.has(id) ? pk[0].name : null;
      if (target === `${table}.${alias ?? 'rowid'}`) return alias ? PRIMARYKEY : 'SQLITE_CONSTRAINT_ROWID';
    }
    return TRIGGER;
  }
}

interface ColumnInfo {
  schema: string;
  table: string;
  wr: boolean;
  strict: boolean;
  name: string;
  type: string;
  pk: number;
  notnull: boolean;
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export class Statement {
  readonly source: string;
  readonly reader: boolean;
  readonly readonly: boolean;
  readonly database: Database;
  readonly #conn: Connection;
  readonly #info: SqlInfo;
  #pluck = false;
  #raw = false;
  #busy = false;

  /** @internal Use Database#prepare(). */
  constructor(database: Database, conn: Connection, source: string, entry: Entry) {
    this.database = database;
    this.#conn = conn;
    this.source = source;
    this.#info = entry.info;
    this.reader = entry.reader;
    this.readonly = entry.info.readonly;
  }

  get busy(): boolean {
    return this.#busy;
  }

  run(...params: unknown[]): RunResult {
    const db = this.#start(false);
    this.#conn.ensureNoIterators();
    const raw = this.#conn.checkout(this.source);
    try {
      this.#bind(raw, params);
      // Native run() throws errors reported by sqlite3_reset(), e.g. a deferred foreign key failing at the
      // implicit COMMIT, but sql.js's reset() drops them; stepping a write to the end raises them instead
      // (only buffered RETURNING rows remain by then).
      if (raw.step() && !this.#info.readonly) while (raw.step());
      raw.reset(); // completes the statement so changes() reflects it
      return { changes: this.#info.dml ? db.getRowsModified() : 0, lastInsertRowid: this.#conn.lastInsertRowid() };
    } catch (e) {
      throw this.#conn.translate(e);
    } finally {
      this.#conn.release(this.source, raw);
    }
  }

  get(...params: unknown[]): unknown {
    this.#start(true);
    const raw = this.#conn.checkout(this.source);
    try {
      this.#bind(raw, params);
      return raw.step() ? this.#row(raw.get(), raw.getColumnNames()) : undefined;
    } catch (e) {
      throw this.#conn.translate(e);
    } finally {
      this.#conn.release(this.source, raw);
    }
  }

  all(...params: unknown[]): unknown[] {
    this.#start(true);
    const raw = this.#conn.checkout(this.source);
    try {
      this.#bind(raw, params);
      const rows: unknown[] = [];
      let names: string[] | null = null;
      while (raw.step()) rows.push(this.#row(raw.get(), (names ??= raw.getColumnNames())));
      return rows;
    } catch (e) {
      throw this.#conn.translate(e);
    } finally {
      this.#conn.release(this.source, raw);
    }
  }

  iterate(...params: unknown[]): IterableIterator<unknown> {
    this.#start(true);
    const conn = this.#conn;
    const raw = conn.checkout(this.source);
    try {
      this.#bind(raw, params);
    } catch (e) {
      conn.release(this.source, raw);
      throw conn.translate(e);
    }
    this.#busy = true;
    conn.iterators++;
    let done = false;
    let active = false;
    let names: string[] | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      this.#busy = false;
      conn.iterators--;
      if (active) conn.active--;
      conn.release(this.source, raw);
    };
    const iterator: IterableIterator<unknown> = {
      next: () => {
        if (done) return { done: true, value: undefined };
        try {
          if (raw.step()) {
            if (!active) conn.active++;
            active = true;
            return { done: false, value: this.#row(raw.get(), (names ??= raw.getColumnNames())) };
          }
        } catch (e) {
          const err = conn.translate(e);
          finish();
          throw err;
        }
        finish();
        return { done: true, value: undefined };
      },
      return: () => {
        finish();
        return { done: true, value: undefined };
      },
      [Symbol.iterator]() {
        return iterator;
      },
    };
    return iterator;
  }

  pluck(toggle = true): this {
    this.#requireReader('pluck');
    this.#pluck = toggle;
    if (toggle) this.#raw = false;
    return this;
  }

  raw(toggle = true): this {
    this.#requireReader('raw');
    this.#raw = toggle;
    if (toggle) this.#pluck = false;
    return this;
  }

  #requireReader(method: string): void {
    if (!this.reader) throw new TypeError(`The ${method}() method is only for statements that return data`);
    this.#conn.ensureOpen();
  }

  #start(needsReader: boolean): SqlJsDatabase {
    if (needsReader && !this.reader) throw new TypeError('This statement does not return data. Use run() instead');
    const db = this.#conn.ensureOpen();
    if (this.#busy) throw new TypeError('This statement is busy executing a query');
    return db;
  }

  #row(values: SqlValue[], names: string[]): unknown {
    if (this.#pluck) return out(values[0]);
    if (this.#raw) return values.map(out);
    const row: Record<string, unknown> = {};
    for (let i = 0; i < names.length; i++) row[names[i]] = out(values[i]);
    return row;
  }

  /** better-sqlite3's binder: anonymous values (arrays expanded) fill unnamed slots; one plain object fills named ones. */
  #bind(raw: SqlJsStatement, params: unknown[]): void {
    const slots = this.#info.slots;
    if (!slots) return bindLeniently(raw, params);
    const count = slots.length;
    if (count === 0 && params.length === 0) return;
    const values = new Array<SqlValue>(count);
    let anon = 0;
    let bound = 0;
    let boundObject = false;
    const nextAnon = () => {
      do anon++;
      while (anon <= count && slots[anon - 1] !== null);
      if (anon > count) throw new RangeError(TOO_MANY);
      return anon - 1;
    };
    // As natively, a value's type is checked before its parameter index.
    const bindAnon = (v: unknown) => {
      const value = toSqlValue(v);
      values[nextAnon()] = value;
    };
    for (const arg of params) {
      if (Array.isArray(arg)) {
        arg.forEach(bindAnon);
        bound += arg.length;
        continue;
      }
      if (isPlainObject(arg)) {
        if (boundObject) throw new TypeError('You cannot specify named parameters in two different objects');
        boundObject = true;
        for (let i = 0; i < count; i++) {
          const key = slots[i];
          if (key === null) continue;
          if (!Object.prototype.hasOwnProperty.call(arg, key)) throw new RangeError(`Missing named parameter "${key}"`);
          values[i] = toSqlValue(arg[key]);
          bound++;
        }
        continue;
      }
      const isObject = (typeof arg === 'object' && arg !== null) || typeof arg === 'function';
      if (isObject && !ArrayBuffer.isView(arg) && slots.some((s) => s !== null)) {
        throw new TypeError('Named parameters can only be passed within plain objects');
      }
      bindAnon(arg);
      bound++;
    }
    if (bound < count) {
      if (!boundObject && slots.some((s) => s !== null)) throw new TypeError('Missing named parameters');
      throw new RangeError('Too few parameter values were provided');
    }
    raw.bind(values);
  }
}

export interface DatabaseOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
  timeout?: number;
  verbose?: ((message?: unknown, ...additionalArgs: unknown[]) => void) | null;
  nativeBinding?: unknown;
}

export interface PragmaOptions {
  simple?: boolean;
}

type AnyFunction = (...args: any[]) => any; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface Transaction<F extends AnyFunction> {
  (...args: Parameters<F>): ReturnType<F>;
  default: Transaction<F>;
  deferred: Transaction<F>;
  immediate: Transaction<F>;
  exclusive: Transaction<F>;
  database: Database;
}

class Database {
  static SqliteError = SqliteError;

  readonly name: string;
  readonly memory: boolean;
  readonly readonly: boolean;
  readonly #conn: Connection;
  readonly #file: { store: FileStore; path: string } | null = null;

  constructor(filename?: string | Uint8Array | null, options?: DatabaseOptions | null) {
    let bytes: Uint8Array | null = null;
    if (filename instanceof Uint8Array) {
      bytes = filename;
      filename = ':memory:';
    }
    if (filename == null) filename = '';
    if (options == null) options = {};
    if (typeof filename !== 'string') throw new TypeError('Expected first argument to be a string');
    if (typeof options !== 'object') throw new TypeError('Expected second argument to be an options object');
    const path = filename.trim();
    const anonymous = path === '' || path === ':memory:';
    const readonly = booleanOption(options, 'readonly');
    if (readonly && anonymous && !bytes) throw new TypeError('In-memory/temporary databases cannot be readonly');
    if (!anonymous) {
      if (!fileStore) throw new Error('The browser edition supports in-memory databases only');
      bytes = fileStore.read(path) ?? null;
      if (!bytes && booleanOption(options, 'fileMustExist')) throw new SqliteError('unable to open database file', 'SQLITE_CANTOPEN');
      this.#file = { store: fileStore, path };
    }
    this.#conn = new Connection(getSqlJs(), bytes);
    this.name = filename;
    this.memory = anonymous;
    this.readonly = readonly;
    if (readonly) this.pragma('query_only = ON');
  }

  get open(): boolean {
    return this.#conn.db !== null;
  }

  get inTransaction(): boolean {
    return this.#conn.inTransaction();
  }

  prepare(source: string): Statement {
    if (typeof source !== 'string') throw new TypeError('Expected first argument to be a string');
    this.#conn.ensureOpen();
    return new Statement(this, this.#conn, source, this.#conn.entry(source));
  }

  exec(source: string): this {
    if (typeof source !== 'string') throw new TypeError('Expected first argument to be a string');
    const db = this.#conn.ensureOpen();
    this.#conn.ensureNoIterators();
    try {
      db.exec(source);
    } catch (e) {
      throw this.#conn.translate(e);
    }
    return this;
  }

  pragma(source: string, options?: PragmaOptions | null): unknown {
    if (options == null) options = {};
    if (typeof source !== 'string') throw new TypeError('Expected first argument to be a string');
    if (typeof options !== 'object') throw new TypeError('Expected second argument to be an options object');
    const simple = booleanOption(options, 'simple');
    const conn = this.#conn;
    conn.ensureOpen();
    conn.ensureNoIterators();
    const assignment = /^\s*(?:(\w+)\.)?(\w+)\s*=\s*(.*?)[\s;]*$/s.exec(source);
    const name = assignment?.[2].toLowerCase();
    // In-memory databases stay in MEMORY journal mode; better-sqlite3's defensive mode also refuses OFF.
    const ignored = name === 'journal_mode' && !/^['"]?memory['"]?$/i.test(assignment![3]);
    const { names, rows } = conn.query(ignored ? `PRAGMA ${assignment![1] ? `${assignment![1]}.` : ''}journal_mode` : `PRAGMA ${source}`);
    if (assignment && !ignored) conn.recordPragma(assignment[1]?.toLowerCase(), name!, source);
    if (simple) return rows.length ? out(rows[0][0]) : undefined;
    return rows.map((values) => {
      const row: Record<string, unknown> = {};
      names.forEach((n, i) => (row[n] = out(values[i])));
      return row;
    });
  }

  transaction<F extends AnyFunction>(fn: F): Transaction<F> {
    if (typeof fn !== 'function') throw new TypeError('Expected first argument to be a function');
    const conn = this.#conn;
    const variant = (begin: string) =>
      function sqliteTransaction(this: unknown, ...args: unknown[]) {
        return conn.transaction(begin, fn, this, args);
      };
    const fns = {
      default: variant('BEGIN'),
      deferred: variant('BEGIN DEFERRED'),
      immediate: variant('BEGIN IMMEDIATE'),
      exclusive: variant('BEGIN EXCLUSIVE'),
    };
    const properties: PropertyDescriptorMap = {
      default: { value: fns.default },
      deferred: { value: fns.deferred },
      immediate: { value: fns.immediate },
      exclusive: { value: fns.exclusive },
      database: { value: this, enumerable: true },
    };
    for (const f of Object.values(fns)) Object.defineProperties(f, properties);
    return fns.default as unknown as Transaction<F>;
  }

  /** The database file as bytes (sql.js export()); open them again with `new Database(bytes)`. */
  serialize(options?: { attached?: string }): Uint8Array {
    const conn = this.#conn;
    conn.ensureOpen();
    if (options?.attached !== undefined && options.attached !== 'main') {
      throw new TypeError('The browser edition can only serialize the main database');
    }
    conn.ensureNoIterators();
    // sql.js export() reopens the connection, which would silently roll back an open transaction.
    if (conn.inTransaction()) throw new TypeError('Cannot serialize the database while a transaction is open');
    return conn.export();
  }

  close(): this {
    const conn = this.#conn;
    if (!conn.db) return this;
    conn.ensureNoIterators();
    if (this.#file) {
      if (conn.inTransaction()) conn.run('ROLLBACK');
      this.#file.store.write(this.#file.path, conn.export());
    }
    conn.close();
    return this;
  }

  backup(): Promise<never> {
    return Promise.reject(new TypeError('backup() is not available in the browser edition; use serialize()'));
  }
}

type DatabaseInstance = Database;
type StatementInstance = Statement;
type SqliteErrorInstance = SqliteError;
type RunResultType = RunResult;

// Mirror better-sqlite3's type namespace (Database.Database, Database.Statement, ...).
declare namespace Database {
  export type Database = DatabaseInstance;
  export type Statement = StatementInstance;
  export type SqliteError = SqliteErrorInstance;
  export type RunResult = RunResultType;
}

export default Database;
