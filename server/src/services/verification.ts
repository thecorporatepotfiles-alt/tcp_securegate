import { z } from 'zod';
import type { DB } from '../db/connection.js';
import type { Ctx } from '../auth/context.js';
import { assertInScope, can, requirePerm, scopeIds, sqlIn } from '../auth/context.js';
import { clock } from '../clock.js';
import { conflict, forbidden, notFound, unprocessable } from '../lib/errors.js';
import { looksLikeAccessToken, parseAccessToken, sha256 } from '../lib/crypto.js';
import { maskIdentifier } from '../lib/sanitize.js';
import { localDate, localTime, zonedParts } from '../lib/time.js';
import { listQuery, parse, type Page } from '../lib/http.js';
import { nextRef, REF } from '../lib/refs.js';
import { audit } from './audit.js';
import { raiseAlert } from './alerts.js';
import { notify, usersWithPermissionAt } from './notifications.js';
import { getSettings } from './settings.js';
import { getPresence } from './movement.js';
import { subjectNameSql } from './subjects.js';
import {
  CONTRACTOR_CATEGORY_LABEL,
  EVENT_TYPES,
  GATE_MODES,
  MANUAL_REVIEW_STATUSES,
  RESULT_INFO,
  normalizePlate,
  type AlertType,
  type EventType,
  type GateMode,
  type RegisterCategory,
  type ResultCode,
  type SubjectType,
} from '../../../shared/constants.js';

export interface GateRow {
  id: number;
  location_id: number;
  code: string;
  name: string;
  gate_type: string;
  is_active: number;
  location_name: string;
}

export function loadGate(ctx: Ctx, gateId: number): GateRow {
  const gate = ctx.db
    .prepare(
      `SELECT g.*, l.name AS location_name FROM gates g JOIN locations l ON l.id = g.location_id
       WHERE g.id = ? AND l.organization_id = ?`,
    )
    .get(gateId, ctx.actor.orgId) as GateRow | undefined;
  if (!gate) throw notFound('Gate');
  assertInScope(ctx.actor, gate.location_id, 'Gate');
  if (gate.is_active !== 1) throw unprocessable('This gate is inactive.', 'GATE_INACTIVE');
  return gate;
}

interface DetailLine {
  label: string;
  value: string;
}

interface Resolution {
  result: ResultCode;
  message: string;
  subjectType?: SubjectType;
  subjectId?: number;
  category?: RegisterCategory;
  display?: { name: string; reference: string; subtitle?: string; lines: DetailLine[] };
  credentialId?: number | null;
  visitId?: number | null;
  passId?: number | null;
  temporaryAccessId?: number | null;
  contractorId?: number | null;
  vehicleId?: number | null;
  deliveryId?: number | null;
  /** True when the record itself is currently inside here and may still exit despite a validity failure. */
  exitOnlyEligible?: boolean;
}

/** Failures that still allow a subject already inside to be recorded leaving. */
const EXIT_PERMITTED_ON: ResultCode[] = [
  'EXPIRED_ACCESS',
  'EXPIRED_CREDENTIAL',
  'EXPIRED_PASS',
  'OUTSIDE_PERMITTED_HOURS',
  'NOT_YET_VALID',
  'INACTIVE_PERSONNEL',
  'INACTIVE_RECORD',
  'INACTIVE_CREDENTIAL',
  'REVOKED_ACCESS',
  'CANCELLED_PASS',
  'MANUAL_REVIEW_REQUIRED',
  // Recorded inside here (e.g. admitted on temporary access or after review): leaving is still recordable.
  'WRONG_LOCATION',
];

const ALERT_FOR_RESULT: Partial<Record<ResultCode, AlertType>> = {
  INVALID_CREDENTIAL: 'INVALID_CREDENTIAL',
  INACTIVE_CREDENTIAL: 'INVALID_CREDENTIAL',
  EXPIRED_CREDENTIAL: 'EXPIRED_CREDENTIAL',
  BLOCKED_CREDENTIAL: 'BLOCKED_CREDENTIAL',
  LOST_CREDENTIAL: 'BLOCKED_CREDENTIAL',
  CANCELLED_PASS: 'CANCELLED_PASS',
  WRONG_LOCATION: 'WRONG_LOCATION',
};

const verifySchema = z.object({
  gateId: z.coerce.number().int().positive(),
  mode: z.enum(GATE_MODES),
  input: z.string().trim().min(1, 'Enter or scan a reference').max(200),
  method: z.enum(['CREDENTIAL', 'MOCK_READER', 'QR', 'REFERENCE', 'PLATE']).optional(),
});

