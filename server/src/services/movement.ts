import { z } from 'zod';
import type { DB } from '../db/connection.js';
import type { Actor, Ctx } from '../auth/context.js';
import { assertInScope, can, requirePerm, scopeIds, sqlIn } from '../auth/context.js';
import { clock } from '../clock.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors.js';
import { dateRangeToUtc } from '../lib/time.js';
import { likeParam, listQuery, orderBy, parse, zDate, zIso, type Page } from '../lib/http.js';
import { nextRef, REF } from '../lib/refs.js';
import { audit, writeAudit } from './audit.js';
import { raiseAlert } from './alerts.js';
import { notify } from './notifications.js';
import { getSettings } from './settings.js';
import { setVisitStatus, type VisitRow } from './visitStatus.js';
import { baseCategory, subjectLink, subjectNameSql, subjectOrgSql, subjectRefSql } from './subjects.js';
import {
  EVENT_TYPES,
  REGISTER_CATEGORIES,
  SUBJECT_TYPES,
  type EventType,
  type RegisterCategory,
  type SubjectType,
} from '../../../shared/constants.js';

export interface PresenceRow {
  subject_type: SubjectType;
  subject_id: number;
  state: 'INSIDE' | 'OUTSIDE';
  category: RegisterCategory;
  location_id: number | null;
  gate_id: number | null;
  last_event_id: number | null;
  since: string | null;
}

export function getPresence(db: DB, type: SubjectType, id: number): PresenceRow | null {
  return (db.prepare('SELECT * FROM presence WHERE subject_type = ? AND subject_id = ?').get(type, id) as PresenceRow) ?? null;
}

const VALID_EVENT = 'NOT EXISTS (SELECT 1 FROM event_corrections c WHERE c.voided_event_id = e.id)';

/** Presence is derived solely from the latest valid (non-voided) movement event. */
export function recomputePresence(db: DB, orgId: number, type: SubjectType, id: number): PresenceRow | null {
  const last = db
    .prepare(
      `SELECT id, event_type, location_id, gate_id, recorded_at FROM movement_events e
       WHERE subject_type = ? AND subject_id = ? AND ${VALID_EVENT} ORDER BY id DESC LIMIT 1`,
    )
    .get(type, id) as { id: number; event_type: EventType; location_id: number; gate_id: number; recorded_at: string } | undefined;
  if (!last) {
    db.prepare('DELETE FROM presence WHERE subject_type = ? AND subject_id = ?').run(type, id);
    return null;
  }
  db.prepare(
    `INSERT INTO presence (subject_type, subject_id, organization_id, state, category, location_id, gate_id, last_event_id, since, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (subject_type, subject_id) DO UPDATE SET state = excluded.state, category = excluded.category,
       location_id = excluded.location_id, gate_id = excluded.gate_id, last_event_id = excluded.last_event_id,
       since = excluded.since, updated_at = excluded.updated_at`,
  ).run(
    type,
    id,
    orgId,
    last.event_type === 'ENTRY' ? 'INSIDE' : 'OUTSIDE',
    baseCategory(db, type, id),
    last.location_id,
    last.gate_id,
    last.id,
    last.recorded_at,
    clock.nowIso(),
  );
  return getPresence(db, type, id);
}

export interface NewMovementEvent {
  orgId: number;
  locationId: number;
  gateId: number;
  eventType: EventType;
  subjectType: SubjectType;
  subjectId: number;
  category: RegisterCategory;
  verificationMethod: string;
  outcome: 'RECORDED' | 'RECORDED_AFTER_REVIEW' | 'CORRECTION_ENTRY';
  operatorUserId: number | null;
  visitId?: number | null;
  passId?: number | null;
  credentialId?: number | null;
  temporaryAccessId?: number | null;
  contractorId?: number | null;
  deliveryId?: number | null;
  vehicleId?: number | null;
  linkedSubjectType?: string | null;
  linkedSubjectId?: number | null;
  driverReference?: string | null;
  purpose?: string | null;
  sponsoringDepartment?: string | null;
  verificationAttemptId?: number | null;
  manualReviewId?: number | null;
  correctionId?: number | null;
  idempotencyKey?: string | null;
  notes?: string | null;
  reportedOccurredAt?: string | null;
}

