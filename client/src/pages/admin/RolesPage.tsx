import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Lock, Save } from 'lucide-react';
import { api } from '../../lib/api';
import type { Permission, RoleCode } from '../../../../shared/constants';
import { useAction } from '../../components/toast';
import { Badge, Button, Card, CardHeader, Checkbox, ErrorState, Modal, Notice, PageHeader, Pill, Spinner, Tabs } from '../../components/ui';

interface RoleRow {
  code: RoleCode;
  name: string;
  description: string;
  rank: number;
  allLocations: boolean;
  permissions: Permission[];
  activeUsers: number;
  assignable: boolean;
}
interface RolesResponse {
  roles: RoleRow[];
  permissions: { code: Permission; group: string; description: string }[];
  lockedAdminPermissions: Permission[];
  canEdit: boolean;
}

/** Mirrors the server rule: the Auditor role may only hold view permissions and report export. */
const auditorAllowed = (p: string) => p.endsWith('.view') || p === 'reports.export';

export default function RolesPage() {
  const q = useQuery({ queryKey: ['admin', 'roles'], queryFn: () => api.get<RolesResponse>('/admin/roles') });
  const [role, setRole] = useState<RoleCode>('HQ_ADMIN');
  const [draft, setDraft] = useState<Set<Permission>>(new Set());
  const [confirm, setConfirm] = useState(false);
  /** Role the user tried to switch to while edits were unsaved. */
  const [pendingRole, setPendingRole] = useState<RoleCode | null>(null);
  const current = q.data?.roles.find((r) => r.code === role);

  useEffect(() => {
    if (current) setDraft(new Set(current.permissions));
  }, [current]);

  const groups = useMemo(() => {
    const m = new Map<string, RolesResponse['permissions']>();
    for (const p of q.data?.permissions ?? []) m.set(p.group, [...(m.get(p.group) ?? []), p]);
    return [...m.entries()];
  }, [q.data]);

  const added = current ? [...draft].filter((p) => !current.permissions.includes(p)) : [];
  const removed = current ? current.permissions.filter((p) => !draft.has(p)) : [];
  const dirty = added.length + removed.length > 0;

  const save = useAction(() => api.put<{ added: string[]; removed: string[] }>(`/admin/roles/${role}`, { permissions: [...draft] }), {
    success: (r) => `Permissions saved (${r.added.length} added, ${r.removed.length} removed). Changes apply on the next request.`,
    invalidate: [['admin', 'roles'], ['me']],
    onSuccess: () => setConfirm(false),
  });

  if (q.isLoading) return <Spinner />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const { roles, lockedAdminPermissions, canEdit } = q.data;
  const isLocked = (p: Permission) => role === 'SYSTEM_ADMIN' && lockedAdminPermissions.includes(p);
  const isBlocked = (p: Permission) => role === 'AUDITOR' && !auditorAllowed(p);

  return (
    <>
      <PageHeader
        title="Roles & permissions"
        subtitle="Permissions are enforced by the server on every request. Location scope is applied separately: local roles never gain access to other locations."
      />
      {!canEdit && <Notice tone="info" className="mb-4">You can view role permissions but not change them.</Notice>}
      <Tabs
        value={role}
        onChange={(v) => {
          if (v === role) return;
          if (dirty) setPendingRole(v);
          else setRole(v);
        }}
        tabs={roles.map((r) => ({ value: r.code, label: r.name, count: r.permissions.length }))}
      />
      {current && (
        <div className="grid gap-5 lg:grid-cols-[300px_1fr]">
          <Card className="h-fit">
            <CardHeader title={current.name} />
            <p className="text-sm text-ink-2">{current.description}</p>
            <div className="mt-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-ink-3">Active users</span>
                <span className="font-medium tabular-nums">{current.activeUsers}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-3">Location scope</span>
                <span className="font-medium">{current.allLocations ? 'All locations' : 'Assigned locations only'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-3">Permissions</span>
                <span className="font-medium tabular-nums">{draft.size}</span>
              </div>
            </div>
            {role === 'SYSTEM_ADMIN' && (
              <Notice tone="info" className="mt-4">
                Locked permissions (<Lock className="inline size-3" aria-hidden />) cannot be removed from the System Administrator, preventing lock-out.
              </Notice>
            )}
            {role === 'AUDITOR' && (
              <Notice tone="warning" className="mt-4">
                The Auditor role is read-only: only view permissions and report export can be granted.
              </Notice>
            )}
            {canEdit && (
              <div className="mt-5 flex flex-col gap-2">
                <Button variant="primary" icon={<Save className="size-4" />} disabled={!dirty} onClick={() => setConfirm(true)}>
                  Review & save
                </Button>
                <Button disabled={!dirty} onClick={() => setDraft(new Set(current.permissions))}>
                  Discard changes
                </Button>
              </div>
            )}
          </Card>
          <div className="grid gap-4 md:grid-cols-2">
            {groups.map(([group, perms]) => (
              <Card key={group}>
                <h3 className="mb-3 text-sm font-semibold text-ink">{group}</h3>
                <div className="space-y-3">
                  {perms.map((p) => (
                    <div key={p.code} className="flex items-start gap-2">
                      <div className="flex-1">
                        <Checkbox
                          label={
                            <span className="flex flex-wrap items-center gap-1.5">
                              {p.description}
                              {isLocked(p.code) && <Lock className="size-3 text-ink-3" aria-label="Locked" />}
                            </span>
                          }
                          hint={p.code}
                          checked={draft.has(p.code)}
                          disabled={!canEdit || isLocked(p.code) || (isBlocked(p.code) && !draft.has(p.code))}
                          onChange={(v) =>
                            setDraft((d) => {
                              const next = new Set(d);
                              if (v) next.add(p.code);
                              else next.delete(p.code);
                              return next;
                            })
                          }
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}
      <Modal
        open={pendingRole !== null}
        onClose={() => setPendingRole(null)}
        size="sm"
        title="Discard unsaved permission changes?"
        footer={
          <>
            <Button data-autofocus onClick={() => setPendingRole(null)}>
              Keep editing
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (pendingRole) setRole(pendingRole);
                setPendingRole(null);
              }}
            >
              Discard changes
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">Your changes to {current?.name ?? 'this role'} have not been saved. Discarding them keeps the role’s saved permissions.</p>
      </Modal>
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Save permissions for ${current?.name}`}
        description="Applies to every user with this role on their next request. The change is recorded in the audit trail."
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>
              Save permissions
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {added.length > 0 && (
            <div>
              <div className="mb-1.5 text-xs font-semibold text-ok">Granting</div>
              <div className="flex flex-wrap gap-1">
                {added.map((p) => (
                  <Pill key={p} className="font-mono">
                    + {p}
                  </Pill>
                ))}
              </div>
            </div>
          )}
          {removed.length > 0 && (
            <div>
              <div className="mb-1.5 text-xs font-semibold text-bad">Removing</div>
              <div className="flex flex-wrap gap-1">
                {removed.map((p) => (
                  <Pill key={p} className="font-mono">
                    − {p}
                  </Pill>
                ))}
              </div>
            </div>
          )}
          {current && current.activeUsers > 0 && <Badge tone="warning">{current.activeUsers} active users affected</Badge>}
        </div>
      </Modal>
    </>
  );
}
