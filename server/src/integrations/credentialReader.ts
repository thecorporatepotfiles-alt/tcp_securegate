/**
 * Integration boundary for future, separately approved RFID/NFC readers.
 *
 * The prototype ships ONLY the MockReaderAdapter. No physical device driver,
 * barrier/turnstile command or automatic admission exists in this codebase.
 * A real adapter must translate device reads into the same verification
 * request the gate UI already uses (POST /api/gate/verify) so every rule,
 * audit record and alert applies unchanged. See docs/INTEGRATIONS.md.
 */

export type ReaderTechnology = 'RFID_125KHZ' | 'MIFARE_13_56MHZ' | 'NFC' | 'MANUAL';

export interface CredentialRead {
  readerId: string;
  /** Opaque card/tag identifier as reported by the device (UID). Never personal data. */
  credentialNumber: string;
  technology: ReaderTechnology;
  /** Device-reported time; informational only — the server timestamp is authoritative. */
  deviceReadAt?: string;
}

export interface ReaderStatus {
  readerId: string;
  gateId: number;
  label: string;
  technology: ReaderTechnology;
  simulated: boolean;
  online: boolean;
  lastSeenAt: string | null;
  note: string;
}

export interface CredentialReaderAdapter {
  readonly readerId: string;
  readonly gateId: number;
  readonly simulated: boolean;
  status(): ReaderStatus;
  /** Normalise a raw device payload into the credential number format stored in the register. */
  normalize(raw: string): string;
}

export class MockReaderAdapter implements CredentialReaderAdapter {
  readonly simulated = true;
  constructor(
    readonly readerId: string,
    readonly gateId: number,
    private label: string,
  ) {}

  status(): ReaderStatus {
    return {
      readerId: this.readerId,
      gateId: this.gateId,
      label: this.label,
      technology: 'MANUAL',
      simulated: true,
      online: true,
      lastSeenAt: null,
      note: 'Simulated reader: credential numbers are typed or picked from demo samples. No hardware is connected.',
    };
  }

  normalize(raw: string): string {
    return raw.trim().toUpperCase().replace(/\s+/g, '');
  }
}

export function readerRegistry(gates: { id: number; code: string; name: string }[]): CredentialReaderAdapter[] {
  return gates.map((g) => new MockReaderAdapter(`MOCK-${g.code}`, g.id, `${g.name} — mock reader`));
}
