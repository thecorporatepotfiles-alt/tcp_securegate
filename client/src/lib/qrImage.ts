const CAPTION = 64;

/** Keep only characters that are safe in a file name (references look like VR-2026-00042). */
export const fileSafe = (s: string) => s.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'pass';

/**
 * Render a pass QR as a PNG: the QR (with a generous quiet zone) above its
 * printed reference. The image carries only the opaque token the pass
 * already shows; it is never logged or used in a file name.
 */
export async function passQrPng(token: string, reference: string): Promise<Blob> {
  const mod = await import('qrcode');
  const toCanvas = mod.toCanvas ?? (mod as unknown as { default: typeof mod }).default.toCanvas;
  const qr = await toCanvas(token, { errorCorrectionLevel: 'M', margin: 4, width: 640, color: { dark: '#000000', light: '#ffffff' } });
  const canvas = document.createElement('canvas');
  canvas.width = qr.width;
  canvas.height = qr.height + CAPTION;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('The QR image could not be created in this browser.');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(qr, 0, 0);
  g.fillStyle = '#0b2418';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '600 26px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  g.fillText(reference, canvas.width / 2, qr.height + CAPTION / 2 - 12, canvas.width - 32);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The QR image could not be created in this browser.'))), 'image/png'),
  );
}
