import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { Camera, CameraOff } from 'lucide-react';
import { GateButton } from './gateUi';

type CamState = 'idle' | 'starting' | 'scanning' | 'unavailable' | 'denied' | 'error';

/**
 * Camera QR scanner (jsQR on video frames). Works on HTTPS or localhost;
 * falls back with a clear message so the guard can use manual entry or the
 * simulated scanner instead.
 */
export function QrScanner({ onDetected, disabled }: { onDetected: (text: string) => void; disabled?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef<number>(0);
  const [state, setState] = useState<CamState>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && window.isSecureContext;

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

  return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/40">
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
                    ? 'Camera permission was refused. Allow camera access in the browser, or use manual entry / the simulated scanner below.'
                    : !supported
                      ? 'Camera scanning needs HTTPS or localhost and a camera. Use manual entry or the simulated scanner below.'
                      : `Camera could not start${message ? ` (${message})` : ''}. Use manual entry or the simulated scanner below.`}
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
      {state === 'scanning' && (
        <div className="flex justify-center border-t border-white/10 p-2">
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
        </div>
      )}
    </div>
  );
}
