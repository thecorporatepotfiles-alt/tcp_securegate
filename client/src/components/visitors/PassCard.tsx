import { useState, type ReactNode } from 'react';
import { Copy, Printer } from 'lucide-react';
import { fmtDateTime } from '../../lib/format';
import { LogoMark } from '../Logo';
import { Button, Notice, cx } from '../ui';
import { SimulatedTag } from '../status';

/**
 * Printable digital pass with a QR code. The QR holds only an opaque signed
 * token; verification always happens on the server.
 */
export function PassCard({
  kind,
  title,
  reference,
  qrSvg,
  token,
  status,
  lines,
  validFrom,
  validUntil,
  footer,
}: {
  kind: string;
  title: string;
  reference: string;
  qrSvg: string;
  token?: string;
  status?: ReactNode;
  lines: { label: string; value: ReactNode }[];
  validFrom?: string | null;
  validUntil?: string | null;
  footer?: ReactNode;
}) {
  const [showCode, setShowCode] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="print-pass mx-auto max-w-md overflow-hidden rounded-2xl border border-line bg-white shadow-[var(--shadow-card)]">
        <div className="flex items-center justify-between gap-3 bg-forest-900 px-5 py-4 text-white">
          <div className="flex items-center gap-2.5">
            <LogoMark size={30} />
            <div className="leading-tight">
              <div className="text-[10px] font-semibold tracking-[0.16em] text-gold-400 uppercase">TCP SecureGate</div>
              <div className="text-sm font-semibold">{kind}</div>
            </div>
          </div>
          <SimulatedTag>Demo pass</SimulatedTag>
        </div>
        <div className="grid gap-4 p-5">
          <div className="qr-box mx-auto w-[200px] rounded-lg border border-line bg-white p-2" aria-label={`QR code for ${reference}`} role="img" dangerouslySetInnerHTML={{ __html: qrSvg }} />
          <div className="text-center">
            <div className="text-lg leading-tight font-semibold text-ink">{title}</div>
            <div className="font-mono text-xs text-ink-3">{reference}</div>
            {status && <div className="mt-2">{status}</div>}
          </div>
          <dl className="divide-y divide-line/70 rounded-lg border border-line text-[13px]">
            {lines.map((l) => (
              <div key={l.label} className="grid grid-cols-[110px_1fr] gap-3 px-3 py-2">
                <dt className="text-ink-3">{l.label}</dt>
                <dd className="min-w-0 break-words text-ink">{l.value || '—'}</dd>
              </div>
            ))}
          </dl>
        </div>
        {(validFrom || validUntil) && (
          <div className="border-t border-line bg-canvas/60 px-5 py-3 text-[13px]">
            <span className="text-ink-3">Valid </span>
            <span className="font-medium text-ink">
              {fmtDateTime(validFrom)} → {fmtDateTime(validUntil)}
            </span>
          </div>
        )}
        <div className="border-t border-line px-5 py-3 text-[11px] leading-snug text-ink-3">
          Present this code at the gate. A scan alone does not authorize entry — the gate verifies it with the server and records entry only after confirmation. Synthetic demonstration pass; not valid at any real facility.
        </div>
        {footer}
      </div>
      <div className="no-print mx-auto mt-3 flex max-w-md flex-wrap items-center justify-center gap-2">
        <Button size="sm" icon={<Printer className="size-4" />} onClick={() => window.print()}>
          Print pass
        </Button>
        {token && (
          <Button size="sm" variant="ghost" onClick={() => setShowCode((v) => !v)}>
            {showCode ? 'Hide test code' : 'Show code for testing'}
          </Button>
        )}
      </div>
      {token && showCode && (
        <div className="no-print mx-auto mt-2 max-w-md">
          <Notice tone="info" title="Opaque pass code (demo testing only)">
            <div className="mt-1 flex items-center gap-2">
              <code className={cx('min-w-0 flex-1 truncate rounded bg-white px-2 py-1 font-mono text-[11px] text-ink-2')}>{token}</code>
              <Button
                size="sm"
                icon={<Copy className="size-3.5" />}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(token);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  } catch {
                    setCopied(false);
                  }
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <div className="mt-1 text-xs">Contains no personal data. Paste into the gate's manual entry to simulate a scan.</div>
          </Notice>
        </div>
      )}
    </div>
  );
}

/** Print stylesheet: only the pass is printed when a pass page is printed. */
export function PassPrintStyle() {
  return (
    <style>{`@media print {
      body * { visibility: hidden !important; }
      .print-pass, .print-pass * { visibility: visible !important; }
      .print-pass { position: absolute; left: 0; top: 0; width: 100%; max-width: 420px; box-shadow: none !important; }
    }`}</style>
  );
}
