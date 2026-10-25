import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CreditCard, Plus } from 'lucide-react';
import { api } from '../lib/api';
import { serverCopy } from '../lib/edition';
import { fmtDateTime } from '../lib/format';
import type { Row } from '../lib/types';
import { CREDENTIAL_TYPES, CREDENTIAL_TYPE_LABEL } from '../../../shared/constants';
import { useAction } from './toast';
import { Button, Checkbox, EmptyState, Input, Modal, Notice, Select, Textarea } from './ui';
import { CredentialStatusBadge, SimulatedTag } from './status';

const TYPE_OPTIONS = CREDENTIAL_TYPES.filter((t) => t !== 'TEMPORARY_CARD').map((t) => ({ value: t, label: CREDENTIAL_TYPE_LABEL[t] }));

/** Generate a random demo credential number (mock reader UID). */
export function mockCredentialNumber(prefix = 'RF'): string {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return `${prefix}-${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

export function AssignCredentialModal({ open, onClose, holderType, holderId, invalidate }: { open: boolean; onClose: () => void; holderType: 'PERSONNEL' | 'CONTRACTOR'; holderId: number; invalidate: unknown[][] }) {
  const [number, setNumber] = useState('');
  const [type, setType] = useState('RFID_CARD');
  const [temporary, setTemporary] = useState(false);
  const [validUntil, setValidUntil] = useState('');
  const [reason, setReason] = useState('');
  const m = useAction((body: unknown) => api.post('/credentials', body), {
    success: 'Credential assigned',
    invalidate: [...invalidate, ['credentials']],
    onSuccess: () => {
      onClose();
      setNumber('');
      setReason('');
    },
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Assign credential"
      description="Enter the card/tag number manually or generate one with the mock reader. No hardware is connected."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={m.isPending}
            disabled={number.trim().length < 6 || (temporary && !validUntil)}
            onClick={() => m.mutate({ holderType, holderId, credentialNumber: number.trim(), credentialType: type, temporary, validUntil: validUntil ? new Date(validUntil).toISOString() : null, reason: reason || null })}
          >
            Assign credential
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="flex items-end gap-2">
          <Input label="Credential number" required value={number} onChange={(e) => setNumber(e.target.value.toUpperCase())} placeholder="e.g. RF-8F3A21C4" containerClassName="flex-1" />
          <Button onClick={() => setNumber(mockCredentialNumber(temporary ? 'TC' : type === 'RFID_CARD' ? 'RF' : 'NF'))}>Mock reader</Button>
        </div>
        <Checkbox label="Temporary credential" hint="Requires an expiry. Holder may keep one permanent and one temporary credential." checked={temporary} onChange={setTemporary} />
        {!temporary && <Select label="Credential type" value={type} onChange={(e) => setType(e.target.value)} options={TYPE_OPTIONS} />}
        <Input label={temporary ? 'Valid until' : 'Valid until (optional)'} type="datetime-local" required={temporary} value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
        <Textarea label="Note (optional)" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
        <p className="text-xs text-ink-3">
          <SimulatedTag /> {serverCopy('Personal details stay in the protected database', 'Personal details stay in the SecureGate database')}; the credential carries only this number.
        </p>
      </div>
    </Modal>
  );
}

type StatusAction = 'BLOCK' | 'REPORT_LOST' | 'DEACTIVATE' | 'REACTIVATE';
const ACTION_LABEL: Record<StatusAction, string> = { BLOCK: 'Block credential', REPORT_LOST: 'Report lost', DEACTIVATE: 'Deactivate', REACTIVATE: 'Reactivate' };

export function CredentialStatusModal({ credential, action, onClose, invalidate }: { credential: Row | null; action: StatusAction | 'REPLACE' | null; onClose: () => void; invalidate: unknown[][] }) {
  const [reason, setReason] = useState('');
  const [newNumber, setNewNumber] = useState('');
  const [newType, setNewType] = useState('RFID_CARD');
  const [markOldAs, setMarkOldAs] = useState('REPLACED');
  const done = () => {
    setReason('');
    setNewNumber('');
    onClose();
  };
  const status = useAction((v: { id: number; action: string; reason: string }) => api.post(`/credentials/${v.id}/status`, { action: v.action, reason: v.reason }), {
    success: 'Credential updated',
    invalidate: [...invalidate, ['credentials']],
    onSuccess: done,
  });
  const replace = useAction((v: { id: number }) => api.post(`/credentials/${v.id}/replace`, { newCredentialNumber: newNumber.trim(), credentialType: newType, reason, markOldAs }), {
    success: 'Replacement credential issued',
    invalidate: [...invalidate, ['credentials']],
    onSuccess: done,
  });
  if (!credential || !action) return null;
  const isReplace = action === 'REPLACE';
  return (
    <Modal
      open
      onClose={done}
      title={isReplace ? 'Replace credential' : ACTION_LABEL[action]}
      description={`Credential ${credential.credentialNumber} · ${credential.holderName ?? ''}`}
      footer={
        <>
          <Button onClick={done}>Cancel</Button>
          <Button
            variant={action === 'BLOCK' || action === 'REPORT_LOST' ? 'danger' : 'primary'}
            disabled={reason.trim().length < 3 || (isReplace && newNumber.trim().length < 6)}
            loading={status.isPending || replace.isPending}
            onClick={() => (isReplace ? replace.mutate({ id: credential.id }) : status.mutate({ id: credential.id, action, reason }))}
          >
            {isReplace ? 'Issue replacement' : ACTION_LABEL[action]}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {(action === 'BLOCK' || action === 'REPORT_LOST') && <Notice tone="warning">Subsequent verification of this credential will be rejected and raise an alert.</Notice>}
        {isReplace && (
          <>
            <div className="flex items-end gap-2">
              <Input label="New credential number" required value={newNumber} onChange={(e) => setNewNumber(e.target.value.toUpperCase())} containerClassName="flex-1" />
              <Button onClick={() => setNewNumber(mockCredentialNumber(newType === 'RFID_CARD' ? 'RF' : 'NF'))}>Mock reader</Button>
            </div>
            <Select label="New credential type" value={newType} onChange={(e) => setNewType(e.target.value)} options={TYPE_OPTIONS} />
            <Select
              label="Mark the old credential as"
              value={markOldAs}
              onChange={(e) => setMarkOldAs(e.target.value)}
              options={[
                { value: 'REPLACED', label: 'Replaced (returned / damaged)' },
                { value: 'LOST', label: 'Lost' },
                { value: 'BLOCKED', label: 'Blocked' },
              ]}
            />
          </>
        )}
        <Textarea label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Recorded in the credential history and audit trail" />
      </div>
    </Modal>
  );
}

/** Credential list with management actions, used on personnel and contractor detail pages. */
export function CredentialPanel({ credentials, holderType, holderId, canManage, invalidate }: { credentials: Row[]; holderType: 'PERSONNEL' | 'CONTRACTOR'; holderId: number; canManage: boolean; invalidate: unknown[][] }) {
  const [assignOpen, setAssignOpen] = useState(false);
  const [target, setTarget] = useState<{ c: Row; a: StatusAction | 'REPLACE' } | null>(null);
  return (
    <div>
      {canManage && (
        <div className="mb-3 flex justify-end">
          <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setAssignOpen(true)}>
            Assign credential
          </Button>
        </div>
      )}
      {credentials.length === 0 ? (
        <EmptyState icon={<CreditCard className="size-5" />} title="No credentials assigned" description={canManage ? 'Assign a simulated RFID/NFC credential to enable gate verification.' : undefined} />
      ) : (
        <ul className="divide-y divide-line">
          {credentials.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link to={`/credentials/${c.id}`} className="font-mono text-sm font-semibold text-ink hover:text-forest-700">
                    {c.credentialNumber}
                  </Link>
                  <CredentialStatusBadge status={c.status} />
                  {c.isTemporary ? <span className="text-xs font-medium text-gold-600">Temporary</span> : null}
                </div>
                <div className="mt-0.5 text-xs text-ink-3">
                  {CREDENTIAL_TYPE_LABEL[c.credentialType as keyof typeof CREDENTIAL_TYPE_LABEL]} · issued {fmtDateTime(c.issuedAt)}
                  {c.validUntil ? ` · valid until ${fmtDateTime(c.validUntil)}` : ''}
                  {c.statusReason ? ` · ${c.statusReason}` : ''}
                </div>
              </div>
              {canManage && (
                <div className="flex flex-wrap gap-1.5">
                  {c.status === 'ACTIVE' && (
                    <>
                      <Button size="sm" onClick={() => setTarget({ c, a: 'REPLACE' })}>
                        Replace
                      </Button>
                      <Button size="sm" onClick={() => setTarget({ c, a: 'REPORT_LOST' })}>
                        Report lost
                      </Button>
                      <Button size="sm" onClick={() => setTarget({ c, a: 'DEACTIVATE' })}>
                        Deactivate
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => setTarget({ c, a: 'BLOCK' })}>
                        Block
                      </Button>
                    </>
                  )}
                  {(c.status === 'INACTIVE' || c.status === 'BLOCKED') && (
                    <Button size="sm" onClick={() => setTarget({ c, a: 'REACTIVATE' })}>
                      Reactivate
                    </Button>
                  )}
                  {c.status === 'INACTIVE' && (
                    <Button size="sm" variant="danger" onClick={() => setTarget({ c, a: 'BLOCK' })}>
                      Block
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <AssignCredentialModal open={assignOpen} onClose={() => setAssignOpen(false)} holderType={holderType} holderId={holderId} invalidate={invalidate} />
      <CredentialStatusModal credential={target?.c ?? null} action={target?.a ?? null} onClose={() => setTarget(null)} invalidate={invalidate} />
    </div>
  );
}
