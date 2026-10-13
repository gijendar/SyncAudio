import { useNavigate } from 'react-router-dom';
import { Plus, LogIn, Radio, Smartphone, Zap, Share2, QrCode, ListMusic, PlayCircle } from 'lucide-react';
import { Nav } from './Nav.jsx';

const FEATURES = [
  {
    icon: Radio,
    variant: '',
    title: 'One audio file',
    body: 'The host picks a track once. It is loaded locally by every device, so no audio is streamed through the server.',
  },
  {
    icon: Smartphone,
    variant: 'feature__icon--blue',
    title: 'Multiple devices',
    body: 'Every phone, tablet and laptop in the room becomes another speaker in one temporary sound system.',
  },
  {
    icon: Zap,
    variant: 'feature__icon--cyan',
    title: 'Real-time synchronization',
    body: 'Play, pause and seek are scheduled against server time, so devices start together and gently correct drift.',
  },
];

const STEPS = [
  { num: '01', text: 'Create a room and get a short Room ID.' },
  { num: '02', text: 'Share the link or let friends scan the QR code.' },
  { num: '03', text: 'Everyone joins — no accounts, no setup.' },
  { num: '04', text: 'The host presses play. Every device hears it together.' },
];

export function Landing() {
  const navigate = useNavigate();

  return (
    <>
      <Nav>
        <button type="button" className="btn btn--ghost" onClick={() => navigate('/join')}>
          <LogIn aria-hidden="true" />
          Join Session
        </button>
      </Nav>

      <main className="page">
        <section className="hero">
          <span className="hero__eyebrow">
            <span className="dot" />
            Real-time multi-device audio
          </span>

          <h1 className="hero__title">
            Sync<span>Audio</span>
          </h1>

          <p className="hero__lead">
            One room. Every speaker. One beat. — Turn your friends&rsquo; phones into a synchronized
            speaker system.
          </p>
          <p className="hero__quote">&ldquo;Turn every device into one synchronized speaker.&rdquo;</p>

          <div className="hero__actions">
            <button type="button" className="btn btn--primary btn--lg" onClick={() => navigate('/create')}>
              <Plus aria-hidden="true" />
              Create Session
            </button>
            <button type="button" className="btn btn--secondary btn--lg" onClick={() => navigate('/join')}>
              <LogIn aria-hidden="true" />
              Join Session
            </button>
          </div>

          <p className="hero__note">No Bluetooth speaker? No problem.</p>
        </section>

        <section className="feature-strip" aria-label="What SyncAudio does">
          {FEATURES.map(({ icon: Icon, variant, title, body }) => (
            <article className="feature" key={title}>
              <div className={`feature__icon ${variant}`}>
                <Icon aria-hidden="true" />
              </div>
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </section>

        <section aria-label="How it works">
          <p className="kicker" style={{ textAlign: 'center' }}>
            How it works
          </p>
          <div className="how">
            {STEPS.map((step) => (
              <div className="how__step" key={step.num}>
                <span className="how__num">{step.num}</span>
                <p>{step.text}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="card" style={{ marginBottom: 40 }}>
          <div className="card__head">
            <span className="card__title">
              <Share2 aria-hidden="true" />
              Built for the room you&rsquo;re actually in
            </span>
          </div>
          <div className="row row--wrap" style={{ gap: 18 }}>
            <span className="tag">
              <QrCode aria-hidden="true" style={{ width: 14, height: 14 }} />
              QR joining
            </span>
            <span className="tag">
              <ListMusic aria-hidden="true" style={{ width: 14, height: 14 }} />
              Temporary playlist
            </span>
            <span className="tag">
              <PlayCircle aria-hidden="true" style={{ width: 14, height: 14 }} />
              Host-controlled playback
            </span>
            <span className="tag">Reconnects automatically</span>
            <span className="tag">Per-device volume</span>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        SyncAudio — synchronized playback, without the speaker. Audio is stored temporarily and removed when a
        session ends.
      </footer>
    </>
  );
}
