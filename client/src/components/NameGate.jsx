import { useState } from 'react';
import { ArrowLeft, LogIn } from 'lucide-react';
import { Nav } from './Nav.jsx';
import { useNavigate } from 'react-router-dom';

/**
 * Shown when someone lands on a room link (or scans the QR code) without a
 * display name yet. No registration — just a name, then straight in.
 */
export function NameGate({ code, onSubmit }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [error, setError] = useState(null);

  const submit = (event) => {
    event.preventDefault();
    const displayName = name.trim().slice(0, 24);
    if (displayName.length < 2) {
      setError('Please enter at least 2 characters.');
      return;
    }
    onSubmit(displayName);
  };

  return (
    <>
      <Nav>
        <button type="button" className="btn btn--ghost" onClick={() => navigate('/')}>
          <ArrowLeft aria-hidden="true" />
          Home
        </button>
      </Nav>

      <main className="page page--narrow" style={{ paddingTop: 40 }}>
        <div className="stack">
          <div>
            <span className="kicker">You&rsquo;ve been invited</span>
            <h1 style={{ fontSize: 'clamp(1.8rem, 6vw, 2.4rem)', letterSpacing: '-0.03em', marginTop: 6 }}>
              Join room {code}
            </h1>
            <p className="lede" style={{ marginTop: 10 }}>
              Pick a name so the other devices know who is in the room. No account, no sign-up.
            </p>
          </div>

          <form className="card stack" onSubmit={submit}>
            <div className="field">
              <label className="field__label" htmlFor="gate-name">
                Enter your display name
              </label>
              <input
                id="gate-name"
                className={`input${error ? ' input--error' : ''}`}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setError(null);
                }}
                placeholder="Neha"
                maxLength={24}
                autoFocus
                autoComplete="nickname"
              />
              {error ? <span className="field__hint" style={{ color: '#fca5a5' }}>{error}</span> : null}
            </div>
            <button type="submit" className="btn btn--primary btn--lg btn--block">
              <LogIn aria-hidden="true" />
              Join Session
            </button>
          </form>
        </div>
      </main>
    </>
  );
}