const fmtDate = (iso: string | null, tz: string) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${localDate(d, tz)} ${localTime(d, tz)}`;
};

// ---------------------------------------------------------------------------
// Credential & personnel
// ---------------------------------------------------------------------------

interface CredentialRow {
  id: number;
  credential_number: string;
  credential_type: string;
  holder_type: 'PERSONNEL' | 'CONTRACTOR';
  personnel_id: number | null;
  contractor_id: number | null;
  status: string;
  is_temporary: number;
  valid_from: string;
  valid_until: string | null;
}

function credentialFailure(c: CredentialRow, nowMs: number): { result: ResultCode; message: string } | null {
  switch (c.status) {
    case 'BLOCKED':
      return { result: 'BLOCKED_CREDENTIAL', message: 'This credential has been blocked. Do not admit; follow established procedure.' };
    case 'LOST':
      return { result: 'LOST_CREDENTIAL', message: 'This credential has been reported lost. Do not admit; follow established procedure.' };
    case 'INACTIVE':
    case 'REPLACED':
      return { result: 'INACTIVE_CREDENTIAL', message: `This credential is ${c.status === 'REPLACED' ? 'replaced' : 'inactive'} and no longer valid.` };
    case 'EXPIRED':
      return { result: 'EXPIRED_CREDENTIAL', message: 'This credential has expired.' };
  }
  if (c.valid_until && new Date(c.valid_until).getTime() <= nowMs) {
    return { result: 'EXPIRED_CREDENTIAL', message: `This credential expired on ${c.valid_until.slice(0, 10)}.` };
  }
  if (new Date(c.valid_from).getTime() > nowMs) {
    return { result: 'NOT_YET_VALID', message: 'This credential is not yet valid.' };
  }
  return null;
}

function personnelDisplay(db: DB, personnelId: number, cred: CredentialRow | null) {
  const p = db
    .prepare(
      `SELECT p.*, l.name AS location_name FROM personnel p JOIN locations l ON l.id = p.primary_location_id WHERE p.id = ?`,
    )
    .get(personnelId) as Record<string, any>;
  const lines: DetailLine[] = [
    { label: 'Rank / designation', value: [p.rank, p.designation].filter(Boolean).join(' · ') || '—' },
    { label: 'Unit / department', value: [p.unit, p.department].filter(Boolean).join(' · ') || '—' },
    { label: 'Assigned location', value: p.location_name },
  ];
  if (cred) lines.push({ label: 'Credential', value: `${cred.is_temporary ? 'Temporary · ' : ''}${maskIdentifier(cred.credential_number)}` });
  if (p.access_valid_until) lines.push({ label: 'Access valid until', value: p.access_valid_until });
  return { person: p, display: { name: [p.rank, p.full_name].filter(Boolean).join(' '), reference: p.service_number, subtitle: 'Personnel', lines } };
}

function resolvePersonnel(db: DB, orgId: number, gate: GateRow, input: string, tz: string, credential?: CredentialRow): Resolution {
  const nowMs = clock.nowMs();
  const cred =
    credential ??
    (db.prepare('SELECT * FROM credentials WHERE organization_id = ? AND credential_number = ?').get(orgId, input) as CredentialRow | undefined);
  if (!cred) {
    const person = db.prepare('SELECT id FROM personnel WHERE organization_id = ? AND service_number = ?').get(orgId, input) as { id: number } | undefined;
    if (person) {
      const { display } = personnelDisplay(db, person.id, null);
      return {
        result: 'MANUAL_REVIEW_REQUIRED',
        message: 'No credential presented. Identification by personnel ID alone requires manual review.',
        subjectType: 'PERSONNEL',
        subjectId: person.id,
        category: 'PERSONNEL',
        display,
      };
    }
    return { result: 'INVALID_CREDENTIAL', message: 'Credential not recognised.' };
  }
  if (cred.holder_type === 'CONTRACTOR') return resolveContractorRecord(db, gate, cred.contractor_id!, tz, cred);

  const { person, display } = personnelDisplay(db, cred.personnel_id!, cred);
  const base: Resolution = {
    result: 'VERIFIED',
    message: 'Credential and personnel record are valid for this location.',
    subjectType: 'PERSONNEL',
    subjectId: person.id,
    category: 'PERSONNEL',
    display,
    credentialId: cred.id,
  };
  const credFail = credentialFailure(cred, nowMs);
  if (credFail) return { ...base, ...credFail, exitOnlyEligible: EXIT_PERMITTED_ON.includes(credFail.result) };
  if (person.status !== 'ACTIVE') {
    return { ...base, result: 'INACTIVE_PERSONNEL', message: 'The personnel record is inactive.', exitOnlyEligible: true };
  }
  const today = localDate(clock.now(), tz);
  if (person.access_valid_until && today > person.access_valid_until) {
    return { ...base, result: 'EXPIRED_ACCESS', message: `Access validity ended on ${person.access_valid_until}.`, exitOnlyEligible: true };
  }
  if (person.access_valid_from && today < person.access_valid_from) {
    return { ...base, result: 'NOT_YET_VALID', message: `Access is valid from ${person.access_valid_from}.`, exitOnlyEligible: true };
  }
  const authorized = db.prepare('SELECT 1 FROM personnel_locations WHERE personnel_id = ? AND location_id = ?').get(person.id, gate.location_id);
  if (!authorized) {
    return { ...base, result: 'WRONG_LOCATION', message: `Not authorized for ${gate.location_name}.` };
  }
  return base;
}

// ---------------------------------------------------------------------------
// Contractors, vendors & service personnel
// ---------------------------------------------------------------------------

function resolveContractorRecord(db: DB, gate: GateRow, contractorId: number, tz: string, cred?: CredentialRow): Resolution {
  const c = db
    .prepare(
      `SELECT c.*, cc.name AS company_name, cc.status AS company_status, l.name AS location_name
       FROM contractors c JOIN contractor_companies cc ON cc.id = c.company_id JOIN locations l ON l.id = c.location_id WHERE c.id = ?`,
    )
    .get(contractorId) as Record<string, any>;
  const lines: DetailLine[] = [
    { label: 'Organization', value: c.company_name },
    { label: 'Category', value: CONTRACTOR_CATEGORY_LABEL[c.category as keyof typeof CONTRACTOR_CATEGORY_LABEL] },
    { label: 'Sponsoring department', value: c.sponsoring_department },
    { label: 'Assignment', value: c.purpose },
    { label: 'Authorized location', value: c.location_name },
    { label: 'Validity', value: `${c.valid_from} to ${c.valid_until}` },
    { label: 'Permitted hours', value: `${c.window_start}–${c.window_end} (${daysLabel(c.allowed_days)})` },
  ];
  const base: Resolution = {
    result: 'VERIFIED',
    message: 'Contractor access is valid for this location and time.',
    subjectType: 'CONTRACTOR',
    subjectId: c.id,
    category: c.category,
    display: { name: c.full_name, reference: c.reference, subtitle: CONTRACTOR_CATEGORY_LABEL[c.category as keyof typeof CONTRACTOR_CATEGORY_LABEL], lines },
    contractorId: c.id,
    credentialId: cred?.id ?? null,
  };
  if (cred) {
    const credFail = credentialFailure(cred, clock.nowMs());
    if (credFail) return { ...base, ...credFail, exitOnlyEligible: EXIT_PERMITTED_ON.includes(credFail.result) };
  }
  if (c.status !== 'ACTIVE' || c.company_status !== 'ACTIVE') {
    return {
      ...base,
      result: 'INACTIVE_RECORD',
      message: c.status !== 'ACTIVE' ? `Contractor record is ${String(c.status).toLowerCase()}.` : 'The contractor organization is inactive.',
      exitOnlyEligible: true,
    };
  }
  const now = clock.now();
  const today = localDate(now, tz);
  if (today > c.valid_until) return { ...base, result: 'EXPIRED_ACCESS', message: `Access validity ended on ${c.valid_until}.`, exitOnlyEligible: true };
  if (today < c.valid_from) return { ...base, result: 'NOT_YET_VALID', message: `Access is valid from ${c.valid_from}.`, exitOnlyEligible: true };
  if (c.location_id !== gate.location_id) return { ...base, result: 'WRONG_LOCATION', message: `Authorized for ${c.location_name} only.` };
  const zonedWeekday = zonedParts(now, tz).weekday;
  const time = localTime(now, tz);
  if (c.allowed_days[zonedWeekday] !== '1' || time < c.window_start || time > c.window_end) {
    return {
      ...base,
      result: 'OUTSIDE_PERMITTED_HOURS',
      message: `Permitted ${c.window_start}–${c.window_end} on ${daysLabel(c.allowed_days)}. Current time ${time}.`,
      exitOnlyEligible: true,
    };
  }
  return base;
}

function daysLabel(mask: string): string {
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  if (mask === '1111111') return 'all days';
  if (mask === '1111100') return 'Mon–Fri';
  if (mask === '1111110') return 'Mon–Sat';
  return names.filter((_, i) => mask[i] === '1').join(', ') || 'no days';
}

function resolveContractor(db: DB, orgId: number, gate: GateRow, input: string, tz: string, secret: string): Resolution {
  if (looksLikeAccessToken(input)) {
    const parsed = parseAccessToken(input, secret);
    if (parsed.kind !== 'CONTRACTOR') return { result: 'INVALID_PASS', message: 'The scanned code is not a valid contractor pass.' };
    const row = db.prepare('SELECT id FROM contractors WHERE organization_id = ? AND access_nonce = ?').get(orgId, parsed.nonce) as { id: number } | undefined;
    if (!row) return { result: 'INVALID_PASS', message: 'The scanned contractor pass is not recognised.' };
    return resolveContractorRecord(db, gate, row.id, tz);
  }
  const upper = input.toUpperCase();
  const byRef = db.prepare('SELECT id FROM contractors WHERE organization_id = ? AND reference = ?').get(orgId, upper) as { id: number } | undefined;
  if (byRef) return resolveContractorRecord(db, gate, byRef.id, tz);
  const cred = db.prepare('SELECT * FROM credentials WHERE organization_id = ? AND credential_number = ?').get(orgId, input) as CredentialRow | undefined;
  if (cred?.holder_type === 'CONTRACTOR') return resolveContractorRecord(db, gate, cred.contractor_id!, tz, cred);
  if (cred?.holder_type === 'PERSONNEL') return resolvePersonnel(db, orgId, gate, input, tz, cred);
  return { result: 'INVALID_CREDENTIAL', message: 'No contractor record or credential matches this reference.' };
}

// ---------------------------------------------------------------------------
// Visitor passes
// ---------------------------------------------------------------------------

function resolveVisitor(db: DB, orgId: number, gate: GateRow, input: string, tz: string, secret: string, isToken: boolean): Resolution {
  let visitId: number | null = null;
  let scannedPass: { id: number; status: string } | null = null;
  if (isToken) {
    const parsed = parseAccessToken(input, secret);
    if (parsed.kind !== 'VISIT_PASS') return { result: 'INVALID_PASS', message: 'The scanned code is not a valid visitor pass.' };
    const pass = db
      .prepare('SELECT vp.id, vp.status, vp.visit_id FROM visit_passes vp JOIN visits v ON v.id = vp.visit_id WHERE vp.token_nonce = ? AND v.organization_id = ?')
      .get(parsed.nonce, orgId) as { id: number; status: string; visit_id: number } | undefined;
    if (!pass) return { result: 'INVALID_PASS', message: 'The scanned visitor pass is not recognised.' };
    visitId = pass.visit_id;
    scannedPass = pass;
  } else {
    const upper = input.toUpperCase();
    const v =
      (db.prepare('SELECT id FROM visits WHERE organization_id = ? AND reference = ?').get(orgId, upper) as { id: number } | undefined) ??
      (db
        .prepare('SELECT v.id FROM visit_passes vp JOIN visits v ON v.id = vp.visit_id WHERE v.organization_id = ? AND vp.pass_number = ?')
        .get(orgId, upper) as { id: number } | undefined);
    if (!v) return { result: 'INVALID_PASS', message: 'No visit found for this reference.' };
    visitId = v.id;
  }
  const v = db
    .prepare(
      `SELECT v.*, vr.full_name AS visitor_name, vr.company, h.display_name AS host_name, l.name AS location_name,
              ve.display_registration AS vehicle_registration
       FROM visits v JOIN visitors vr ON vr.id = v.visitor_id JOIN users h ON h.id = v.host_user_id
       JOIN locations l ON l.id = v.location_id LEFT JOIN vehicles ve ON ve.id = v.vehicle_id WHERE v.id = ?`,
    )
    .get(visitId) as Record<string, any>;
  const activePass = db.prepare("SELECT * FROM visit_passes WHERE visit_id = ? AND status IN ('ACTIVE','USED') ORDER BY id DESC LIMIT 1").get(visitId) as
    | Record<string, any>
    | undefined;
  const pass = scannedPass ? (db.prepare('SELECT * FROM visit_passes WHERE id = ?').get(scannedPass.id) as Record<string, any>) : activePass;
  const lines: DetailLine[] = [
    { label: 'Organization', value: v.company || '—' },
    { label: 'Host', value: v.host_name },
    { label: 'Destination', value: v.destination },
    { label: 'Purpose', value: v.purpose },
    { label: 'Approved location', value: v.location_name },
    { label: 'Valid', value: pass ? `${fmtDate(pass.valid_from, tz)} → ${fmtDate(pass.valid_until, tz)}` : 'No pass issued' },
  ];
  if (v.vehicle_registration) lines.push({ label: 'Vehicle', value: v.vehicle_registration });
  const base: Resolution = {
    result: 'VERIFIED',
    message: 'Visitor pass is valid. Confirm the visitor matches the pass details.',
    subjectType: 'VISITOR',
    subjectId: v.id,
    category: 'VISITOR',
    display: { name: v.visitor_name, reference: v.reference, subtitle: 'Visitor', lines },
    visitId: v.id,
    passId: pass?.id ?? null,
  };
  if (v.location_id !== gate.location_id) return { ...base, result: 'WRONG_LOCATION', message: `This pass is for ${v.location_name}, not ${gate.location_name}.` };
  if (v.status === 'INSIDE' || v.status === 'OVERDUE') {
    return { ...base, message: v.status === 'OVERDUE' ? 'Visitor is overdue. Record exit.' : 'Visitor is recorded inside. Record exit.' };
  }
  if (scannedPass && activePass && scannedPass.id !== activePass.id) {
    return { ...base, result: 'CANCELLED_PASS', message: 'This pass has been superseded by a newer pass.' };
  }
  switch (v.status) {
    case 'CANCELLED':
      return { ...base, result: 'CANCELLED_PASS', message: 'This visit has been cancelled.' };
    case 'REJECTED':
      return { ...base, result: 'NOT_APPROVED', message: 'This visit request was rejected.' };
    case 'EXPIRED':
      return { ...base, result: 'EXPIRED_PASS', message: 'This visit has expired.' };
    case 'EXPECTED':
    case 'ARRIVED':
    case 'HOST_NOTIFIED':
    case 'WAITING':
      return { ...base, result: 'NOT_APPROVED', message: 'This visit is awaiting authorization. Entry is not permitted yet.' };
  }
  if (!pass) {
    return {
      ...base,
      result: 'NOT_APPROVED',
      message: v.requires_security_check && !v.security_checked_at ? 'Security verification step pending; no pass issued yet.' : 'No pass has been issued.',
    };
  }
  if (pass.status === 'REVOKED') return { ...base, result: 'CANCELLED_PASS', message: 'This pass has been cancelled.' };
  if (pass.status === 'EXPIRED') return { ...base, result: 'EXPIRED_PASS', message: 'This pass has expired.' };
  if (v.status === 'EXITED' || pass.status === 'USED') {
    if (pass.single_use === 1 || pass.status === 'USED') return { ...base, result: 'ALREADY_USED', message: 'This single-use pass has already been used for entry and exit.' };
  }
  const now = clock.nowMs();
  if (now < new Date(pass.valid_from).getTime()) return { ...base, result: 'NOT_YET_VALID', message: `Pass valid from ${fmtDate(pass.valid_from, tz)}.` };
  if (now > new Date(pass.valid_until).getTime()) return { ...base, result: 'EXPIRED_PASS', message: `Pass expired at ${fmtDate(pass.valid_until, tz)}.` };
  return base;
}

// ---------------------------------------------------------------------------
// Temporary access
// ---------------------------------------------------------------------------

function resolveTemporary(db: DB, orgId: number, gate: GateRow, input: string, tz: string, secret: string): Resolution {
  let row: Record<string, any> | undefined;
  if (looksLikeAccessToken(input)) {
    const parsed = parseAccessToken(input, secret);
    if (parsed.kind !== 'TEMPORARY_ACCESS') return { result: 'INVALID_PASS', message: 'The scanned code is not a valid temporary access pass.' };
    row = db.prepare('SELECT * FROM temporary_access WHERE organization_id = ? AND access_nonce = ?').get(orgId, parsed.nonce) as Record<string, any>;
    if (!row) return { result: 'INVALID_PASS', message: 'The scanned temporary access pass is not recognised.' };
  } else {
    row = db.prepare('SELECT * FROM temporary_access WHERE organization_id = ? AND reference = ?').get(orgId, input.toUpperCase()) as Record<string, any>;
    if (!row) return { result: 'NOT_FOUND', message: 'No temporary access record matches this reference.' };
  }
  const loc = db.prepare('SELECT name FROM locations WHERE id = ?').get(row.location_id) as { name: string };
  const lines: DetailLine[] = [
    { label: 'Holder type', value: row.holder_type === 'INDIVIDUAL' ? 'Individual' : row.holder_type === 'PERSONNEL' ? 'Personnel' : 'Contractor' },
    { label: 'Organization', value: row.holder_organization || '—' },
    { label: 'Reason', value: row.reason },
    { label: 'Location', value: loc.name },
    { label: 'Valid', value: `${fmtDate(row.valid_from, tz)} → ${fmtDate(row.valid_until, tz)}` },
  ];
  let subjectType: SubjectType = 'TEMPORARY';
  let subjectId = row.id as number;
  if (row.holder_type === 'PERSONNEL') {
    subjectType = 'PERSONNEL';
    subjectId = row.personnel_id;
  } else if (row.holder_type === 'CONTRACTOR') {
    subjectType = 'CONTRACTOR';
    subjectId = row.contractor_id;
  }
  const base: Resolution = {
    result: 'VERIFIED',
    message: 'Temporary access is valid for this location and time.',
    subjectType,
    subjectId,
    category: 'TEMPORARY',
    display: { name: row.holder_name, reference: row.reference, subtitle: 'Temporary access', lines },
    temporaryAccessId: row.id,
    contractorId: row.contractor_id ?? null,
  };
  const now = clock.nowMs();
  if (row.status === 'REVOKED') return { ...base, result: 'REVOKED_ACCESS', message: 'This temporary access has been revoked.', exitOnlyEligible: true };
  if (now > new Date(row.valid_until).getTime()) return { ...base, result: 'EXPIRED_ACCESS', message: `Temporary access expired at ${fmtDate(row.valid_until, tz)}.`, exitOnlyEligible: true };
  if (now < new Date(row.valid_from).getTime()) return { ...base, result: 'NOT_YET_VALID', message: `Valid from ${fmtDate(row.valid_from, tz)}.`, exitOnlyEligible: true };
  if (row.location_id !== gate.location_id) return { ...base, result: 'WRONG_LOCATION', message: `Valid for ${loc.name} only.` };
  if (row.holder_type === 'PERSONNEL') {
    const p = db.prepare('SELECT status FROM personnel WHERE id = ?').get(row.personnel_id) as { status: string };
    if (p.status !== 'ACTIVE') return { ...base, result: 'INACTIVE_PERSONNEL', message: 'The personnel record is inactive.', exitOnlyEligible: true };
  }
  if (row.holder_type === 'CONTRACTOR') {
    const c = db.prepare('SELECT status FROM contractors WHERE id = ?').get(row.contractor_id) as { status: string };
    if (c.status !== 'ACTIVE') return { ...base, result: 'INACTIVE_RECORD', message: 'The contractor record is inactive.', exitOnlyEligible: true };
  }
  return base;
}

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------

function resolveVehicle(db: DB, orgId: number, gate: GateRow, input: string, tz: string): Resolution {
  const plate = normalizePlate(input);
  if (plate.length < 4) return { result: 'NOT_FOUND', message: 'Enter a complete registration number.' };
  const v = db
    .prepare(
      `SELECT v.*, l.name AS location_name FROM vehicles v JOIN locations l ON l.id = v.registered_location_id
       WHERE v.organization_id = ? AND v.registration_number = ?`,
    )
    .get(orgId, plate) as Record<string, any> | undefined;
  if (!v) return { result: 'UNREGISTERED_VEHICLE', message: 'This vehicle is not in the register. Register it before recording movement.' };
  const ownerName =
    v.owner_type === 'PERSONNEL'
      ? (db.prepare('SELECT TRIM(COALESCE(rank || \' \', \'\') || full_name) AS n FROM personnel WHERE id = ?').get(v.personnel_id) as { n: string } | undefined)?.n
      : v.owner_type === 'CONTRACTOR'
        ? (db.prepare('SELECT full_name AS n FROM contractors WHERE id = ?').get(v.contractor_id) as { n: string } | undefined)?.n
        : v.owner_name;
  const lines: DetailLine[] = [
    { label: 'Category', value: v.category },
    { label: 'Make / model', value: [v.make_model, v.colour].filter(Boolean).join(' · ') || '—' },
    { label: 'Owner / association', value: `${v.owner_type.charAt(0)}${v.owner_type.slice(1).toLowerCase()}${ownerName ? ` · ${ownerName}` : ''}` },
    { label: 'Registered at', value: v.location_name },
    { label: 'Authorization', value: v.authorization_status.replace('_', ' ') + (v.authorized_until ? ` (until ${v.authorized_until})` : '') },
  ];
  const base: Resolution = {
    result: 'VERIFIED',
    message: 'Vehicle is authorized for this location. Vehicle movement does not record occupants.',
    subjectType: 'VEHICLE',
    subjectId: v.id,
    category: 'VEHICLE',
    display: { name: v.display_registration, reference: v.make_model ?? v.category, subtitle: 'Vehicle', lines },
    vehicleId: v.id,
  };
  const presence = getPresence(db, 'VEHICLE', v.id);
  if (presence?.state === 'INSIDE' && presence.location_id === gate.location_id) {
    return { ...base, message: 'Vehicle is recorded inside. Record exit. Occupants are recorded separately.' };
  }
  if (v.authorization_status === 'BLOCKED') return { ...base, result: 'BLOCKED_VEHICLE', message: 'This vehicle is blocked. Do not admit; follow established procedure.' };
  const today = localDate(clock.now(), tz);
  const visit = db
    .prepare(
      `SELECT reference FROM visits WHERE vehicle_id = ? AND location_id = ? AND status IN ('APPROVED','INSIDE','OVERDUE') AND visit_date = ? LIMIT 1`,
    )
    .get(v.id, gate.location_id, today) as { reference: string } | undefined;
  if (visit) return { ...base, message: `Vehicle linked to approved visit ${visit.reference}.` };
  const delivery = db
    .prepare(
      `SELECT reference, status FROM deliveries WHERE vehicle_id = ? AND location_id = ? AND status IN ('ARRIVED','AWAITING_AUTHORIZATION','AUTHORIZED','RECEIVED') ORDER BY id DESC LIMIT 1`,
    )
    .get(v.id, gate.location_id) as { reference: string; status: string } | undefined;
  if (delivery) {
    if (delivery.status === 'AUTHORIZED' || delivery.status === 'RECEIVED') return { ...base, message: `Vehicle linked to authorized delivery ${delivery.reference}.`, deliveryId: null };
    return { ...base, result: 'MANUAL_REVIEW_REQUIRED', message: `Linked delivery ${delivery.reference} is awaiting authorization.` };
  }
  if (v.authorization_status === 'AUTHORIZED') {
    if (v.authorized_until && today > v.authorized_until) return { ...base, result: 'EXPIRED_ACCESS', message: `Vehicle authorization ended on ${v.authorized_until}.` };
    const allowedHere =
      v.registered_location_id === gate.location_id ||
      db.prepare('SELECT 1 FROM vehicle_locations WHERE vehicle_id = ? AND location_id = ?').get(v.id, gate.location_id);
    if (!allowedHere) return { ...base, result: 'WRONG_LOCATION', message: `Vehicle is not authorized for ${gate.location_name}.` };
    return base;
  }
  return { ...base, result: 'MANUAL_REVIEW_REQUIRED', message: 'Vehicle is registered but not authorized for entry. Refer for manual review.' };
}

// ---------------------------------------------------------------------------
// Deliveries (delivery personnel movement)
// ---------------------------------------------------------------------------

function resolveDelivery(db: DB, orgId: number, gate: GateRow, input: string): Resolution {
  const d = db
    .prepare(
      `SELECT d.*, l.name AS location_name FROM deliveries d JOIN locations l ON l.id = d.location_id WHERE d.organization_id = ? AND d.reference = ?`,
    )
    .get(orgId, input.toUpperCase()) as Record<string, any> | undefined;
  if (!d) return { result: 'NOT_FOUND', message: 'No delivery matches this reference.' };
  const base: Resolution = {
    result: 'VERIFIED',
    message: 'Delivery is authorized to proceed under applicable procedures.',
    subjectType: 'DELIVERY',
    subjectId: d.id,
    category: 'DELIVERY',
    display: {
      name: d.courier_name,
      reference: d.reference,
      subtitle: 'Delivery personnel',
      lines: [
        { label: 'Company', value: d.company },
        { label: 'Recipient', value: `${d.recipient_name ?? '—'} · ${d.recipient_department}` },
        { label: 'Items', value: `${d.item_count} · ${d.description}` },
        { label: 'Status', value: d.status.replace(/_/g, ' ') },
      ],
    },
    deliveryId: d.id,
  };
  if (d.location_id !== gate.location_id) return { ...base, result: 'WRONG_LOCATION', message: `This delivery is registered for ${d.location_name}.` };
  const presence = getPresence(db, 'DELIVERY', d.id);
  if (presence?.state === 'INSIDE') return { ...base, message: 'Delivery person is recorded inside. Record exit.' };
  if (d.status === 'AUTHORIZED') return base;
  if (['ARRIVED', 'AWAITING_AUTHORIZATION', 'EXPECTED'].includes(d.status)) {
    return { ...base, result: 'NOT_APPROVED', message: 'Delivery is awaiting authorization.' };
  }
  return { ...base, result: 'ALREADY_USED', message: `Delivery is ${d.status.toLowerCase().replace(/_/g, ' ')}; no further entry.` };
}

// ---------------------------------------------------------------------------
// Public: verify
// ---------------------------------------------------------------------------

export function verify(ctx: Ctx, body: unknown) {
  requirePerm(ctx.actor, 'gate.operate');
  const input = parse(verifySchema, body);
  const { db, actor, config } = ctx;
  const gate = loadGate(ctx, input.gateId);
  const tz = config.timezone;
  const raw = input.input.trim();
  const isToken = looksLikeAccessToken(raw);
  const method = input.method ?? (isToken ? 'QR' : input.mode === 'VEHICLE' ? 'PLATE' : input.mode === 'PERSONNEL' ? 'CREDENTIAL' : 'REFERENCE');

  return db.transaction(() => {
    let r: Resolution;
    switch (input.mode) {
      case 'PERSONNEL':
        r = isToken ? resolveTemporary(db, actor.orgId, gate, raw, tz, config.tokenSecret) : resolvePersonnel(db, actor.orgId, gate, raw, tz);
        break;
      case 'VISITOR':
        r = resolveVisitor(db, actor.orgId, gate, raw, tz, config.tokenSecret, isToken);
        break;
      case 'CONTRACTOR':
        r = resolveContractor(db, actor.orgId, gate, raw, tz, config.tokenSecret);
        break;
      case 'TEMPORARY':
        r = resolveTemporary(db, actor.orgId, gate, raw, tz, config.tokenSecret);
        break;
      case 'VEHICLE':
        r = resolveVehicle(db, actor.orgId, gate, raw, tz);
        break;
      case 'DELIVERY':
        r = resolveDelivery(db, actor.orgId, gate, raw);
        break;
    }

    // Presence-aware outcome: what movement may be recorded next.
    let allowed: EventType[] = [];
    let presence = r.subjectType && r.subjectId ? getPresence(db, r.subjectType, r.subjectId) : null;
    const insideHere = presence?.state === 'INSIDE' && presence.location_id === gate.location_id;
    const insideElsewhere = presence?.state === 'INSIDE' && presence.location_id !== gate.location_id;
    if (r.result === 'VERIFIED') {
      if (insideHere) allowed = ['EXIT'];
      else if (insideElsewhere) {
        const where = (db.prepare('SELECT name FROM locations WHERE id = ?').get(presence!.location_id) as { name: string }).name;
        r = { ...r, result: 'MANUAL_REVIEW_REQUIRED', message: `Recorded inside at ${where} with no exit recorded. Manual review required.` };
      } else allowed = ['ENTRY'];
    } else if (insideHere && (r.exitOnlyEligible || EXIT_PERMITTED_ON.includes(r.result))) {
      allowed = ['EXIT'];
      r = { ...r, message: `${r.message} Exit may still be recorded; entry is not permitted.` };
    }

    const settings = getSettings(db, actor.orgId);
    const reviewEligible = r.result !== 'VERIFIED' && !!r.subjectType && settings['gate.manualReviewEligible'].includes(r.result);
    const fingerprint = sha256(`${input.mode}:${isToken ? raw : raw.toUpperCase()}`);
    const now = clock.nowIso();
    const info = db
      .prepare(
        `INSERT INTO verification_attempts (organization_id, location_id, gate_id, operator_user_id, mode, method, input_fingerprint, input_display,
           result_code, subject_type, subject_id, category, credential_id, visit_id, pass_id, temporary_access_id, contractor_id, vehicle_id,
           delivery_id, presence_state, allowed_actions, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        actor.orgId,
        gate.location_id,
        gate.id,
        actor.userId,
        input.mode,
        method,
        fingerprint,
        input.mode === 'VEHICLE' ? normalizePlate(raw) : maskIdentifier(raw),
        r.result,
        r.subjectType ?? null,
        r.subjectId ?? null,
        r.category ?? null,
        r.credentialId ?? null,
        r.visitId ?? null,
        r.passId ?? null,
        r.temporaryAccessId ?? null,
        r.contractorId ?? null,
        r.vehicleId ?? null,
        r.deliveryId ?? null,
        presence?.state ?? null,
        JSON.stringify(allowed),
        r.message,
        now,
      );
    const attemptId = Number(info.lastInsertRowid);

    if (r.result !== 'VERIFIED') raiseVerificationAlerts(ctx, gate, attemptId, r, method, fingerprint, isToken);

    audit(ctx, {
      action: 'gate.verify',
      entityType: 'verification_attempt',
      entityId: attemptId,
      locationId: gate.location_id,
      outcome: r.result === 'VERIFIED' ? 'SUCCESS' : 'FAILURE',
      metadata: { mode: input.mode, method, result: r.result, gate: gate.code, subjectType: r.subjectType ?? null, subjectId: r.subjectId ?? null },
    });

    if (r.subjectType === 'VISITOR' && r.result === 'VERIFIED' && allowed.includes('ENTRY')) {
      const visit = db.prepare('SELECT host_user_id, reference FROM visits WHERE id = ?').get(r.subjectId) as { host_user_id: number; reference: string };
      notify(db, {
        orgId: actor.orgId,
        userIds: [visit.host_user_id],
        locationId: gate.location_id,
        type: 'VISITOR_AT_GATE',
        title: `Visitor at ${gate.name}`,
        body: `${r.display?.name} has presented pass ${visit.reference} at ${gate.name}.`,
        link: `/visitors/${r.subjectId}`,
        relatedType: 'visit',
        relatedId: r.subjectId,
      });
    }

    if (presence && presence.location_id) {
      const names = db
        .prepare('SELECT l.name AS locationName, g.name AS gateName FROM locations l LEFT JOIN gates g ON g.id = ? WHERE l.id = ?')
        .get(presence.gate_id, presence.location_id) as { locationName: string; gateName: string | null };
      presence = { ...presence, ...names } as typeof presence;
    }
    const ttl = settings['gate.verificationTtlSeconds'];
    return {
      attemptId,
      mode: input.mode,
      method,
      result: r.result,
      label: RESULT_INFO[r.result].label,
      tone: RESULT_INFO[r.result].tone,
      message: r.message,
      subject: r.subjectType
        ? { type: r.subjectType, id: r.subjectId, category: r.category, ...r.display }
        : null,
      presence: presence
        ? { state: presence.state, since: presence.since, locationName: (presence as any).locationName, gateName: (presence as any).gateName }
        : { state: 'NONE' },
      allowedActions: allowed,
      manualReviewEligible: reviewEligible,
      expiresAt: new Date(Date.parse(now) + ttl * 1000).toISOString(),
      gate: { id: gate.id, name: gate.name, locationName: gate.location_name },
      simulated: true,
    };
  })();
}

