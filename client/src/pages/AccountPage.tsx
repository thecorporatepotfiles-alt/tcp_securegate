import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { KeyRound } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth, useMe } from '../lib/auth';
import { useAction } from '../components/toast';
import { Button, Card, CardHeader, Input, KeyValue, Notice, PageHeader, Pill } from '../components/ui';

export default function AccountPage() {
  const me = useMe();
  const { config, logout } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const change = useAction(() => api.post('/auth/change-password', { currentPassword: current, newPassword: next }), {
    success: 'Password changed. Please sign in again.',
    onSuccess: async () => {
      await logout();
      navigate('/login');
    },
  });
  const mismatch = confirm.length > 0 && next !== confirm;
  const weak = next.length > 0 && (next.length < 10 || !/[A-Za-z]/.test(next) || !/\d/.test(next));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!mismatch && !weak) change.mutate(undefined);
  };
  return (
    <>
      <PageHeader title="Account" subtitle="Your profile, permissions and password." />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Profile" />
          <KeyValue
            items={[
              { label: 'Name', value: me.user.displayName },
              { label: 'Username', value: me.user.username },
              { label: 'Role', value: me.user.roleName },
              { label: 'Designation', value: me.user.designation },
              { label: 'Department', value: me.user.department },
              { label: 'Authorized locations', value: <span className="flex flex-wrap gap-1">{me.locations.map((l) => <Pill key={l.id}>{l.name}</Pill>)}</span> },
            ]}
          />
          <div className="mt-5">
            <div className="mb-2 text-xs font-medium text-ink-3">Permissions ({me.permissions.length})</div>
            <div className="flex flex-wrap gap-1">
              {me.permissions.map((p) => (
                <Pill key={p} className="font-mono">
                  {p}
                </Pill>
              ))}
            </div>
          </div>
        </Card>
        <Card>
          <CardHeader title="Change password" subtitle="All your sessions are signed out after a change." />
          {me.user.isDemo && config?.demo ? (
            <Notice tone="info">Demo account passwords are fixed for the demonstration and cannot be changed.</Notice>
          ) : (
            <form onSubmit={submit} className="grid gap-4">
              <Input label="Current password" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
              <Input label="New password" type="password" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} error={weak ? 'At least 10 characters with letters and digits' : null} />
              <Input label="Confirm new password" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} error={mismatch ? 'Passwords do not match' : null} />
              <div className="flex justify-end">
                <Button type="submit" variant="primary" icon={<KeyRound className="size-4" />} loading={change.isPending} disabled={!current || !next || mismatch || weak}>
                  Change password
                </Button>
              </div>
            </form>
          )}
        </Card>
      </div>
    </>
  );
}
