import {
  ALERT_SEVERITY_TONE,
  ALERT_STATUS_INFO,
  CREDENTIAL_STATUS_INFO,
  DELIVERY_STATUS_INFO,
  EXCEPTION_STATUS_INFO,
  MANUAL_REVIEW_INFO,
  REGISTER_CATEGORY_LABEL,
  RESULT_INFO,
  VEHICLE_AUTH_INFO,
  VISIT_STATUS_INFO,
  type AlertSeverity,
  type AlertStatus,
  type CredentialStatus,
  type DeliveryStatus,
  type ExceptionStatus,
  type ManualReviewStatus,
  type RegisterCategory,
  type ResultCode,
  type VehicleAuthStatus,
  type VisitStatus,
} from '../../../shared/constants';
import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { Badge, Pill, cx } from './ui';
import { titleCase } from '../lib/format';

export const VisitStatusBadge = ({ status }: { status: VisitStatus }) => <Badge tone={VISIT_STATUS_INFO[status]?.tone ?? 'neutral'}>{VISIT_STATUS_INFO[status]?.label ?? status}</Badge>;
export const DeliveryStatusBadge = ({ status }: { status: DeliveryStatus }) => <Badge tone={DELIVERY_STATUS_INFO[status]?.tone ?? 'neutral'}>{DELIVERY_STATUS_INFO[status]?.label ?? status}</Badge>;
export const CredentialStatusBadge = ({ status }: { status: CredentialStatus }) => <Badge tone={CREDENTIAL_STATUS_INFO[status]?.tone ?? 'neutral'}>{CREDENTIAL_STATUS_INFO[status]?.label ?? status}</Badge>;
export const AlertStatusBadge = ({ status }: { status: AlertStatus }) => <Badge tone={ALERT_STATUS_INFO[status]?.tone ?? 'neutral'}>{ALERT_STATUS_INFO[status]?.label ?? status}</Badge>;
export const SeverityBadge = ({ severity }: { severity: AlertSeverity }) => (
  <Badge tone={ALERT_SEVERITY_TONE[severity] ?? 'neutral'} icon={false} className="tracking-wide uppercase">
    {severity}
  </Badge>
);
export const ExceptionStatusBadge = ({ status }: { status: ExceptionStatus }) => <Badge tone={EXCEPTION_STATUS_INFO[status]?.tone ?? 'neutral'}>{EXCEPTION_STATUS_INFO[status]?.label ?? status}</Badge>;
export const ReviewStatusBadge = ({ status }: { status: ManualReviewStatus }) => <Badge tone={MANUAL_REVIEW_INFO[status]?.tone ?? 'neutral'}>{MANUAL_REVIEW_INFO[status]?.label ?? status}</Badge>;
export const ResultBadge = ({ result }: { result: ResultCode }) => <Badge tone={RESULT_INFO[result]?.tone ?? 'neutral'}>{RESULT_INFO[result]?.label ?? titleCase(result)}</Badge>;
export const VehicleAuthBadge = ({ status }: { status: VehicleAuthStatus }) => <Badge tone={VEHICLE_AUTH_INFO[status]?.tone ?? 'neutral'}>{VEHICLE_AUTH_INFO[status]?.label ?? status}</Badge>;

export function PersonStatusBadge({ status }: { status: 'ACTIVE' | 'INACTIVE' | 'CANCELLED' | string }) {
  return <Badge tone={status === 'ACTIVE' ? 'success' : status === 'CANCELLED' ? 'danger' : 'neutral'}>{titleCase(status)}</Badge>;
}

export function PresenceBadge({ state }: { state?: 'INSIDE' | 'OUTSIDE' | null }) {
  if (state === 'INSIDE') return <Badge tone="success">Inside</Badge>;
  if (state === 'OUTSIDE') return <Badge tone="neutral">Outside</Badge>;
  return <Badge tone="neutral" icon={false}>No movement</Badge>;
}

export function EventTypeBadge({ type, voided }: { type: 'ENTRY' | 'EXIT'; voided?: boolean | number }) {
  return (
    <span className={cx('inline-flex items-center gap-1 text-xs font-semibold', voided ? 'text-ink-3 line-through' : type === 'ENTRY' ? 'text-ok' : 'text-info')}>
      {type === 'ENTRY' ? <ArrowDownLeft className="size-3.5" aria-hidden /> : <ArrowUpRight className="size-3.5" aria-hidden />}
      {type === 'ENTRY' ? 'Entry' : 'Exit'}
      {voided ? <span className="ml-1 font-normal no-underline">(voided)</span> : null}
    </span>
  );
}

export function CategoryPill({ category }: { category: RegisterCategory | string }) {
  return <Pill>{REGISTER_CATEGORY_LABEL[category as RegisterCategory] ?? titleCase(category)}</Pill>;
}

export function SimulatedTag({ children = 'Simulated' }: { children?: string }) {
  return (
    <span className="inline-flex items-center rounded-md border border-dashed border-gold-500/60 bg-gold-100 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-gold-600 uppercase">
      {children}
    </span>
  );
}