function raiseVerificationAlerts(
  ctx: Ctx,
  gate: GateRow,
  attemptId: number,
  r: Resolution,
  method: string,
  fingerprint: string,
  isToken: boolean,
) {
  const { db, actor } = ctx;
  const today = localDate(clock.now(), ctx.config.timezone);
  let type = ALERT_FOR_RESULT[r.result];
  if (r.result === 'INVALID_PASS' && (isToken || method === 'QR')) type = 'INVALID_QR';
  if (type) {
    raiseAlert(db, actor, {
      orgId: actor.orgId,
      locationId: gate.location_id,
      gateId: gate.id,
      type,
      description: `${RESULT_INFO[r.result].label} at ${gate.name}: ${r.message}${r.display ? ` (${r.display.name}, ${r.display.reference})` : ''}`,
      relatedType: r.subjectType ?? null,
      relatedId: r.subjectId ?? null,
      relatedReference: r.display?.reference ?? null,
      attemptId,
      dedupeKey: `${type}:${gate.id}:${fingerprint.slice(0, 16)}:${today}`,
    });
  }
  const settings = getSettings(db, actor.orgId);
  const windowStart = new Date(clock.nowMs() - settings['alerts.repeatedFailureWindowMinutes'] * 60_000).toISOString();
  const threshold = settings['alerts.repeatedFailureThreshold'];
  const failuresAtGate = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM verification_attempts WHERE gate_id = ? AND created_at >= ? AND result_code NOT IN ('VERIFIED','MANUAL_REVIEW_REQUIRED','UNREGISTERED_VEHICLE')",
      )
      .get(gate.id, windowStart) as { n: number }
  ).n;
  const failuresForInput = (
    db
      .prepare("SELECT COUNT(*) AS n FROM verification_attempts WHERE input_fingerprint = ? AND created_at >= ? AND result_code <> 'VERIFIED'")
      .get(fingerprint, windowStart) as { n: number }
  ).n;
  if (failuresForInput >= threshold) {
    raiseAlert(db, actor, {
      orgId: actor.orgId,
      locationId: gate.location_id,
      gateId: gate.id,
      type: 'REPEATED_FAILED_VERIFICATION',
      description: `${failuresForInput} failed verifications for the same credential/reference within ${settings['alerts.repeatedFailureWindowMinutes']} minutes (latest at ${gate.name}).`,
      attemptId,
      relatedType: r.subjectType ?? null,
      relatedId: r.subjectId ?? null,
      relatedReference: r.display?.reference ?? null,
      dedupeKey: `REPEATED:input:${fingerprint.slice(0, 16)}`,
    });
  } else if (failuresAtGate >= threshold) {
    raiseAlert(db, actor, {
      orgId: actor.orgId,
      locationId: gate.location_id,
      gateId: gate.id,
      type: 'REPEATED_FAILED_VERIFICATION',
      description: `${failuresAtGate} failed verifications at ${gate.name} within ${settings['alerts.repeatedFailureWindowMinutes']} minutes.`,
      attemptId,
      dedupeKey: `REPEATED:gate:${gate.id}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Manual review
// ---------------------------------------------------------------------------

const reviewRequestSchema = z.object({
  attemptId: z.coerce.number().int().positive(),
  requestedAction: z.enum(EVENT_TYPES),
  note: z.string().trim().min(5, 'Describe why a manual review is requested (min 5 characters)').max(1000),
});

export function requestManualReview(ctx: Ctx, body: unknown) {
  requirePerm(ctx.actor, 'gate.operate');
  const input = parse(reviewRequestSchema, body);
  const { db, actor } = ctx;
  return db.transaction(() => {
    const attempt = db.prepare('SELECT * FROM verification_attempts WHERE id = ? AND organization_id = ?').get(input.attemptId, actor.orgId) as
      | Record<string, any>
      | undefined;
    if (!attempt || attempt.operator_user_id !== actor.userId) throw notFound('Verification');
    assertInScope(actor, attempt.location_id, 'Verification');
    const settings = getSettings(db, actor.orgId);
    if (attempt.result_code === 'VERIFIED') throw unprocessable('Verified records do not need manual review.', 'NOT_ELIGIBLE');
    if (!attempt.subject_type || !settings['gate.manualReviewEligible'].includes(attempt.result_code)) {
      throw unprocessable(`${RESULT_INFO[attempt.result_code as ResultCode].label} cannot be referred for manual review under current rules.`, 'NOT_ELIGIBLE');
    }
    if (db.prepare('SELECT 1 FROM manual_reviews WHERE verification_attempt_id = ?').get(attempt.id)) {
      throw conflict('A manual review has already been requested for this verification.', 'DUPLICATE_REVIEW');
    }
    const reference = nextRef(db, actor.orgId, REF.REVIEW);
    const now = clock.nowIso();
    const info = db
      .prepare(
        `INSERT INTO manual_reviews (organization_id, reference, location_id, gate_id, verification_attempt_id, requested_action, requested_by,
           request_note, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
      )
      .run(actor.orgId, reference, attempt.location_id, attempt.gate_id, attempt.id, input.requestedAction, actor.userId, input.note, now, now);
    const id = Number(info.lastInsertRowid);
    notify(db, {
      orgId: actor.orgId,
      userIds: usersWithPermissionAt(db, actor.orgId, 'gate.manual_review', attempt.location_id).filter((u) => u !== actor.userId),
      locationId: attempt.location_id,
      type: 'MANUAL_REVIEW_REQUESTED',
      title: `Manual review requested (${RESULT_INFO[attempt.result_code as ResultCode].label})`,
      body: `${actor.displayName} requested review of a ${input.requestedAction.toLowerCase()}: ${input.note}`,
      link: `/manual-reviews`,
      relatedType: 'manual_review',
      relatedId: id,
    });
    audit(ctx, {
      action: 'gate.manual_review.request',
      entityType: 'manual_review',
      entityId: id,
      entityRef: reference,
      locationId: attempt.location_id,
      metadata: { result: attempt.result_code, requestedAction: input.requestedAction },
    });
    return getManualReview(ctx, id);
  })();
}

