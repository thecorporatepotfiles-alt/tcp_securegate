import { useState } from 'react';
import { ShieldCheck, ShieldX } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { BROWSER_EDITION } from '../lib/edition';
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
            <Notice tone={result.ok ? 'success' : 'danger'} className="no-print mb-4" title={result.ok ? 'No break in the audit chain' : 'Audit chain broken'}>
              {result.ok ? (
                // Claim only what an unkeyed hash chain shows: it cannot prove nothing was removed from the end,
                // and in the browser edition whoever has the browser can rewrite the whole chain.
                <>
                  All {result.checked.toLocaleString('en-IN')} audit records match their hash chain (checked at {fmtTime(result.at)}); no break in the chain was found.
                  {BROWSER_EDITION &&
                    ' This edition keeps its data in this browser, where anyone with access to the browser can change it, so this check only demonstrates the mechanism.'}
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