/** Low-level append of a movement event + presence refresh. Callers validate first. */
export function insertMovementEvent(db: DB, e: NewMovementEvent): { id: number; reference: string; recordedAt: string } {
  const reference = nextRef(db, e.orgId, REF.EVENT);
  const recordedAt = clock.nowIso();
  const info = db
    .prepare(
      `INSERT INTO movement_events (organization_id, reference, location_id, gate_id, event_type, subject_type, subject_id, category,
         visit_id, pass_id, credential_id, temporary_access_id, contractor_id, delivery_id, vehicle_id, linked_subject_type, linked_subject_id,
         driver_reference, purpose, sponsoring_department, verification_attempt_id, manual_review_id, correction_id, verification_method,
         outcome, operator_user_id, idempotency_key, notes, reported_occurred_at, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      e.orgId,
      reference,
      e.locationId,
      e.gateId,
      e.eventType,
      e.subjectType,
      e.subjectId,
      e.category,
      e.visitId ?? null,
      e.passId ?? null,
      e.credentialId ?? null,
      e.temporaryAccessId ?? null,
      e.contractorId ?? null,
      e.deliveryId ?? null,
      e.vehicleId ?? null,
      e.linkedSubjectType ?? null,
      e.linkedSubjectId ?? null,
      e.driverReference ?? null,
      e.purpose ?? null,
      e.sponsoringDepartment ?? null,
      e.verificationAttemptId ?? null,
      e.manualReviewId ?? null,
      e.correctionId ?? null,
      e.verificationMethod,
      e.outcome,
      e.operatorUserId,
      e.idempotencyKey ?? null,
      e.notes ?? null,
      e.reportedOccurredAt ?? null,
      recordedAt,
    );
  recomputePresence(db, e.orgId, e.subjectType, e.subjectId);
  return { id: Number(info.lastInsertRowid), reference, recordedAt };
}

/**
 * Re-derive a visit's movement status (APPROVED / INSIDE / OVERDUE / EXITED)
 * and pass usage from its valid movement events.
 */
export function syncVisitFromEvents(db: DB, actor: Actor | null, visitId: number, reason: string): void {
  const visit = db.prepare('SELECT * FROM visits WHERE id = ?').get(visitId) as VisitRow | undefined;
  if (!visit) return;
  const events = db
    .prepare(`SELECT id, event_type, recorded_at FROM movement_events e WHERE subject_type = 'VISITOR' AND subject_id = ? AND ${VALID_EVENT} ORDER BY id`)
    .all(visitId) as { id: number; event_type: EventType; recorded_at: string }[];
  const firstEntry = events.find((e) => e.event_type === 'ENTRY')?.recorded_at ?? null;
  const last = events[events.length - 1];
  const lastExit = last?.event_type === 'EXIT' ? last.recorded_at : null;
  const settings = getSettings(db, visit.organization_id);
  let target = visit.status;
  if (!last) {
    if (['INSIDE', 'OVERDUE', 'EXITED'].includes(visit.status)) target = 'APPROVED';
  } else if (last.event_type === 'ENTRY') {
    const overdueAt = new Date(visit.expected_departure).getTime() + settings['visit.overstayGraceMinutes'] * 60_000;
    target = clock.nowMs() > overdueAt ? 'OVERDUE' : 'INSIDE';
    if (visit.status === 'OVERDUE' && target === 'OVERDUE') target = 'OVERDUE';
  } else {
    target = 'EXITED';
  }
  // OVERDUE is only reachable from INSIDE; step through INSIDE when needed.
  if (target === 'OVERDUE' && !['INSIDE', 'OVERDUE'].includes(visit.status)) {
    setVisitStatus(db, actor, visit, 'INSIDE', reason);
  }
  setVisitStatus(db, actor, visit, target, reason, { entered_at: firstEntry, exited_at: lastExit });

  const pass = db
    .prepare("SELECT * FROM visit_passes WHERE visit_id = ? AND status IN ('ACTIVE', 'USED') ORDER BY id DESC LIMIT 1")
    .get(visitId) as { id: number; status: string; single_use: number } | undefined;
  if (pass) {
    const passStatus = target === 'EXITED' && pass.single_use === 1 ? 'USED' : 'ACTIVE';
    if (passStatus === 'ACTIVE' && pass.status === 'USED') {
      // Only revert a used pass when no other pass is active for this visit.
      const other = db.prepare("SELECT 1 FROM visit_passes WHERE visit_id = ? AND status = 'ACTIVE' AND id <> ?").get(visitId, pass.id);
      if (other) return;
    }
    db.prepare('UPDATE visit_passes SET status = ?, entry_used_at = ?, exit_used_at = ? WHERE id = ?').run(
      passStatus,
      firstEntry,
      lastExit,
      pass.id,
    );
  }
}

// ---------------------------------------------------------------------------
// Recording a movement from a verification attempt
// ---------------------------------------------------------------------------

const recordSchema = z.object({
  attemptId: z.coerce.number().int().positive(),
  eventType: z.enum(EVENT_TYPES),
  idempotencyKey: z.string().trim().min(8).max(80).optional(),
  notes: z.string().trim().max(500).optional(),
  driverReference: z.string().trim().max(120).optional(),
  purpose: z.string().trim().max(200).optional(),
  sponsoringDepartment: z.string().trim().max(120).optional(),
  linkedSubjectType: z.enum(SUBJECT_TYPES).optional(),
  linkedSubjectId: z.coerce.number().int().positive().optional(),
});

interface AttemptRow {
  id: number;
  organization_id: number;
  location_id: number;
  gate_id: number;
  operator_user_id: number | null;
  mode: string;
  method: string;
  result_code: string;
  subject_type: SubjectType | null;
  subject_id: number | null;
  category: RegisterCategory | null;
  credential_id: number | null;
  visit_id: number | null;
  pass_id: number | null;
  temporary_access_id: number | null;
  contractor_id: number | null;
  vehicle_id: number | null;
  delivery_id: number | null;
  allowed_actions: string;
  created_at: string;
}

function locationName(db: DB, id: number | null): string {
  if (!id) return 'unknown location';
  return (db.prepare('SELECT name FROM locations WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? 'unknown location';
}

export function eventSummary(db: DB, id: number) {
  return db
    .prepare(
      `SELECT e.id, e.reference, e.event_type AS eventType, e.subject_type AS subjectType, e.subject_id AS subjectId, e.category,
         ${subjectNameSql('e')} AS subjectName, ${subjectRefSql('e')} AS subjectReference,
         e.location_id AS locationId, l.name AS locationName, e.gate_id AS gateId, g.name AS gateName,
         e.verification_method AS verificationMethod, e.outcome, e.recorded_at AS recordedAt, u.display_name AS operatorName,
         e.notes, e.driver_reference AS driverReference, e.purpose, e.reported_occurred_at AS reportedOccurredAt,
         CASE WHEN EXISTS (SELECT 1 FROM event_corrections c WHERE c.voided_event_id = e.id) THEN 1 ELSE 0 END AS voided
       FROM movement_events e
       JOIN locations l ON l.id = e.location_id
       JOIN gates g ON g.id = e.gate_id
       LEFT JOIN users u ON u.id = e.operator_user_id
       WHERE e.id = ?`,
    )
    .get(id) as Record<string, unknown>;
}

export function recordMovement(ctx: Ctx, body: unknown) {
  requirePerm(ctx.actor, 'gate.operate');
  const input = parse(recordSchema, body);
  const { db, actor } = ctx;
  return db.transaction(() => {
    if (input.idempotencyKey) {
      const existing = db.prepare('SELECT id, operator_user_id FROM movement_events WHERE idempotency_key = ?').get(input.idempotencyKey) as
        | { id: number; operator_user_id: number }
        | undefined;
      if (existing) {
        if (existing.operator_user_id !== actor.userId) throw conflict('Idempotency key already used', 'IDEMPOTENCY_CONFLICT');
        return { duplicate: true, event: eventSummary(db, existing.id) };
      }
    }
    const attempt = db.prepare('SELECT * FROM verification_attempts WHERE id = ? AND organization_id = ?').get(input.attemptId, actor.orgId) as
      | AttemptRow
      | undefined;
    if (!attempt || attempt.operator_user_id !== actor.userId) throw notFound('Verification');
    assertInScope(actor, attempt.location_id, 'Verification');

    const already = db.prepare('SELECT id FROM movement_events WHERE verification_attempt_id = ?').get(attempt.id) as { id: number } | undefined;
    if (already) return { duplicate: true, event: eventSummary(db, already.id) };

    if (!attempt.subject_type || !attempt.subject_id) {
      throw unprocessable('This verification did not identify a record, so no movement can be recorded.', 'NO_SUBJECT');
    }
    const settings = getSettings(db, actor.orgId);
    const review = db.prepare('SELECT * FROM manual_reviews WHERE verification_attempt_id = ?').get(attempt.id) as
      | { id: number; status: string; decided_at: string | null; requested_action: EventType; reference: string }
      | undefined;
    let viaReview = false;
    if (review) {
      if (review.status === 'PENDING') throw conflict('A manual review for this verification is still pending.', 'REVIEW_PENDING');
      if (review.status === 'DECLINED') throw forbidden('The manual review for this verification was declined.');
      if (review.status !== 'APPROVED') throw conflict(`Manual review is ${review.status.toLowerCase()}.`, 'REVIEW_STATE');
      const validUntil = new Date(review.decided_at!).getTime() + settings['gate.manualReviewValidityMinutes'] * 60_000;
      if (clock.nowMs() > validUntil) throw unprocessable('The manual review approval has expired. Verify again.', 'REVIEW_EXPIRED');
      if (review.requested_action !== input.eventType) {
        throw unprocessable(`The manual review approved a ${review.requested_action.toLowerCase()} only.`, 'REVIEW_ACTION_MISMATCH');
      }
      viaReview = true;
    } else {
      const allowed = JSON.parse(attempt.allowed_actions) as EventType[];
      if (!allowed.includes(input.eventType)) {
        throw unprocessable(`This verification does not permit recording an ${input.eventType.toLowerCase()}.`, 'ACTION_NOT_PERMITTED');
      }
      const age = clock.nowMs() - new Date(attempt.created_at).getTime();
      if (age > settings['gate.verificationTtlSeconds'] * 1000) {
        throw unprocessable('This verification has expired. Please verify again before recording.', 'VERIFICATION_EXPIRED');
      }
    }

    const subjectType = attempt.subject_type;
    const subjectId = attempt.subject_id;
    const presence = getPresence(db, subjectType, subjectId);
    let discrepancy: string | null = null;

    if (input.eventType === 'ENTRY' && presence?.state === 'INSIDE') {
      const where = locationName(db, presence.location_id);
      if (!viaReview) {
        raiseAlert(db, actor, {
          orgId: actor.orgId,
          locationId: attempt.location_id,
          gateId: attempt.gate_id,
          type: 'INCONSISTENT_EVENT',
          description: `Duplicate entry prevented: subject already recorded inside at ${where} since ${presence.since}.`,
          relatedType: subjectType,
          relatedId: subjectId,
          dedupeKey: `DUP:${subjectType}:${subjectId}:ENTRY:${presence.last_event_id}`,
        });
        throw conflict(`Already recorded inside at ${where}. Duplicate entry was not recorded.`, 'ALREADY_INSIDE');
      }
      discrepancy = `Entry recorded after manual review while previously recorded inside at ${where} (no exit recorded).`;
    }
    if (input.eventType === 'EXIT') {
      if (presence?.state !== 'INSIDE') {
        if (!viaReview) {
          raiseAlert(db, actor, {
            orgId: actor.orgId,
            locationId: attempt.location_id,
            gateId: attempt.gate_id,
            type: 'INCONSISTENT_EVENT',
            description: 'Exit attempted for a subject with no recorded entry.',
            relatedType: subjectType,
            relatedId: subjectId,
            dedupeKey: `DUP:${subjectType}:${subjectId}:EXIT:${presence?.last_event_id ?? 'none'}`,
          });
          throw conflict('No entry is recorded for this person or vehicle, so an exit cannot be recorded.', 'NOT_INSIDE');
        }
        discrepancy = 'Exit recorded after manual review although no entry was recorded.';
      } else if (presence.location_id !== attempt.location_id) {
        if (!viaReview) {
          throw conflict(`Recorded inside at ${locationName(db, presence.location_id)}, not at this location.`, 'INSIDE_ELSEWHERE');
        }
        discrepancy = `Exit recorded after manual review at a different location from the recorded entry (${locationName(db, presence.location_id)}).`;
      }
    }

    // Re-check the authoritative record state inside the transaction.
    if (subjectType === 'VISITOR' && input.eventType === 'ENTRY') {
      const visit = db.prepare('SELECT status FROM visits WHERE id = ?').get(subjectId) as { status: string };
      const pass = attempt.pass_id
        ? (db.prepare('SELECT status FROM visit_passes WHERE id = ?').get(attempt.pass_id) as { status: string } | undefined)
        : undefined;
      if (!['APPROVED', 'EXITED'].includes(visit.status) || (pass && pass.status !== 'ACTIVE')) {
        throw conflict('The visit is no longer approved for entry. Verify the pass again.', 'VISIT_STATE');
      }
    }
    if (subjectType === 'DELIVERY' && input.eventType === 'ENTRY') {
      const d = db.prepare('SELECT status FROM deliveries WHERE id = ?').get(subjectId) as { status: string };
      if (d.status !== 'AUTHORIZED') throw conflict('The delivery is not authorized to proceed.', 'DELIVERY_STATE');
    }

    const event = insertMovementEvent(db, {
      orgId: actor.orgId,
      locationId: attempt.location_id,
      gateId: attempt.gate_id,
      eventType: input.eventType,
      subjectType,
      subjectId,
      category: attempt.category ?? baseCategory(db, subjectType, subjectId),
      verificationMethod: attempt.method,
      outcome: viaReview ? 'RECORDED_AFTER_REVIEW' : 'RECORDED',
      operatorUserId: actor.userId,
      visitId: attempt.visit_id,
      passId: attempt.pass_id,
      credentialId: attempt.credential_id,
      temporaryAccessId: attempt.temporary_access_id,
      contractorId: attempt.contractor_id,
      deliveryId: attempt.delivery_id,
      vehicleId: attempt.vehicle_id,
      linkedSubjectType: input.linkedSubjectType ?? null,
      linkedSubjectId: input.linkedSubjectId ?? null,
      driverReference: input.driverReference ?? null,
      purpose: input.purpose ?? null,
      sponsoringDepartment: input.sponsoringDepartment ?? null,
      verificationAttemptId: attempt.id,
      manualReviewId: review?.id ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      notes: input.notes ?? null,
    });

    if (review) {
      db.prepare("UPDATE manual_reviews SET status = 'USED', event_id = ?, updated_at = ? WHERE id = ?").run(event.id, clock.nowIso(), review.id);
    }

    if (discrepancy) {
      const exRef = nextRef(db, actor.orgId, REF.EXCEPTION);
      db.prepare(
        `INSERT INTO admin_exceptions (organization_id, reference, location_id, category, related_type, related_id, related_reference,
           title, description, responsible_role, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'RECORD_DISCREPANCY', 'event', ?, ?, 'Movement record discrepancy', ?, 'LOCATION_ADMIN', 'OPEN', ?, ?, ?)`,
      ).run(actor.orgId, exRef, attempt.location_id, event.id, event.reference, `${discrepancy} Manual review ${review?.reference}.`, actor.userId, event.recordedAt, event.recordedAt);
    }

    if (subjectType === 'VISITOR') {
      syncVisitFromEvents(db, actor, subjectId, `${input.eventType === 'ENTRY' ? 'Entry' : 'Exit'} recorded (${event.reference})`);
      const visit = db
        .prepare('SELECT v.host_user_id, v.reference, vr.full_name, v.location_id FROM visits v JOIN visitors vr ON vr.id = v.visitor_id WHERE v.id = ?')
        .get(subjectId) as { host_user_id: number; reference: string; full_name: string; location_id: number };
      const gate = db.prepare('SELECT name FROM gates WHERE id = ?').get(attempt.gate_id) as { name: string };
      notify(db, {
        orgId: actor.orgId,
        userIds: [visit.host_user_id],
        locationId: visit.location_id,
        type: input.eventType === 'ENTRY' ? 'VISITOR_ENTERED' : 'VISITOR_EXITED',
        title: input.eventType === 'ENTRY' ? `${visit.full_name} has entered` : `${visit.full_name} has exited`,
        body: `${input.eventType === 'ENTRY' ? 'Entry' : 'Exit'} recorded at ${gate.name} for visit ${visit.reference}.`,
        link: `/visitors/${subjectId}`,
        relatedType: 'visit',
        relatedId: subjectId,
      });
    }

    audit(ctx, {
      action: input.eventType === 'ENTRY' ? 'movement.entry' : 'movement.exit',
      entityType: 'movement_event',
      entityId: event.id,
      entityRef: event.reference,
      locationId: attempt.location_id,
      metadata: {
        subjectType,
        subjectId,
        gateId: attempt.gate_id,
        method: attempt.method,
        viaManualReview: review?.reference ?? null,
        discrepancy: discrepancy ? true : undefined,
      },
    });
    return { duplicate: false, event: eventSummary(db, event.id), presence: getPresence(db, subjectType, subjectId) };
  })();
}

// ---------------------------------------------------------------------------
// Authorized corrections (never rewrite history)
// ---------------------------------------------------------------------------

const voidSchema = z.object({ reason: z.string().trim().min(5, 'Explain the correction (min 5 characters)').max(1000) });

function syncSideEffects(db: DB, actor: Actor, subjectType: SubjectType, subjectId: number, reason: string) {
  if (subjectType === 'VISITOR') syncVisitFromEvents(db, actor, subjectId, reason);
}

export function voidEvent(ctx: Ctx, eventId: number, body: unknown) {
  requirePerm(ctx.actor, 'events.correct');
  const { reason } = parse(voidSchema, body);
  const { db, actor } = ctx;
  return db.transaction(() => {
    const ev = db.prepare('SELECT * FROM movement_events WHERE id = ? AND organization_id = ?').get(eventId, actor.orgId) as
      | { id: number; reference: string; location_id: number; subject_type: SubjectType; subject_id: number }
      | undefined;
    if (!ev) throw notFound('Event');
    assertInScope(actor, ev.location_id, 'Event');
    if (db.prepare('SELECT 1 FROM event_corrections WHERE voided_event_id = ?').get(eventId)) {
      throw conflict('This event has already been voided.', 'ALREADY_VOIDED');
    }
    const ref = nextRef(db, actor.orgId, REF.CORRECTION);
    const info = db
      .prepare(
        `INSERT INTO event_corrections (organization_id, reference, location_id, correction_type, voided_event_id, subject_type, subject_id, reason, requested_by, created_at)
         VALUES (?, ?, ?, 'VOID_EVENT', ?, ?, ?, ?, ?, ?)`,
      )
      .run(actor.orgId, ref, ev.location_id, ev.id, ev.subject_type, ev.subject_id, reason, actor.userId, clock.nowIso());
    recomputePresence(db, actor.orgId, ev.subject_type, ev.subject_id);
    syncSideEffects(db, actor, ev.subject_type, ev.subject_id, `Correction ${ref}: event ${ev.reference} voided`);
    audit(ctx, {
      action: 'movement.correction.void',
      entityType: 'movement_event',
      entityId: ev.id,
      entityRef: ev.reference,
      locationId: ev.location_id,
      metadata: { correction: ref, reason },
    });
    return { correctionId: Number(info.lastInsertRowid), reference: ref, event: eventSummary(db, ev.id) };
  })();
}

const missingSchema = z.object({
  subjectType: z.enum(SUBJECT_TYPES),
  subjectId: z.coerce.number().int().positive(),
  eventType: z.enum(EVENT_TYPES),
  gateId: z.coerce.number().int().positive(),
  reportedOccurredAt: zIso,
  reason: z.string().trim().min(5, 'Explain the correction (min 5 characters)').max(1000),
});

/** Add a missing movement (e.g. an unrecorded exit) as a clearly marked correction entry. */
export function recordMissingEvent(ctx: Ctx, body: unknown) {
  requirePerm(ctx.actor, 'events.correct');
  const input = parse(missingSchema, body);
  const { db, actor } = ctx;
  return db.transaction(() => {
    const gate = db
      .prepare('SELECT g.id, g.location_id FROM gates g JOIN locations l ON l.id = g.location_id WHERE g.id = ? AND l.organization_id = ?')
      .get(input.gateId, actor.orgId) as { id: number; location_id: number } | undefined;
    if (!gate) throw notFound('Gate');
    assertInScope(actor, gate.location_id, 'Gate');
    if (new Date(input.reportedOccurredAt).getTime() > clock.nowMs()) throw badRequest('The reported time cannot be in the future.');
    assertSubjectExists(db, actor.orgId, input.subjectType, input.subjectId);
    const presence = getPresence(db, input.subjectType, input.subjectId);
    if (input.eventType === 'EXIT' && presence?.state !== 'INSIDE') throw conflict('Subject is not recorded inside; a missing exit cannot be added.', 'NOT_INSIDE');
    if (input.eventType === 'ENTRY' && presence?.state === 'INSIDE') throw conflict('Subject is already recorded inside.', 'ALREADY_INSIDE');
    const ref = nextRef(db, actor.orgId, REF.CORRECTION);
    const now = clock.nowIso();
    const corr = db
      .prepare(
        `INSERT INTO event_corrections (organization_id, reference, location_id, correction_type, subject_type, subject_id, reason, requested_by, created_at)
         VALUES (?, ?, ?, 'RECORD_MISSING_EVENT', ?, ?, ?, ?, ?)`,
      )
      .run(actor.orgId, ref, gate.location_id, input.subjectType, input.subjectId, input.reason, actor.userId, now);
    const visitId = input.subjectType === 'VISITOR' ? input.subjectId : null;
    const event = insertMovementEvent(db, {
      orgId: actor.orgId,
      locationId: gate.location_id,
      gateId: gate.id,
      eventType: input.eventType,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      category: baseCategory(db, input.subjectType, input.subjectId),
      verificationMethod: 'ADMIN_CORRECTION',
      outcome: 'CORRECTION_ENTRY',
      operatorUserId: actor.userId,
      visitId,
      correctionId: Number(corr.lastInsertRowid),
      notes: input.reason,
      reportedOccurredAt: input.reportedOccurredAt,
    });
    syncSideEffects(db, actor, input.subjectType, input.subjectId, `Correction ${ref}: missing ${input.eventType.toLowerCase()} recorded`);
    audit(ctx, {
      action: 'movement.correction.add',
      entityType: 'movement_event',
      entityId: event.id,
      entityRef: event.reference,
      locationId: gate.location_id,
      metadata: { correction: ref, subjectType: input.subjectType, subjectId: input.subjectId, eventType: input.eventType, reportedOccurredAt: input.reportedOccurredAt },
    });
    return { reference: ref, event: eventSummary(db, event.id) };
  })();
}

export function assertSubjectExists(db: DB, orgId: number, type: SubjectType, id: number): void {
  const table: Record<SubjectType, string> = {
    PERSONNEL: 'personnel',
    VISITOR: 'visits',
    CONTRACTOR: 'contractors',
    TEMPORARY: 'temporary_access',
    DELIVERY: 'deliveries',
    VEHICLE: 'vehicles',
  };
  const row = db.prepare(`SELECT 1 FROM ${table[type]} WHERE id = ? AND organization_id = ?`).get(id, orgId);
  if (!row) throw notFound('Subject');
}

// ---------------------------------------------------------------------------
// Unified gate register & event history
// ---------------------------------------------------------------------------

export const registerQuery = listQuery.extend({
  category: z.enum(REGISTER_CATEGORIES).optional(),
  subjectType: z.enum(SUBJECT_TYPES).optional(),
  subjectId: z.coerce.number().int().positive().optional(),
  eventType: z.enum(EVENT_TYPES).optional(),
  gateId: z.coerce.number().int().positive().optional(),
  outcome: z.enum(['RECORDED', 'RECORDED_AFTER_REVIEW', 'CORRECTION_ENTRY', 'VOIDED']).optional(),
  from: zDate.optional(),
  to: zDate.optional(),
  operatorId: z.coerce.number().int().positive().optional(),
});

export function buildRegisterWhere(ctx: Ctx, q: z.infer<typeof registerQuery>) {
  const scope = sqlIn('e.location_id', scopeIds(ctx.actor, q.locationId));
  const where = [scope.sql, 'e.organization_id = ?'];
  const params: unknown[] = [...scope.params, ctx.actor.orgId];
  if (q.category) {
    if (q.category === 'TEMPORARY') where.push("(e.category = 'TEMPORARY' OR e.temporary_access_id IS NOT NULL)");
    else {
      where.push('e.category = ?');
      params.push(q.category);
    }
  }
  if (q.subjectType) {
    where.push('e.subject_type = ?');
    params.push(q.subjectType);
  }
  if (q.subjectId) {
    where.push('e.subject_id = ?');
    params.push(q.subjectId);
  }
  if (q.eventType) {
    where.push('e.event_type = ?');
    params.push(q.eventType);
  }
  if (q.gateId) {
    where.push('e.gate_id = ?');
    params.push(q.gateId);
  }
  if (q.operatorId) {
    where.push('e.operator_user_id = ?');
    params.push(q.operatorId);
  }
  if (q.outcome === 'VOIDED') where.push('EXISTS (SELECT 1 FROM event_corrections c WHERE c.voided_event_id = e.id)');
  else if (q.outcome) {
    where.push('e.outcome = ?');
    params.push(q.outcome);
  }
  if (q.from || q.to) {
    const tz = ctx.config.timezone;
    const [start, end] = dateRangeToUtc(q.from ?? '2000-01-01', q.to ?? '2999-12-31', tz);
    where.push('e.recorded_at >= ? AND e.recorded_at < ?');
    params.push(start, end);
  }
  if (q.q) {
    const like = likeParam(q.q);
    where.push(
      `(e.reference LIKE ? ESCAPE '\\' OR (${subjectNameSql('e')}) LIKE ? ESCAPE '\\' OR (${subjectRefSql('e')}) LIKE ? ESCAPE '\\' OR e.driver_reference LIKE ? ESCAPE '\\')`,
    );
    params.push(like, like, like, like);
  }
  return { whereSql: where.join(' AND '), params };
}

export const REGISTER_SELECT = `SELECT e.id, e.reference, e.event_type AS eventType, e.subject_type AS subjectType, e.subject_id AS subjectId,
    e.category, ${subjectNameSql('e')} AS subjectName, ${subjectRefSql('e')} AS subjectReference, ${subjectOrgSql('e')} AS subjectOrganization,
    e.location_id AS locationId, l.name AS locationName, e.gate_id AS gateId, g.name AS gateName,
    e.verification_method AS verificationMethod, e.outcome, e.recorded_at AS recordedAt, u.display_name AS operatorName,
    e.temporary_access_id AS temporaryAccessId, e.driver_reference AS driverReference, e.notes,
    e.reported_occurred_at AS reportedOccurredAt,
    CASE WHEN EXISTS (SELECT 1 FROM event_corrections c WHERE c.voided_event_id = e.id) THEN 1 ELSE 0 END AS voided
  FROM movement_events e
  JOIN locations l ON l.id = e.location_id
  JOIN gates g ON g.id = e.gate_id
  LEFT JOIN users u ON u.id = e.operator_user_id`;

export function listRegister(ctx: Ctx, raw: unknown): Page<Record<string, unknown>> {
  requirePerm(ctx.actor, 'events.view');
  const q = parse(registerQuery, raw);
  const { whereSql, params } = buildRegisterWhere(ctx, q);
  const order = orderBy(q.sort, q.dir, { recordedAt: 'e.recorded_at', category: 'e.category', gate: 'g.name', eventType: 'e.event_type' }, 'e.recorded_at DESC');
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM movement_events e WHERE ${whereSql}`).get(...params) as { n: number }).n;
  const items = (ctx.db
    .prepare(`${REGISTER_SELECT} WHERE ${whereSql} ORDER BY ${order}, e.id DESC LIMIT ? OFFSET ?`)
    .all(...params, q.pageSize, (q.page - 1) * q.pageSize) as Record<string, any>[]).map((r) => ({
    ...r,
    link: subjectLink(r.subjectType, r.subjectId),
  }));
  return { items, total, page: q.page, pageSize: q.pageSize };
}