const decideSchema = z.object({
  decision: z.enum(['APPROVED', 'DECLINED']),
  note: z.string().trim().min(5, 'A decision note is required (min 5 characters)').max(1000),
});

export function decideManualReview(ctx: Ctx, id: number, body: unknown) {
  requirePerm(ctx.actor, 'gate.manual_review');
  const input = parse(decideSchema, body);
  const { db, actor } = ctx;
  return db.transaction(() => {
    const review = db.prepare('SELECT * FROM manual_reviews WHERE id = ? AND organization_id = ?').get(id, actor.orgId) as Record<string, any> | undefined;
    if (!review) throw notFound('Manual review');
    assertInScope(actor, review.location_id, 'Manual review');
    if (review.requested_by === actor.userId) throw forbidden('You cannot decide a manual review you requested.');
    if (review.status !== 'PENDING') throw conflict(`This review has already been ${review.status.toLowerCase()}.`, 'REVIEW_STATE');
    const now = clock.nowIso();
    db.prepare('UPDATE manual_reviews SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ? WHERE id = ?').run(
      input.decision,
      actor.userId,
      now,
      input.note,
      now,
      id,
    );
    notify(db, {
      orgId: actor.orgId,
      userIds: [review.requested_by],
      locationId: review.location_id,
      type: 'MANUAL_REVIEW_DECIDED',
      title: `Manual review ${input.decision === 'APPROVED' ? 'approved' : 'declined'} (${review.reference})`,
      body: input.note,
      link: '/gate',
      relatedType: 'manual_review',
      relatedId: id,
    });
    audit(ctx, {
      action: input.decision === 'APPROVED' ? 'gate.manual_review.approve' : 'gate.manual_review.decline',
      entityType: 'manual_review',
      entityId: id,
      entityRef: review.reference,
      locationId: review.location_id,
      metadata: { note: input.note },
    });
    return getManualReview(ctx, id);
  })();
}

