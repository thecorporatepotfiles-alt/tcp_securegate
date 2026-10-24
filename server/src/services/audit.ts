import type { DB } from '../db/connection.js';
import type { Actor, Ctx } from '../auth/context.js';
import { clock } from '../clock.js';
import { sha256 } from '../lib/crypto.js';
import { scrubMetadata } from '../lib/sanitize.js';

export interface AuditEntry {
  action: string;
  entityType?: string | null;
  entityId?: number | string | null;
  entityRef?: string | null;
  outcome?: 'SUCCESS' | 'DENIED' | 'FAILURE';
  locationId?: number | null;
  metadata?: Record<string, unknown> | null;
  /** Seed/back-fill only: explicit timestamp. Live actions always use server time. */
  createdAt?: string;
}

function computeHash(prev: string | null, fields: unknown[]): string {
  return sha256(JSON.stringify([prev, ...fields]));
}

/**
 * Append an audit record. Call inside the same transaction as the change it
 * describes so the record and the change commit (or roll back) together.
 */
export function writeAudit(db: DB, actor: Actor | null, entry: AuditEntry, ip: string | null = null, orgId?: number): void {
  const prev = (db.prepare('SELECT hash FROM audit_events ORDER BY id DESC LIMIT 1').get() as { hash: string } | undefined)
    ?.hash ?? null;
  const createdAt = entry.createdAt ?? clock.nowIso();
  const metadata = entry.metadata ? JSON.stringify(scrubMetadata(entry.metadata)) : null;
  const fields = [
    actor?.orgId ?? orgId ?? null,
    entry.locationId ?? null,
    actor?.userId ?? null,
    actor?.username ?? 'anonymous',
    actor?.role ?? null,
    entry.action,
    entry.entityType ?? null,
    entry.entityId != null ? String(entry.entityId) : null,
    entry.entityRef ?? null,
    entry.outcome ?? 'SUCCESS',
    metadata,
    ip,
    createdAt,
  ];
  db.prepare(
    `INSERT INTO audit_events (organization_id, location_id, actor_user_id, actor_username, actor_role, action,
       entity_type, entity_id, entity_ref, outcome, metadata, ip, created_at, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(...fields, prev, computeHash(prev, fields));
}

export function audit(ctx: Ctx, entry: AuditEntry): void {
  writeAudit(ctx.db, ctx.actor, entry, ctx.ip);
}

export function verifyAuditChain(db: DB): { ok: boolean; checked: number; brokenAtId: number | null } {
  const rows = db
    .prepare(
      `SELECT id, organization_id, location_id, actor_user_id, actor_username, actor_role, action, entity_type, entity_id,
              entity_ref, outcome, metadata, ip, created_at, prev_hash, hash FROM audit_events ORDER BY id`,
    )
    .iterate() as IterableIterator<Record<string, unknown>>;
  let prev: string | null = null;
  let checked = 0;
  for (const r of rows) {
    const fields = [
      r.organization_id,
      r.location_id,
      r.actor_user_id,
      r.actor_username,
      r.actor_role,
      r.action,
      r.entity_type,
      r.entity_id,
      r.entity_ref,
      r.outcome,
      r.metadata,
      r.ip,
      r.created_at,
    ];
    if (r.prev_hash !== prev || computeHash(prev, fields) !== r.hash) {
      return { ok: false, checked, brokenAtId: r.id as number };
    }
    prev = r.hash as string;
    checked += 1;
  }
  return { ok: true, checked, brokenAtId: null };
}
