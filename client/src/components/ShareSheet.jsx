import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Check, Copy, Link2, QrCode, Share2 } from 'lucide-react';
import { Modal } from './Modal.jsx';
import { useToast } from './ToastProvider.jsx';

export function sessionLink(code) {
  if (typeof window === 'undefined') return `/room/${code}`;
  return `${window.location.origin}/room/${code}`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for browsers without the async clipboard API (or insecure origins).
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand?.('copy');
    document.body.removeChild(area);
    return Boolean(ok);
  }
}

export function ShareSheet({ code, onClose }) {
  const toast = useToast();
  const [qr, setQr] = useState(null);
  const [copied, setCopied] = useState(null);
  const link = sessionLink(code);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(link, {
      margin: 1,
      width: 512,
      errorCorrectionLevel: 'M',
      color: { dark: '#0b0b14', light: '#ffffff' },
    })
      .then((dataUrl) => {
        if (!cancelled) setQr(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setQr(null);
      });
    return () => {
      cancelled = true;
    };
  }, [link]);

  const flash = (key) => {
    setCopied(key);
    setTimeout(() => setCopied((current) => (current === key ? null : current)), 1800);
  };

  const copy = async (key, value, label) => {
    const ok = await copyText(value);
    if (ok) {
      flash(key);
      toast({ type: 'success', message: `${label} copied.` });
    } else {
      toast({ type: 'error', message: 'Copying is blocked in this browser. Select the text manually.' });
    }
  };

  const share = async () => {
    if (!navigator.share) {
      copy('link', link, 'Link');
      return;
    }
    try {
      await navigator.share({
        title: 'Join my SyncAudio session',
        text: `Join my SyncAudio room ${code} — every device becomes a speaker.`,
        url: link,
      });
    } catch {
      /* the user dismissed the share sheet */
    }
  };

  return (
    <Modal title="Invite your friends" subtitle="Share the Room ID, the link, or let them scan the QR code." onClose={onClose}>
      <div className="stack">
        <div className="code-display">
          <span className="code-display__label">Room ID</span>
          <span className="code-display__value">{code}</span>
        </div>

        <div className="link-box">
          <Link2 style={{ width: 15, height: 15, flex: 'none' }} aria-hidden="true" />
          <span title={link}>{link}</span>
        </div>

        <div className="row row--wrap">
          <button type="button" className="btn btn--secondary" onClick={() => copy('id', code, 'Room ID')}>
            {copied === 'id' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            Copy ID
          </button>
          <button type="button" className="btn btn--secondary" onClick={() => copy('link', link, 'Link')}>
            {copied === 'link' ? <Check aria-hidden="true" /> : <Link2 aria-hidden="true" />}
            Copy Link
          </button>
          <button type="button" className="btn btn--primary" onClick={share}>
            <Share2 aria-hidden="true" />
            Share
          </button>
        </div>

        <div className="stack stack--sm" style={{ marginTop: 6 }}>
          <span className="card__title">
            <QrCode aria-hidden="true" />
            Show QR Code
          </span>
          <div className="qr-frame">
            {qr ? (
              <img src={qr} alt={`QR code to join SyncAudio room ${code}`} />
            ) : (
              <span className="spinner" />
            )}
          </div>
          <p className="lede" style={{ textAlign: 'center', fontSize: '0.85rem' }}>
            A friend can scan this with their phone camera and land straight in this room.
          </p>
        </div>
      </div>
    </Modal>
  );
}