const REVIEW_SELECT = `SELECT mr.id, mr.reference, mr.location_id AS locationId, l.name AS locationName, mr.gate_id AS gateId, g.name AS gateName,
    mr.verification_attempt_id AS attemptId, mr.requested_action AS requestedAction, mr.request_note AS requestNote, mr.status,
    mr.requested_by AS requestedById, ru.display_name AS requestedBy, mr.decided_at AS decidedAt, du.display_name AS decidedBy,
    mr.decision_note AS decisionNote, mr.event_id AS eventId, mr.created_at AS createdAt,
    va.result_code AS resultCode, va.mode, va.input_display AS inputDisplay, va.detail AS verificationMessage,
    va.subject_type AS subjectType, va.subject_id AS subjectId, ${subjectNameSql('va')} AS subjectName
  FROM manual_reviews mr
  JOIN verification_attempts va ON va.id = mr.verification_attempt_id
  JOIN locations l ON l.id = mr.location_id
  JOIN gates g ON g.id = mr.gate_id
  JOIN users ru ON ru.id = mr.requested_by
  LEFT JOIN users du ON du.id = mr.decided_by`;

export function getManualReview(ctx: Ctx, id: number) {
  const row = ctx.db.prepare(`${REVIEW_SELECT} WHERE mr.id = ? AND mr.organization_id = ?`).get(id, ctx.actor.orgId) as Record<string, any> | undefined;
  if (!row) throw notFound('Manual review');
  assertInScope(ctx.actor, row.locationId, 'Manual review');
  if (!can(ctx.actor, 'gate.manual_review') && row.requestedById !== ctx.actor.userId) throw notFound('Manual review');
  return row;
}

