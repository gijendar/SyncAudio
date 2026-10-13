import { useEffect, useRef, useState } from 'react';
import { CameraOff, ScanLine, QrCode } from 'lucide-react';
import { Modal } from './Modal.jsx';
import { normaliseCode } from '../lib/format.js';

/** Pull a room code out of a scanned payload (URL or raw code). */
function extractCode(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  const fromUrl = text.match(/\/room\/([A-Za-z0-9-]+)/);
  const candidate = normaliseCode(fromUrl ? fromUrl[1] : text);
  return candidate.length === 6 ? candidate : null;
}

const SCAN_INTERVAL_MS = 400;

export function ScanQR({ onDetected, onClose }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const [status, setStatus] = useState('starting'); // starting | scanning | unsupported | denied | notfound
  const [message, setMessage] = useState('');

  useEffect(() => {
    let cancelled = false;

    const stop = () => {
      clearInterval(timerRef.current);
      timerRef.current = null;
      for (const track of streamRef.current?.getTracks?.() ?? []) track.stop();
      streamRef.current = null;
    };

    const start = async () => {
      if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) {
        setStatus('unsupported');
        return;
      }
      let detector;
      try {
        detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      } catch {
        setStatus('unsupported');
        return;
      }

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
      } catch {
        setStatus('denied');
        return;
      }
      if (cancelled) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      setStatus('scanning');

      timerRef.current = setInterval(async () => {
        const video = videoRef.current;
        if (!video || video.readyState < 2) return;
        try {
          const codes = await detector.detect(video);
          if (!codes?.length) return;
          const code = extractCode(codes[0].rawValue);
          if (code) {
            stop();
            onDetected(code);
          } else {
            setMessage('That QR code is not a SyncAudio room.');
          }
        } catch {
          /* transient detect errors are safe to ignore */
        }
      }, SCAN_INTERVAL_MS);
    };

    start();
    return () => {
      cancelled = true;
      stop();
    };
  }, [onDetected]);

  return (
    <Modal
      title="Scan QR Code"
      subtitle="Point your camera at the host's QR code to join instantly."
      onClose={onClose}
    >
      {status === 'unsupported' ? (
        <div className="banner banner--info">
          <QrCode aria-hidden="true" />
          <span>
            This browser can&rsquo;t scan QR codes from the camera. Ask the host to share the link, or type the
            6-character Room ID instead.
          </span>
        </div>
      ) : status === 'denied' ? (
        <div className="banner banner--warn">
          <CameraOff aria-hidden="true" />
          <span>Camera access was blocked. Allow it in your browser settings, or enter the Room ID manually.</span>
        </div>
      ) : (
        <div className="stack stack--sm">
          <div className="scan-video">
            <video ref={videoRef} playsInline muted />
            {status === 'scanning' ? <div className="scan-video__frame" /> : null}
          </div>
          <p className="row" style={{ justifyContent: 'center', color: 'var(--muted)', fontSize: '0.85rem', gap: 8 }}>
            <ScanLine style={{ width: 16, height: 16 }} aria-hidden="true" />
            {message || 'Looking for a SyncAudio room…'}
          </p>
        </div>
      )}
    </Modal>
  );
}
