import { Badge } from '../ui';
import type { Tone } from '../../../../shared/constants';

const INFO: Record<string, { label: string; tone: Tone }> = {
  ACTIVE: { label: 'Active', tone: 'success' },
  UPCOMING: { label: 'Not yet valid', tone: 'info' },
  EXPIRED: { label: 'Expired', tone: 'neutral' },
  REVOKED: { label: 'Revoked', tone: 'danger' },
};

export function TempStatusBadge({ status }: { status: string }) {
  const i = INFO[status] ?? { label: status, tone: 'neutral' as Tone };
  return <Badge tone={i.tone}>{i.label}</Badge>;
}

export const HOLDER_LABEL: Record<string, string> = { PERSONNEL: 'Personnel', CONTRACTOR: 'Contractor', INDIVIDUAL: 'Individual' };
