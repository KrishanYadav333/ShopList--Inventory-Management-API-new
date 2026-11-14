import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons';

// The browser's built-in barcode API is not in TypeScript's DOM types yet.
interface DetectedBarcode { rawValue: string }
interface BarcodeDetectorLike { detect(source: CanvasImageSource): Promise<DetectedBarcode[]> }
declare global {
  interface Window { BarcodeDetector?: new (opts?: { formats?: string[] }) => BarcodeDetectorLike }
}

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code'];
export const canScan = () => typeof window !== 'undefined' && !!window.BarcodeDetector && !!navigator.mediaDevices?.getUserMedia;

/** Opens the camera inline and reports the first barcode it reads. Hidden where the browser cannot scan. */
export function ScanButton({ onResult, label = 'Scan' }: { onResult: (code: string) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  if (!canScan()) return null;
  return (
    <>
      <button type="button" className="btn btn-outline scan-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Icon name="scan" size={14} /> {open ? 'Close camera' : label}
      </button>
      {open && <ScanPanel onResult={(c) => { setOpen(false); onResult(c); }} />}
    </>
  );
}

function ScanPanel({ onResult }: { onResult: (code: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        if (stopped) return stream.getTracks().forEach((t) => t.stop());
        const el = video.current!;
        el.srcObject = stream;
        await el.play().catch(() => undefined);
        const detector = new window.BarcodeDetector!({ formats: FORMATS });
        timer = setInterval(async () => {
          if (el.readyState < 2) return;
          try {
            const found = await detector.detect(el);
            if (found[0]?.rawValue) { navigator.vibrate?.(60); onResult(found[0].rawValue); }
          } catch { /* a frame that cannot be read is skipped */ }
        }, 250);
      } catch (e) {
        const name = (e as DOMException).name;
        setError(name === 'NotAllowedError' ? 'Camera access was blocked. Allow the camera for this site in your browser settings, or type the code instead.' : 'Could not start the camera. Type the code instead.');
      }
    })();
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop()); // always release the camera
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="scanner" role="region" aria-label="Barcode scanner">
      {error ? <div className="field-error" role="alert">{error}</div> : (
        <>
          <video ref={video} muted playsInline aria-label="Camera preview" />
          <div className="scan-line" aria-hidden="true" />
          <p className="hint">Point the camera at the barcode. It is read automatically.</p>
        </>
      )}
    </div>
  );
}
