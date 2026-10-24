import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { KeyRound, Pencil, Plus, Power, UserCog } from 'lucide-react';
import { ApiError, api, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useListParams } from '../../lib/useListParams';
import { fmtDateTime } from '../../lib/format';
import type { LocationInfo, Row } from '../../lib/types';
import { ROLES, ROLE_INFO, type RoleCode } from '../../../../shared/constants';
import { useAction } from '../../components/toast';
import { Avatar, Badge, Button, Card, Checkbox, DataTable, EmptyState, ErrorState, Field, FilterBar, Input, Modal, Notice, PageHeader, Pagination, Pill, SearchInput, Select } from '../../components/ui';
import { fieldErrors } from '../../components/ops/common';

const DEFAULTS = { q: '', role: '', active: '', locationId: '' };

interface RolesResponse {
  roles: { code: RoleCode; name: string; allLocations: boolean; assignable: boolean }[];
}

function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const b = new Uint8Array(14);
  crypto.getRandomValues(b);
  const s = Array.from(b, (x) => chars[x % chars.length]).join('');
  return `${s.slice(0, 7)}-${s.slice(7)}7`;
}

export default function UsersPage() {
  const { me } = useAuth();
  const { values, set, page, setPage } = useListParams(DEFAULTS);
  const pageSize = 25;
  const q = useQuery({ queryKey: ['admin', 'users', values, page], queryFn: () => api.get<Page<Row>>('/admin/users', { ...values, page, pageSize }) });
  const roles = useQuery({ queryKey: ['admin', 'roles'], queryFn: () => api.get<RolesResponse>('/admin/roles'), staleTime: 60_000 });
  const assignable = useMemo(() => (roles.data?.roles ?? []).filter((r) => r.assignable), [roles.data]);
  const locations = me?.locations ?? [];
  const [editing, setEditing] = useState<Row | 'new' | null>(null);
  const [resetting, setResetting] = useState<Row | null>(null);
  const [toggling, setToggling] = useState<Row | null>(null);
  const toggle = useAction((u: Row) => api.patch(`/admin/users/${u.id}`, { isActive: !u.isActive }), {
    success: (_r) => 'User updated',
    invalidate: [['admin', 'users']],
    onSuccess: () => setToggling(null),
  });

  return (
    <>
      <PageHeader
        title="Users"
        subtitle={me?.user.role === 'SYSTEM_ADMIN' ? 'All user accounts in the organization.' : 'Users assigned to your location(s). You can manage the roles your role is permitted to assign.'}
        actions={
          assignable.length > 0 && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              New user
            </Button>
          )
        }
      />
      <FilterBar>
        <SearchInput value={values.q} onChange={(v) => set({ q: v })} placeholder="Search name, username or department" />
        <Select aria-label="Role" className="w-auto" value={values.role} onChange={(e) => set({ role: e.target.value })} placeholder="All roles" options={ROLES.map((r) => ({ value: r, label: ROLE_INFO[r].name }))} />
        <Select
          aria-label="Status"
          className="w-auto"
          value={values.active}
          onChange={(e) => set({ active: e.target.value })}
          options={[
            { value: '', label: 'Active and inactive' },
            { value: 'true', label: 'Active' },
            { value: 'false', label: 'Inactive' },
          ]}
        />
        {locations.length > 1 && (
          <Select aria-label="Location" className="w-auto" value={values.locationId} onChange={(e) => set({ locationId: e.target.value })} placeholder="All locations" options={locations.map((l) => ({ value: l.id, label: l.name }))} />
        )}
      </FilterBar>
      <Card padded={false}>
        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : (
          <>
            <DataTable
              loading={q.isFetching && !q.data}
              rows={q.data?.items ?? []}
              rowKey={(r) => r.id}
              empty={<EmptyState icon={<UserCog className="size-5" />} title="No users match" description="Adjust the filters, or create a user." />}
              columns={[
                {
                  key: 'name',
                  header: 'User',
                  render: (r) => (
                    <div className="flex items-center gap-3">
                      <Avatar name={r.displayName} size={34} tone={r.role === 'GUARD' ? 'gold' : 'forest'} />
                      <div className="min-w-0">
                        <div className="font-medium">
                          {r.displayName} {r.isDemo ? <span className="ml-1 text-[11px] font-semibold text-gold-600 uppercase">demo</span> : null}
                        </div>
                        <div className="text-xs text-ink-3">
                          {r.username}
                          {r.designation ? ` · ${r.designation}` : ''}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-2 sm:hidden">
                          {ROLE_INFO[r.role as RoleCode]?.name ?? r.role}
                          {!r.isActive && <Badge tone="neutral">Inactive</Badge>}
                        </div>
                      </div>
                    </div>
                  ),
                },
                { key: 'role', header: 'Role', hideBelow: 'sm', render: (r) => ROLE_INFO[r.role as RoleCode]?.name ?? r.role },
                {
                  key: 'locations',
                  header: 'Locations',
                  hideBelow: 'md',
                  render: (r) =>
                    r.allLocations ? (
                      <Pill>All locations</Pill>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {(r.locationIds as number[]).map((id) => (
                          <Pill key={id}>{locations.find((l) => l.id === id)?.name ?? `#${id}`}</Pill>
                        ))}
                      </span>
                    ),
                },
                { key: 'gate', header: 'Assigned gate', hideBelow: 'lg', render: (r) => r.assignedGateName ?? '—' },
                { key: 'lastLogin', header: 'Last sign-in', hideBelow: 'lg', render: (r) => (r.lastLoginAt ? fmtDateTime(r.lastLoginAt) : 'Never') },
                { key: 'status', header: 'Status', hideBelow: 'sm', render: (r) => (r.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Inactive</Badge>) },
                {
                  key: 'actions',
                  header: <span className="sr-only">Actions</span>,
                  align: 'right',
                  render: (r) => {
                    const manageable = assignable.some((a) => a.code === r.role);
                    if (!manageable) return <span className="text-xs text-ink-3">View only</span>;
                    const self = r.id === me?.user.id;
                    return (
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" aria-label={`Edit ${r.displayName}`} icon={<Pencil className="size-4" />} onClick={() => setEditing(r)} />
                        <Button size="sm" variant="ghost" aria-label={`Reset password for ${r.displayName}`} icon={<KeyRound className="size-4" />} onClick={() => setResetting(r)} />
                        {!self && <Button size="sm" variant="ghost" aria-label={r.isActive ? 'Deactivate' : 'Activate'} icon={<Power className={r.isActive ? 'size-4 text-bad' : 'size-4 text-ok'} />} onClick={() => setToggling(r)} />}
                      </div>
                    );
                  },
                },
              ]}
            />
            {q.data && <Pagination page={page} pageSize={pageSize} total={q.data.total} onPage={setPage} />}
          </>
        )}
      </Card>
      {editing && <UserModal user={editing === 'new' ? null : editing} roles={assignable} locations={locations} onClose={() => setEditing(null)} />}
      {resetting && <ResetPasswordModal user={resetting} onClose={() => setResetting(null)} />}
      <Modal
        open={!!toggling}
        onClose={() => setToggling(null)}
        title={toggling?.isActive ? 'Deactivate user' : 'Activate user'}
        description={toggling ? `${toggling.displayName} (${toggling.username})` : ''}
        footer={
          <>
            <Button onClick={() => setToggling(null)}>Cancel</Button>
            <Button variant={toggling?.isActive ? 'danger' : 'primary'} loading={toggle.isPending} onClick={() => toggling && toggle.mutate(toggling)}>
              {toggling?.isActive ? 'Deactivate' : 'Activate'}
            </Button>
          </>
        }
      >
        {toggling?.isActive ? (
          <Notice tone="warning">The user is signed out of all sessions immediately and cannot sign in until reactivated.</Notice>
        ) : (
          <p className="text-sm text-ink-2">The user will be able to sign in again with their existing password.</p>
        )}
      </Modal>
    </>
  );
}

