import { z } from 'zod';
import type { Ctx } from '../auth/context.js';
import { can, requirePerm, scopeIds, sqlIn } from '../auth/context.js';
import { notFound } from '../lib/errors.js';
import { dateRangeToUtc } from '../lib/time.js';
import { likeParam, parse, zDate } from '../lib/http.js';
import { toCsv } from '../lib/csv.js';
import { audit } from './audit.js';
import { subjectNameSql, subjectOrgSql, subjectRefSql } from './subjects.js';
import type { Permission } from '../../../shared/constants.js';

type ColType = 'datetime' | 'date' | 'text' | 'number' | 'status' | 'bool';
interface Column {
  key: string;
  label: string;
  type?: ColType;
}

interface ReportDef {
  key: string;
  title: string;
  description: string;
  group: string;
  permission?: Permission;
  columns: Column[];
  /** Inner query producing aliased columns, including locationId and ts (for date filtering). */
  source: (range: { start: string; end: string }) => { sql: string; params: unknown[] };
  /** Aggregated reports apply the date range inside the source. */
  aggregated?: boolean;
  search: string[];
  sortable: string[];
  defaultSort: string;
  filters: { gate?: boolean; category?: string[]; status?: string[] };
  /** Rows with a NULL location are only visible to all-location users. */
  allowNullLocation?: boolean;
}

const EVENT_COLUMNS: Column[] = [
  { key: 'recordedAt', label: 'Recorded at', type: 'datetime' },
  { key: 'reference', label: 'Event ref' },
  { key: 'eventType', label: 'Type', type: 'status' },
  { key: 'category', label: 'Category', type: 'status' },
  { key: 'subjectName', label: 'Name / registration' },
  { key: 'subjectReference', label: 'Reference' },
  { key: 'subjectOrganization', label: 'Unit / organization' },
  { key: 'locationName', label: 'Location' },
  { key: 'gateName', label: 'Gate' },
  { key: 'verificationMethod', label: 'Method' },
  { key: 'outcome', label: 'Outcome', type: 'status' },
  { key: 'operatorName', label: 'Operator' },
  { key: 'voided', label: 'Voided', type: 'bool' },
];

function eventSource(categories?: string[], extraCols = '') {
  return (_range: { start: string; end: string }) => ({
    sql: `SELECT e.id, e.reference, e.recorded_at AS recordedAt, e.recorded_at AS ts, e.event_type AS eventType, e.category,
                 e.subject_type AS subjectType, e.subject_id AS subjectId,
                 ${subjectNameSql('e')} AS subjectName, ${subjectRefSql('e')} AS subjectReference, ${subjectOrgSql('e')} AS subjectOrganization,
                 e.location_id AS locationId, l.name AS locationName, e.gate_id AS gateId, g.name AS gateName,
                 e.verification_method AS verificationMethod, e.outcome, u.display_name AS operatorName, e.organization_id AS orgId,
                 CASE WHEN EXISTS (SELECT 1 FROM event_corrections c WHERE c.voided_event_id = e.id) THEN 1 ELSE 0 END AS voided,
                 e.event_type AS status ${extraCols}
          FROM movement_events e JOIN locations l ON l.id = e.location_id JOIN gates g ON g.id = e.gate_id LEFT JOIN users u ON u.id = e.operator_user_id
          ${categories ? `WHERE (e.category IN (${categories.map((c) => `'${c}'`).join(',')})${categories.includes('PERSONNEL') ? " OR (e.subject_type = 'PERSONNEL')" : ''})` : ''}`,
    params: [],
  });
}

const VISIT_COLUMNS: Column[] = [
  { key: 'reference', label: 'Visit ref' },
  { key: 'visitorName', label: 'Visitor' },
  { key: 'visitorCompany', label: 'Organization' },
  { key: 'hostName', label: 'Host' },
  { key: 'purpose', label: 'Purpose' },
  { key: 'destination', label: 'Destination' },
  { key: 'locationName', label: 'Location' },
  { key: 'visitDate', label: 'Visit date', type: 'date' },
  { key: 'expectedArrival', label: 'Expected arrival', type: 'datetime' },
  { key: 'expectedDeparture', label: 'Expected departure', type: 'datetime' },
  { key: 'status', label: 'Status', type: 'status' },
  { key: 'enteredAt', label: 'Entered', type: 'datetime' },
  { key: 'exitedAt', label: 'Exited', type: 'datetime' },
  { key: 'source', label: 'Source', type: 'status' },
];

