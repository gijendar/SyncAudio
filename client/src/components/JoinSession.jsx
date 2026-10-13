import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Loader2, LogIn, QrCode } from 'lucide-react';
import { Nav } from './Nav.jsx';
import { ScanQR } from './ScanQR.jsx';
import { apiFetch } from '../lib/api.js';
import { getDisplayName, setDisplayName } from '../lib/identity.js';
import { normaliseCode } from '../lib/format.js';

export function JoinSession() {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const [code, setCode] = useState(() => normaliseCode(params.get('code') || ''));
  const [name, setName] = useState(() => getDisplayName());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    const preset = normaliseCode(params.get('code') || '');
    if (preset.length === 6) setCode(preset);
  }, [params]);

  const join = async (event) => {
    event.preventDefault();
    const roomCode = normaliseCode(code);
    const displayName = name.trim().slice(0, 24);

    if (roomCode.length !== 6) {
      setError('Please enter a valid 6-character Room ID.');
      return;
    }
    if (displayName.length < 2) {
      setError('Please enter at least 2 characters for your name.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      // Confirm the room exists before navigating, so we can show precise errors.
      const room = await apiFetch(`/api/rooms/${roomCode}`);
      if (room.status === 'ended') {
        setError('This session has ended.');
        setBusy(false);
        return;
      }
      setDisplayName(displayName);
      navigate(`/room/${roomCode}`);
    } catch (requestError) {
      setError(
        requestError.code === 'NOT_FOUND'
          ? 'Session not found. Please check the Room ID.'
          : requestError.message || 'Could not reach the session.',
      );
      setBusy(false);
    }
  };

  return (
    <>
      <Nav>
        <button type="button" className="btn btn--ghost" onClick={() => navigate('/')}>
          <ArrowLeft aria-hidden="true" />
          Back
        </button>
      </Nav>

      <main className="page page--narrow stack" style={{ paddingTop: 40, paddingBottom: 60 }}>
        <div>
          <span className="kicker">Join a session</span>
          <h1 style={{ fontSize: 'clamp(1.9rem, 6vw, 2.6rem)', letterSpacing: '-0.03em', marginTop: 6 }}>
            Enter the Room ID
          </h1>
          <p className="lede" style={{ marginTop: 10 }}>
            Ask the host for their 6-character Room ID, or scan their QR code.
          </p>
        </div>

        <form className="card stack" onSubmit={join}>
          <div className="field">
            <label className="field__label" htmlFor="room-code">
              Room ID
            </label>
            <input
              id="room-code"
              className={`input input--code${error ? ' input--error' : ''}`}
              value={code}
              onChange={(event) => {
                setCode(normaliseCode(event.target.value));
                if (error) setError(null);
              }}
              placeholder="A7X9P2"
              inputMode="text"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              maxLength={6}
              aria-describedby="room-code-hint"
            />
            <span className="field__hint" id="room-code-hint">
              Six letters and numbers, for example A7X9P2.
            </span>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="listener-name">
              Enter your display name
            </label>
            <input
              id="listener-name"
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Rahul"
              maxLength={24}
              autoComplete="nickname"
            />
          </div>

          {error ? (
            <p className="banner banner--error" role="alert">
              {error}
            </p>
          ) : null}

          <button type="submit" className="btn btn--primary btn--lg btn--block" disabled={busy}>
            {busy ? <Loader2 className="spinner" aria-hidden="true" /> : <LogIn aria-hidden="true" />}
            {busy ? 'Joining…' : 'Join Session'}
          </button>

          <button
            type="button"
            className="btn btn--secondary btn--block"
            onClick={() => setScanning(true)}
            disabled={busy}
          >
            <QrCode aria-hidden="true" />
            Scan QR Code
          </button>
        </form>
      </main>

      {scanning ? (
        <ScanQR
          onClose={() => setScanning(false)}
          onDetected={(detected) => {
            setScanning(false);
            setCode(detected);
            setError(null);
          }}
        />
      ) : null}
    </>
  );
}