function UserModal({ user, roles, locations, onClose }: { user: Row | null; roles: RolesResponse['roles']; locations: LocationInfo[]; onClose: () => void }) {
  const editing = !!user;
  const [form, setForm] = useState({
    username: user?.username ?? '',
    displayName: user?.displayName ?? '',
    designation: user?.designation ?? '',
    department: user?.department ?? '',
    role: (user?.role as RoleCode) ?? roles[0]?.code ?? 'GUARD',
    locationIds: (user?.locationIds as number[]) ?? (locations.length === 1 ? [locations[0].id] : []),
    primaryLocationId: user?.primaryLocationId ? String(user.primaryLocationId) : '',
    assignedGateId: user?.assignedGateId ? String(user.assignedGateId) : '',
    password: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const roleInfo = ROLE_INFO[form.role];
  const gates = locations.filter((l) => roleInfo.allLocations || form.locationIds.includes(l.id)).flatMap((l) => l.gates.map((g) => ({ ...g, locationName: l.name })));
  const save = useAction(
    (body: Record<string, unknown>) => (editing ? api.patch(`/admin/users/${user!.id}`, body) : api.post('/admin/users', body)),
    {
      success: editing ? 'User updated' : 'User created',
      invalidate: [['admin', 'users'], ['admin', 'roles']],
      onSuccess: onClose,
      onError: (e) => {
        if (e instanceof ApiError && e.code === 'DUPLICATE_USERNAME') setErrors({ username: e.message });
        else setErrors(fieldErrors(e));
      },
    },
  );

  const submit = () => {
    const errs: Record<string, string> = {};
    if (!editing && !/^[a-z0-9._-]{3,40}$/i.test(form.username)) errs.username = '3–40 letters, digits, dot, dash or underscore';
    if (!form.displayName.trim()) errs.displayName = 'Required';
    if (!roleInfo.allLocations && form.locationIds.length === 0) errs.locationIds = 'Assign at least one location';
    if (!editing && (form.password.length < 10 || !/[A-Za-z]/.test(form.password) || !/\d/.test(form.password))) errs.password = 'At least 10 characters with letters and digits';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const primary = form.primaryLocationId ? Number(form.primaryLocationId) : roleInfo.allLocations ? null : form.locationIds[0];
    const full: Record<string, unknown> = {
      displayName: form.displayName.trim(),
      designation: form.designation || null,
      department: form.department || null,
      role: form.role,
      locationIds: roleInfo.allLocations ? [] : form.locationIds,
      primaryLocationId: primary ?? null,
      assignedGateId: form.assignedGateId ? Number(form.assignedGateId) : null,
    };
    if (!editing) {
      save.mutate({ ...full, username: form.username.trim().toLowerCase(), password: form.password });
      return;
    }
    // Send only the fields that changed (PATCH semantics).
    const before: Record<string, unknown> = {
      displayName: user!.displayName,
      designation: user!.designation ?? null,
      department: user!.department ?? null,
      role: user!.role,
      locationIds: user!.allLocations ? [] : user!.locationIds,
      primaryLocationId: user!.primaryLocationId ?? null,
      assignedGateId: user!.assignedGateId ?? null,
    };
    const changed = Object.fromEntries(Object.entries(full).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(before[k])));
    if (Object.keys(changed).length === 0) {
      onClose();
      return;
    }
    save.mutate(changed);
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={editing ? `Edit ${user!.displayName}` : 'New user'}
      description={editing ? user!.username : 'Use fictional names in the demonstration environment.'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            {editing ? 'Save changes' : 'Create user'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Username" required value={form.username} disabled={editing} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} error={errors.username} />
        <Input label="Display name" required value={form.displayName} onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))} error={errors.displayName} />
        <Input label="Designation" value={form.designation} onChange={(e) => setForm((f) => ({ ...f, designation: e.target.value }))} />
        <Input label="Department" value={form.department} onChange={(e) => setForm((f) => ({ ...f, department: e.target.value }))} />
        <Select
          label="Role"
          required
          containerClassName="sm:col-span-2"
          value={form.role}
          onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as RoleCode, assignedGateId: '' }))}
          options={roles.map((r) => ({ value: r.code, label: r.name }))}
          hint={ROLE_INFO[form.role]?.description}
        />
        {roleInfo.allLocations ? (
          <Notice tone="info" className="sm:col-span-2">
            This role has visibility across all locations.
          </Notice>
        ) : (
          <Field label="Locations" required error={errors.locationIds} className="sm:col-span-2">
            <div className="grid gap-2 rounded-lg border border-line p-3 sm:grid-cols-2">
              {locations.map((l) => (
                <Checkbox
                  key={l.id}
                  label={l.name}
                  checked={form.locationIds.includes(l.id)}
                  onChange={(v) => setForm((f) => ({ ...f, locationIds: v ? [...f.locationIds, l.id] : f.locationIds.filter((x) => x !== l.id), primaryLocationId: !v && f.primaryLocationId === String(l.id) ? '' : f.primaryLocationId }))}
                />
              ))}
            </div>
          </Field>
        )}
        {!roleInfo.allLocations && form.locationIds.length > 1 && (
          <Select
            label="Primary location"
            value={form.primaryLocationId}
            onChange={(e) => setForm((f) => ({ ...f, primaryLocationId: e.target.value }))}
            placeholder="First assigned location"
            options={locations.filter((l) => form.locationIds.includes(l.id)).map((l) => ({ value: l.id, label: l.name }))}
          />
        )}
        <Select
          label="Assigned gate"
          value={form.assignedGateId}
          onChange={(e) => setForm((f) => ({ ...f, assignedGateId: e.target.value }))}
          placeholder="None"
          options={gates.map((g) => ({ value: g.id, label: `${g.name} · ${g.locationName}` }))}
          hint={form.role === 'GUARD' ? 'Default gate when the guard opens the gate interface' : undefined}
        />
        {!editing && (
          <div className="flex items-end gap-2 sm:col-span-2">
            <Input label="Initial password" required containerClassName="flex-1" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} error={errors.password} hint="Share it securely; the user should change it after first sign-in." />
            <Button onClick={() => setForm((f) => ({ ...f, password: generatePassword() }))}>Generate</Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

function ResetPasswordModal({ user, onClose }: { user: Row; onClose: () => void }) {
  const [password, setPassword] = useState(generatePassword());
  const weak = password.length < 10 || !/[A-Za-z]/.test(password) || !/\d/.test(password);
  const reset = useAction(() => api.post(`/admin/users/${user.id}/password`, { password }), { success: 'Password reset; the user was signed out everywhere', onSuccess: onClose });
  return (
    <Modal
      open
      onClose={onClose}
      title="Reset password"
      description={`${user.displayName} (${user.username})`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={reset.isPending} disabled={weak} onClick={() => reset.mutate(undefined)}>
            Reset password
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <div className="flex items-end gap-2">
          <Input label="New password" containerClassName="flex-1" value={password} onChange={(e) => setPassword(e.target.value)} error={weak ? 'At least 10 characters with letters and digits' : null} />
          <Button onClick={() => setPassword(generatePassword())}>Generate</Button>
        </div>
        <p className="text-xs text-ink-3">The password is never written to the audit trail. Existing sessions for this user are revoked.</p>
      </div>
    </Modal>
  );
}
