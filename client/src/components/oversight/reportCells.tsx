import type { ReactNode } from 'react';
import {
  VERIFICATION_METHOD_LABEL,
  ALERT_STATUS_INFO,
  CREDENTIAL_STATUS_INFO,
  DELIVERY_STATUS_INFO,
  EXCEPTION_CATEGORY_LABEL,
  EXCEPTION_STATUS_INFO,
  REGISTER_CATEGORY_LABEL,
  RESULT_INFO,
  ROLE_INFO,
  VISIT_STATUS_INFO,
  type Tone,
} from '../../../../shared/constants';
import { fmtDate, fmtDateTime, titleCase } from '../../lib/format';
import { Badge, Pill } from '../ui';
import { EventTypeBadge } from '../status';
import { OutcomeBadge } from './OutcomeBadge';

export interface ReportColumn {
  key: string;
  label: string;
  type?: 'datetime' | 'date' | 'text' | 'number' | 'status' | 'bool';
}

const AUDIT_OUTCOME: Record<string, { label: string; tone: Tone }> = {
  SUCCESS: { label: 'Success', tone: 'success' },
  DENIED: { label: 'Denied', tone: 'danger' },
  FAILURE: { label: 'Failure', tone: 'warning' },
};

const CREDENTIAL_ACTION: Record<string, string> = {
  ISSUED: 'Issued',
  ISSUED_AS_REPLACEMENT: 'Issued as replacement',
  BLOCKED: 'Blocked',
  REPORTED_LOST: 'Reported lost',
  DEACTIVATED: 'Deactivated',
  REACTIVATED: 'Reactivated',
  REPLACED: 'Replaced',
  EXPIRED: 'Expired',
};

/** Human label + tone for a status-like code, whatever report it comes from. */
export function codeInfo(code: string, columnKey?: string): { label: string; tone?: Tone } {
  if (columnKey === 'outcome' && AUDIT_OUTCOME[code]) return AUDIT_OUTCOME[code];
  if (columnKey === 'action' && CREDENTIAL_ACTION[code]) return { label: CREDENTIAL_ACTION[code] };
  if (columnKey === 'actorRole' && code in ROLE_INFO) return { label: ROLE_INFO[code as keyof typeof ROLE_INFO].name };
  if (code in RESULT_INFO) return RESULT_INFO[code as keyof typeof RESULT_INFO];
  if (columnKey === 'category' && code in EXCEPTION_CATEGORY_LABEL) return { label: EXCEPTION_CATEGORY_LABEL[code as keyof typeof EXCEPTION_CATEGORY_LABEL] };
  if (code in REGISTER_CATEGORY_LABEL) return { label: REGISTER_CATEGORY_LABEL[code as keyof typeof REGISTER_CATEGORY_LABEL] };
  if (code in VISIT_STATUS_INFO) return VISIT_STATUS_INFO[code as keyof typeof VISIT_STATUS_INFO];
  if (code in DELIVERY_STATUS_INFO) return DELIVERY_STATUS_INFO[code as keyof typeof DELIVERY_STATUS_INFO];
  if (code in EXCEPTION_STATUS_INFO) return EXCEPTION_STATUS_INFO[code as keyof typeof EXCEPTION_STATUS_INFO];
  if (code in ALERT_STATUS_INFO) return ALERT_STATUS_INFO[code as keyof typeof ALERT_STATUS_INFO];
  if (code in CREDENTIAL_STATUS_INFO) return CREDENTIAL_STATUS_INFO[code as keyof typeof CREDENTIAL_STATUS_INFO];
  if (code in AUDIT_OUTCOME) return AUDIT_OUTCOME[code];
  if (code in CREDENTIAL_ACTION) return { label: CREDENTIAL_ACTION[code] };
  if (code === 'REVOKED') return { label: 'Revoked', tone: 'danger' };
  if (code === 'PRE_REGISTERED') return { label: 'Pre-registered' };
  if (code === 'WALK_IN') return { label: 'Walk-in' };
  return { label: titleCase(code) };
}