export function getEvent(ctx: Ctx, id: number) {
  requirePerm(ctx.actor, 'events.view');
  const ev = ctx.db.prepare(`${REGISTER_SELECT} WHERE e.id = ? AND e.organization_id = ?`).get(id, ctx.actor.orgId) as
    | Record<string, any>
    | undefined;
  if (!ev) throw notFound('Event');
  assertInScope(ctx.actor, ev.locationId, 'Event');
  const corrections = ctx.db
    .prepare(
      `SELECT c.reference, c.correction_type AS type, c.reason, c.created_at AS createdAt, u.display_name AS requestedBy
       FROM event_corrections c JOIN users u ON u.id = c.requested_by
       WHERE c.voided_event_id = ? OR c.id = (SELECT correction_id FROM movement_events WHERE id = ?)`,
    )
    .all(id, id);
  const attempt = ctx.db
    .prepare(
      `SELECT va.input_display AS inputDisplay, va.result_code AS resultCode, va.method, va.created_at AS createdAt
       FROM verification_attempts va JOIN movement_events e ON e.verification_attempt_id = va.id WHERE e.id = ?`,
    )
    .get(id);
  const review = ctx.db
    .prepare(
      `SELECT mr.reference, mr.request_note AS requestNote, mr.decision_note AS decisionNote, mr.decided_at AS decidedAt, u.display_name AS decidedBy
       FROM manual_reviews mr JOIN movement_events e ON e.manual_review_id = mr.id LEFT JOIN users u ON u.id = mr.decided_by WHERE e.id = ?`,
    )
    .get(id);
  return { ...ev, link: subjectLink(ev.subjectType, ev.subjectId), corrections, attempt: attempt ?? null, manualReview: review ?? null, canCorrect: can(ctx.actor, 'events.correct') };
}

