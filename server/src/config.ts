import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type AppMode = 'demo' | 'production';

export interface AppConfig {
  mode: AppMode;
  port: number;
  host: string;
  databaseFile: string;
  dataDir: string;
  /** HMAC key used to sign QR / access tokens. */
  tokenSecret: string;
  timezone: string;
  sessionIdleMinutes: number;
  sessionAbsoluteHours: number;
  secureCookies: boolean;
  trustProxy: boolean;
  /** Seed demo data automatically when the database is empty (demo mode only). */
  autoSeed: boolean;
  demoPersonnelCount: number;
  schedulerIntervalSeconds: number;
  serveClient: boolean;
  clientDir: string;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be an integer`);
  return n;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

/**
 * Demo mode persists a generated token secret under the data directory so QR
 * passes survive restarts. Production mode refuses to start without an
 * explicitly provided secret.
 */
function resolveTokenSecret(mode: AppMode, dataDir: string): string {
  const fromEnv = process.env.TOKEN_SECRET;
  if (fromEnv) {
    if (fromEnv.length < 32) throw new Error('TOKEN_SECRET must be at least 32 characters');
    return fromEnv;
  }
  if (mode === 'production') {
    throw new Error('TOKEN_SECRET is required when APP_MODE=production');
  }
  const file = path.join(dataDir, '.demo-token-secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const mode: AppMode = process.env.APP_MODE === 'production' ? 'production' : 'demo';
  const dataDir = path.resolve(process.env.DATA_DIR ?? 'data');
  const config: AppConfig = {
    mode,
    port: intEnv('PORT', 3000),
    host: process.env.HOST ?? '127.0.0.1',
    dataDir,
    databaseFile: process.env.DATABASE_FILE ?? path.join(dataDir, 'securegate.db'),
    tokenSecret: overrides.tokenSecret ?? resolveTokenSecret(mode, dataDir),
    timezone: process.env.APP_TIMEZONE ?? 'Asia/Kolkata',
    sessionIdleMinutes: intEnv('SESSION_IDLE_MINUTES', mode === 'production' ? 15 : 60),
    sessionAbsoluteHours: intEnv('SESSION_ABSOLUTE_HOURS', 12),
    secureCookies: boolEnv('SECURE_COOKIES', mode === 'production'),
    trustProxy: boolEnv('TRUST_PROXY', false),
    autoSeed: boolEnv('DEMO_AUTO_SEED', true),
    demoPersonnelCount: intEnv('DEMO_PERSONNEL_COUNT', 1200),
    schedulerIntervalSeconds: intEnv('SCHEDULER_INTERVAL_SECONDS', 60),
    serveClient: boolEnv('SERVE_CLIENT', true),
    clientDir: path.resolve(process.env.CLIENT_DIR ?? 'dist/client'),
    ...overrides,
  };
  if (config.mode === 'production' && config.autoSeed) {
    // Demo data must never be generated automatically in production.
    config.autoSeed = false;
  }
  return config;
}

export function isDemo(config: AppConfig): boolean {
  return config.mode === 'demo';
}
