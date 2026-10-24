import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import {
  ALERT_SEVERITIES,
  ALERT_TYPES,
  ALERT_TYPE_INFO,
  DELIVERY_STATUSES,
  DELIVERY_STATUS_INFO,
  RESULT_CODES,
  RESULT_INFO,
  VISIT_STATUSES,
  VISIT_STATUS_INFO,
} from '../../../../shared/constants';
import { useAction } from '../../components/toast';
import { Button, Card, Checkbox, ErrorState, Input, Notice, PageHeader, Select, Spinner, Tabs, cx } from '../../components/ui';

interface SettingRow {
  key: string;
  value: unknown;
  description: string;
}

type Kind = 'bool' | 'number' | 'categories' | 'transitions' | 'alertRules' | 'resultList';

const META: Record<string, { label: string; kind: Kind; min?: number; max?: number; unit?: string }> = {
  'visit.requireSecurityCheck': { label: 'Security verification step before pass', kind: 'bool' },
  'visit.allowSelfApproval': { label: 'Allow requesters to approve their own visits', kind: 'bool' },
  'visit.passSingleUse': { label: 'Single-use visitor passes', kind: 'bool' },
  'visit.passEarlyMinutes': { label: 'Pass valid before arrival', kind: 'number', min: 0, max: 720, unit: 'minutes' },
  'visit.passGraceMinutes': { label: 'Pass grace after departure', kind: 'number', min: 0, max: 720, unit: 'minutes' },
  'visit.overstayGraceMinutes': { label: 'Overstay grace period', kind: 'number', min: 0, max: 720, unit: 'minutes' },
  'visit.transitions': { label: 'Visitor status transitions', kind: 'transitions' },
  'delivery.requireAuthorization': { label: 'Deliveries require authorization', kind: 'bool' },
  'delivery.ackOverdueHours': { label: 'Receipt acknowledgement alert after', kind: 'number', min: 1, max: 168, unit: 'hours' },
  'delivery.transitions': { label: 'Delivery status transitions', kind: 'transitions' },
  'delivery.categories': { label: 'Delivery categories', kind: 'categories' },
  'vehicle.categories': { label: 'Vehicle categories', kind: 'categories' },
  'gate.verificationTtlSeconds': { label: 'Verification usable for', kind: 'number', min: 30, max: 1800, unit: 'seconds' },
  'gate.manualReviewEligible': { label: 'Results eligible for manual review', kind: 'resultList' },
  'gate.manualReviewValidityMinutes': { label: 'Approved manual review valid for', kind: 'number', min: 5, max: 240, unit: 'minutes' },
  'gate.guardCanAuthorizeDelivery': { label: 'Gate operators may authorize deliveries', kind: 'bool' },
  'alerts.rules': { label: 'Alert rules', kind: 'alertRules' },
  'alerts.repeatedFailureThreshold': { label: 'Repeated-failure threshold', kind: 'number', min: 2, max: 50, unit: 'failures' },
  'alerts.repeatedFailureWindowMinutes': { label: 'Repeated-failure window', kind: 'number', min: 1, max: 240, unit: 'minutes' },
  'exceptions.unresolvedHours': { label: 'Unresolved exception alert after', kind: 'number', min: 1, max: 720, unit: 'hours' },
};

const SECTIONS: { id: string; label: string; keys: string[] }[] = [
  { id: 'visitors', label: 'Visitor workflow', keys: ['visit.requireSecurityCheck', 'visit.allowSelfApproval', 'visit.passSingleUse', 'visit.passEarlyMinutes', 'visit.passGraceMinutes', 'visit.overstayGraceMinutes', 'visit.transitions'] },
  { id: 'deliveries', label: 'Delivery workflow', keys: ['delivery.requireAuthorization', 'delivery.ackOverdueHours', 'delivery.categories', 'delivery.transitions'] },
  { id: 'gate', label: 'Gate operations', keys: ['gate.verificationTtlSeconds', 'gate.manualReviewValidityMinutes', 'gate.guardCanAuthorizeDelivery', 'gate.manualReviewEligible', 'vehicle.categories'] },
  { id: 'alerts', label: 'Alerts & exceptions', keys: ['alerts.repeatedFailureThreshold', 'alerts.repeatedFailureWindowMinutes', 'exceptions.unresolvedHours', 'alerts.rules'] },
];

export default function SettingsPage() {
  const q = useQuery({ queryKey: ['admin', 'settings'], queryFn: () => api.get<SettingRow[]>('/admin/settings') });
  const [section, setSection] = useState('visitors');
  const byKey = useMemo(() => new Map((q.data ?? []).map((s) => [s.key, s])), [q.data]);

  return (
    <>
      <PageHeader
        title="Workflow settings"
        subtitle="Configurable rules enforced by the server. Defaults are safe demonstration values, not operational policy — the establishment must approve final settings."
      />
      <Tabs value={section} onChange={setSection} tabs={SECTIONS.map((s) => ({ value: s.id, label: s.label }))} />
      {q.isLoading ? (
        <Spinner />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {SECTIONS.find((s) => s.id === section)!
            .keys.map((k) => byKey.get(k))
            .filter((s): s is SettingRow => !!s)
            .map((s) => (
              <SettingEditor key={s.key} setting={s} />
            ))}
        </div>
      )}
    </>
  );
}