// ---------------------------------------------------------------------------
// Who is inside?
// ---------------------------------------------------------------------------

const presenceQuery = listQuery.extend({
  category: z.enum(REGISTER_CATEGORIES).optional(),
  gateId: z.coerce.number().int().positive().optional(),
  state: z.enum(['INSIDE', 'OUTSIDE']).default('INSIDE'),
});

export function listPresence(ctx: Ctx, raw: unknown): Page<Record<string, unknown>> {
  requirePerm(ctx.actor, 'presence.view');
  const q = parse(presenceQuery, raw);
  const ids = scopeIds(ctx.actor, q.locationId);
  if (q.state === 'OUTSIDE') {
    if (q.category && q.category !== 'PERSONNEL') throw badRequest('Outside status is tracked for personnel only');
    return listPersonnelOutside(ctx, ids, q);
  }
  const scope = sqlIn('pr.location_id', ids);
  const where = [scope.sql, "pr.state = 'INSIDE'", 'pr.organization_id = ?'];
  const params: unknown[] = [...scope.params, ctx.actor.orgId];
  if (q.category) {
    where.push('pr.category = ?');
    params.push(q.category);
  }
  if (q.gateId) {
    where.push('pr.gate_id = ?');
    params.push(q.gateId);
  }
  if (q.q) {
    const like = likeParam(q.q);
    where.push(`((${subjectNameSql('pr')}) LIKE ? ESCAPE '\\' OR (${subjectRefSql('pr')}) LIKE ? ESCAPE '\\')`);
    params.push(like, like);
  }
  const whereSql = where.join(' AND ');
  const order = orderBy(q.sort, q.dir, { since: 'pr.since', name: 'subjectName', category: 'pr.category' }, 'pr.since DESC');
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM presence pr WHERE ${whereSql}`).get(...params) as { n: number }).n;
  const items = (ctx.db
    .prepare(
      `SELECT pr.subject_type AS subjectType, pr.subject_id AS subjectId, pr.category, pr.state, pr.since,
              ${subjectNameSql('pr')} AS subjectName, ${subjectRefSql('pr')} AS subjectReference, ${subjectOrgSql('pr')} AS subjectOrganization,
              pr.location_id AS locationId, l.name AS locationName, pr.gate_id AS gateId, g.name AS gateName,
              e.reference AS lastEventReference,
              CASE WHEN pr.subject_type = 'VISITOR' THEN (SELECT expected_departure FROM visits WHERE id = pr.subject_id) END AS expectedDeparture,
              CASE WHEN pr.subject_type = 'VISITOR' THEN (SELECT status FROM visits WHERE id = pr.subject_id) END AS visitStatus
       FROM presence pr
       JOIN locations l ON l.id = pr.location_id
       LEFT JOIN gates g ON g.id = pr.gate_id
       LEFT JOIN movement_events e ON e.id = pr.last_event_id
       WHERE ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
    )
    .all(...params, q.pageSize, (q.page - 1) * q.pageSize) as Record<string, any>[]).map((r) => ({ ...r, link: subjectLink(r.subjectType, r.subjectId) }));
  return { items, total, page: q.page, pageSize: q.pageSize };
}

