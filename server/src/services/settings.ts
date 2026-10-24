import { z } from 'zod';
import type { DB } from '../db/connection.js';
import type { Ctx } from '../auth/context.js';
import { requirePerm } from '../auth/context.js';
import { clock } from '../clock.js';
import { badRequest } from '../lib/errors.js';
import { audit } from './audit.js';
import {
  ALERT_SEVERITIES,
  ALERT_TYPES,
  ALERT_TYPE_INFO,
  DEFAULT_DELIVERY_CATEGORIES,
  DEFAULT_DELIVERY_TRANSITIONS,
  DEFAULT_MANUAL_REVIEW_ELIGIBLE,
  DEFAULT_VEHICLE_CATEGORIES,
  DEFAULT_VISIT_TRANSITIONS,
  DELIVERY_STATUSES,
  RESULT_CODES,
  VISIT_STATUSES,
  type AlertSeverity,
  type AlertType,
} from '../../../shared/constants.js';

function transitionsSchema<T extends readonly [string, ...string[]]>(statuses: T) {
  const status = z.enum(statuses);
  return z
    .record(z.string(), z.array(status))
    .refine((rec) => Object.keys(rec).every((k) => (statuses as readonly string[]).includes(k)), 'Unknown status key');
}

const categoryList = z
  .array(z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{1,30}$/), label: z.string().trim().min(1).max(60) }))
  .min(1)
  .max(30)
  .refine((list) => new Set(list.map((c) => c.code)).size === list.length, 'Category codes must be unique');

export const SETTINGS_SCHEMA = {
  'visit.transitions': transitionsSchema(VISIT_STATUSES),
  'visit.requireSecurityCheck': z.boolean(),
  'visit.allowSelfApproval': z.boolean(),
  'visit.passSingleUse': z.boolean(),
  'visit.passEarlyMinutes': z.number().int().min(0).max(720),
  'visit.passGraceMinutes': z.number().int().min(0).max(720),
  'visit.overstayGraceMinutes': z.number().int().min(0).max(720),
  'delivery.transitions': transitionsSchema(DELIVERY_STATUSES),
  'delivery.requireAuthorization': z.boolean(),
  'delivery.ackOverdueHours': z.number().int().min(1).max(168),
  'delivery.categories': categoryList,
  'vehicle.categories': categoryList,
  'gate.verificationTtlSeconds': z.number().int().min(30).max(1800),
  'gate.manualReviewEligible': z.array(z.enum(RESULT_CODES)),
  'gate.manualReviewValidityMinutes': z.number().int().min(5).max(240),
  'gate.guardCanAuthorizeDelivery': z.boolean(),
  'alerts.rules': z.record(z.string(), z.object({ enabled: z.boolean(), severity: z.enum(ALERT_SEVERITIES) })),
  'alerts.repeatedFailureThreshold': z.number().int().min(2).max(50),
  'alerts.repeatedFailureWindowMinutes': z.number().int().min(1).max(240),
  'exceptions.unresolvedHours': z.number().int().min(1).max(720),
} as const;

export type SettingKey = keyof typeof SETTINGS_SCHEMA;
export type Settings = { [K in SettingKey]: z.infer<(typeof SETTINGS_SCHEMA)[K]> };

export const SETTING_DESCRIPTIONS: Record<SettingKey, string> = {
  'visit.transitions': 'Permitted visitor status transitions (server-enforced).',
  'visit.requireSecurityCheck': 'Require a recorded security verification step before a visitor pass is generated.',
  'visit.allowSelfApproval': 'Allow the requester of a visit to also approve it.',
  'visit.passSingleUse': 'Visitor passes allow one entry and one exit only.',
  'visit.passEarlyMinutes': 'Minutes before expected arrival that a pass becomes valid.',
  'visit.passGraceMinutes': 'Minutes after expected departure that a pass remains valid for entry.',
  'visit.overstayGraceMinutes': 'Minutes after expected departure before an inside visitor is marked overdue.',
  'delivery.transitions': 'Permitted delivery status transitions (server-enforced).',
  'delivery.requireAuthorization': 'Deliveries require an authorization decision after arrival.',
  'delivery.ackOverdueHours': 'Hours after authorization before a missing receipt acknowledgement raises an alert.',
  'delivery.categories': 'Delivery categories offered in forms.',
  'vehicle.categories': 'Vehicle categories offered in forms.',
  'gate.verificationTtlSeconds': 'Seconds a successful verification remains usable to record a movement.',
  'gate.manualReviewEligible': 'Verification results a guard may refer for manual review.',
  'gate.manualReviewValidityMinutes': 'Minutes an approved manual review remains usable.',
  'gate.guardCanAuthorizeDelivery': 'Allow gate operators to authorize deliveries.',
  'alerts.rules': 'Enable/disable each alert type and set its severity.',
  'alerts.repeatedFailureThreshold': 'Failed verifications at one gate (or for one credential) that trigger a repeated-failure alert.',
  'alerts.repeatedFailureWindowMinutes': 'Time window for counting repeated failures.',
  'exceptions.unresolvedHours': 'Hours an administrative exception may stay open before raising an alert.',
};