const visitSource = (where = '') => () => ({
  sql: `SELECT v.id, v.reference, vr.full_name AS visitorName, vr.company AS visitorCompany, h.display_name AS hostName, v.purpose, v.destination,
               v.location_id AS locationId, l.name AS locationName, v.visit_date AS visitDate, v.expected_arrival AS expectedArrival,
               v.expected_departure AS expectedDeparture, v.status, v.entered_at AS enteredAt, v.exited_at AS exitedAt, v.source,
               v.expected_arrival AS ts, v.organization_id AS orgId
        FROM visits v JOIN visitors vr ON vr.id = v.visitor_id JOIN users h ON h.id = v.host_user_id JOIN locations l ON l.id = v.location_id ${where}`,
  params: [],
});

export const REPORTS: ReportDef[] = [
  {
    key: 'daily-movement',
    title: 'Daily entry and exit',
    description: 'Every recorded entry and exit across all record types.',
    group: 'Movement',
    columns: EVENT_COLUMNS,
    source: eventSource(),
    search: ['reference', 'subjectName', 'subjectReference', 'operatorName'],
    sortable: ['recordedAt', 'category', 'gateName', 'eventType'],
    defaultSort: 'recordedAt DESC',
    filters: { gate: true, category: ['PERSONNEL', 'VISITOR', 'CONTRACTOR', 'VENDOR', 'SERVICE', 'TEMPORARY', 'DELIVERY', 'VEHICLE'], status: ['ENTRY', 'EXIT'] },
  },
  {
    key: 'personnel-movement',
    title: 'Personnel movement',
    description: 'Entries and exits of personnel, including movements on temporary access.',
    group: 'Movement',
    columns: EVENT_COLUMNS,
    source: (r) => {
      const s = eventSource()(r);
      return { sql: s.sql + " WHERE e.subject_type = 'PERSONNEL'", params: [] };
    },
    search: ['reference', 'subjectName', 'subjectReference', 'subjectOrganization'],
    sortable: ['recordedAt', 'gateName', 'eventType'],
    defaultSort: 'recordedAt DESC',
    filters: { gate: true, status: ['ENTRY', 'EXIT'] },
  },
  {
    key: 'contractor-movement',
    title: 'Contractor movement',
    description: 'Entries and exits of contractor personnel.',
    group: 'Movement',
    columns: EVENT_COLUMNS,
    source: (r) => ({ sql: eventSource()(r).sql + " WHERE e.subject_type = 'CONTRACTOR' AND e.category IN ('CONTRACTOR','TEMPORARY') AND (SELECT category FROM contractors WHERE id = e.subject_id) = 'CONTRACTOR'", params: [] }),
    search: ['reference', 'subjectName', 'subjectReference', 'subjectOrganization'],
    sortable: ['recordedAt', 'gateName', 'eventType'],
    defaultSort: 'recordedAt DESC',
    filters: { gate: true, status: ['ENTRY', 'EXIT'] },
  },
  {
    key: 'vendor-visits',
    title: 'Vendor and service visits',
    description: 'Entries and exits of vendor, supplier and service personnel.',
    group: 'Movement',
    columns: EVENT_COLUMNS,
    source: (r) => ({ sql: eventSource()(r).sql + " WHERE e.subject_type = 'CONTRACTOR' AND (SELECT category FROM contractors WHERE id = e.subject_id) IN ('VENDOR','SERVICE')", params: [] }),
    search: ['reference', 'subjectName', 'subjectReference', 'subjectOrganization'],
    sortable: ['recordedAt', 'gateName', 'eventType'],
    defaultSort: 'recordedAt DESC',
    filters: { gate: true, status: ['ENTRY', 'EXIT'] },
  },
  {
    key: 'vehicle-movement',
    title: 'Vehicle movement',
    description: 'Vehicle entries and exits. Occupants are recorded separately.',
    group: 'Movement',
    columns: [...EVENT_COLUMNS.slice(0, 7), { key: 'driverReference', label: 'Driver reference' }, { key: 'purpose', label: 'Purpose' }, ...EVENT_COLUMNS.slice(7)],
    source: (r) => ({ sql: eventSource(undefined, ', e.driver_reference AS driverReference, e.purpose')(r).sql + " WHERE e.subject_type = 'VEHICLE'", params: [] }),
    search: ['reference', 'subjectName', 'subjectReference', 'driverReference'],
    sortable: ['recordedAt', 'gateName', 'eventType'],
    defaultSort: 'recordedAt DESC',
    filters: { gate: true, status: ['ENTRY', 'EXIT'] },
  },
  {
    key: 'visitor-register',
    title: 'Visitor register',
    description: 'All visitor requests and visits in the selected period.',
    group: 'Visitors',
    columns: VISIT_COLUMNS,
    source: visitSource(),
    search: ['reference', 'visitorName', 'visitorCompany', 'hostName', 'destination'],
    sortable: ['expectedArrival', 'visitorName', 'status'],
    defaultSort: 'expectedArrival DESC',
    filters: { status: ['EXPECTED', 'ARRIVED', 'HOST_NOTIFIED', 'WAITING', 'APPROVED', 'INSIDE', 'OVERDUE', 'EXITED', 'REJECTED', 'CANCELLED', 'EXPIRED'] },
  },
  {
    key: 'active-visitors',
    title: 'Active visitors',
    description: 'Visitors currently recorded inside (including overdue). Not date-filtered.',
    group: 'Visitors',
    columns: VISIT_COLUMNS,
    source: () => {
      const s = visitSource("WHERE v.status IN ('INSIDE','OVERDUE')")();
      return { sql: s.sql.replace('v.expected_arrival AS ts', 'NULL AS ts'), params: [] };
    },
    aggregated: true,
    search: ['reference', 'visitorName', 'visitorCompany', 'hostName'],
    sortable: ['expectedDeparture', 'visitorName', 'status'],
    defaultSort: 'expectedDeparture ASC',
    filters: {},
  },
  {
    key: 'overdue-visits',
    title: 'Overdue visits',
    description: 'Visitors currently overdue, plus visits in the period that exited after the expected departure.',
    group: 'Visitors',
    columns: VISIT_COLUMNS,
    source: visitSource("WHERE v.status = 'OVERDUE' OR (v.exited_at IS NOT NULL AND v.exited_at > v.expected_departure)"),
    search: ['reference', 'visitorName', 'visitorCompany', 'hostName'],
    sortable: ['expectedDeparture', 'visitorName', 'status'],
    defaultSort: 'expectedDeparture DESC',
    filters: { status: ['OVERDUE', 'EXITED'] },
  },
  {
    key: 'temporary-access',
    title: 'Temporary access',
    description: 'Temporary access records issued in the period.',
    group: 'Access',
    columns: [
      { key: 'reference', label: 'Reference' },
      { key: 'holderName', label: 'Holder' },
      { key: 'holderType', label: 'Holder type', type: 'status' },
      { key: 'holderOrganization', label: 'Organization' },
      { key: 'reason', label: 'Reason' },
      { key: 'locationName', label: 'Location' },
      { key: 'validFrom', label: 'Valid from', type: 'datetime' },
      { key: 'validUntil', label: 'Valid until', type: 'datetime' },
      { key: 'status', label: 'Status', type: 'status' },
      { key: 'movements', label: 'Movements', type: 'number' },
      { key: 'issuedBy', label: 'Issued by' },
    ],
    source: () => ({
      sql: `SELECT t.id, t.reference, t.holder_name AS holderName, t.holder_type AS holderType, t.holder_organization AS holderOrganization, t.reason,
                   t.location_id AS locationId, l.name AS locationName, t.valid_from AS validFrom, t.valid_until AS validUntil,
                   CASE WHEN t.status = 'REVOKED' THEN 'REVOKED' WHEN t.valid_until <= strftime('%Y-%m-%dT%H:%M:%fZ','now') THEN 'EXPIRED' ELSE 'ACTIVE' END AS status,
                   (SELECT COUNT(*) FROM movement_events e WHERE e.temporary_access_id = t.id) AS movements, u.display_name AS issuedBy,
                   t.created_at AS ts, t.organization_id AS orgId
            FROM temporary_access t JOIN locations l ON l.id = t.location_id LEFT JOIN users u ON u.id = t.issued_by`,
      params: [],
    }),
    search: ['reference', 'holderName', 'holderOrganization', 'reason'],
    sortable: ['validFrom', 'validUntil', 'holderName', 'status'],
    defaultSort: 'validFrom DESC',
    filters: { status: ['ACTIVE', 'EXPIRED', 'REVOKED'] },
  },
  {
    key: 'delivery-activity',
    title: 'Delivery activity',
    description: 'Deliveries arriving or expected in the period, with receipt acknowledgement.',
    group: 'Deliveries',
    columns: [
      { key: 'reference', label: 'Reference' },
      { key: 'category', label: 'Category', type: 'status' },
      { key: 'company', label: 'Company' },
      { key: 'courierName', label: 'Courier' },
      { key: 'recipient', label: 'Recipient' },
      { key: 'recipientDepartment', label: 'Department' },
      { key: 'itemCount', label: 'Items', type: 'number' },
      { key: 'locationName', label: 'Location' },
      { key: 'arrivedAt', label: 'Arrived', type: 'datetime' },
      { key: 'status', label: 'Status', type: 'status' },
      { key: 'receivedBy', label: 'Receipt acknowledged by' },
      { key: 'receivedAt', label: 'Acknowledged at', type: 'datetime' },
      { key: 'departedAt', label: 'Departed', type: 'datetime' },
    ],
    source: () => ({
      sql: `SELECT d.id, d.reference, d.category, d.company, d.courier_name AS courierName, COALESCE(ru.display_name, d.recipient_name) AS recipient,
                   d.recipient_department AS recipientDepartment, d.item_count AS itemCount, d.location_id AS locationId, l.name AS locationName,
                   d.gate_id AS gateId, d.arrived_at AS arrivedAt, d.status, COALESCE(d.received_by_name, rc.display_name) AS receivedBy, d.received_at AS receivedAt,
                   d.departed_at AS departedAt, COALESCE(d.arrived_at, d.expected_at, d.created_at) AS ts, d.organization_id AS orgId
            FROM deliveries d JOIN locations l ON l.id = d.location_id LEFT JOIN users ru ON ru.id = d.recipient_user_id LEFT JOIN users rc ON rc.id = d.received_by_user_id`,
      params: [],
    }),
    search: ['reference', 'company', 'courierName', 'recipient', 'recipientDepartment'],
    sortable: ['arrivedAt', 'status', 'company'],
    defaultSort: 'ts DESC',
    filters: { gate: true, status: ['EXPECTED', 'ARRIVED', 'AWAITING_AUTHORIZATION', 'AUTHORIZED', 'RECEIVED', 'DEPARTED', 'REJECTED', 'CANCELLED', 'RETURNED'] },
  },
  {
    key: 'denied-verifications',
    title: 'Denied verification attempts',
    description: 'Every gate verification that did not return Verified.',
    group: 'Gate operations',
    columns: [
      { key: 'createdAt', label: 'Time', type: 'datetime' },
      { key: 'result', label: 'Result', type: 'status' },
      { key: 'mode', label: 'Record type', type: 'status' },
      { key: 'method', label: 'Method' },
      { key: 'inputDisplay', label: 'Presented (masked)' },
      { key: 'subjectName', label: 'Matched record' },
      { key: 'locationName', label: 'Location' },
      { key: 'gateName', label: 'Gate' },
      { key: 'operatorName', label: 'Operator' },
      { key: 'detail', label: 'Detail' },
    ],
    source: () => ({
      sql: `SELECT va.id, va.created_at AS createdAt, va.created_at AS ts, va.result_code AS result, va.result_code AS status, va.mode AS category, va.mode, va.method,
                   va.input_display AS inputDisplay, ${subjectNameSql('va')} AS subjectName, va.location_id AS locationId, l.name AS locationName,
                   va.gate_id AS gateId, g.name AS gateName, u.display_name AS operatorName, va.detail, va.organization_id AS orgId
            FROM verification_attempts va JOIN locations l ON l.id = va.location_id JOIN gates g ON g.id = va.gate_id LEFT JOIN users u ON u.id = va.operator_user_id
            WHERE va.result_code <> 'VERIFIED'`,
      params: [],
    }),
    search: ['inputDisplay', 'subjectName', 'operatorName', 'detail'],
    sortable: ['createdAt', 'result', 'gateName'],
    defaultSort: 'createdAt DESC',
    filters: {
      gate: true,
      category: ['PERSONNEL', 'VISITOR', 'CONTRACTOR', 'TEMPORARY', 'VEHICLE', 'DELIVERY'],
      status: [
        'INVALID_CREDENTIAL', 'INACTIVE_CREDENTIAL', 'BLOCKED_CREDENTIAL', 'LOST_CREDENTIAL', 'EXPIRED_CREDENTIAL', 'INACTIVE_PERSONNEL', 'INACTIVE_RECORD',
        'EXPIRED_ACCESS', 'REVOKED_ACCESS', 'NOT_YET_VALID', 'OUTSIDE_PERMITTED_HOURS', 'WRONG_LOCATION', 'INVALID_PASS', 'EXPIRED_PASS', 'CANCELLED_PASS',
        'NOT_APPROVED', 'ALREADY_USED', 'UNREGISTERED_VEHICLE', 'BLOCKED_VEHICLE', 'MANUAL_REVIEW_REQUIRED', 'NOT_FOUND',
      ],
    },
  },
  {
    key: 'gate-activity',
    title: 'Gate-wise activity',
    description: 'Entries, exits, verifications and failures per gate.',
    group: 'Gate operations',
    aggregated: true,
    columns: [
      { key: 'gateName', label: 'Gate' },
      { key: 'locationName', label: 'Location' },
      { key: 'gateType', label: 'Type', type: 'status' },
      { key: 'entries', label: 'Entries', type: 'number' },
      { key: 'exits', label: 'Exits', type: 'number' },
      { key: 'verifications', label: 'Verifications', type: 'number' },
      { key: 'failures', label: 'Failed verifications', type: 'number' },
    ],
    source: ({ start, end }) => ({
      sql: `SELECT g.id, g.id AS gateId, g.name AS gateName, l.name AS locationName, g.location_id AS locationId, g.gate_type AS gateType, l.organization_id AS orgId,
                   (SELECT COUNT(*) FROM movement_events e WHERE e.gate_id = g.id AND e.event_type = 'ENTRY' AND e.recorded_at >= ? AND e.recorded_at < ? AND NOT EXISTS (SELECT 1 FROM event_corrections c WHERE c.voided_event_id = e.id)) AS entries,
                   (SELECT COUNT(*) FROM movement_events e WHERE e.gate_id = g.id AND e.event_type = 'EXIT' AND e.recorded_at >= ? AND e.recorded_at < ? AND NOT EXISTS (SELECT 1 FROM event_corrections c WHERE c.voided_event_id = e.id)) AS exits,
                   (SELECT COUNT(*) FROM verification_attempts va WHERE va.gate_id = g.id AND va.created_at >= ? AND va.created_at < ?) AS verifications,
                   (SELECT COUNT(*) FROM verification_attempts va WHERE va.gate_id = g.id AND va.result_code <> 'VERIFIED' AND va.created_at >= ? AND va.created_at < ?) AS failures,
                   NULL AS ts
            FROM gates g JOIN locations l ON l.id = g.location_id`,
      params: [start, end, start, end, start, end, start, end],
    }),
    search: ['gateName', 'locationName'],
    sortable: ['gateName', 'locationName', 'entries', 'exits', 'failures'],
    defaultSort: 'entries DESC',
    filters: { gate: true },
  },
  {
    key: 'location-activity',
    title: 'Location-wise activity',
    description: 'Movement, visitors, deliveries and alerts per location.',
    group: 'Gate operations',
    aggregated: true,
    columns: [
      { key: 'locationName', label: 'Location' },
      { key: 'entries', label: 'Entries', type: 'number' },
      { key: 'exits', label: 'Exits', type: 'number' },
      { key: 'visits', label: 'Visits', type: 'number' },
      { key: 'deliveries', label: 'Deliveries', type: 'number' },
      { key: 'failures', label: 'Failed verifications', type: 'number' },
      { key: 'alerts', label: 'Alerts raised', type: 'number' },
    ],
    source: ({ start, end }) => ({
      sql: `SELECT l.id, l.id AS locationId, l.name AS locationName, l.organization_id AS orgId,
                   (SELECT COUNT(*) FROM movement_events e WHERE e.location_id = l.id AND e.event_type = 'ENTRY' AND e.recorded_at >= ? AND e.recorded_at < ? AND NOT EXISTS (SELECT 1 FROM event_corrections c WHERE c.voided_event_id = e.id)) AS entries,
                   (SELECT COUNT(*) FROM movement_events e WHERE e.location_id = l.id AND e.event_type = 'EXIT' AND e.recorded_at >= ? AND e.recorded_at < ? AND NOT EXISTS (SELECT 1 FROM event_corrections c WHERE c.voided_event_id = e.id)) AS exits,
                   (SELECT COUNT(*) FROM visits v WHERE v.location_id = l.id AND v.expected_arrival >= ? AND v.expected_arrival < ?) AS visits,
                   (SELECT COUNT(*) FROM deliveries d WHERE d.location_id = l.id AND COALESCE(d.arrived_at, d.expected_at, d.created_at) >= ? AND COALESCE(d.arrived_at, d.expected_at, d.created_at) < ?) AS deliveries,
                   (SELECT COUNT(*) FROM verification_attempts va WHERE va.location_id = l.id AND va.result_code <> 'VERIFIED' AND va.created_at >= ? AND va.created_at < ?) AS failures,
                   (SELECT COUNT(*) FROM alerts a WHERE a.location_id = l.id AND a.created_at >= ? AND a.created_at < ?) AS alerts,
                   NULL AS ts
            FROM locations l`,
      params: [start, end, start, end, start, end, start, end, start, end, start, end],
    }),
    search: ['locationName'],
    sortable: ['locationName', 'entries', 'exits', 'visits', 'failures'],
    defaultSort: 'locationName ASC',
    filters: {},
  },
  {
    key: 'credential-history',
    title: 'Credential history',
    description: 'Credential issue, block, loss, replacement and status changes.',
    group: 'Access',
    permission: 'credentials.view',
    columns: [
      { key: 'createdAt', label: 'Time', type: 'datetime' },
      { key: 'action', label: 'Action', type: 'status' },
      { key: 'credentialNumber', label: 'Credential (masked)' },
      { key: 'holderName', label: 'Holder' },
      { key: 'holderReference', label: 'Holder ref' },
      { key: 'fromStatus', label: 'From', type: 'status' },
      { key: 'toStatus', label: 'To', type: 'status' },
      { key: 'reason', label: 'Reason' },
      { key: 'actor', label: 'By' },
    ],
    source: () => ({
      sql: `SELECT h.id, h.created_at AS createdAt, h.created_at AS ts, h.action, h.action AS status,
                   substr(c.credential_number, 1, 3) || '…' || substr(c.credential_number, -4) AS credentialNumber,
                   COALESCE((SELECT TRIM(COALESCE(p.rank || ' ', '') || p.full_name) FROM personnel p WHERE p.id = c.personnel_id), (SELECT k.full_name FROM contractors k WHERE k.id = c.contractor_id)) AS holderName,
                   COALESCE((SELECT p.service_number FROM personnel p WHERE p.id = c.personnel_id), (SELECT k.reference FROM contractors k WHERE k.id = c.contractor_id)) AS holderReference,
                   COALESCE((SELECT p.primary_location_id FROM personnel p WHERE p.id = c.personnel_id), (SELECT k.location_id FROM contractors k WHERE k.id = c.contractor_id)) AS locationId,
                   h.from_status AS fromStatus, h.to_status AS toStatus, h.reason, COALESCE(u.display_name, 'System') AS actor, c.organization_id AS orgId
            FROM credential_history h JOIN credentials c ON c.id = h.credential_id LEFT JOIN users u ON u.id = h.actor_user_id`,
      params: [],
    }),
    search: ['credentialNumber', 'holderName', 'holderReference', 'reason', 'actor'],
    sortable: ['createdAt', 'action', 'holderName'],
    defaultSort: 'createdAt DESC',
    filters: { status: ['ISSUED', 'ISSUED_AS_REPLACEMENT', 'BLOCKED', 'REPORTED_LOST', 'DEACTIVATED', 'REACTIVATED', 'REPLACED', 'EXPIRED'] },
  },
  {
    key: 'admin-exceptions',
    title: 'Administrative exceptions',
    description: 'Administrative exceptions created in the period and their resolution.',
    group: 'Administration',
    columns: [
      { key: 'reference', label: 'Reference' },
      { key: 'createdAt', label: 'Created', type: 'datetime' },
      { key: 'category', label: 'Category', type: 'status' },
      { key: 'title', label: 'Title' },
      { key: 'relatedReference', label: 'Related record' },
      { key: 'locationName', label: 'Location' },
      { key: 'responsible', label: 'Responsible' },
      { key: 'status', label: 'Status', type: 'status' },
      { key: 'resolvedBy', label: 'Resolved by' },
      { key: 'resolvedAt', label: 'Resolved at', type: 'datetime' },
      { key: 'resolutionNote', label: 'Resolution note' },
    ],
    source: () => ({
      sql: `SELECT x.id, x.reference, x.created_at AS createdAt, x.created_at AS ts, x.category, x.title, x.related_reference AS relatedReference,
                   x.location_id AS locationId, l.name AS locationName, COALESCE(ru.display_name, x.responsible_role) AS responsible, x.status,
                   rs.display_name AS resolvedBy, x.resolved_at AS resolvedAt, x.resolution_note AS resolutionNote, x.organization_id AS orgId
            FROM admin_exceptions x JOIN locations l ON l.id = x.location_id LEFT JOIN users ru ON ru.id = x.responsible_user_id LEFT JOIN users rs ON rs.id = x.resolved_by`,
      params: [],
    }),
    search: ['reference', 'title', 'relatedReference', 'responsible'],
    sortable: ['createdAt', 'status', 'category'],
    defaultSort: 'createdAt DESC',
    filters: {
      category: ['RECORD_DISCREPANCY', 'MISSING_EXIT', 'EVENT_CORRECTION', 'MANUAL_REVIEW', 'CREDENTIAL_ISSUE', 'VISITOR_ISSUE', 'DELIVERY_ISSUE', 'OTHER'],
      status: ['OPEN', 'UNDER_REVIEW', 'RESOLVED'],
    },
  },
  {
    key: 'audit-history',
    title: 'Audit history',
    description: 'Append-only audit trail of important actions.',
    group: 'Administration',
    permission: 'audit.view',
    allowNullLocation: true,
    columns: [
      { key: 'createdAt', label: 'Time', type: 'datetime' },
      { key: 'actor', label: 'Actor' },
      { key: 'actorRole', label: 'Role', type: 'status' },
      { key: 'action', label: 'Action' },
      { key: 'entityType', label: 'Record type' },
      { key: 'entityRef', label: 'Record' },
      { key: 'outcome', label: 'Outcome', type: 'status' },
      { key: 'locationName', label: 'Location' },
      { key: 'metadata', label: 'Details' },
    ],
    source: () => ({
      sql: `SELECT a.id, a.created_at AS createdAt, a.created_at AS ts, a.actor_username AS actor, a.actor_role AS actorRole, a.action, a.action AS category,
                   a.entity_type AS entityType, COALESCE(a.entity_ref, a.entity_id) AS entityRef, a.outcome, a.outcome AS status,
                   a.location_id AS locationId, l.name AS locationName, a.metadata, a.organization_id AS orgId
            FROM audit_events a LEFT JOIN locations l ON l.id = a.location_id`,
      params: [],
    }),
    search: ['actor', 'action', 'entityType', 'entityRef', 'metadata'],
    sortable: ['createdAt', 'actor', 'action'],
    defaultSort: 'createdAt DESC',
    filters: { status: ['SUCCESS', 'DENIED', 'FAILURE'] },
  },
];

