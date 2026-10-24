/** RFC 4180 CSV with protection against spreadsheet formula injection. */
export function toCsv(columns: { key: string; label: string }[], rows: Record<string, unknown>[]): string {
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    let s = String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [columns.map((c) => escape(c.label)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => escape(row[c.key])).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}
