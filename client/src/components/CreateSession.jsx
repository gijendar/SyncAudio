import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Crown, Loader2, Sparkles } from 'lucide-react';
import { Nav } from './Nav.jsx';
import { createSocket } from '../lib/api.js';
import { getDisplayName, getSessionId, setDisplayName, setHostKey } from '../lib/identity.js';
import { useToast } from './ToastProvider.jsx';

function onceConnected(socket, timeoutMs = 9000) {
  if (socket.connected) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off('connect', onConnect);
      resolve(false);
    }, timeoutMs);
    const onConnect = () => {
      clearTimeout(timer);
      resolve(true);
    };
    socket.once('connect', onConnect);
    socket.connect();
  });
}

export function CreateSession() {
  const navigate = useNavigate();
  const toast = useToast();
  const socket = useMemo(() => createSocket(), []);
  const submittedRef = useRef(false);

  const [name, setName] = useState(() => getDisplayName());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => () => socket.disconnect(), [socket]);

  const createRoom = async (event) => {
    event.preventDefault();
    if (submittedRef.current || busy) return;

    const displayName = name.trim().slice(0, 24);
    if (displayName.length < 2) {
      setError('Please enter at least 2 characters for your name.');
      return;
    }

    submittedRef.current = true;
    setBusy(true);
    setError(null);

    const connected = await onceConnected(socket);
    if (!connected) {
      submittedRef.current = false;
      setBusy(false);
      setError('Could not reach the SyncAudio server. Check your connection and try again.');
      return;
    }

    socket.emit('room:create', { displayName, sessionId: getSessionId() }, (response) => {
      if (!response?.ok) {
        submittedRef.current = false;
        setBusy(false);
        setError(response?.error?.message || 'Could not create the session.');
        return;
      }
      setDisplayName(displayName);
      setHostKey(response.code, response.hostKey);
      toast({ type: 'success', message: `Room ${response.code} is ready.` });
      navigate(`/room/${response.code}`, { replace: true });
    });
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
          <span className="kicker">New session</span>
          <h1 style={{ fontSize: 'clamp(1.9rem, 6vw, 2.6rem)', letterSpacing: '-0.03em', marginTop: 6 }}>
            Start a SyncAudio room
          </h1>
          <p className="lede" style={{ marginTop: 10 }}>
            You&rsquo;ll get a short Room ID and a shareable link. Everyone who joins plays the same audio
            through their own speaker.
          </p>
        </div>

        <form className="card stack" onSubmit={createRoom}>
          <div className="field">
            <label className="field__label" htmlFor="host-name">
              Enter your display name
            </label>
            <input
              id="host-name"
              className={`input${error ? ' input--error' : ''}`}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                if (error) setError(null);
              }}
              placeholder="Gijendar"
              maxLength={24}
              autoComplete="nickname"
              autoFocus
              disabled={busy}
            />
            <span className="field__hint">This is what the other devices will see. No account needed.</span>
          </div>

          {error ? (
            <p className="banner banner--error" role="alert">
              {error}
            </p>
          ) : null}

          <button type="submit" className="btn btn--primary btn--lg btn--block" disabled={busy}>
            {busy ? <Loader2 className="spinner" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
            {busy ? 'Creating room…' : 'Create Room'}
          </button>

          <p className="row" style={{ color: 'var(--muted-dim)', fontSize: '0.82rem', gap: 8 }}>
            <Crown style={{ width: 14, height: 14 }} aria-hidden="true" />
            As the creator you become the host and control playback.
          </p>
        </form>
      </main>
    </>
  );
}
