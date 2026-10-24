import type { Ctx } from '../auth/context.js';
import { requirePerm } from '../auth/context.js';
import { clock } from '../clock.js';
import { notFound } from '../lib/errors.js';
import { makeAccessToken } from '../lib/crypto.js';
import { localDate } from '../lib/time.js';
import { loadGate } from './verification.js';

interface Sample {
  mode: 'PERSONNEL' | 'VISITOR' | 'CONTRACTOR' | 'TEMPORARY' | 'VEHICLE' | 'DELIVERY';
  method: 'QR' | 'MOCK_READER' | 'REFERENCE' | 'PLATE';
  label: string;
  expected: string;
  input: string;
}

/**
 * Demo-only "simulated scanner" samples, derived live from the database so
 * they stay meaningful as the demo progresses. Disabled outside demo mode.
 */
export function demoSamples(ctx: Ctx, gateId: number): Sample[] {
  if (ctx.config.mode !== 'demo') throw notFound('Endpoint');
  requirePerm(ctx.actor, 'gate.operate');
  const gate = loadGate(ctx, gateId);
  const db = ctx.db;
  const secret = ctx.config.tokenSecret;
  const now = clock.nowIso();
  const today = localDate(clock.now(), ctx.config.timezone);
  const out: Sample[] = [];
  const add = (s: Sample | null) => s && out.push(s);
  const one = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as T | undefined;

  // Visitor passes
  const validPass = one<{ nonce: string; name: string }>(
    `SELECT vp.token_nonce AS nonce, vr.full_name AS name FROM visit_passes vp JOIN visits v ON v.id = vp.visit_id JOIN visitors vr ON vr.id = v.visitor_id
     WHERE v.location_id = ? AND v.status = 'APPROVED' AND vp.status = 'ACTIVE' AND vp.valid_from <= ? AND vp.valid_until > ? ORDER BY v.expected_arrival LIMIT 1`,
    gate.location_id, now, now,
  );
  if (validPass) add({ mode: 'VISITOR', method: 'QR', label: `Visitor pass — ${validPass.name}`, expected: 'Verified', input: makeAccessToken('VISIT_PASS', validPass.nonce, secret) });
  const insidePass = one<{ nonce: string; name: string }>(
    `SELECT vp.token_nonce AS nonce, vr.full_name AS name FROM visit_passes vp JOIN visits v ON v.id = vp.visit_id JOIN visitors vr ON vr.id = v.visitor_id
     WHERE v.location_id = ? AND v.status IN ('INSIDE','OVERDUE') AND vp.status = 'ACTIVE' LIMIT 1`,
    gate.location_id,
  );
  if (insidePass) add({ mode: 'VISITOR', method: 'QR', label: `Visitor inside (exit) — ${insidePass.name}`, expected: 'Verified (exit)', input: makeAccessToken('VISIT_PASS', insidePass.nonce, secret) });
  const cancelled = one<{ nonce: string }>(
    `SELECT vp.token_nonce AS nonce FROM visit_passes vp JOIN visits v ON v.id = vp.visit_id WHERE v.location_id = ? AND vp.status = 'REVOKED' LIMIT 1`,
    gate.location_id,
  );
  if (cancelled) add({ mode: 'VISITOR', method: 'QR', label: 'Cancelled visitor pass', expected: 'Cancelled Pass', input: makeAccessToken('VISIT_PASS', cancelled.nonce, secret) });
  const expired = one<{ nonce: string }>(
    `SELECT vp.token_nonce AS nonce FROM visit_passes vp JOIN visits v ON v.id = vp.visit_id WHERE v.location_id = ? AND (vp.status = 'EXPIRED' OR v.status = 'EXPIRED') LIMIT 1`,
    gate.location_id,
  );
  if (expired) add({ mode: 'VISITOR', method: 'QR', label: 'Expired visitor pass', expected: 'Expired Pass', input: makeAccessToken('VISIT_PASS', expired.nonce, secret) });
  const used = one<{ nonce: string }>(
    `SELECT vp.token_nonce AS nonce FROM visit_passes vp JOIN visits v ON v.id = vp.visit_id WHERE v.location_id = ? AND vp.status = 'USED' LIMIT 1`,
    gate.location_id,
  );
  if (used) add({ mode: 'VISITOR', method: 'QR', label: 'Single-use pass already used', expected: 'Already Used', input: makeAccessToken('VISIT_PASS', used.nonce, secret) });
  const wrongLoc = one<{ nonce: string; loc: string }>(
    `SELECT vp.token_nonce AS nonce, l.name AS loc FROM visit_passes vp JOIN visits v ON v.id = vp.visit_id JOIN locations l ON l.id = v.location_id
     WHERE v.location_id <> ? AND vp.status = 'ACTIVE' AND v.status = 'APPROVED' LIMIT 1`,
    gate.location_id,
  );
  if (wrongLoc) add({ mode: 'VISITOR', method: 'QR', label: `Pass issued for ${wrongLoc.loc}`, expected: 'Wrong Location', input: makeAccessToken('VISIT_PASS', wrongLoc.nonce, secret) });
  const pending = one<{ reference: string }>(`SELECT reference FROM visits WHERE location_id = ? AND status IN ('EXPECTED','WAITING') AND visit_date = ? LIMIT 1`, gate.location_id, today);
  if (pending) add({ mode: 'VISITOR', method: 'REFERENCE', label: `Visit awaiting authorization (${pending.reference})`, expected: 'Not Approved', input: pending.reference });
  add({ mode: 'VISITOR', method: 'QR', label: 'Forged / tampered QR code', expected: 'Invalid Visitor Pass', input: 'SGV1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB' });

  // Personnel credentials
  const cred = (where: string, label: string, expected: string, ...p: unknown[]) => {
    const row = one<{ n: string; name: string }>(
      `SELECT c.credential_number AS n, TRIM(COALESCE(p.rank || ' ', '') || p.full_name) AS name FROM credentials c JOIN personnel p ON p.id = c.personnel_id
       WHERE ${where} ORDER BY c.id LIMIT 1`,
      ...p,
    );
    if (row) add({ mode: 'PERSONNEL', method: 'MOCK_READER', label: `${label} — ${row.name}`, expected, input: row.n });
  };
  cred(
    `c.status = 'ACTIVE' AND c.is_temporary = 0 AND p.status = 'ACTIVE' AND (p.access_valid_until IS NULL OR p.access_valid_until >= ?)
     AND (p.access_valid_from IS NULL OR p.access_valid_from <= ?) AND EXISTS (SELECT 1 FROM personnel_locations pl WHERE pl.personnel_id = p.id AND pl.location_id = ?)
     AND NOT EXISTS (SELECT 1 FROM presence pr WHERE pr.subject_type = 'PERSONNEL' AND pr.subject_id = p.id AND pr.state = 'INSIDE')`,
    'Active card (outside)', 'Verified (entry)', today, today, gate.location_id,
  );
  cred(
    `c.status = 'ACTIVE' AND p.status = 'ACTIVE' AND (p.access_valid_until IS NULL OR p.access_valid_until >= ?)
     AND EXISTS (SELECT 1 FROM presence pr WHERE pr.subject_type = 'PERSONNEL' AND pr.subject_id = p.id AND pr.state = 'INSIDE' AND pr.location_id = ?)
     AND EXISTS (SELECT 1 FROM personnel_locations pl WHERE pl.personnel_id = p.id AND pl.location_id = ?)`,
    'Active card (inside)', 'Verified (exit)', today, gate.location_id, gate.location_id,
  );
  cred("c.status = 'BLOCKED'", 'Blocked card', 'Blocked Credential');
  cred("c.status = 'LOST'", 'Card reported lost', 'Credential Reported Lost');
  cred("c.status = 'ACTIVE' AND p.status = 'INACTIVE'", 'Card of inactive personnel', 'Inactive Personnel');
  cred("c.is_temporary = 1 AND (c.status = 'EXPIRED' OR c.valid_until <= ?)", 'Expired temporary card', 'Expired Credential', now);
  cred("c.status = 'REPLACED'", 'Replaced card', 'Inactive Credential');
  cred(
    `c.status = 'ACTIVE' AND p.status = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM personnel_locations pl WHERE pl.personnel_id = p.id AND pl.location_id = ?)
     AND NOT EXISTS (SELECT 1 FROM presence pr WHERE pr.subject_type = 'PERSONNEL' AND pr.subject_id = p.id AND pr.state = 'INSIDE')`,
    'Card not authorized here', 'Wrong Location', gate.location_id,
  );
  add({ mode: 'PERSONNEL', method: 'MOCK_READER', label: 'Unknown card', expected: 'Invalid Credential', input: 'RF-00000000' });

  // Contractors
  const contractor = (where: string, label: string, expected: string, ...p: unknown[]) => {
    const row = one<{ reference: string; nonce: string; name: string }>(`SELECT reference, access_nonce AS nonce, full_name AS name FROM contractors WHERE ${where} LIMIT 1`, ...p);
    if (row) add({ mode: 'CONTRACTOR', method: 'QR', label: `${label} — ${row.name}`, expected, input: makeAccessToken('CONTRACTOR', row.nonce, secret) });
  };
  contractor("location_id = ? AND status = 'ACTIVE' AND valid_from <= ? AND valid_until >= ? AND window_start = '00:00'", 'Contractor pass (any hours)', 'Verified', gate.location_id, today, today);
  contractor("location_id = ? AND status = 'ACTIVE' AND valid_from <= ? AND valid_until >= ? AND window_start <> '00:00'", 'Contractor pass (permitted hours)', 'Verified or Outside Permitted Hours', gate.location_id, today, today);
  contractor('location_id = ? AND valid_until < ?', 'Expired contractor access', 'Expired Access', gate.location_id, today);
  contractor("status <> 'ACTIVE'", 'Inactive contractor record', 'Inactive Record');

  // Temporary access
  const ta = (where: string, label: string, expected: string, ...p: unknown[]) => {
    const row = one<{ nonce: string; name: string }>(`SELECT access_nonce AS nonce, holder_name AS name FROM temporary_access WHERE ${where} LIMIT 1`, ...p);
    if (row) add({ mode: 'TEMPORARY', method: 'QR', label: `${label} — ${row.name}`, expected, input: makeAccessToken('TEMPORARY_ACCESS', row.nonce, secret) });
  };
  ta("location_id = ? AND status = 'ACTIVE' AND valid_from <= ? AND valid_until > ?", 'Temporary access', 'Verified', gate.location_id, now, now);
  ta("status = 'ACTIVE' AND valid_until <= ?", 'Expired temporary access', 'Expired Access', now);
  ta("status = 'REVOKED'", 'Revoked temporary access', 'Access Revoked');

  // Vehicles
  const veh = (where: string, label: string, expected: string, ...p: unknown[]) => {
    const row = one<{ reg: string }>(`SELECT display_registration AS reg FROM vehicles v WHERE ${where} LIMIT 1`, ...p);
    if (row) add({ mode: 'VEHICLE', method: 'PLATE', label: `${label} — ${row.reg}`, expected, input: row.reg });
  };
  veh(
    "registered_location_id = ? AND authorization_status = 'AUTHORIZED' AND NOT EXISTS (SELECT 1 FROM presence pr WHERE pr.subject_type = 'VEHICLE' AND pr.subject_id = v.id AND pr.state = 'INSIDE')",
    'Authorized vehicle', 'Verified (entry)', gate.location_id,
  );
  veh("EXISTS (SELECT 1 FROM presence pr WHERE pr.subject_type = 'VEHICLE' AND pr.subject_id = v.id AND pr.state = 'INSIDE' AND pr.location_id = ?)", 'Vehicle inside', 'Verified (exit)', gate.location_id);
  veh("authorization_status = 'BLOCKED'", 'Blocked vehicle', 'Blocked Vehicle');
  veh("registered_location_id = ? AND authorization_status = 'PENDING' AND NOT EXISTS (SELECT 1 FROM visits x WHERE x.vehicle_id = v.id)", 'Unauthorized vehicle', 'Manual Review Required', gate.location_id);
  add({ mode: 'VEHICLE', method: 'PLATE', label: 'Unregistered vehicle — DEMO 99 ZZ 0001', expected: 'Vehicle Not Registered', input: 'DEMO 99 ZZ 0001' });

  // Deliveries
  const del = one<{ reference: string; company: string }>("SELECT reference, company FROM deliveries WHERE location_id = ? AND status = 'AUTHORIZED' LIMIT 1", gate.location_id);
  if (del) add({ mode: 'DELIVERY', method: 'REFERENCE', label: `Authorized delivery — ${del.company}`, expected: 'Verified', input: del.reference });

  return out;
}
