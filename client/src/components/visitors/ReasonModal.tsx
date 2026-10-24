import { useEffect, useState, type ReactNode } from 'react';
import { Button, Modal, Notice, Textarea } from '../ui';

/** Confirmation dialog that collects a note/reason before running an action. */
export function ReasonModal({
  open,
  onClose,
  title,
  description,
  label = 'Reason',
  placeholder = 'Recorded in the history and audit trail',
  required = true,
  minLength = 3,
  confirmLabel,
  variant = 'primary',
  loading,
  warning,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  label?: string;
  placeholder?: string;
  required?: boolean;
  minLength?: number;
  confirmLabel: string;
  variant?: 'primary' | 'danger' | 'gold';
  loading?: boolean;
  warning?: ReactNode;
  onConfirm: (text: string) => void;
}) {
  const [text, setText] = useState('');
  useEffect(() => {
    if (open) setText('');
  }, [open]);
  const tooShort = required && text.trim().length < minLength;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={variant} loading={loading} disabled={tooShort} onClick={() => onConfirm(text.trim())}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {warning && (
        <Notice tone="warning" className="mb-4">
          {warning}
        </Notice>
      )}
      <Textarea
        label={required ? label : `${label} (optional)`}
        required={required}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        hint={required ? `At least ${minLength} characters.` : undefined}
      />
    </Modal>
  );
}