const reportQuery = z.object({
  from: zDate.optional(),
  to: zDate.optional(),
  locationId: z.coerce.number().int().positive().optional(),
  gateId: z.coerce.number().int().positive().optional(),
  category: z.string().max(40).optional(),
  status: z.string().max(40).optional(),
  q: z.string().trim().max(100).optional(),
  sort: z.string().max(40).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

export function listReportDefinitions(ctx: Ctx) {
  requirePerm(ctx.actor, 'reports.view');
  return REPORTS.filter((r) => !r.permission || can(ctx.actor, r.permission)).map((r) => ({
    key: r.key,
    title: r.title,
    description: r.description,
    group: r.group,
    columns: r.columns,
    filters: r.filters,
    dateFiltered: !r.aggregated || r.key !== 'active-visitors',
    sortable: r.sortable,
  }));
}

function getDef(ctx: Ctx, key: string): ReportDef {
  requirePerm(ctx.actor, 'reports.view');
  const def = REPORTS.find((r) => r.key === key);
  if (!def) throw notFound('Report');
  if (def.permission) requirePerm(ctx.actor, def.permission);
  return def;
}

function buildQuery(ctx: Ctx, def: ReportDef, q: z.infer<typeof reportQuery>) {
  const tz = ctx.config.timezone;
  const from = q.from ?? '2000-01-01';
  const to = q.to ?? '2999-12-31';
  const [start, end] = dateRangeToUtc(from, to, tz);
  const src = def.source({ start, end });
  const ids = scopeIds(ctx.actor, q.locationId);
  const scope = sqlIn('r.locationId', ids);
  const where = ['r.orgId = ?'];
  const params: unknown[] = [...src.params, ctx.actor.orgId];
  if (def.allowNullLocation && ctx.actor.allLocations && !q.locationId) {
    where.push(`(${scope.sql} OR r.locationId IS NULL)`);
  } else where.push(scope.sql);
  params.push(...scope.params);
  if (!def.aggregated && (q.from || q.to)) {
    where.push('r.ts >= ? AND r.ts < ?');
    params.push(start, end);
  }
  if (q.gateId && def.filters.gate) {
    where.push('r.gateId = ?');
    params.push(q.gateId);
  }
  if (q.category && def.filters.category?.includes(q.category)) {
    where.push('r.category = ?');
    params.push(q.category);
  }
  if (q.status && def.filters.status?.includes(q.status)) {
    where.push('r.status = ?');
    params.push(q.status);
  }
  if (q.q && def.search.length) {
    const like = likeParam(q.q);
    where.push(`(${def.search.map((c) => `CAST(r.${c} AS TEXT) LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    params.push(...def.search.map(() => like));
  }
  const sortKey = q.sort && def.sortable.includes(q.sort) ? q.sort : null;
  const order = sortKey ? `r.${sortKey} ${q.dir === 'asc' ? 'ASC' : 'DESC'}` : `r.${def.defaultSort}`;
  const sql = `SELECT * FROM (${src.sql}) r WHERE ${where.join(' AND ')}`;
  return { sql, params, order };
}

export function runReport(ctx: Ctx, key: string, raw: unknown) {
  const def = getDef(ctx, key);
  const q = parse(reportQuery, raw);
  const { sql, params, order } = buildQuery(ctx, def, q);
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).get(...params) as { n: number }).n;
  const items = ctx.db.prepare(`${sql} ORDER BY ${order}, r.id DESC LIMIT ? OFFSET ?`).all(...params, q.pageSize, (q.page - 1) * q.pageSize);
  return { key: def.key, title: def.title, columns: def.columns, items, total, page: q.page, pageSize: q.pageSize };
}

const EXPORT_LIMIT = 50_000;

export function exportReportCsv(ctx: Ctx, key: string, raw: unknown): { filename: string; csv: string; rows: number } {
  requirePerm(ctx.actor, 'reports.export');
  const def = getDef(ctx, key);
  const q = parse(reportQuery, raw);
  const { sql, params, order } = buildQuery(ctx, def, q);
  const rows = ctx.db.prepare(`${sql} ORDER BY ${order}, r.id DESC LIMIT ${EXPORT_LIMIT}`).all(...params) as Record<string, unknown>[];
  const csv = toCsv(def.columns, rows);
  const stamp = new Date().toISOString().slice(0, 10);
  audit(ctx, {
    action: 'report.export',
    entityType: 'report',
    entityId: def.key,
    entityRef: def.title,
    locationId: q.locationId ?? null,
    metadata: { rows: rows.length, filters: { from: q.from, to: q.to, locationId: q.locationId, gateId: q.gateId, category: q.category, status: q.status, q: q.q } },
  });
  return { filename: `securegate-${def.key}-${stamp}.csv`, csv, rows: rows.length };
}
