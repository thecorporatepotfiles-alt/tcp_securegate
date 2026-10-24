import type { DB } from '../db/connection.js';
import type { RegisterCategory, SubjectType } from '../../../shared/constants.js';

/** SQL expressions that describe a movement subject (used by registers, presence & reports). */
export function subjectNameSql(a: string): string {
  return `CASE ${a}.subject_type
    WHEN 'PERSONNEL' THEN (SELECT TRIM(COALESCE(p.rank || ' ', '') || p.full_name) FROM personnel p WHERE p.id = ${a}.subject_id)
    WHEN 'VISITOR' THEN (SELECT vr.full_name FROM visits vi JOIN visitors vr ON vr.id = vi.visitor_id WHERE vi.id = ${a}.subject_id)
    WHEN 'CONTRACTOR' THEN (SELECT c.full_name FROM contractors c WHERE c.id = ${a}.subject_id)
    WHEN 'TEMPORARY' THEN (SELECT t.holder_name FROM temporary_access t WHERE t.id = ${a}.subject_id)
    WHEN 'DELIVERY' THEN (SELECT d.courier_name FROM deliveries d WHERE d.id = ${a}.subject_id)
    WHEN 'VEHICLE' THEN (SELECT v.display_registration FROM vehicles v WHERE v.id = ${a}.subject_id)
  END`;
}

export function subjectRefSql(a: string): string {
  return `CASE ${a}.subject_type
    WHEN 'PERSONNEL' THEN (SELECT p.service_number FROM personnel p WHERE p.id = ${a}.subject_id)
    WHEN 'VISITOR' THEN (SELECT vi.reference FROM visits vi WHERE vi.id = ${a}.subject_id)
    WHEN 'CONTRACTOR' THEN (SELECT c.reference FROM contractors c WHERE c.id = ${a}.subject_id)
    WHEN 'TEMPORARY' THEN (SELECT t.reference FROM temporary_access t WHERE t.id = ${a}.subject_id)
    WHEN 'DELIVERY' THEN (SELECT d.reference FROM deliveries d WHERE d.id = ${a}.subject_id)
    WHEN 'VEHICLE' THEN (SELECT COALESCE(v.make_model, v.category) FROM vehicles v WHERE v.id = ${a}.subject_id)
  END`;
}

export function subjectOrgSql(a: string): string {
  return `CASE ${a}.subject_type
    WHEN 'PERSONNEL' THEN (SELECT p.unit FROM personnel p WHERE p.id = ${a}.subject_id)
    WHEN 'VISITOR' THEN (SELECT vr.company FROM visits vi JOIN visitors vr ON vr.id = vi.visitor_id WHERE vi.id = ${a}.subject_id)
    WHEN 'CONTRACTOR' THEN (SELECT cc.name FROM contractors c JOIN contractor_companies cc ON cc.id = c.company_id WHERE c.id = ${a}.subject_id)
    WHEN 'TEMPORARY' THEN (SELECT t.holder_organization FROM temporary_access t WHERE t.id = ${a}.subject_id)
    WHEN 'DELIVERY' THEN (SELECT d.company FROM deliveries d WHERE d.id = ${a}.subject_id)
    WHEN 'VEHICLE' THEN (SELECT COALESCE(v.owner_name, v.owner_type) FROM vehicles v WHERE v.id = ${a}.subject_id)
  END`;
}

/** The subject's base category (used for presence counts). */
export function baseCategory(db: DB, type: SubjectType, id: number): RegisterCategory {
  if (type === 'CONTRACTOR') {
    const row = db.prepare('SELECT category FROM contractors WHERE id = ?').get(id) as { category: RegisterCategory } | undefined;
    return row?.category ?? 'CONTRACTOR';
  }
  return type as RegisterCategory;
}

export function subjectLink(type: SubjectType, id: number): string {
  switch (type) {
    case 'PERSONNEL':
      return `/personnel/${id}`;
    case 'VISITOR':
      return `/visitors/${id}`;
    case 'CONTRACTOR':
      return `/contractors/people/${id}`;
    case 'TEMPORARY':
      return `/temporary-access/${id}`;
    case 'DELIVERY':
      return `/deliveries/${id}`;
    case 'VEHICLE':
      return `/vehicles/${id}`;
  }
}
