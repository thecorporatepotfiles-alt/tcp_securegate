import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import jsQR from 'jsqr';
import { Camera, CameraOff, ImageUp } from 'lucide-react';
import { BROWSER_EDITION } from '../lib/edition';
import { GateButton, GateError } from './gateUi';

type CamState = 'idle' | 'starting' | 'scanning' | 'unavailable' | 'denied' | 'error';

/** Longest side a photo is scaled to before decoding; a smaller second pass helps with large, soft photos. */
const PHOTO_SIDES = [1600, 800];

interface LoadedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}

async function loadImage(file: Blob): Promise<LoadedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      /* fall back to an <img> decode */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Unreadable image'));
      img.src = url;
    });
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => undefined };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Decode a QR code from a photo or image file; null when none is found. Throws when the file is not a readable image. */
export async function decodeQrFromImage(file: Blob): Promise<string | null> {
  const img = await loadImage(file);
  try {
    if (!img.width || !img.height) return null;
    const longest = Math.max(img.width, img.height);
    const sides = PHOTO_SIDES.filter((side, i) => i === 0 || side < longest);
    for (const side of sides) {
      const scale = Math.min(1, side / longest);
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const g = canvas.getContext('2d', { willReadFrequently: true });
      if (!g) return null;
      // Transparent pixels would otherwise read as black.
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, w, h);
      g.drawImage(img.source, 0, 0, w, h);
      const data = g.getImageData(0, 0, w, h);
      const code = jsQR(data.data, w, h, { inversionAttempts: 'attemptBoth' });
      const text = code?.data?.trim();
      if (text) return text;
    }
    return null;
  } finally {
    img.close();
  }
}

/**
 * QR scanner: live camera (jsQR on video frames, HTTPS or localhost) or a
 * photo of the pass. Either way the decoded text goes to `onDetected`, which
 * verifies it with the server — a scan alone never authorizes entry. The
 * browser edition has no camera access, so it offers the photo path only;
 * manual entry and the simulated scanner remain alongside.
 */