function SettingEditor({ setting }: { setting: SettingRow }) {
  const meta = META[setting.key] ?? { label: setting.key, kind: 'number' as Kind };
  const [draft, setDraft] = useState<unknown>(setting.value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(setting.value), [setting.value]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(setting.value);
  const save = useAction((value: unknown) => api.put(`/admin/settings/${setting.key}`, { value }), {
    success: `${meta.label} saved`,
    invalidate: [['admin', 'settings'], ['me']],
    onError: () => {
      if (meta.kind === 'bool') setDraft(setting.value);
    },
  });

  const validate = (): string | null => {
    if (meta.kind === 'number') {
      const n = draft as number;
      if (!Number.isInteger(n) || n < (meta.min ?? 0) || n > (meta.max ?? Infinity)) return `Enter a whole number between ${meta.min} and ${meta.max}`;
    }
    if (meta.kind === 'categories') {
      const list = draft as { code: string; label: string }[];
      if (list.length === 0) return 'Keep at least one category';
      if (list.some((c) => !/^[A-Z][A-Z0-9_]{1,30}$/.test(c.code))) return 'Codes: upper-case letters, digits and underscores (start with a letter)';
      if (list.some((c) => !c.label.trim())) return 'Every category needs a label';
      if (new Set(list.map((c) => c.code)).size !== list.length) return 'Codes must be unique';
    }
    return null;
  };

  const wide = ['transitions', 'alertRules', 'resultList', 'categories'].includes(meta.kind);
  return (
    <Card className={cx('min-w-0', wide && 'lg:col-span-2')}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-ink">{meta.label}</h3>
          <p className="mt-0.5 text-[13px] text-ink-3">{setting.description}</p>
          <p className="mt-0.5 font-mono text-[11px] text-ink-3">{setting.key}</p>
        </div>
        {meta.kind !== 'bool' && (
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" icon={<RotateCcw className="size-4" />} disabled={!dirty} onClick={() => setDraft(setting.value)}>
              Reset
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<Save className="size-4" />}
              disabled={!dirty}
              loading={save.isPending}
              onClick={() => {
                const v = validate();
                setError(v);
                if (!v) save.mutate(draft);
              }}
            >
              Save
            </Button>
          </div>
        )}
      </div>
      {error && <Notice tone="danger" className="mb-3">{error}</Notice>}
      {meta.kind === 'bool' && (
        <BoolEditor value={draft as boolean} saving={save.isPending} onChange={(v) => { setDraft(v); save.mutate(v); }} />
      )}
      {meta.kind === 'number' && (
        <div className="flex items-center gap-2">
          <Input type="number" aria-label={meta.label} className="w-32" min={meta.min} max={meta.max} value={String(draft ?? '')} onChange={(e) => setDraft(e.target.value === '' ? NaN : Number(e.target.value))} />
          <span className="text-sm text-ink-3">
            {meta.unit} ({meta.min}–{meta.max})
          </span>
        </div>
      )}
      {meta.kind === 'categories' && <CategoryEditor value={draft as { code: string; label: string }[]} onChange={setDraft} />}
      {meta.kind === 'alertRules' && <AlertRulesEditor value={draft as Record<string, { enabled: boolean; severity: string }>} onChange={setDraft} />}
      {meta.kind === 'resultList' && <ResultListEditor value={draft as string[]} onChange={setDraft} />}
      {meta.kind === 'transitions' && (
        <TransitionMatrix
          value={draft as Record<string, string[]>}
          onChange={setDraft}
          statuses={setting.key.startsWith('visit') ? [...VISIT_STATUSES] : [...DELIVERY_STATUSES]}
          label={(s) => (setting.key.startsWith('visit') ? VISIT_STATUS_INFO[s as keyof typeof VISIT_STATUS_INFO]?.label : DELIVERY_STATUS_INFO[s as keyof typeof DELIVERY_STATUS_INFO]?.label) ?? s}
          note={
            setting.key.startsWith('visit')
              ? 'Inside / Exited / Overdue are only reached through recorded gate events and authorized corrections; Approved only through an approval decision. Removing a transition blocks the matching action on the server.'
              : 'Each delivery action still checks its own preconditions (for example, receipt can only be acknowledged once authorized).'
          }
        />
      )}
    </Card>
  );
}

function BoolEditor({ value, onChange, saving }: { value: boolean; onChange: (v: boolean) => void; saving: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={value}
        disabled={saving}
        onClick={() => onChange(!value)}
        className={cx('relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60', value ? 'bg-forest-600' : 'bg-line-strong')}
      >
        <span className={cx('absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform', value && 'translate-x-5')} />
      </button>
      <span className="text-sm font-medium text-ink">{value ? 'Enabled' : 'Disabled'}</span>
      <span className="text-xs text-ink-3">Saved immediately</span>
    </div>
  );
}

