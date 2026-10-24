/**
 * Synthetic demonstration dataset.
 *
 * Every name, number, plate and organization below is fictional and generated
 * for demonstration only. Nothing here represents real personnel, credentials,
 * vehicles or operational records.
 *
 * Idempotency: the whole seed runs in one transaction and records a marker in
 * app_meta. If the marker — or any personnel data — already exists, it does
 * nothing, so running it repeatedly never creates duplicates.
 */
import type { DB } from '../db/connection.js';
import type { AppConfig } from '../config.js';
import { clock } from '../clock.js';
import { hashPassword, newNonce } from '../lib/crypto.js';
import { addDays, localDate, zonedToUtc } from '../lib/time.js';
import { dropAll, migrate } from '../db/migrate.js';
import { writeAudit } from '../services/audit.js';
import { raiseAlert } from '../services/alerts.js';
import { invalidatePermissionCache } from '../auth/permissions.js';
import { invalidateSettingsCache } from '../services/settings.js';
import { runScheduledChecks } from '../services/scheduler.js';
import { systemActor } from '../auth/context.js';
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, ROLES, ROLE_INFO } from '../../../shared/constants.js';

export const DEMO_PASSWORD = 'SecureGate-Demo-2026';
const SEED_VERSION = '1';

/** Roles and permissions are system data required in every mode. */
export function ensureBaseline(db: DB): void {
  db.transaction(() => {
    const role = db.prepare('INSERT OR IGNORE INTO roles (code, name, description, rank) VALUES (?, ?, ?, ?)');
    for (const r of ROLES) role.run(r, ROLE_INFO[r].name, ROLE_INFO[r].description, ROLE_INFO[r].rank);
    const perm = db.prepare('INSERT OR IGNORE INTO permissions (code, group_name, description) VALUES (?, ?, ?)');
    for (const p of ALL_PERMISSIONS) perm.run(p, PERMISSIONS[p].group, PERMISSIONS[p].description);
    // Default grants are applied once; afterwards role permissions are administrator-managed.
    const seeded = db.prepare("SELECT 1 FROM app_meta WHERE key = 'role_defaults_applied'").get();
    if (!seeded) {
      const rp = db.prepare('INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES (?, ?)');
      for (const r of ROLES) for (const p of DEFAULT_ROLE_PERMISSIONS[r]) rp.run(r, p);
      db.prepare("INSERT INTO app_meta (key, value, updated_at) VALUES ('role_defaults_applied', '1', ?)").run(clock.nowIso());
    }
  })();
  invalidatePermissionCache(db);
}

// ---------------------------------------------------------------------------
// Deterministic pseudo-random generator so the dataset is reproducible
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = [
  'Aarav', 'Vivaan', 'Aditya', 'Arjun', 'Sai', 'Reyansh', 'Krishna', 'Ishaan', 'Rohan', 'Kabir', 'Dev', 'Karan', 'Nikhil', 'Rahul', 'Sameer',
  'Vikram', 'Anil', 'Manoj', 'Rajesh', 'Suresh', 'Imran', 'Farhan', 'Joseph', 'Thomas', 'Harpreet', 'Gurdeep', 'Pranav', 'Siddharth', 'Varun', 'Yash',
  'Ananya', 'Diya', 'Priya', 'Neha', 'Kavya', 'Meera', 'Isha', 'Pooja', 'Sneha', 'Ritu', 'Anjali', 'Sunita', 'Fatima', 'Mary', 'Simran', 'Lakshmi',
  'Deepa', 'Nandini', 'Tanvi', 'Shreya',
];
const LAST = [
  'Sharma', 'Verma', 'Nair', 'Menon', 'Iyer', 'Rao', 'Reddy', 'Patel', 'Shah', 'Mehta', 'Joshi', 'Kulkarni', 'Deshpande', 'Gupta', 'Singh', 'Yadav',
  'Chauhan', 'Thakur', 'Bhat', 'Pillai', 'Das', 'Ghosh', 'Mukherjee', 'Banerjee', 'Khan', 'Qureshi', 'Fernandes', 'DSouza', 'Gill', 'Sandhu', 'Naidu',
  'Hegde', 'Kamath', 'Mishra', 'Pandey', 'Tiwari', 'Saxena', 'Bose', 'Chopra', 'Malhotra',
];
const RANKS = [
  ['Sep', 40],
  ['L/Nk', 18],
  ['Nk', 14],
  ['Hav', 10],
  ['Nb Sub', 5],
  ['Sub', 3],
  ['Lt', 2],
  ['Capt', 3],
  ['Maj', 2],
  ['Lt Col', 1],
  ['', 6], // civilian staff
] as const;
const DEPARTMENTS = ['Administration', 'Logistics', 'Workshop', 'Signals', 'Medical', 'Training', 'Accounts', 'Quartermaster', 'Transport', 'Security'];
const VISITOR_COMPANIES = [
  'Orbit Software Pvt Ltd (Demo)', 'Sunrise Medical Supplies (Demo)', 'Bluewave Consulting (Demo)', 'Civic Training Institute (Demo)', 'Kestrel Engineering (Demo)',
  'Lotus Publications (Demo)', null, null,
];
const PURPOSES = ['Official meeting', 'Equipment demonstration', 'Training session', 'Interview', 'Audit visit', 'Family welfare meeting', 'Maintenance survey', 'Liaison visit'];
const DESTINATIONS = ['Admin Block', 'Conference Room 2', 'Training Hall', 'Medical Inspection Room', 'Workshop Office', 'Quartermaster Stores', 'Signals Centre'];

interface Loc {
  id: number;
  code: string;
  letter: string;
  gates: { id: number; code: string; type: string }[];
}