const reviewListQuery = listQuery.extend({
  status: z.enum(MANUAL_REVIEW_STATUSES).optional(),
  mine: z.coerce.boolean().optional(),
});

export function listManualReviews(ctx: Ctx, raw: unknown): Page<Record<string, unknown>> {
  requirePerm(ctx.actor, 'gate.manual_review', 'gate.operate');
  const q = parse(reviewListQuery, raw);
  const scope = sqlIn('mr.location_id', scopeIds(ctx.actor, q.locationId));
  const where = [scope.sql, 'mr.organization_id = ?'];
  const params: unknown[] = [...scope.params, ctx.actor.orgId];
  if (!can(ctx.actor, 'gate.manual_review') || q.mine) {
    where.push('mr.requested_by = ?');
    params.push(ctx.actor.userId);
  }
  if (q.status) {
    where.push('mr.status = ?');
    params.push(q.status);
  }
  const whereSql = where.join(' AND ');
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM manual_reviews mr WHERE ${whereSql}`).get(...params) as { n: number }).n;
  const items = ctx.db
    .prepare(`${REVIEW_SELECT} WHERE ${whereSql} ORDER BY CASE mr.status WHEN 'PENDING' THEN 0 WHEN 'APPROVED' THEN 1 ELSE 2 END, mr.id DESC LIMIT ? OFFSET ?`)
    .all(...params, q.pageSize, (q.page - 1) * q.pageSize) as Record<string, unknown>[];
  return { items, total, page: q.page, pageSize: q.pageSize };
}
