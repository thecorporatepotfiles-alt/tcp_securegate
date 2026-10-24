import request from 'supertest';
import type { Express } from 'express';
import { clock } from '../src/clock.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { openDatabase, type DB } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { ensureBaseline, seedDemo } from '../src/seed/demo.js';
import { createApp } from '../src/app.js';
import type { RateLimiter } from '../src/lib/rateLimit.js';

/** 11:30 local time in Asia/Kolkata on a Saturday — inside normal working hours. */
export const T0 = '2026-10-24T06:00:00.000Z';

export interface TestEnv {
  db: DB;
  config: AppConfig;
  app: Express;
  as: (username: string) => Promise<Client>;
  anon: () => Client;
}

export interface Client {
  get: (path: string, query?: Record<string, unknown>) => request.Test;
  post: (path: string, body?: unknown) => request.Test;
  patch: (path: string, body?: unknown) => request.Test;
  put: (path: string, body?: unknown) => request.Test;
  agent: ReturnType<typeof request.agent>;
}

function wrap(agent: ReturnType<typeof request.agent>): Client {
  return {
    agent,
    get: (path, query) => agent.get(`/api${path}`).query(query ?? {}),
    post: (path, body = {}) => agent.post(`/api${path}`).set('X-SG-Request', '1').send(body as object),
    patch: (path, body = {}) => agent.patch(`/api${path}`).set('X-SG-Request', '1').send(body as object),
    put: (path, body = {}) => agent.put(`/api${path}`).set('X-SG-Request', '1').send(body as object),
  };
}

export function setup(opts: { mode?: 'demo' | 'production'; seed?: boolean; at?: string; databaseFile?: string } = {}): TestEnv {
  clock.freeze(opts.at ?? T0);
  const config = loadConfig({
    mode: opts.mode ?? 'demo',
    databaseFile: opts.databaseFile ?? ':memory:',
    tokenSecret: 'test-token-secret-0123456789-abcdefghijklmnop',
    demoPersonnelCount: 150,
    serveClient: false,
    autoSeed: false,
    timezone: 'Asia/Kolkata',
  });
  const db = openDatabase(config.databaseFile);
  migrate(db);
  ensureBaseline(db);
  if (opts.seed !== false) seedDemo(db, { ...config, mode: 'demo' });
  const app = createApp({ db, config }) as unknown as Express;
  const limiters = app.locals.limiters as Record<string, RateLimiter>;
  return {
    db,
    config,
    app,
    anon: () => wrap(request.agent(app)),
    as: async (username: string) => {
      const agent = request.agent(app);
      const res = await agent.post('/api/auth/demo-login').set('X-SG-Request', '1').send({ username });
      if (res.status !== 200) throw new Error(`demo login failed for ${username}: ${res.status} ${JSON.stringify(res.body)}`);
      Object.values(limiters).forEach((l) => l.reset());
      return wrap(agent);
    },
  };
}

export function id(db: DB, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as { id: number } | undefined;
  if (!row) throw new Error(`No row for: ${sql}`);
  return row.id;
}

export function gateId(db: DB, code: string): number {
  return id(db, 'SELECT id FROM gates WHERE code = ?', code);
}

export function locationId(db: DB, code: string): number {
  return id(db, 'SELECT id FROM locations WHERE code = ?', code);
}

export function userId(db: DB, username: string): number {
  return id(db, 'SELECT id FROM users WHERE username = ?', username);
}

/** Verify at a gate and return the response body. */
export async function verify(c: Client, gate: number, mode: string, input: string, method?: string) {
  const res = await c.post('/gate/verify', { gateId: gate, mode, input, method });
  if (res.status !== 200) throw new Error(`verify failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { attemptId: number; result: string; allowedActions: string[]; subject: { id: number; type: string } | null; manualReviewEligible: boolean; message: string };
}

export async function record(c: Client, attemptId: number, eventType: 'ENTRY' | 'EXIT', extra: Record<string, unknown> = {}) {
  return c.post('/gate/events', { attemptId, eventType, ...extra });
}

/** A fresh active personnel record at a location with an active credential, recorded outside. */
export function freshPersonnel(db: DB, locationCode: string): { personnelId: number; credential: string } {
  const loc = locationId(db, locationCode);
  const row = db
    .prepare(
      `SELECT p.id, c.credential_number AS n FROM personnel p JOIN credentials c ON c.personnel_id = p.id AND c.status = 'ACTIVE' AND c.is_temporary = 0
       WHERE p.primary_location_id = ? AND p.status = 'ACTIVE' AND (p.access_valid_until IS NULL OR p.access_valid_until > '2026-12-31')
       AND NOT EXISTS (SELECT 1 FROM presence pr WHERE pr.subject_type = 'PERSONNEL' AND pr.subject_id = p.id AND pr.state = 'INSIDE')
       AND NOT EXISTS (SELECT 1 FROM credentials c2 WHERE c2.personnel_id = p.id AND c2.is_temporary = 1)
       ORDER BY p.id LIMIT 1`,
    )
    .get(loc) as { id: number; n: string };
  return { personnelId: row.id, credential: row.n };
}