function listPersonnelOutside(ctx: Ctx, ids: number[], q: z.infer<typeof presenceQuery>): Page<Record<string, unknown>> {
  const scope = sqlIn('p.primary_location_id', ids);
  const where = [
    scope.sql,
    "p.status = 'ACTIVE'",
    'p.organization_id = ?',
    "NOT EXISTS (SELECT 1 FROM presence pr WHERE pr.subject_type = 'PERSONNEL' AND pr.subject_id = p.id AND pr.state = 'INSIDE')",
  ];
  const params: unknown[] = [...scope.params, ctx.actor.orgId];
  if (q.q) {
    const like = likeParam(q.q);
    where.push("(p.full_name LIKE ? ESCAPE '\\' OR p.service_number LIKE ? ESCAPE '\\')");
    params.push(like, like);
  }
  const whereSql = where.join(' AND ');
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM personnel p WHERE ${whereSql}`).get(...params) as { n: number }).n;
  const items = (ctx.db
    .prepare(
      `SELECT 'PERSONNEL' AS subjectType, p.id AS subjectId, 'PERSONNEL' AS category, 'OUTSIDE' AS state,
              TRIM(COALESCE(p.rank || ' ', '') || p.full_name) AS subjectName, p.service_number AS subjectReference, p.unit AS subjectOrganization,
              p.primary_location_id AS locationId, l.name AS locationName,
              pr.since AS since, pr.gate_id AS gateId, g.name AS gateName,
              CASE WHEN pr.subject_id IS NULL THEN 'No movement recorded' ELSE 'Exit recorded' END AS note
       FROM personnel p
       JOIN locations l ON l.id = p.primary_location_id
       LEFT JOIN presence pr ON pr.subject_type = 'PERSONNEL' AND pr.subject_id = p.id
       LEFT JOIN gates g ON g.id = pr.gate_id
       WHERE ${whereSql} ORDER BY pr.since IS NULL, pr.since DESC, p.full_name LIMIT ? OFFSET ?`,
    )
    .all(...params, q.pageSize, (q.page - 1) * q.pageSize) as Record<string, any>[]).map((r) => ({ ...r, link: `/personnel/${r.subjectId}` }));
  return { items, total, page: q.page, pageSize: q.pageSize };
}

/** Movement history for one subject (used by detail pages). */
export function subjectHistory(ctx: Ctx, type: SubjectType, id: number, limit = 50) {
  return (ctx.db
    .prepare(`${REGISTER_SELECT} WHERE e.subject_type = ? AND e.subject_id = ? AND e.organization_id = ? ORDER BY e.id DESC LIMIT ?`)
    .all(type, id, ctx.actor.orgId, limit) as Record<string, any>[]).filter((r) => ctx.actor.locationIds.includes(r.locationId));
}

export { writeAudit };