/** Compact, readable rendering of an audit metadata JSON blob. */
export function MetadataSummary({ raw }: { raw: unknown }) {
  if (raw == null || raw === '') return <span className="text-ink-3">—</span>;
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return <span className="text-xs text-ink-2">{raw}</span>;
    }
  }
  if (typeof data !== 'object' || data === null) return <span className="text-xs text-ink-2">{String(data)}</span>;
  const entries = Object.entries(data as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (entries.length === 0) return <span className="text-ink-3">—</span>;
  const show = (v: unknown): string => {
    if (Array.isArray(v)) return v.length ? v.map(show).join(', ') : 'none';
    if (typeof v === 'object' && v) {
      return Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== null && x !== undefined && x !== '')
        .map(([k, x]) => `${k}: ${show(x)}`)
        .join('; ');
    }
    return String(v);
  };
  return (
    <dl className="flex max-w-md flex-wrap gap-x-3 gap-y-0.5 text-xs">
      {entries.slice(0, 6).map(([k, v]) => (
        <div key={k} className="flex min-w-0 gap-1">
          <dt className="text-ink-3">{k}:</dt>
          <dd className="truncate text-ink-2" title={show(v)}>
            {show(v)}
          </dd>
        </div>
      ))}
      {entries.length > 6 && <span className="text-ink-3">+{entries.length - 6} more</span>}
    </dl>
  );
}

const SHORT_METHOD: Record<string, string> = {
  CREDENTIAL: 'Credential',
  MOCK_READER: 'Mock reader',
  QR: 'QR (simulated)',
  REFERENCE: 'Manual reference',
  PLATE: 'Plate lookup',
  ADMIN_CORRECTION: 'Correction',
};
const REFERENCE_KEYS = new Set(['reference', 'subjectReference', 'entityRef', 'inputDisplay', 'credentialNumber', 'holderReference', 'relatedReference']);
const LONG_TEXT_KEYS = new Set(['description', 'purpose', 'reason', 'detail', 'resolutionNote', 'title', 'destination']);

export function methodLabel(code: string): string {
  return SHORT_METHOD[code] ?? VERIFICATION_METHOD_LABEL[code as keyof typeof VERIFICATION_METHOD_LABEL] ?? code;
}

export function renderReportCell(col: ReportColumn, value: unknown): ReactNode {
  if (value === null || value === undefined || value === '') return <span className="text-ink-3">—</span>;
  if (col.key === 'metadata') return <MetadataSummary raw={value} />;
  switch (col.type) {
    case 'datetime':
      return <span className="whitespace-nowrap">{fmtDateTime(String(value))}</span>;
    case 'date':
      return <span className="whitespace-nowrap">{fmtDate(String(value))}</span>;
    case 'number':
      return <span className="tabular-nums">{Number(value).toLocaleString('en-IN')}</span>;
    case 'bool':
      return Number(value) ? <Badge tone="neutral">Yes</Badge> : <span className="text-ink-3">—</span>;
    case 'status': {
      const code = String(value);
      if (col.key === 'eventType' && (code === 'ENTRY' || code === 'EXIT')) return <EventTypeBadge type={code} />;
      if (col.key === 'outcome' && ['RECORDED', 'RECORDED_AFTER_REVIEW', 'CORRECTION_ENTRY'].includes(code)) return <OutcomeBadge outcome={code} />;
      const info = codeInfo(code, col.key);
      return info.tone ? <Badge tone={info.tone}>{info.label}</Badge> : <Pill className="whitespace-nowrap">{info.label}</Pill>;
    }
    default: {
      const text = String(value);
      if (col.key === 'method' || col.key === 'verificationMethod') return <span className="whitespace-nowrap" title={VERIFICATION_METHOD_LABEL[text as keyof typeof VERIFICATION_METHOD_LABEL]}>{methodLabel(text)}</span>;
      if (REFERENCE_KEYS.has(col.key)) return <span className="font-mono text-xs whitespace-nowrap text-ink-2">{text}</span>;
      if (LONG_TEXT_KEYS.has(col.key)) return <span className="block max-w-xs min-w-[180px] break-words">{text}</span>;
      return <span className="whitespace-nowrap">{text}</span>;
    }
  }
}
