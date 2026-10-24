import { Badge } from '../ui';

export function OutcomeBadge({ outcome, voided }: { outcome: string; voided?: number | boolean }) {
  if (voided) return <Badge tone="neutral">Voided</Badge>;
  if (outcome === 'RECORDED_AFTER_REVIEW') return <Badge tone="warning">After manual review</Badge>;
  if (outcome === 'CORRECTION_ENTRY') return <Badge tone="info">Correction entry</Badge>;
  return <Badge tone="success">Recorded</Badge>;
}