function CategoryEditor({ value, onChange }: { value: { code: string; label: string }[]; onChange: (v: { code: string; label: string }[]) => void }) {
  return (
    <div className="space-y-2">
      {value.map((c, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Input aria-label="Code" className="w-44 font-mono" value={c.code} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') } : x)))} />
          <Input aria-label="Label" className="min-w-[180px] flex-1" value={c.label} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
          <Button size="sm" variant="ghost" aria-label={`Remove ${c.label || c.code}`} icon={<Trash2 className="size-4" />} disabled={value.length <= 1} onClick={() => onChange(value.filter((_, j) => j !== i))} />
        </div>
      ))}
      <Button size="sm" icon={<Plus className="size-4" />} onClick={() => onChange([...value, { code: '', label: '' }])} disabled={value.length >= 30}>
        Add category
      </Button>
      <p className="text-xs text-ink-3">Existing records keep their category code even if it is removed from this list.</p>
    </div>
  );
}

function AlertRulesEditor({ value, onChange }: { value: Record<string, { enabled: boolean; severity: string }>; onChange: (v: Record<string, { enabled: boolean; severity: string }>) => void }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-ink-3">
            <th className="py-2 pr-4 font-semibold">Alert type</th>
            <th className="py-2 pr-4 font-semibold">Enabled</th>
            <th className="py-2 font-semibold">Severity</th>
          </tr>
        </thead>
        <tbody>
          {ALERT_TYPES.map((t) => {
            const rule = value[t] ?? { enabled: true, severity: ALERT_TYPE_INFO[t].defaultSeverity };
            return (
              <tr key={t} className="border-b border-line/70 last:border-0">
                <td className="py-2 pr-4">{ALERT_TYPE_INFO[t].label}</td>
                <td className="py-2 pr-4">
                  <input type="checkbox" className="size-4 accent-[var(--color-forest-700)]" aria-label={`Enable ${ALERT_TYPE_INFO[t].label}`} checked={rule.enabled} onChange={(e) => onChange({ ...value, [t]: { ...rule, enabled: e.target.checked } })} />
                </td>
                <td className="py-1.5">
                  <Select aria-label={`Severity for ${ALERT_TYPE_INFO[t].label}`} className="h-9 w-36" value={rule.severity} disabled={!rule.enabled} onChange={(e) => onChange({ ...value, [t]: { ...rule, severity: e.target.value } })} options={ALERT_SEVERITIES.map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-ink-3">Alert rules only control recording and severity. Escalation procedures are not configured by this system.</p>
    </div>
  );
}

function ResultListEditor({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const codes = RESULT_CODES.filter((r) => r !== 'VERIFIED');
  return (
    <div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {codes.map((r) => (
          <Checkbox key={r} label={RESULT_INFO[r].label} checked={value.includes(r)} onChange={(v) => onChange(v ? [...value, r] : value.filter((x) => x !== r))} />
        ))}
      </div>
      <p className="mt-3 text-xs text-ink-3">A manual review always needs a decision by another authorized user and creates an audit record; it never bypasses verification silently.</p>
    </div>
  );
}

function TransitionMatrix({ value, onChange, statuses, label, note }: { value: Record<string, string[]>; onChange: (v: Record<string, string[]>) => void; statuses: string[]; label: (s: string) => string; note: ReactNode }) {
  const toggle = (from: string, to: string, on: boolean) => {
    const cur = value[from] ?? [];
    onChange({ ...value, [from]: on ? [...cur, to] : cur.filter((x) => x !== to) });
  };
  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="text-xs">
          <thead>
            <tr className="bg-canvas">
              <th className="sticky left-0 z-10 bg-canvas px-3 py-2 text-left font-semibold text-ink-3">From ↓ / To →</th>
              {statuses.map((s) => (
                <th key={s} className="px-2 py-2 text-center font-semibold whitespace-nowrap text-ink-2">
                  {label(s)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {statuses.map((from) => (
              <tr key={from} className="border-t border-line">
                <th scope="row" className="sticky left-0 z-10 bg-white px-3 py-1.5 text-left font-medium whitespace-nowrap text-ink">
                  {label(from)}
                </th>
                {statuses.map((to) => (
                  <td key={to} className={cx('px-2 py-1.5 text-center', from === to && 'bg-canvas')}>
                    {from === to ? (
                      <span className="text-ink-3" aria-hidden>
                        ·
                      </span>
                    ) : (
                      <input
                        type="checkbox"
                        className="size-4 accent-[var(--color-forest-700)]"
                        aria-label={`${label(from)} to ${label(to)}`}
                        checked={(value[from] ?? []).includes(to)}
                        onChange={(e) => toggle(from, to, e.target.checked)}
                      />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-ink-3">{note}</p>
    </div>
  );
}
