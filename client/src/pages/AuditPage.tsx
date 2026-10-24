import { useState } from 'react';
import { ShieldCheck, ShieldX } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { fmtTime } from '../lib/format';
import { Button, Notice, PageHeader } from '../components/ui';
import { ReportView } from '../components/oversight/ReportView';

interface ChainResult {
  ok: boolean;
  checked: number;
  brokenAtId: number | null;
}

export default function AuditPage() {
  const [result, setResult] = useState<(ChainResult & { at: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.get<ChainResult>('/audit/verify');
      setResult({ ...r, at: new Date().toISOString() });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ReportView
      reportKey="audit-history"
      header={(_def, actions) => (
        <>
          <PageHeader
            eyebrow="Accountability"
            title="Audit trail"
            subtitle="Append-only record of important actions: who did what, when, to which record, and the outcome. Passwords, tokens and QR secrets are never logged."
            actions={
              <>
                <Button variant="primary" icon={<ShieldCheck className="size-4" />} loading={busy} onClick={verify}>
                  Verify integrity
                </Button>
                {actions}
              </>
            }
          />
          {result && (
            <Notice tone={result.ok ? 'success' : 'danger'} className="no-print mb-4" title={result.ok ? 'Audit chain intact' : 'Audit chain broken'}>
              {result.ok ? (
                <>
                  All {result.checked.toLocaleString('en-IN')} audit records verified against their hash chain at {fmtTime(result.at)}. No record has been altered or removed.
                </>
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <ShieldX className="size-4" aria-hidden /> Verification failed at audit record #{result.brokenAtId} after {result.checked.toLocaleString('en-IN')} valid records. Investigate under
                  established procedures.
                </span>
              )}
            </Notice>
          )}
          {error && (
            <Notice tone="danger" className="no-print mb-4">
              {error}
            </Notice>
          )}
        </>
      )}
    />
  );
}
