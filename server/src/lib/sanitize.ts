const SENSITIVE_KEY = /pass(word)?|token|secret|nonce|cookie|session|hash|authorization|qr/i;

/** Remove secrets and trim large values before writing audit metadata. */
export function scrubMetadata(input: unknown, depth = 0): unknown {
  if (input === null || input === undefined) return input;
  if (depth > 4) return '[truncated]';
  if (Array.isArray(input)) return input.slice(0, 50).map((v) => scrubMetadata(v, depth + 1));
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : scrubMetadata(v, depth + 1);
    }
    return out;
  }
  if (typeof input === 'string') {
    if (/^SG[VTC]1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(input)) return '[access-token]';
    return input.length > 500 ? `${input.slice(0, 500)}…` : input;
  }
  return input;
}

/** Show only the edges of a credential number or token in logs and lists. */
export function maskIdentifier(raw: string): string {
  const s = raw.trim();
  if (/^SG[VTC]1\./.test(s)) return `${s.slice(0, 5)}…(QR token)`;
  if (s.length <= 6) return s;
  return `${s.slice(0, 3)}…${s.slice(-4)}`;
}