export function defaultSettings(): Settings {
  return {
    'visit.transitions': structuredClone(DEFAULT_VISIT_TRANSITIONS),
    'visit.requireSecurityCheck': false,
    'visit.allowSelfApproval': false,
    'visit.passSingleUse': true,
    'visit.passEarlyMinutes': 60,
    'visit.passGraceMinutes': 60,
    'visit.overstayGraceMinutes': 30,
    'delivery.transitions': structuredClone(DEFAULT_DELIVERY_TRANSITIONS),
    'delivery.requireAuthorization': true,
    'delivery.ackOverdueHours': 4,
    'delivery.categories': structuredClone(DEFAULT_DELIVERY_CATEGORIES),
    'vehicle.categories': structuredClone(DEFAULT_VEHICLE_CATEGORIES),
    'gate.verificationTtlSeconds': 300,
    'gate.manualReviewEligible': [...DEFAULT_MANUAL_REVIEW_ELIGIBLE],
    'gate.manualReviewValidityMinutes': 30,
    'gate.guardCanAuthorizeDelivery': false,
    'alerts.rules': Object.fromEntries(
      ALERT_TYPES.map((t) => [t, { enabled: true, severity: ALERT_TYPE_INFO[t].defaultSeverity }]),
    ) as Record<AlertType, { enabled: boolean; severity: AlertSeverity }>,
    'alerts.repeatedFailureThreshold': 3,
    'alerts.repeatedFailureWindowMinutes': 10,
    'exceptions.unresolvedHours': 24,
  };
}

const cache = new WeakMap<DB, Map<number, Settings>>();

export function getSettings(db: DB, orgId: number): Settings {
  let perDb = cache.get(db);
  if (!perDb) {
    perDb = new Map();
    cache.set(db, perDb);
  }
  const hit = perDb.get(orgId);
  if (hit) return hit;
  const merged = defaultSettings() as Record<string, unknown>;
  const rows = db.prepare('SELECT key, value FROM settings WHERE organization_id = ?').all(orgId) as {
    key: string;
    value: string;
  }[];
  for (const row of rows) {
    if (row.key in SETTINGS_SCHEMA) {
      const parsed = SETTINGS_SCHEMA[row.key as SettingKey].safeParse(JSON.parse(row.value));
      if (parsed.success) merged[row.key] = parsed.data;
    }
  }
  const settings = merged as Settings;
  perDb.set(orgId, settings);
  return settings;
}

export function invalidateSettingsCache(db: DB): void {
  cache.delete(db);
}

export function updateSetting(ctx: Ctx, key: string, value: unknown): Settings {
  requirePerm(ctx.actor, 'settings.manage');
  if (!(key in SETTINGS_SCHEMA)) throw badRequest(`Unknown setting: ${key}`);
  const schema = SETTINGS_SCHEMA[key as SettingKey];
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw badRequest(`Invalid value for ${key}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  ctx.db.transaction(() => {
    ctx.db
      .prepare(
        `INSERT INTO settings (organization_id, key, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (organization_id, key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(ctx.actor.orgId, key, JSON.stringify(parsed.data), ctx.actor.userId, clock.nowIso());
    audit(ctx, { action: 'settings.update', entityType: 'setting', entityId: key, metadata: { key, value: parsed.data } });
  })();
  invalidateSettingsCache(ctx.db);
  return getSettings(ctx.db, ctx.actor.orgId);
}

export function canTransition<S extends string>(map: Record<string, S[]>, from: S, to: S): boolean {
  return (map[from] ?? []).includes(to);
}