export function QrScanner({ onDetected, disabled }: { onDetected: (text: string) => void; disabled?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef<number>(0);
  const [state, setState] = useState<CamState>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const camera = !BROWSER_EDITION;
  const supported = camera && typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && window.isSecureContext;

  const stop = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  useEffect(() => stop, []);
  useEffect(() => {
    if (disabled && state === 'scanning') {
      stop();
      setState('idle');
    }
  }, [disabled, state]);

  const tick = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !streamRef.current) return;
    const now = performance.now();
    if (now - lastRef.current > 140 && video.readyState === video.HAVE_ENOUGH_DATA) {
      lastRef.current = now;
      const w = video.videoWidth;
      const h = video.videoHeight;
      const scale = Math.min(1, 640 / Math.max(w, h));
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      const g = canvas.getContext('2d', { willReadFrequently: true });
      if (g) {
        g.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = g.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (code?.data) {
          stop();
          setState('idle');
          if (navigator.vibrate) navigator.vibrate(60);
          onDetected(code.data.trim());
          return;
        }
      }
    }
    rafRef.current = requestAnimationFrame(tick);
  };

  const start = async () => {
    if (!supported) {
      setState('unavailable');
      return;
    }
    setState('starting');
    setMessage(null);
    setPhotoError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      streamRef.current = stream;
      const v = videoRef.current!;
      v.srcObject = stream;
      v.setAttribute('playsinline', 'true');
      await v.play();
      setState('scanning');
      rafRef.current = requestAnimationFrame(tick);
    } catch (e) {
      const name = (e as DOMException)?.name;
      setState(name === 'NotAllowedError' ? 'denied' : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'unavailable' : 'error');
      setMessage((e as Error)?.message ?? null);
      stop();
    }
  };

  const pickPhoto = () => {
    setPhotoError(null);
    fileRef.current?.click();
  };

  const onPhoto = async (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    // Reset so choosing the same file again still triggers a change.
    input.value = '';
    if (!file) return;
    setPhotoBusy(true);
    setPhotoError(null);
    try {
      const text = await decodeQrFromImage(file);
      if (!text) {
        setPhotoError('No QR code found in that image.');
        return;
      }
      if (streamRef.current) {
        stop();
        setState('idle');
      }
      onDetected(text);
    } catch {
      setPhotoError('That file could not be opened as an image. Try a JPEG or PNG photo.');
    } finally {
      setPhotoBusy(false);
    }
  };

  const photoButton = (primary: boolean) => (
    <GateButton
      variant={primary ? 'gold' : 'ghost'}
      size={primary ? 'xl' : 'md'}
      onClick={pickPhoto}
      loading={photoBusy}
      disabled={disabled}
      icon={<ImageUp className={primary ? 'size-6' : 'size-5'} aria-hidden />}
    >
      Scan from photo
    </GateButton>
  );

  return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/40">
      <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden aria-label="Photo of a pass QR code" onChange={onPhoto} />
      {!camera && (
        <div className="flex flex-col items-center justify-center gap-3 p-5 text-center sm:p-6">
          <ImageUp className="size-10 text-gold-400" aria-hidden />
          {photoButton(true)}
          <p className="max-w-sm text-xs text-forest-200/60">
            Take or choose a photo of the pass QR. The live camera is not available in this browser edition. The code is still checked by the server.
          </p>
        </div>
      )}
      {camera && (
        <div className="relative aspect-[4/3] w-full sm:aspect-video">
          <video ref={videoRef} className={state === 'scanning' ? 'size-full object-cover' : 'hidden'} muted aria-label="Camera preview" />
          <canvas ref={canvasRef} className="hidden" />
          {state === 'scanning' ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="size-[58%] max-h-[260px] max-w-[260px] rounded-2xl border-4 border-gold-400/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
              <div className="absolute bottom-3 rounded-full bg-black/60 px-3 py-1 text-sm text-white">Hold the QR inside the frame</div>
            </div>
          ) : (
            <div className="flex size-full flex-col items-center justify-center gap-3 p-5 text-center">
              {state === 'unavailable' || state === 'denied' || state === 'error' ? (
                <>
                  <CameraOff className="size-10 text-forest-200/60" aria-hidden />
                  <p className="max-w-sm text-sm text-forest-200/80">
                    {state === 'denied'
                      ? 'Camera permission was refused. Allow camera access in the browser, or use Scan from photo, manual entry or the simulated scanner.'
                      : !supported
                        ? 'Camera scanning needs HTTPS or localhost and a camera. Use Scan from photo, manual entry or the simulated scanner.'
                        : `Camera could not start${message ? ` (${message})` : ''}. Use Scan from photo, manual entry or the simulated scanner.`}
                  </p>
                  {supported && (
                    <GateButton size="md" onClick={start} icon={<Camera className="size-5" />}>
                      Try camera again
                    </GateButton>
                  )}
                </>
              ) : (
                <>
                  <Camera className="size-10 text-gold-400" aria-hidden />
                  <GateButton variant="gold" size="xl" onClick={start} loading={state === 'starting'} disabled={disabled} icon={<Camera className="size-6" />}>
                    Start camera scan
                  </GateButton>
                  <p className="text-xs text-forest-200/60">Uses this device's camera to read the pass QR. The code is checked by the server.</p>
                </>
              )}
            </div>
          )}
        </div>
      )}
      {camera && (
        <div className="flex flex-wrap justify-center gap-2 border-t border-white/10 p-2">
          {state === 'scanning' && (
            <GateButton
              size="md"
              variant="ghost"
              onClick={() => {
                stop();
                setState('idle');
              }}
            >
              Stop camera
            </GateButton>
          )}
          {photoButton(false)}
        </div>
      )}
      {photoError && (
        <div className="border-t border-white/10 p-3">
          <GateError>{photoError}</GateError>
        </div>
      )}
    </div>
  );
}