export function seedDemo(db: DB, config: AppConfig): { seeded: boolean; summary: string } {
  if (config.mode !== 'demo') throw new Error('Demo data can only be seeded in demo mode');
  if (db.prepare("SELECT 1 FROM app_meta WHERE key = 'demo_seed_version'").get()) return { seeded: false, summary: 'already seeded' };
  if (db.prepare('SELECT 1 FROM personnel LIMIT 1').get()) return { seeded: false, summary: 'existing data present' };

  const tz = config.timezone;
  const rand = mulberry32(20261024);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const chance = (p: number) => rand() < p;
  const between = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
  const now = clock.now();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const today = localDate(now, tz);
  const iso = (ms: number) => new Date(ms).toISOString();
  const atLocal = (date: string, hh: number, mm: number) => zonedToUtc(date, `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, tz).getTime();
  const passwordHash = hashPassword(DEMO_PASSWORD);
  const counts: Record<string, number> = {};
  const bump = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n);

  db.transaction(() => {
    // ---- Organization, locations & gates -----------------------------------
    const org = Number(
      db.prepare("INSERT INTO organizations (code, name, created_at) VALUES ('DEMO-EST', 'Demonstration Establishment (Synthetic)', ?)").run(nowIso).lastInsertRowid,
    );
    const locDefs = [
      { code: 'HQ', name: 'Headquarters (Demo)', kind: 'HQ', letter: 'H', gates: [['HQ-G1', 'HQ Main Gate', 'MAIN'], ['HQ-G2', 'HQ Pedestrian Gate', 'PEDESTRIAN']] },
      { code: 'LOC-A', name: 'Location Alpha', kind: 'LOCATION', letter: 'A', gates: [['A1', 'Alpha Main Gate', 'MAIN'], ['A2', 'Alpha Vehicle Gate', 'VEHICLE'], ['A3', 'Alpha Service Gate', 'SERVICE']] },
      { code: 'LOC-B', name: 'Location Bravo', kind: 'LOCATION', letter: 'B', gates: [['B1', 'Bravo Main Gate', 'MAIN'], ['B2', 'Bravo Vehicle Gate', 'VEHICLE']] },
      { code: 'LOC-C', name: 'Location Charlie', kind: 'LOCATION', letter: 'C', gates: [['C1', 'Charlie Main Gate', 'MAIN'], ['C2', 'Charlie Pedestrian Gate', 'PEDESTRIAN']] },
      { code: 'LOC-D', name: 'Location Delta', kind: 'LOCATION', letter: 'D', gates: [['D1', 'Delta Main Gate', 'MAIN'], ['D2', 'Delta Service Gate', 'SERVICE']] },
    ] as const;
    const locs: Loc[] = [];
    for (const l of locDefs) {
      const id = Number(
        db
          .prepare('INSERT INTO locations (organization_id, code, name, kind, address_note, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)')
          .run(org, l.code, l.name, l.kind, 'Synthetic demo location', nowIso, nowIso).lastInsertRowid,
      );
      const gates = l.gates.map(([code, name, type]) => ({
        id: Number(db.prepare('INSERT INTO gates (location_id, code, name, gate_type, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)').run(id, code, name, type, nowIso, nowIso).lastInsertRowid),
        code,
        type,
      }));
      locs.push({ id, code: l.code, letter: l.letter, gates });
    }
    const [HQ, A, B, C, D] = locs;
    const mainGate = (l: Loc) => l.gates.find((g) => g.type === 'MAIN')!.id;
    const vehicleGate = (l: Loc) => (l.gates.find((g) => g.type === 'VEHICLE') ?? l.gates[0]).id;
    const serviceGate = (l: Loc) => (l.gates.find((g) => g.type === 'SERVICE') ?? l.gates[0]).id;
    const pedGates = (l: Loc) => l.gates.filter((g) => g.type === 'MAIN' || g.type === 'PEDESTRIAN').map((g) => g.id);

    // ---- Users ---------------------------------------------------------------
    const users: Record<string, number> = {};
    const addUser = (username: string, name: string, role: (typeof ROLES)[number], designation: string, department: string | null, loc: Loc | null, extraLocs: Loc[] = [], gate?: number) => {
      const id = Number(
        db
          .prepare(
            `INSERT INTO users (organization_id, username, display_name, designation, department, role_code, password_hash, all_locations,
               primary_location_id, assigned_gate_id, is_active, is_demo, password_changed_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`,
          )
          .run(org, username, name, designation, department, role, passwordHash, ROLE_INFO[role].allLocations ? 1 : 0, loc?.id ?? null, gate ?? null, nowIso, nowIso, nowIso).lastInsertRowid,
      );
      for (const l of [loc, ...extraLocs].filter((x): x is Loc => !!x)) db.prepare('INSERT OR IGNORE INTO user_locations (user_id, location_id) VALUES (?, ?)').run(id, l.id);
      users[username] = id;
      bump('users');
      return id;
    };
    addUser('admin', 'Meera Iyer', 'SYSTEM_ADMIN', 'System Administrator', 'IT Cell', HQ);
    addUser('hq.admin', 'Col Vikram Rao', 'HQ_ADMIN', 'HQ Administrator', 'Headquarters', HQ);
    addUser('auditor', 'Anita Kulkarni', 'AUDITOR', 'Internal Auditor', 'Audit Cell', HQ);
    addUser('hq.officer', 'Lt Col Deepa Menon', 'HOST', 'Staff Officer', 'Administration', HQ);
    addUser('hq.guard', 'Hav Gurdeep Gill', 'GUARD', 'Gate NCO', 'Security', HQ, [], mainGate(HQ));
    addUser('alpha.admin', 'Maj Rohan Verma', 'LOCATION_ADMIN', 'Location Administrator', 'Administration', A);
    addUser('alpha.officer', 'Lt Col Arjun Nair', 'HOST', 'Approving Officer', 'Administration', A);
    addUser('alpha.host', 'Capt Neha Sharma', 'HOST', 'Host Officer', 'Signals', A);
    addUser('alpha.guard', 'Hav Suresh Yadav', 'GUARD', 'Gate NCO', 'Security', A, [], mainGate(A));
    addUser('alpha.guard2', 'Nk Imran Khan', 'GUARD', 'Vehicle Gate NCO', 'Security', A, [], vehicleGate(A));
    addUser('bravo.admin', 'Maj Kavita Joshi', 'LOCATION_ADMIN', 'Location Administrator', 'Administration', B);
    addUser('bravo.officer', 'Lt Col Sanjay Gupta', 'HOST', 'Approving Officer', 'Administration', B);
    addUser('bravo.host', 'Capt Rahul Bhat', 'HOST', 'Host Officer', 'Workshop', B);
    addUser('bravo.guard', 'Hav Prakash Singh', 'GUARD', 'Gate NCO', 'Security', B, [], mainGate(B));
    addUser('charlie.admin', 'Maj Farhan Qureshi', 'LOCATION_ADMIN', 'Location Administrator', 'Administration', C);
    addUser('charlie.officer', 'Lt Col Mary Fernandes', 'HOST', 'Approving Officer', 'Medical', C);
    addUser('charlie.guard', 'Nk Joseph Thomas', 'GUARD', 'Gate NCO', 'Security', C, [], mainGate(C));
    addUser('delta.admin', 'Maj Harpreet Sandhu', 'LOCATION_ADMIN', 'Location Administrator', 'Administration', D);
    addUser('delta.officer', 'Lt Col Lakshmi Pillai', 'HOST', 'Approving Officer', 'Training', D);
    addUser('delta.guard', 'Hav Manoj Pandey', 'GUARD', 'Gate NCO', 'Security', D, [], mainGate(D));
    const officerOf: Record<number, number> = {
      [HQ.id]: users['hq.officer'],
      [A.id]: users['alpha.officer'],
      [B.id]: users['bravo.officer'],
      [C.id]: users['charlie.officer'],
      [D.id]: users['delta.officer'],
    };
    const hostOf: Record<number, number> = {
      [HQ.id]: users['hq.officer'],
      [A.id]: users['alpha.host'],
      [B.id]: users['bravo.host'],
      [C.id]: users['charlie.officer'],
      [D.id]: users['delta.officer'],
    };
    const guardOf: Record<number, number> = {
      [HQ.id]: users['hq.guard'],
      [A.id]: users['alpha.guard'],
      [B.id]: users['bravo.guard'],
      [C.id]: users['charlie.guard'],
      [D.id]: users['delta.guard'],
    };
    const adminOf: Record<number, number> = {
      [HQ.id]: users['admin'],
      [A.id]: users['alpha.admin'],
      [B.id]: users['bravo.admin'],
      [C.id]: users['charlie.admin'],
      [D.id]: users['delta.admin'],
    };

    // ---- Reference helpers (sequential, set ref_sequences at end) -----------
    const seq: Record<string, number> = {};
    const year = now.getUTCFullYear();
    const ref = (prefix: string) => {
      seq[prefix] = (seq[prefix] ?? 0) + 1;
      const width = prefix === 'EV' ? 7 : 5;
      return `${prefix}-${year}-${String(seq[prefix]).padStart(width, '0')}`;
    };

    // ---- Personnel & credentials -------------------------------------------
    const total = Math.max(100, Math.min(config.demoPersonnelCount, 15000));
    const share = [0.14, 0.24, 0.22, 0.2, 0.2];
    const usedNames = new Set<string>();
    const usedCreds = new Set<string>();
    const credNumber = (prefix: string) => {
      let n: string;
      do n = `${prefix}-${Math.floor(rand() * 0xffffffff).toString(16).toUpperCase().padStart(8, '0')}`;
      while (usedCreds.has(n));
      usedCreds.add(n);
      return n;
    };
    const insPersonnel = db.prepare(
      `INSERT INTO personnel (organization_id, service_number, full_name, rank, designation, unit, department, primary_location_id, status, status_reason,
         access_valid_from, access_valid_until, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insPL = db.prepare('INSERT OR IGNORE INTO personnel_locations (personnel_id, location_id) VALUES (?, ?)');
    const insCred = db.prepare(
      `INSERT INTO credentials (organization_id, credential_number, credential_type, holder_type, personnel_id, contractor_id, status, is_temporary,
         valid_from, valid_until, status_reason, replaces_id, replaced_by_id, issued_by, issued_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insCredHist = db.prepare(
      'INSERT INTO credential_history (credential_id, action, from_status, to_status, reason, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const rankPool: string[] = RANKS.flatMap(([r, w]) => Array(w).fill(r));
    interface P {
      id: number;
      loc: Loc;
      active: boolean;
      credActive: string | null;
      accessExpired: boolean;
    }
    const people: P[] = [];
    const longAgo = iso(nowMs - 400 * 86_400_000);
    locs.forEach((loc, li) => {
      const n = Math.round(total * share[li]);
      for (let i = 0; i < n; i++) {
        let name: string;
        do name = `${pick(FIRST)} ${pick(LAST)}`;
        while (usedNames.has(name) && usedNames.size < FIRST.length * LAST.length - 10);
        usedNames.add(name);
        const rank = pick(rankPool);
        const civilian = rank === '';
        const serviceNumber = `TCP-${loc.letter}-${String(10001 + i).padStart(5, '0')}`;
        const inactive = chance(0.02);
        const contract = civilian && chance(0.5);
        const accessExpired = contract && chance(0.15);
        const validUntil = contract ? (accessExpired ? addDays(today, -between(3, 30)) : addDays(today, between(30, 300))) : null;
        const dept = pick(DEPARTMENTS);
        const unit = li === 0 ? `HQ ${dept} Branch` : `${['Alpha', 'Bravo', 'Charlie', 'Delta'][li - 1]} ${pick(['Signals Wing', 'Workshop Company', 'Logistics Company', 'Training Wing', 'Admin Company'])}`;
        const id = Number(
          insPersonnel.run(
            org,
            serviceNumber,
            name,
            civilian ? null : rank,
            civilian ? pick(['Clerk', 'Store Keeper', 'Technician', 'Driver', 'Lab Assistant']) : null,
            unit,
            dept,
            loc.id,
            inactive ? 'INACTIVE' : 'ACTIVE',
            inactive ? 'Posted out (synthetic)' : null,
            contract ? addDays(today, -between(60, 400)) : null,
            validUntil,
            users['admin'],
            users['admin'],
            longAgo,
            longAgo,
          ).lastInsertRowid,
        );
        insPL.run(id, loc.id);
        if (li > 0 && chance(0.08)) insPL.run(id, HQ.id);
        if (li > 0 && chance(0.04)) insPL.run(id, locs[1 + ((li) % 4)].id);
        bump('personnel');
        const p: P = { id, loc, active: !inactive, credActive: null, accessExpired };
        // Credentials
        if (chance(0.97)) {
          const type = chance(0.75) ? 'RFID_CARD' : 'NFC_CARD';
          const number = credNumber(type === 'RFID_CARD' ? 'RF' : 'NF');
          const issued = iso(nowMs - between(30, 700) * 86_400_000);
          const cid = Number(insCred.run(org, number, type, 'PERSONNEL', id, null, 'ACTIVE', 0, issued, null, null, null, null, users['admin'], issued, issued).lastInsertRowid);
          insCredHist.run(cid, 'ISSUED', null, 'ACTIVE', 'Initial issue (synthetic)', users['admin'], issued);
          p.credActive = number;
          bump('credentials');
        }
        people.push(p);
      }
    });

    // Special credential states for demonstration
    const withCred = people.filter((p) => p.active && p.credActive && !p.accessExpired);
    const setStatus = (p: P, status: string, reason: string, actor: number) => {
      const c = db.prepare("SELECT id FROM credentials WHERE personnel_id = ? AND status = 'ACTIVE'").get(p.id) as { id: number };
      const at = iso(nowMs - between(1, 20) * 86_400_000);
      db.prepare('UPDATE credentials SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?').run(status, reason, at, c.id);
      insCredHist.run(c.id, status === 'BLOCKED' ? 'BLOCKED' : status === 'LOST' ? 'REPORTED_LOST' : 'DEACTIVATED', 'ACTIVE', status, reason, actor, at);
      writeAudit(db, { ...systemActor(db, org), userId: actor, username: 'seed', role: 'LOCATION_ADMIN' }, { action: status === 'BLOCKED' ? 'credential.block' : 'credential.lost', entityType: 'credential', entityId: c.id, locationId: p.loc.id, metadata: { reason }, createdAt: at });
      p.credActive = null;
    };
    const pickPeople = (loc: Loc, n: number) => {
      const pool = withCred.filter((p) => p.loc.id === loc.id && p.credActive);
      return pool.splice(0, n).map((p) => {
        withCred.splice(withCred.indexOf(p), 1);
        return p;
      });
    };
    for (const loc of [A, B, C, D]) {
      pickPeople(loc, 2).forEach((p) => setStatus(p, 'BLOCKED', 'Blocked pending investigation (synthetic)', adminOf[loc.id]));
      pickPeople(loc, 1).forEach((p) => setStatus(p, 'LOST', 'Reported lost by holder (synthetic)', adminOf[loc.id]));
      // Replaced: old card REPLACED, new card ACTIVE
      pickPeople(loc, 2).forEach((p) => {
        const old = db.prepare("SELECT id, credential_number FROM credentials WHERE personnel_id = ? AND status = 'ACTIVE'").get(p.id) as { id: number; credential_number: string };
        const at = iso(nowMs - between(2, 40) * 86_400_000);
        db.prepare("UPDATE credentials SET status = 'REPLACED', status_reason = 'Card damaged (synthetic)', updated_at = ? WHERE id = ?").run(at, old.id);
        const number = credNumber('RF');
        const nid = Number(insCred.run(org, number, 'RFID_CARD', 'PERSONNEL', p.id, null, 'ACTIVE', 0, at, null, null, old.id, null, adminOf[loc.id], at, at).lastInsertRowid);
        db.prepare('UPDATE credentials SET replaced_by_id = ? WHERE id = ?').run(nid, old.id);
        insCredHist.run(old.id, 'REPLACED', 'ACTIVE', 'REPLACED', 'Card damaged (synthetic)', adminOf[loc.id], at);
        insCredHist.run(nid, 'ISSUED_AS_REPLACEMENT', null, 'ACTIVE', 'Card damaged (synthetic)', adminOf[loc.id], at);
        p.credActive = number;
        withCred.push(p);
        bump('credentials');
      });
      // Temporary credentials: one active, one expired
      pickPeople(loc, 2).forEach((p, i) => {
        const number = credNumber('TC');
        const from = iso(nowMs - (i === 0 ? 2 : 6) * 86_400_000);
        const until = i === 0 ? iso(nowMs + 3 * 86_400_000) : iso(nowMs - 2 * 86_400_000);
        const id = Number(insCred.run(org, number, 'TEMPORARY_CARD', 'PERSONNEL', p.id, null, i === 0 ? 'ACTIVE' : 'EXPIRED', 1, from, until, i === 0 ? null : 'Validity period ended', null, null, adminOf[loc.id], from, from).lastInsertRowid);
        insCredHist.run(id, 'ISSUED', null, 'ACTIVE', 'Temporary card — permanent card left at home (synthetic)', adminOf[loc.id], from);
        if (i === 1) insCredHist.run(id, 'EXPIRED', 'ACTIVE', 'EXPIRED', 'Validity period ended', null, until);
        withCred.push(p);
        bump('credentials');
      });
    }

    // ---- Contractors -----------------------------------------------------------
    const companies = [
      ['Northfield Facility Services (Demo)', 'SERVICE', 'ACTIVE'],
      ['Brightline Electricals (Demo)', 'CONTRACTOR', 'ACTIVE'],
      ['Greenleaf Catering Supplies (Demo)', 'VENDOR', 'ACTIVE'],
      ['Apex Civil Works (Demo)', 'CONTRACTOR', 'ACTIVE'],
      ['Swift Housekeeping (Demo)', 'SERVICE', 'ACTIVE'],
      ['Metro Office Supplies (Demo)', 'VENDOR', 'INACTIVE'],
    ] as const;
    const companyIds = companies.map(([name, cat, status]) =>
      Number(
        db
          .prepare(
            `INSERT INTO contractor_companies (organization_id, name, category, contact_name, contact_phone, contact_email, status, notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(org, name, cat, `${pick(FIRST)} ${pick(LAST)}`, `+91 90000 ${String(between(10000, 99999))}`, `contact@${name.split(' ')[0].toLowerCase()}.example`, status, status === 'INACTIVE' ? 'Contract ended (synthetic)' : null, longAgo, longAgo)
          .lastInsertRowid,
      ),
    );
    interface K {
      id: number;
      loc: Loc;
      category: string;
      ok: boolean;
    }
    const contractorsList: K[] = [];
    const insContractor = db.prepare(
      `INSERT INTO contractors (organization_id, company_id, reference, full_name, category, phone, sponsoring_department, sponsor_user_id, purpose, location_id,
         valid_from, valid_until, window_start, window_end, allowed_days, access_nonce, status, status_reason, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const contractorPurposes: Record<string, string[]> = {
      CONTRACTOR: ['Electrical rewiring — Admin Block', 'Road resurfacing', 'Roof repair — Stores', 'CCTV cabling (civil works)'],
      VENDOR: ['Ration and catering supplies', 'Stationery supply', 'Canteen stock replenishment'],
      SERVICE: ['Housekeeping services', 'Garden maintenance', 'Water purifier servicing', 'Pest control'],
    };
    for (const loc of locs) {
      const n = loc === HQ ? 4 : 7;
      for (let i = 0; i < n; i++) {
        const ci = between(0, companies.length - 2);
        const cat = companies[ci][1];
        const expired = i === n - 1 && loc !== HQ;
        const inactive = i === n - 2 && loc === B;
        const anyHours = i % 3 === 0;
        const reference = ref('CW');
        const id = Number(
          insContractor.run(
            org,
            companyIds[ci],
            reference,
            `${pick(FIRST)} ${pick(LAST)}`,
            cat,
            `+91 98000 ${String(between(10000, 99999))}`,
            pick(DEPARTMENTS),
            hostOf[loc.id],
            pick(contractorPurposes[cat]),
            loc.id,
            addDays(today, -between(20, 120)),
            expired ? addDays(today, -between(1, 10)) : addDays(today, between(15, 180)),
            anyHours ? '00:00' : '07:00',
            anyHours ? '23:59' : '19:00',
            anyHours ? '1111111' : '1111110',
            newNonce(),
            inactive ? 'INACTIVE' : 'ACTIVE',
            inactive ? 'Suspended by sponsor (synthetic)' : null,
            adminOf[loc.id],
            longAgo,
            longAgo,
          ).lastInsertRowid,
        );
        contractorsList.push({ id, loc, category: cat, ok: !expired && !inactive });
        bump('contractors');
        if (i % 2 === 0) {
          const number = credNumber('CT');
          const issued = iso(nowMs - between(10, 90) * 86_400_000);
          const cid = Number(insCred.run(org, number, 'RFID_CARD', 'CONTRACTOR', null, id, 'ACTIVE', 0, issued, null, null, null, null, adminOf[loc.id], issued, issued).lastInsertRowid);
          insCredHist.run(cid, 'ISSUED', null, 'ACTIVE', 'Contractor card (synthetic)', adminOf[loc.id], issued);
          bump('credentials');
        }
      }
    }
    // One cancelled contractor record (Metro Office Supplies — inactive company)
    insContractor.run(org, companyIds[5], ref('CW'), `${pick(FIRST)} ${pick(LAST)}`, 'VENDOR', null, 'Quartermaster', hostOf[A.id], 'Stationery supply', A.id, addDays(today, -200), addDays(today, 30), '09:00', '17:00', '1111100', newNonce(), 'CANCELLED', 'Supplier contract ended (synthetic)', adminOf[A.id], longAgo, longAgo);
    bump('contractors');

    // ---- Vehicles ----------------------------------------------------------------
    const usedPlates = new Set<string>();
    const plate = () => {
      let p: string;
      do p = `DM ${String(between(1, 99)).padStart(2, '0')} ${String.fromCharCode(65 + between(0, 25))}${String.fromCharCode(65 + between(0, 25))} ${between(1000, 9999)}`;
      while (usedPlates.has(p));
      usedPlates.add(p);
      return p;
    };
    const insVehicle = db.prepare(
      `INSERT INTO vehicles (organization_id, registration_number, display_registration, category, make_model, colour, owner_type, personnel_id, contractor_id,
         visitor_id, owner_name, registered_location_id, authorization_status, authorized_until, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const addVehicle = (o: { category: string; make: string; colour: string; ownerType: string; personnelId?: number; contractorId?: number; visitorId?: number; ownerName?: string; loc: Loc; status: string; until?: string | null; notes?: string }) => {
      const display = plate();
      const id = Number(
        insVehicle.run(org, display.replace(/[^A-Z0-9]/g, ''), display, o.category, o.make, o.colour, o.ownerType, o.personnelId ?? null, o.contractorId ?? null, o.visitorId ?? null, o.ownerName ?? null, o.loc.id, o.status, o.until ?? null, o.notes ?? null, adminOf[o.loc.id], longAgo, longAgo).lastInsertRowid,
      );
      bump('vehicles');
      return id;
    };
    const personnelVehicles: { id: number; loc: Loc; personnelId: number }[] = [];
    for (const loc of locs) {
      const owners = people.filter((p) => p.loc.id === loc.id && p.active).slice(0, loc === HQ ? 6 : 10);
      for (const p of owners) {
        const category = chance(0.35) ? 'MOTORCYCLE' : 'CAR';
        const id = addVehicle({ category, make: category === 'CAR' ? pick(['Maruti Swift', 'Hyundai i20', 'Tata Nexon', 'Honda City', 'Mahindra XUV300']) : pick(['Hero Splendor', 'Bajaj Pulsar', 'TVS Jupiter', 'Royal Enfield Classic']), colour: pick(['White', 'Silver', 'Grey', 'Red', 'Blue', 'Black']), ownerType: 'PERSONNEL', personnelId: p.id, loc, status: 'AUTHORIZED', until: addDays(today, between(60, 365)) });
        personnelVehicles.push({ id, loc, personnelId: p.id });
      }
      for (let i = 0; i < 2; i++) addVehicle({ category: i === 0 ? 'SERVICE_VEHICLE' : 'TRUCK', make: i === 0 ? 'Mahindra Bolero' : 'Tata LPT 1613', colour: 'Olive', ownerType: 'ESTABLISHMENT', ownerName: 'Establishment transport pool', loc, status: 'AUTHORIZED' });
    }
    const contractorVan = addVehicle({ category: 'VAN', make: 'Maruti Eeco', colour: 'White', ownerType: 'CONTRACTOR', contractorId: contractorsList.find((k) => k.loc === A && k.ok)!.id, loc: A, status: 'AUTHORIZED', until: addDays(today, 60) });
    addVehicle({ category: 'CAR', make: 'Toyota Innova', colour: 'Grey', ownerType: 'OTHER', ownerName: 'Unknown (synthetic)', loc: A, status: 'BLOCKED', notes: 'Blocked after repeated unauthorized attempts (synthetic)' });
    addVehicle({ category: 'CAR', make: 'Hyundai Creta', colour: 'Blue', ownerType: 'OTHER', ownerName: 'Pending registration (synthetic)', loc: A, status: 'PENDING' });
    addVehicle({ category: 'CAR', make: 'Kia Seltos', colour: 'Red', ownerType: 'OTHER', ownerName: 'Pending registration (synthetic)', loc: B, status: 'PENDING' });

    // ---- Movement events (built in memory, inserted chronologically) -----------
    interface E {
      t: number;
      loc: Loc;
      gate: number;
      type: 'ENTRY' | 'EXIT';
      st: string;
      sid: number;
      cat: string;
      method: string;
      op: number;
      visitId?: number;
      passId?: number;
      credentialId?: number | null;
      contractorId?: number;
      vehicleId?: number;
      deliveryId?: number;
      tempId?: number;
      driver?: string;
      purpose?: string;
    }
    const events: E[] = [];
    const credIdOf = db.prepare("SELECT id FROM credentials WHERE personnel_id = ? AND status = 'ACTIVE' ORDER BY is_temporary LIMIT 1");
    const days = 7;
    const lastT = new Map<string, number>();
    const push = (e: E) => {
      events.push(e);
      lastT.set(`${e.st}:${e.sid}`, Math.max(lastT.get(`${e.st}:${e.sid}`) ?? 0, e.t));
    };
    // Past days: regular day-shift pattern.
    for (let d = days; d >= 1; d--) {
      const date = addDays(today, -d);
      for (const p of people) {
        if (!p.active || p.accessExpired || !chance(0.55)) continue;
        const gates = pedGates(p.loc);
        const cred = (credIdOf.get(p.id) as { id: number } | undefined)?.id ?? null;
        const inT = atLocal(date, 7, 0) + between(0, 150) * 60_000;
        push({ t: inT, loc: p.loc, gate: pick(gates), type: 'ENTRY', st: 'PERSONNEL', sid: p.id, cat: 'PERSONNEL', method: 'MOCK_READER', op: guardOf[p.loc.id], credentialId: cred });
        if (d === 1 && chance(0.004)) continue; // a rare unclosed movement
        const outT = atLocal(date, 16, 30) + between(0, 180) * 60_000;
        push({ t: outT, loc: p.loc, gate: pick(gates), type: 'EXIT', st: 'PERSONNEL', sid: p.id, cat: 'PERSONNEL', method: 'MOCK_READER', op: guardOf[p.loc.id], credentialId: cred });
      }
      for (const v of personnelVehicles) {
        if (!chance(0.5)) continue;
        const inT = atLocal(date, 7, 30) + between(0, 120) * 60_000;
        push({ t: inT, loc: v.loc, gate: vehicleGate(v.loc), type: 'ENTRY', st: 'VEHICLE', sid: v.id, cat: 'VEHICLE', method: 'PLATE', op: guardOf[v.loc.id], vehicleId: v.id, driver: 'Owner (personnel)' });
        push({ t: atLocal(date, 17, 0) + between(0, 120) * 60_000, loc: v.loc, gate: vehicleGate(v.loc), type: 'EXIT', st: 'VEHICLE', sid: v.id, cat: 'VEHICLE', method: 'PLATE', op: guardOf[v.loc.id], vehicleId: v.id, driver: 'Owner (personnel)' });
      }
      for (const k of contractorsList) {
        if (!k.ok || !chance(0.6)) continue;
        const g = k.category === 'VENDOR' ? serviceGate(k.loc) : mainGate(k.loc);
        push({ t: atLocal(date, 8, 30) + between(0, 90) * 60_000, loc: k.loc, gate: g, type: 'ENTRY', st: 'CONTRACTOR', sid: k.id, cat: k.category, method: 'QR', op: guardOf[k.loc.id], contractorId: k.id });
        push({ t: atLocal(date, 16, 0) + between(0, 150) * 60_000, loc: k.loc, gate: g, type: 'EXIT', st: 'CONTRACTOR', sid: k.id, cat: k.category, method: 'QR', op: guardOf[k.loc.id], contractorId: k.id });
      }
    }
    // Current period: relative to "now" so the demo shows a realistic picture at
    // any hour (day shift, night duty and those who came and left).
    const recent = (key: string, maxBackMin: number, minBackMin: number) => {
      const floor = (lastT.get(key) ?? 0) + 10 * 60_000;
      const t = nowMs - between(minBackMin, maxBackMin) * 60_000;
      return Math.max(t, floor);
    };
    for (const p of people) {
      if (!p.active || p.accessExpired) continue;
      const key = `PERSONNEL:${p.id}`;
      const gates = pedGates(p.loc);
      const cred = (credIdOf.get(p.id) as { id: number } | undefined)?.id ?? null;
      const roll = rand();
      if (roll < 0.45) {
        const inT = recent(key, 540, 15);
        if (inT < nowMs - 60_000) push({ t: inT, loc: p.loc, gate: pick(gates), type: 'ENTRY', st: 'PERSONNEL', sid: p.id, cat: 'PERSONNEL', method: 'MOCK_READER', op: guardOf[p.loc.id], credentialId: cred });
      } else if (roll < 0.6) {
        const inT = recent(key, 720, 120);
        const outT = Math.min(nowMs - 5 * 60_000, inT + between(30, 240) * 60_000);
        if (outT > inT + 5 * 60_000) {
          push({ t: inT, loc: p.loc, gate: pick(gates), type: 'ENTRY', st: 'PERSONNEL', sid: p.id, cat: 'PERSONNEL', method: 'MOCK_READER', op: guardOf[p.loc.id], credentialId: cred });
          push({ t: outT, loc: p.loc, gate: pick(gates), type: 'EXIT', st: 'PERSONNEL', sid: p.id, cat: 'PERSONNEL', method: 'MOCK_READER', op: guardOf[p.loc.id], credentialId: cred });
        }
      }
    }
    for (const v of personnelVehicles) {
      if (!chance(0.4)) continue;
      const inT = recent(`VEHICLE:${v.id}`, 480, 20);
      if (inT < nowMs - 60_000) push({ t: inT, loc: v.loc, gate: vehicleGate(v.loc), type: 'ENTRY', st: 'VEHICLE', sid: v.id, cat: 'VEHICLE', method: 'PLATE', op: guardOf[v.loc.id], vehicleId: v.id, driver: 'Owner (personnel)' });
    }
    for (const k of contractorsList) {
      if (!k.ok || !chance(0.5)) continue;
      const row = db.prepare('SELECT window_start AS ws, window_end AS we FROM contractors WHERE id = ?').get(k.id) as { ws: string; we: string };
      const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
      if (time < row.ws || time > row.we) continue;
      const windowStartMs = atLocal(today, Number(row.ws.slice(0, 2)), Number(row.ws.slice(3)));
      const inT = Math.max(recent(`CONTRACTOR:${k.id}`, 300, 20), windowStartMs + 5 * 60_000);
      if (inT >= nowMs - 60_000) continue;
      const g = k.category === 'VENDOR' ? serviceGate(k.loc) : mainGate(k.loc);
      push({ t: inT, loc: k.loc, gate: g, type: 'ENTRY', st: 'CONTRACTOR', sid: k.id, cat: k.category, method: 'QR', op: guardOf[k.loc.id], contractorId: k.id });
    }
    // Contractor van inside today
    events.push({ t: nowMs - 3 * 3_600_000, loc: A, gate: vehicleGate(A), type: 'ENTRY', st: 'VEHICLE', sid: contractorVan, cat: 'VEHICLE', method: 'PLATE', op: users['alpha.guard2'], vehicleId: contractorVan, driver: 'Contractor driver', purpose: 'Electrical materials' });

    // ---- Visitors & visits ---------------------------------------------------------
    const insVisitor = db.prepare('INSERT INTO visitors (organization_id, full_name, company, phone, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const visitorIds: number[] = [];
    for (let i = 0; i < 40; i++) {
      const name = `${pick(FIRST)} ${pick(LAST)}`;
      const company = pick(VISITOR_COMPANIES);
      visitorIds.push(Number(insVisitor.run(org, name, company, `+91 97000 ${String(10000 + i * 137).slice(0, 5)}`, company ? `${name.split(' ')[0].toLowerCase()}@visitor.example` : null, longAgo, longAgo).lastInsertRowid));
      bump('visitors');
    }
    const insVisit = db.prepare(
      `INSERT INTO visits (organization_id, reference, location_id, visitor_id, source, host_user_id, host_department, approving_officer_id, purpose, destination,
         visit_date, expected_arrival, expected_departure, vehicle_id, notes, status, requires_security_check, security_checked_by, security_checked_at,
         security_check_note, host_acknowledged_by, host_acknowledged_at, arrived_at, arrived_gate_id, entered_at, exited_at, cancelled_reason, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insHist = db.prepare('INSERT INTO visit_status_history (visit_id, from_status, to_status, reason, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    const insApproval = db.prepare('INSERT INTO visit_approvals (visit_id, decision, reason, reviewer_user_id, created_at) VALUES (?, ?, ?, ?, ?)');
    const insPass = db.prepare(
      `INSERT INTO visit_passes (visit_id, pass_number, token_nonce, status, single_use, valid_from, valid_until, issued_by, issued_at, revoked_at, revoked_by, revoked_reason, entry_used_at, exit_used_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let vi = 0;
    const nextVisitor = () => visitorIds[vi++ % visitorIds.length];
    interface VisitSpec {
      loc: Loc;
      status: string;
      arrival: number;
      departure: number;
      source?: 'PRE_REGISTERED' | 'WALK_IN';
      enteredAt?: number;
      exitedAt?: number;
      pass?: 'ACTIVE' | 'USED' | 'REVOKED' | 'EXPIRED' | null;
      decision?: 'APPROVED' | 'REJECTED';
      reason?: string;
      securityCheck?: 'PENDING' | 'DONE';
      vehicle?: boolean;
      host?: number;
      createdBy?: number;
    }
    const visitIdsByKey: Record<string, number> = {};
    const addVisit = (s: VisitSpec, key?: string) => {
      const reference = ref('VR');
      const host = s.host ?? hostOf[s.loc.id];
      const officer = officerOf[s.loc.id];
      const createdBy = s.createdBy ?? (s.source === 'WALK_IN' ? guardOf[s.loc.id] : host);
      const created = Math.min(s.arrival - 86_400_000, nowMs - 3_600_000);
      const visitorId = nextVisitor();
      let vehicleId: number | null = null;
      if (s.vehicle) vehicleId = addVehicle({ category: 'CAR', make: pick(['Maruti Ciaz', 'Hyundai Verna', 'Tata Altroz']), colour: pick(['White', 'Silver']), ownerType: 'VISITOR', visitorId, loc: s.loc, status: 'PENDING' });
      const visitDate = localDate(new Date(s.arrival), tz);
      const arrivedAt = s.enteredAt ?? (['ARRIVED', 'HOST_NOTIFIED', 'WAITING'].includes(s.status) ? nowMs - between(5, 25) * 60_000 : null);
      const id = Number(
        insVisit.run(
          org, reference, s.loc.id, visitorId, s.source ?? 'PRE_REGISTERED', host, pick(DEPARTMENTS), officer, pick(PURPOSES), pick(DESTINATIONS), visitDate,
          iso(s.arrival), iso(s.departure), vehicleId, null, s.status, s.securityCheck ? 1 : 0,
          s.securityCheck === 'DONE' ? adminOf[s.loc.id] : null, s.securityCheck === 'DONE' ? iso(created + 3_600_000) : null, s.securityCheck === 'DONE' ? 'Security verification step completed (synthetic)' : null,
          s.status === 'WAITING' ? host : null, s.status === 'WAITING' ? iso(nowMs - 4 * 60_000) : null,
          arrivedAt ? iso(arrivedAt) : null, arrivedAt ? mainGate(s.loc) : null,
          s.enteredAt ? iso(s.enteredAt) : null, s.exitedAt ? iso(s.exitedAt) : null,
          s.status === 'CANCELLED' ? s.reason ?? 'Meeting rescheduled (synthetic)' : null, createdBy, iso(created), iso(created),
        ).lastInsertRowid,
      );
      insHist.run(id, null, s.source === 'WALK_IN' ? 'ARRIVED' : 'EXPECTED', s.source === 'WALK_IN' ? 'Walk-in registered at gate' : 'Visitor request created', createdBy, iso(created));
      if (s.decision) {
        const decidedAt = iso(created + 1_800_000);
        insApproval.run(id, s.decision, s.reason ?? (s.decision === 'REJECTED' ? 'Purpose not adequately justified (synthetic)' : null), officer, decidedAt);
        insHist.run(id, 'EXPECTED', s.decision, s.decision === 'APPROVED' ? 'Approved' : `Rejected: ${s.reason ?? 'Purpose not adequately justified (synthetic)'}`, officer, decidedAt);
        writeAudit(db, { ...systemActor(db, org), userId: officer, username: 'seed', role: 'HOST' }, { action: s.decision === 'APPROVED' ? 'visit.approve' : 'visit.reject', entityType: 'visit', entityId: id, entityRef: reference, locationId: s.loc.id, createdAt: decidedAt });
      }
      let passId: number | undefined;
      if (s.pass) {
        const issued = iso(created + 1_800_000);
        passId = Number(
          insPass.run(id, reference.replace('VR-', 'VP-'), newNonce(), s.pass, iso(s.arrival - 3_600_000), iso(s.departure + 3_600_000), officer, issued,
            s.pass === 'REVOKED' ? iso(nowMs - 2 * 3_600_000) : null, s.pass === 'REVOKED' ? host : null, s.pass === 'REVOKED' ? 'Visit cancelled' : null,
            s.enteredAt ? iso(s.enteredAt) : null, s.exitedAt ? iso(s.exitedAt) : null).lastInsertRowid,
        );
        insHist.run(id, 'APPROVED', 'APPROVED', `Digital pass ${reference.replace('VR-', 'VP-')} generated`, officer, issued);
      }
      if (s.enteredAt) {
        events.push({ t: s.enteredAt, loc: s.loc, gate: mainGate(s.loc), type: 'ENTRY', st: 'VISITOR', sid: id, cat: 'VISITOR', method: 'QR', op: guardOf[s.loc.id], visitId: id, passId });
        insHist.run(id, 'APPROVED', 'INSIDE', 'Entry recorded', guardOf[s.loc.id], iso(s.enteredAt));
      }
      if (s.exitedAt) {
        events.push({ t: s.exitedAt, loc: s.loc, gate: mainGate(s.loc), type: 'EXIT', st: 'VISITOR', sid: id, cat: 'VISITOR', method: 'QR', op: guardOf[s.loc.id], visitId: id, passId });
        insHist.run(id, 'INSIDE', 'EXITED', 'Exit recorded', guardOf[s.loc.id], iso(s.exitedAt));
      }
      if (s.status === 'OVERDUE') insHist.run(id, 'INSIDE', 'OVERDUE', 'Inside beyond expected departure', null, iso(s.departure + 31 * 60_000));
      if (s.status === 'CANCELLED') insHist.run(id, s.pass ? 'APPROVED' : 'EXPECTED', 'CANCELLED', `Cancelled: ${s.reason ?? 'Meeting rescheduled (synthetic)'}`, host, iso(nowMs - 2 * 3_600_000));
      if (s.status === 'EXPIRED') insHist.run(id, s.decision ? 'APPROVED' : 'EXPECTED', 'EXPIRED', 'Validity window passed without a recorded entry', null, iso(s.departure + 3_700_000));
      if (s.status === 'HOST_NOTIFIED' || s.status === 'WAITING') insHist.run(id, s.source === 'WALK_IN' ? 'ARRIVED' : 'ARRIVED', 'HOST_NOTIFIED', 'Host notified in-app', null, iso(nowMs - 10 * 60_000));
      if (s.status === 'WAITING') insHist.run(id, 'HOST_NOTIFIED', 'WAITING', 'Host acknowledged arrival', host, iso(nowMs - 4 * 60_000));
      if (key) visitIdsByKey[key] = id;
      bump('visits');
      return id;
    };
    const H = 3_600_000;
    // History: completed, rejected, cancelled and expired visits over the past week
    for (let d = 7; d >= 1; d--) {
      const date = addDays(today, -d);
      for (const loc of locs) {
        const nDone = loc === HQ ? 1 : between(2, 4);
        for (let i = 0; i < nDone; i++) {
          const arr = atLocal(date, between(9, 14), pick([0, 15, 30, 45]));
          const dep = arr + between(1, 3) * H;
          const ent = arr + between(-20, 20) * 60_000;
          const ex = dep + between(-30, 40) * 60_000;
          addVisit({ loc, status: 'EXITED', arrival: arr, departure: dep, enteredAt: ent, exitedAt: ex, pass: 'USED', decision: 'APPROVED', vehicle: chance(0.2) });
        }
        if (chance(0.35)) addVisit({ loc, status: 'REJECTED', arrival: atLocal(date, 11, 0), departure: atLocal(date, 12, 0), decision: 'REJECTED' });
        if (chance(0.25)) addVisit({ loc, status: 'EXPIRED', arrival: atLocal(date, 10, 0), departure: atLocal(date, 11, 30), decision: 'APPROVED', pass: 'EXPIRED' });
      }
    }
    // Today and upcoming — enough to demonstrate every workflow at each location
    for (const loc of locs) {
      const k = loc.code;
      addVisit({ loc, status: 'APPROVED', arrival: nowMs - 20 * 60_000, departure: nowMs + 3 * H, pass: 'ACTIVE', decision: 'APPROVED', vehicle: loc === A }, `${k}:approved1`);
      addVisit({ loc, status: 'APPROVED', arrival: nowMs + 30 * 60_000, departure: nowMs + 4 * H, pass: 'ACTIVE', decision: 'APPROVED' }, `${k}:approved2`);
      addVisit({ loc, status: 'INSIDE', arrival: nowMs - 2 * H, departure: nowMs + 2 * H, enteredAt: nowMs - 110 * 60_000, pass: 'ACTIVE', decision: 'APPROVED' }, `${k}:inside1`);
      if (loc !== HQ) addVisit({ loc, status: 'INSIDE', arrival: nowMs - 3 * H, departure: nowMs + H, enteredAt: nowMs - 170 * 60_000, pass: 'ACTIVE', decision: 'APPROVED' }, `${k}:inside2`);
      addVisit({ loc, status: 'OVERDUE', arrival: nowMs - 5 * H, departure: nowMs - 70 * 60_000, enteredAt: nowMs - 290 * 60_000, pass: 'ACTIVE', decision: 'APPROVED' }, `${k}:overdue`);
      addVisit({ loc, status: 'EXPECTED', arrival: nowMs + 60 * 60_000, departure: nowMs + 3 * H }, `${k}:expected`);
      addVisit({ loc, status: 'CANCELLED', arrival: nowMs + 2 * H, departure: nowMs + 4 * H, pass: 'REVOKED', decision: 'APPROVED', reason: 'Visitor unable to attend (synthetic)' }, `${k}:cancelled`);
      addVisit({ loc, status: 'EXPECTED', arrival: atLocal(addDays(today, 1), 10, 0), departure: atLocal(addDays(today, 1), 12, 0) }, `${k}:tomorrow`);
      if (loc !== HQ) {
        addVisit({ loc, status: 'HOST_NOTIFIED', source: 'WALK_IN', arrival: nowMs - 15 * 60_000, departure: nowMs + 2 * H, host: officerOf[loc.id] }, `${k}:walkin`);
        addVisit({ loc, status: 'WAITING', source: 'WALK_IN', arrival: nowMs - 30 * 60_000, departure: nowMs + 2 * H, host: officerOf[loc.id] }, `${k}:waiting`);
        addVisit({ loc, status: 'APPROVED', arrival: nowMs + 45 * 60_000, departure: nowMs + 3 * H, decision: 'APPROVED', securityCheck: 'PENDING' }, `${k}:seccheck`);
        addVisit({ loc, status: 'APPROVED', arrival: nowMs + 6 * H, departure: nowMs + 8 * H, pass: 'ACTIVE', decision: 'APPROVED' }, `${k}:later`);
        addVisit({ loc, status: 'EXPIRED', arrival: nowMs - 30 * H, departure: nowMs - 27 * H, pass: 'EXPIRED', decision: 'APPROVED' }, `${k}:expired`);
      }
    }

    // ---- Temporary access ------------------------------------------------------------
    const insTA = db.prepare(
      `INSERT INTO temporary_access (organization_id, reference, location_id, holder_type, personnel_id, contractor_id, holder_name, holder_organization, holder_phone,
         reason, sponsoring_department, valid_from, valid_until, access_nonce, status, revoked_reason, revoked_by, revoked_at, issued_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const nameOf = (pid: number) => (db.prepare("SELECT TRIM(COALESCE(rank || ' ', '') || full_name) AS n, unit FROM personnel WHERE id = ?").get(pid) as { n: string; unit: string });
    const startOfToday = atLocal(today, 0, 0);
    const movedToday = new Set(events.filter((e) => e.st === 'PERSONNEL' && e.t >= nowMs - 86_400_000).map((e) => e.sid));
    const onTempDuty = new Set<number>();
    for (const loc of [A, B, C, D]) {
      const visitorFromOtherLoc = people.find((p) => p.active && !p.accessExpired && p.loc.id !== loc.id && p.credActive && !movedToday.has(p.id) && !onTempDuty.has(p.id));
      if (visitorFromOtherLoc) onTempDuty.add(visitorFromOtherLoc.id);
      if (visitorFromOtherLoc) {
        const who = nameOf(visitorFromOtherLoc.id);
        const taId = Number(
          insTA.run(org, ref('TA'), loc.id, 'PERSONNEL', visitorFromOtherLoc.id, null, who.n, who.unit, null, 'Temporary duty attachment (synthetic)', 'Training', iso(nowMs - 2 * 86_400_000), iso(nowMs + 5 * 86_400_000), newNonce(), 'ACTIVE', null, null, null, adminOf[loc.id], iso(nowMs - 2 * 86_400_000), iso(nowMs - 2 * 86_400_000)).lastInsertRowid,
        );
        bump('temporaryAccess');
        if (loc === A) events.push({ t: nowMs - 150 * 60_000, loc, gate: mainGate(loc), type: 'ENTRY', st: 'PERSONNEL', sid: visitorFromOtherLoc.id, cat: 'TEMPORARY', method: 'QR', op: guardOf[loc.id], tempId: taId });
      }
      const indId = Number(
        insTA.run(org, ref('TA'), loc.id, 'INDIVIDUAL', null, null, `${pick(FIRST)} ${pick(LAST)}`, 'Civic Training Institute (Demo)', '+91 95000 12345', 'Short-term trainee instructor (synthetic)', 'Training', iso(nowMs - 86_400_000), iso(nowMs + 2 * 86_400_000), newNonce(), 'ACTIVE', null, null, null, adminOf[loc.id], iso(nowMs - 86_400_000), iso(nowMs - 86_400_000)).lastInsertRowid,
      );
      bump('temporaryAccess');
      if (loc === A || loc === B) events.push({ t: nowMs - 100 * 60_000, loc, gate: mainGate(loc), type: 'ENTRY', st: 'TEMPORARY', sid: indId, cat: 'TEMPORARY', method: 'QR', op: guardOf[loc.id], tempId: indId });
      insTA.run(org, ref('TA'), loc.id, 'INDIVIDUAL', null, null, `${pick(FIRST)} ${pick(LAST)}`, 'Kestrel Engineering (Demo)', null, 'Equipment installation (synthetic)', 'Workshop', iso(nowMs - 5 * 86_400_000), iso(nowMs - 86_400_000), newNonce(), 'ACTIVE', null, null, null, adminOf[loc.id], iso(nowMs - 5 * 86_400_000), iso(nowMs - 5 * 86_400_000));
      bump('temporaryAccess');
      if (loc === A) {
        insTA.run(org, ref('TA'), loc.id, 'INDIVIDUAL', null, null, `${pick(FIRST)} ${pick(LAST)}`, null, null, 'Short-term labour (synthetic)', 'Quartermaster', iso(nowMs - 3 * 86_400_000), iso(nowMs + 4 * 86_400_000), newNonce(), 'REVOKED', 'Assignment ended early (synthetic)', adminOf[loc.id], iso(nowMs - 86_400_000), adminOf[loc.id], iso(nowMs - 3 * 86_400_000), iso(nowMs - 86_400_000));
        insTA.run(org, ref('TA'), loc.id, 'INDIVIDUAL', null, null, `${pick(FIRST)} ${pick(LAST)}`, 'Bluewave Consulting (Demo)', null, 'Network survey (synthetic)', 'Signals', iso(nowMs + 86_400_000), iso(nowMs + 3 * 86_400_000), newNonce(), 'ACTIVE', null, null, null, adminOf[loc.id], nowIso, nowIso);
        bump('temporaryAccess', 2);
      }
    }

    // ---- Deliveries --------------------------------------------------------------
    const insDelivery = db.prepare(
      `INSERT INTO deliveries (organization_id, reference, location_id, gate_id, category, company, courier_name, courier_phone, vehicle_id, recipient_user_id,
         recipient_name, recipient_department, sponsor_user_id, description, item_count, status, requires_authorization, expected_at, arrived_at, authorized_by,
         authorized_at, authorization_note, received_by_user_id, received_by_name, received_at, receipt_note, departed_at, departed_gate_id, status_reason,
         created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insDHist = db.prepare('INSERT INTO delivery_status_history (delivery_id, from_status, to_status, reason, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    const couriers = [
      ['COURIER', 'Speedline Couriers (Demo)', 'Documents envelope'],
      ['PARCEL', 'Parcelwise Logistics (Demo)', 'Boxed spare parts'],
      ['FOOD', 'Tiffin Express (Demo)', 'Packed lunch order'],
      ['SUPPLIER', 'Greenleaf Catering Supplies (Demo)', 'Ration crates'],
      ['SUPPLIER', 'Brightline Electricals (Demo)', 'Cable drums'],
    ] as const;
    const addDelivery = (loc: Loc, status: string, arrivedAt: number | null, opts: { authorizedAt?: number; receivedAt?: number; departedAt?: number; reason?: string; vehicle?: boolean; enteredAt?: number } = {}) => {
      const [cat, company, desc] = pick(couriers);
      const recipient = hostOf[loc.id];
      const reference = ref('DL');
      const vehicleId = opts.vehicle ? addVehicle({ category: 'DELIVERY_VEHICLE', make: 'Tata Ace', colour: 'White', ownerType: 'DELIVERY', ownerName: company, loc, status: 'PENDING' }) : null;
      const created = arrivedAt ?? nowMs - H;
      const id = Number(
        insDelivery.run(
          org, reference, loc.id, serviceGate(loc), cat, company, `${pick(FIRST)} ${pick(LAST)}`, '+91 96000 54321', vehicleId, recipient, null, pick(DEPARTMENTS), null, desc, between(1, 12),
          status, status === 'EXPECTED' ? iso(nowMs + 2 * H) : null, arrivedAt ? iso(arrivedAt) : null,
          opts.authorizedAt ? recipient : null, opts.authorizedAt ? iso(opts.authorizedAt) : null, opts.authorizedAt ? 'Proceed under applicable procedures' : null,
          opts.receivedAt ? recipient : null, opts.receivedAt ? 'Recipient (synthetic)' : null, opts.receivedAt ? iso(opts.receivedAt) : null, opts.receivedAt ? 'Received in good order' : null,
          opts.departedAt ? iso(opts.departedAt) : null, opts.departedAt ? serviceGate(loc) : null, opts.reason ?? null, guardOf[loc.id], iso(created), iso(created),
        ).lastInsertRowid,
      );
      insDHist.run(id, null, 'EXPECTED', 'Delivery registered', guardOf[loc.id], iso(created));
      if (arrivedAt) {
        insDHist.run(id, 'EXPECTED', 'ARRIVED', 'Arrival recorded at gate', guardOf[loc.id], iso(arrivedAt));
        insDHist.run(id, 'ARRIVED', 'AWAITING_AUTHORIZATION', 'Awaiting authorization', guardOf[loc.id], iso(arrivedAt));
      }
      if (opts.authorizedAt) insDHist.run(id, 'AWAITING_AUTHORIZATION', 'AUTHORIZED', 'Authorized to proceed under applicable procedures', recipient, iso(opts.authorizedAt));
      if (opts.receivedAt) insDHist.run(id, 'AUTHORIZED', 'RECEIVED', 'Receipt acknowledged', recipient, iso(opts.receivedAt));
      if (opts.departedAt && status === 'DEPARTED') insDHist.run(id, 'RECEIVED', 'DEPARTED', 'Departed', guardOf[loc.id], iso(opts.departedAt));
      if (['REJECTED', 'RETURNED', 'CANCELLED'].includes(status)) insDHist.run(id, 'AWAITING_AUTHORIZATION', status, opts.reason ?? null, recipient, iso((arrivedAt ?? nowMs) + 20 * 60_000));
      if (opts.enteredAt) {
        events.push({ t: opts.enteredAt, loc, gate: serviceGate(loc), type: 'ENTRY', st: 'DELIVERY', sid: id, cat: 'DELIVERY', method: 'REFERENCE', op: guardOf[loc.id], deliveryId: id });
        if (opts.departedAt) events.push({ t: opts.departedAt, loc, gate: serviceGate(loc), type: 'EXIT', st: 'DELIVERY', sid: id, cat: 'DELIVERY', method: 'REFERENCE', op: guardOf[loc.id], deliveryId: id });
      }
      bump('deliveries');
      return id;
    };
    for (let d = 6; d >= 1; d--) {
      const date = addDays(today, -d);
      for (const loc of [A, B, C, D]) {
        const arr = atLocal(date, between(10, 15), between(0, 59));
        addDelivery(loc, 'DEPARTED', arr, { authorizedAt: arr + 10 * 60_000, receivedAt: arr + 25 * 60_000, departedAt: arr + 35 * 60_000, enteredAt: chance(0.5) ? arr + 12 * 60_000 : undefined });
      }
    }
    for (const loc of [A, B, C, D]) {
      addDelivery(loc, 'AWAITING_AUTHORIZATION', nowMs - 12 * 60_000, { vehicle: loc === A });
      addDelivery(loc, 'AUTHORIZED', nowMs - 5 * H, { authorizedAt: nowMs - 5 * H + 10 * 60_000 });
      addDelivery(loc, 'AUTHORIZED', nowMs - 40 * 60_000, { authorizedAt: nowMs - 30 * 60_000, enteredAt: nowMs - 28 * 60_000 });
      addDelivery(loc, 'RECEIVED', nowMs - 90 * 60_000, { authorizedAt: nowMs - 85 * 60_000, receivedAt: nowMs - 60 * 60_000 });
      addDelivery(loc, 'EXPECTED', null);
      if (loc === A) {
        addDelivery(loc, 'REJECTED', nowMs - 26 * H, { reason: 'Recipient not available; not expected (synthetic)', departedAt: nowMs - 25.5 * H });
        addDelivery(loc, 'RETURNED', nowMs - 50 * H, { authorizedAt: nowMs - 49.8 * H, reason: 'Wrong consignment (synthetic)', departedAt: nowMs - 49.5 * H });
        addDelivery(loc, 'CANCELLED', null, { reason: 'Order cancelled by sender (synthetic)' });
      }
    }

    // ---- Insert movement events chronologically ----------------------------------
    events.sort((x, y) => x.t - y.t);
    const insEvent = db.prepare(
      `INSERT INTO movement_events (organization_id, reference, location_id, gate_id, event_type, subject_type, subject_id, category, visit_id, pass_id, credential_id,
         temporary_access_id, contractor_id, delivery_id, vehicle_id, driver_reference, purpose, verification_method, outcome, operator_user_id, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECORDED', ?, ?)`,
    );
    for (const e of events) {
      insEvent.run(org, ref('EV'), e.loc.id, e.gate, e.type, e.st, e.sid, e.cat, e.visitId ?? null, e.passId ?? null, e.credentialId ?? null, e.tempId ?? null, e.contractorId ?? null, e.deliveryId ?? null, e.vehicleId ?? null, e.driver ?? null, e.purpose ?? null, e.method, e.op, iso(e.t));
    }
    bump('events', events.length);
    db.prepare(
      `INSERT INTO presence (subject_type, subject_id, organization_id, state, category, location_id, gate_id, last_event_id, since, updated_at)
       SELECT e.subject_type, e.subject_id, e.organization_id, CASE e.event_type WHEN 'ENTRY' THEN 'INSIDE' ELSE 'OUTSIDE' END,
              CASE e.subject_type WHEN 'CONTRACTOR' THEN (SELECT category FROM contractors WHERE id = e.subject_id) ELSE e.subject_type END,
              e.location_id, e.gate_id, e.id, e.recorded_at, ?
       FROM movement_events e WHERE e.id IN (SELECT MAX(id) FROM movement_events GROUP BY subject_type, subject_id)`,
    ).run(nowIso);

    // ---- Failed verification attempts & alerts ------------------------------------
    const sys = systemActor(db, org);
    const insAttempt = db.prepare(
      `INSERT INTO verification_attempts (organization_id, location_id, gate_id, operator_user_id, mode, method, input_fingerprint, input_display, result_code,
         subject_type, subject_id, category, allowed_actions, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
    );
    const failureKinds = [
      ['PERSONNEL', 'MOCK_READER', 'INVALID_CREDENTIAL', 'Credential not recognised.'],
      ['PERSONNEL', 'MOCK_READER', 'BLOCKED_CREDENTIAL', 'This credential has been blocked.'],
      ['PERSONNEL', 'MOCK_READER', 'WRONG_LOCATION', 'Not authorized for this location.'],
      ['VISITOR', 'QR', 'INVALID_PASS', 'The scanned visitor pass is not recognised.'],
      ['VISITOR', 'QR', 'EXPIRED_PASS', 'This pass has expired.'],
      ['VISITOR', 'QR', 'CANCELLED_PASS', 'This visit has been cancelled.'],
      ['CONTRACTOR', 'QR', 'EXPIRED_ACCESS', 'Access validity ended.'],
      ['CONTRACTOR', 'QR', 'OUTSIDE_PERMITTED_HOURS', 'Outside permitted hours.'],
      ['VEHICLE', 'PLATE', 'UNREGISTERED_VEHICLE', 'This vehicle is not in the register.'],
    ] as const;
    for (let d = 6; d >= 0; d--) {
      for (const loc of locs) {
        const n = between(1, loc === A ? 6 : 3);
        for (let i = 0; i < n; i++) {
          const [mode, method, result, detail] = pick(failureKinds);
          const t = atLocal(addDays(today, -d), between(7, 19), between(0, 59));
          if (t > nowMs) continue;
          insAttempt.run(org, loc.id, pick(loc.gates).id, guardOf[loc.id], mode, method, `seed-${d}-${loc.id}-${i}`, mode === 'VEHICLE' ? 'DM00ZZ0000' : 'RF-…0000', result, null, null, null, detail, iso(t));
          bump('failedVerifications');
        }
      }
    }
    const alertAt = (type: Parameters<typeof raiseAlert>[2]['type'], loc: Loc, description: string, key: string) =>
      raiseAlert(db, sys, { orgId: org, locationId: loc.id, gateId: mainGate(loc), type, description, dedupeKey: key });
    const a1 = alertAt('BLOCKED_CREDENTIAL', A, 'Blocked Credential at Alpha Main Gate: This credential has been blocked (synthetic history).', 'seed:a1');
    const a2 = alertAt('INVALID_QR', A, 'Invalid Visitor Pass at Alpha Main Gate: The scanned code is not a valid visitor pass (synthetic history).', 'seed:a2');
    const a3 = alertAt('WRONG_LOCATION', B, 'Wrong Location at Bravo Main Gate: Not authorized for Location Bravo (synthetic history).', 'seed:a3');
    const a4 = alertAt('REPEATED_FAILED_VERIFICATION', A, '4 failed verifications at Alpha Vehicle Gate within 10 minutes (synthetic history).', 'seed:a4');
    const a5 = alertAt('INVALID_CREDENTIAL', C, 'Invalid Credential at Charlie Main Gate: Credential not recognised (synthetic history).', 'seed:a5');
    const ackStmt = db.prepare("UPDATE alerts SET status = 'ACKNOWLEDGED', acknowledged_by = ?, acknowledged_at = ?, acknowledgement_note = ?, updated_at = ? WHERE id = ?");
    const resStmt = db.prepare(
      "UPDATE alerts SET status = 'RESOLVED', acknowledged_by = ?, acknowledged_at = ?, resolved_by = ?, resolved_at = ?, resolution_note = ?, updated_at = ? WHERE id = ?",
    );
    const alertHist = db.prepare('INSERT INTO alert_history (alert_id, action, note, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?)');
    if (a3) {
      ackStmt.run(users['bravo.admin'], iso(nowMs - H), 'Checking posting order with HQ (synthetic)', iso(nowMs - H), a3.id);
      alertHist.run(a3.id, 'ACKNOWLEDGED', 'Checking posting order with HQ (synthetic)', users['bravo.admin'], iso(nowMs - H));
    }
    if (a5) {
      resStmt.run(users['charlie.admin'], iso(nowMs - 3 * H), users['charlie.admin'], iso(nowMs - 2 * H), 'Card was a damaged spare; holder re-issued a valid card (synthetic).', iso(nowMs - 2 * H), a5.id);
      alertHist.run(a5.id, 'ACKNOWLEDGED', null, users['charlie.admin'], iso(nowMs - 3 * H));
      alertHist.run(a5.id, 'RESOLVED', 'Card was a damaged spare; holder re-issued a valid card (synthetic).', users['charlie.admin'], iso(nowMs - 2 * H));
    }
    void a1;
    void a2;
    void a4;
    bump('alerts', 5);

    // ---- Manual reviews -----------------------------------------------------------
    const wrongLocPerson = people.find((p) => p.active && p.loc.id === B.id && p.credActive);
    if (wrongLocPerson) {
      const attemptId = Number(
        db
          .prepare(
            `INSERT INTO verification_attempts (organization_id, location_id, gate_id, operator_user_id, mode, method, input_fingerprint, input_display, result_code,
               subject_type, subject_id, category, credential_id, allowed_actions, detail, created_at)
             VALUES (?, ?, ?, ?, 'PERSONNEL', 'MOCK_READER', 'seed-review-1', 'RF-…REVW', 'WRONG_LOCATION', 'PERSONNEL', ?, 'PERSONNEL', ?, '[]', 'Not authorized for Location Alpha.', ?)`,
          )
          .run(org, A.id, mainGate(A), users['alpha.guard'], wrongLocPerson.id, (credIdOf.get(wrongLocPerson.id) as { id: number } | undefined)?.id ?? null, iso(nowMs - 8 * 60_000)).lastInsertRowid,
      );
      db.prepare(
        `INSERT INTO manual_reviews (organization_id, reference, location_id, gate_id, verification_attempt_id, requested_action, requested_by, request_note, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'ENTRY', ?, 'Holder states they are attending a coordination conference at Alpha today (synthetic).', 'PENDING', ?, ?)`,
      ).run(org, ref('MR'), A.id, mainGate(A), attemptId, users['alpha.guard'], iso(nowMs - 7 * 60_000), iso(nowMs - 7 * 60_000));
      bump('manualReviews');
    }

    // ---- Administrative exceptions & handovers -------------------------------------
    const insEx = db.prepare(
      `INSERT INTO admin_exceptions (organization_id, reference, location_id, category, related_type, related_id, related_reference, title, description, responsible_role,
         responsible_user_id, status, created_by, created_at, updated_at, resolution_note, resolved_by, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insExH = db.prepare('INSERT INTO admin_exception_history (exception_id, from_status, to_status, note, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    const addEx = (loc: Loc, category: string, title: string, description: string, status: string, ageH: number, resolution?: string) => {
      const created = iso(nowMs - ageH * H);
      const resolvedAt = status === 'RESOLVED' ? iso(nowMs - (ageH / 2) * H) : null;
      const id = Number(
        insEx.run(org, ref('EX'), loc.id, category, null, null, null, title, description, 'LOCATION_ADMIN', adminOf[loc.id], status, guardOf[loc.id], created, resolvedAt ?? created, resolution ?? null, status === 'RESOLVED' ? adminOf[loc.id] : null, resolvedAt).lastInsertRowid,
      );
      insExH.run(id, null, 'OPEN', 'Created', guardOf[loc.id], created);
      if (status !== 'OPEN') insExH.run(id, 'OPEN', 'UNDER_REVIEW', 'Under review by location administrator', adminOf[loc.id], iso(nowMs - (ageH * 0.75) * H));
      if (status === 'RESOLVED') insExH.run(id, 'UNDER_REVIEW', 'RESOLVED', resolution ?? null, adminOf[loc.id], resolvedAt!);
      bump('exceptions');
    };
    addEx(A, 'MISSING_EXIT', 'Personnel exit not recorded on previous shift', 'Night shift register shows a departure that was not recorded in the system (synthetic).', 'OPEN', 6);
    addEx(A, 'RECORD_DISCREPANCY', 'Visitor count mismatch at Alpha Main Gate', 'Manual tally and system count differed by one at 18:00 handover (synthetic).', 'UNDER_REVIEW', 20);
    addEx(A, 'CREDENTIAL_ISSUE', 'Card reader position complaint', 'Holders report needing multiple taps on the mock reader stand (synthetic).', 'RESOLVED', 50, 'Reader stand repositioned; no further reports (synthetic).');
    addEx(B, 'VISITOR_ISSUE', 'Visitor arrived without host details', 'Walk-in visitor could not name a host; referred to administration (synthetic).', 'OPEN', 30);
    addEx(C, 'DELIVERY_ISSUE', 'Delivery left without receipt acknowledgement', 'Courier departed before the recipient acknowledged receipt (synthetic).', 'RESOLVED', 72, 'Recipient confirmed receipt in writing; record updated (synthetic).');
    addEx(D, 'OTHER', 'Gate register binder replaced', 'Paper register binder full; replaced and archived (synthetic).', 'OPEN', 3);
    db.prepare(
      `INSERT INTO handovers (organization_id, reference, location_id, gate_id, shift_label, handed_over_by, handed_over_to, summary_json, notes, created_at, acknowledged_by, acknowledged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(org, ref('HO'), A.id, mainGate(A), 'Night shift → Day shift', users['alpha.guard2'], users['alpha.guard'], JSON.stringify({ openExceptions: 2, pendingApprovals: 1, visitorsAwaitingAction: 0, incompleteDeliveries: 1, unresolvedDiscrepancies: 1 }), 'Quiet night. One delivery awaiting receipt (synthetic).', iso(nowMs - 9 * H), users['alpha.guard'], iso(nowMs - 8.9 * H));
    bump('handovers');

    // ---- Notifications --------------------------------------------------------------
    const insN = db.prepare(
      `INSERT INTO notifications (organization_id, user_id, location_id, type, title, body, link, related_type, related_id, channel, created_at, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'IN_APP', ?, ?)`,
    );
    for (const loc of [A, B, C, D]) {
      const exp = visitIdsByKey[`${loc.code}:expected`];
      insN.run(org, officerOf[loc.id], loc.id, 'VISIT_APPROVAL_REQUESTED', 'Visitor request awaiting your authorization', 'A pre-registered visitor request needs a decision (synthetic).', `/visitors/${exp}`, 'visit', exp, iso(nowMs - 50 * 60_000), null);
      const walk = visitIdsByKey[`${loc.code}:walkin`];
      if (walk) insN.run(org, officerOf[loc.id], loc.id, 'VISITOR_ARRIVED', 'Walk-in visitor has arrived at the main gate', 'Please acknowledge the visitor waiting at the gate (synthetic).', `/visitors/${walk}`, 'visit', walk, iso(nowMs - 14 * 60_000), null);
    }
    insN.run(org, users['alpha.host'], A.id, 'VISIT_APPROVED', 'Visit approved', 'Your visitor request was approved and a digital pass generated (synthetic).', `/visitors/${visitIdsByKey['LOC-A:approved1']}`, 'visit', visitIdsByKey['LOC-A:approved1'], iso(nowMs - 3 * H), iso(nowMs - 2.5 * H));
    insN.run(org, users['alpha.admin'], A.id, 'MANUAL_REVIEW_REQUESTED', 'Manual review requested (Wrong Location)', 'Gate NCO requested review of an entry at Alpha Main Gate (synthetic).', '/manual-reviews', 'manual_review', null, iso(nowMs - 7 * 60_000), null);

    // ---- Reference sequences & marker ------------------------------------------------
    const seqStmt = db.prepare('INSERT INTO ref_sequences (organization_id, prefix, year, last_value) VALUES (?, ?, ?, ?) ON CONFLICT (organization_id, prefix, year) DO UPDATE SET last_value = excluded.last_value');
    for (const [prefix, value] of Object.entries(seq)) seqStmt.run(org, prefix, year, value);
    writeAudit(db, sys, { action: 'demo.seed', entityType: 'demo', metadata: { version: SEED_VERSION, counts } });
    db.prepare("INSERT INTO app_meta (key, value, updated_at) VALUES ('demo_seed_version', ?, ?)").run(SEED_VERSION, nowIso);
  })();

  invalidateSettingsCache(db);
  // Apply time-based rules once so overdue/expired statuses and alerts are consistent.
  runScheduledChecks(db, config);
  return { seeded: true, summary: Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') };
}

/** Drop everything and rebuild the synthetic dataset. Demo mode only. */
export function resetDemo(db: DB, config: AppConfig, by: string): string {
  if (config.mode !== 'demo') throw new Error('Reset is only available in demo mode');
  dropAll(db);
  migrate(db);
  invalidatePermissionCache(db);
  invalidateSettingsCache(db);
  ensureBaseline(db);
  const r = seedDemo(db, config);
  writeAudit(db, null, { action: 'demo.reset', metadata: { by } }, null, (db.prepare('SELECT id FROM organizations LIMIT 1').get() as { id: number }).id);
  return r.summary;
}
