import { useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  Check,
  Copy,
  Home,
  LogOut,
  QrCode,
  Share2,
  Sparkles,
  WifiOff,
} from 'lucide-react';
import { Nav } from './Nav.jsx';
import { Player } from './Player.jsx';
import { Queue } from './Queue.jsx';
import { Participants } from './Participants.jsx';
import { ShareSheet, copyText } from './ShareSheet.jsx';
import { NameGate } from './NameGate.jsx';
import { StatusPill } from './StatusPill.jsx';
import { useRoomSession } from '../lib/useRoomSession.js';
import { useToast } from './ToastProvider.jsx';
import { getDisplayName, setDisplayName } from '../lib/identity.js';
import { normaliseCode } from '../lib/format.js';

export function Room() {
  const { code: rawCode } = useParams();
  const code = normaliseCode(rawCode || '');
  const [name, setName] = useState(() => getDisplayName());

  if (code.length !== 6) {
    return (
      <StateScreen
        icon={AlertTriangle}
        title="Invalid Room ID"
        body="Room IDs are six letters or numbers, for example A7X9P2."
      />
    );
  }

  if (!name) {
    return (
      <NameGate
        code={code}
        onSubmit={(displayName) => {
          setDisplayName(displayName);
          setName(displayName);
        }}
      />
    );
  }

  return <RoomSession key={`${code}:${name}`} code={code} name={name} />;
}

function RoomSession({ code, name }) {
  const toast = useToast();
  const navigate = useNavigate();
  const audioRef = useRef(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const session = useRoomSession({
    code,
    displayName: name,
    audioRef,
    onToast: toast,
  });

  const {
    roomState,
    connection,
    syncState,
    error,
    ended,
    isHost,
    sessionId,
    play,
    pause,
    seek,
    next,
    previous,
    playTrack,
    endSession,
    changeVolume,
    toggleMute,
    retryAudio,
    leave,
  } = session;

  const tracks = roomState?.tracks ?? [];

  /**
   * The <audio> element must satisfy two things, or the room silently breaks:
   *
   *  1. It is rendered on *every* branch below, never behind `roomState`.
   *     `useRoomSession` binds the sync engine to this element when its effect
   *     runs, and that effect can only run once the element is in the DOM — so
   *     rendering it only after the first snapshot arrived deadlocked the page
   *     (no element -> no socket -> no snapshot). The room then stayed
   *     unconnected until the server's host-grace timer ended the session,
   *     which is why joiners were told "this session has ended" while the host
   *     tab was still open.
   *  2. It always sits at the *same* position in the tree — the first child of
   *     this component's root fragment, in every branch. React reconciles
   *     children by position, so moving the element between branches (for
   *     example from the loading screen into <main>) unmounts it and mounts a
   *     fresh one. The engine keeps the element it captured at mount time, so
   *     playback would continue on a detached node: the UI looks synced while
   *     no audio is ever heard.
   */
  const audio = <audio ref={audioRef} preload="auto" playsInline />;

  const handleCopyId = async () => {
    const ok = await copyText(code);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      toast({ type: 'success', message: `Room ID ${code} copied.` });
    } else {
      toast({ type: 'error', message: 'Copying is blocked in this browser.' });
    }
  };

  const handleEnd = () => {
    endSession();
    toast({ type: 'info', message: 'Ending the session…' });
  };

  const handleLeave = () => {
    leave();
    navigate('/');
  };

  if (error) {
    const notFound = error.code === 'NOT_FOUND';
    const hasEnded = error.code === 'ENDED';
    return (
      <>
        {audio}
        <StateScreen
          icon={hasEnded ? WifiOff : AlertTriangle}
          title={hasEnded ? 'Session Ended' : notFound ? 'Session not found' : 'Could not join'}
          body={
            hasEnded
              ? 'This session has ended. Ask the host to start a new one.'
              : error.message || 'Please check the Room ID and try again.'
          }
          primary={{ label: 'Back to home', onClick: () => navigate('/') }}
          secondary={{ label: 'Try another room', onClick: () => navigate('/join') }}
        />
      </>
    );
  }

  if (ended) {
    return (
      <>
        {audio}
        <StateScreen
          icon={WifiOff}
          title="Session Ended"
          body={
            ended === 'expired'
              ? 'This room timed out after everyone left. Start a new session any time.'
              : 'The host ended this SyncAudio session. Thanks for listening together!'
          }
          primary={{ label: 'Start a new session', onClick: () => navigate('/create') }}
          secondary={{ label: 'Back to home', onClick: () => navigate('/') }}
        />
      </>
    );
  }

  if (!roomState) {
    return (
      <>
        {audio}
        <Nav />
        <main className="page centered">
          <div className="stack" style={{ alignItems: 'center' }}>
            <span className="spinner" />
            <p className="lede">Joining room {code}…</p>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      {/* Playback is driven entirely by the sync engine; this element only exists to play. */}
      {audio}

      <Nav>
        <StatusPill connection={connection} syncState={syncState} />
        <button type="button" className="btn btn--icon" onClick={handleCopyId} aria-label="Copy Room ID">
          {copied ? <Check /> : <Copy />}
        </button>
        <button type="button" className="btn btn--icon" onClick={() => setShareOpen(true)} aria-label="Show QR code and share">
          <QrCode />
        </button>
        {isHost ? (
          <button type="button" className="btn btn--danger" onClick={handleEnd}>
            <LogOut aria-hidden="true" />
            End
          </button>
        ) : (
          <button type="button" className="btn btn--ghost" onClick={handleLeave}>
            <LogOut aria-hidden="true" />
            Leave
          </button>
        )}
      </Nav>

      <main className="page" style={{ paddingTop: 18 }}>
        {connection === 'lost' ? (
          <div className="banner banner--warn" style={{ marginBottom: 16 }} role="status">
            <WifiOff aria-hidden="true" />
            <span>
              Connection lost — reconnecting… Playback will resynchronise automatically, no need to reload.
            </span>
          </div>
        ) : null}

        <div className="room-head">
          <div className="room-head__id">
            <span className="kicker">Sync room</span>
            <span className="code">{code}</span>
          </div>
          <div className="row row--wrap">
            <span className="tag">
              <Home style={{ width: 13, height: 13 }} aria-hidden="true" />
              {name}
              {isHost ? ' · Host' : ''}
            </span>
            <button type="button" className="btn btn--secondary" onClick={() => setShareOpen(true)}>
              <Share2 aria-hidden="true" />
              Share Session
            </button>
          </div>
        </div>

        {isHost && tracks.length === 0 ? (
          <div className="card" style={{ marginBottom: 18 }}>
            <div className="card__head">
              <span className="card__title">
                <Sparkles aria-hidden="true" />
                Your session is ready
              </span>
              <span className="tag tag--live">Waiting for friends…</span>
            </div>
            <p className="lede">
              Share the room with your friends, then upload audio to begin. Everyone who joins hears the same
              track through their own speaker.
            </p>
            <div className="row row--wrap" style={{ marginTop: 14 }}>
              <button type="button" className="btn btn--primary" onClick={() => setShareOpen(true)}>
                <Share2 aria-hidden="true" />
                Share Link
              </button>
              <button type="button" className="btn btn--secondary" onClick={handleCopyId}>
                <Copy aria-hidden="true" />
                Copy ID
              </button>
              <span className="tag">
                Room ID: <b style={{ letterSpacing: '0.12em' }}>{code}</b>
              </span>
            </div>
          </div>
        ) : null}

        <div className="room">
          <Player
            roomState={roomState}
            isHost={isHost}
            syncState={syncState}
            connection={connection}
            audioRef={audioRef}
            onPlay={() => play()}
            onPause={() => pause()}
            onSeek={seek}
            onNext={next}
            onPrevious={previous}
            onRetryAudio={retryAudio}
            onVolumeChange={changeVolume}
            onToggleMute={toggleMute}
          />

          <div className="stack">
            <Participants roomState={roomState} code={code} onShare={() => setShareOpen(true)} />
            <Queue
              code={code}
              roomState={roomState}
              isHost={isHost}
              sessionId={sessionId}
              onPlayTrack={(index) => playTrack(index, true)}
              uploadProgress={session.uploadProgress}
              setUploadProgress={session.setUploadProgress}
            />
          </div>
        </div>
      </main>

      {shareOpen ? <ShareSheet code={code} onClose={() => setShareOpen(false)} /> : null}
    </>
  );
}

function StateScreen({ icon: Icon, title, body, primary, secondary }) {
  const navigate = useNavigate();
  return (
    <>
      <Nav />
      <main className="page centered">
        <div className="card stack" style={{ maxWidth: 470, textAlign: 'center', alignItems: 'center' }}>
          <span
            style={{
              width: 58,
              height: 58,
              borderRadius: 18,
              display: 'grid',
              placeItems: 'center',
              background: 'rgba(124, 92, 255, 0.16)',
              border: '1px solid rgba(124, 92, 255, 0.34)',
            }}
          >
            <Icon style={{ width: 26, height: 26, color: '#c4b4ff' }} aria-hidden="true" />
          </span>
          <h1 style={{ fontSize: '1.5rem', letterSpacing: '-0.02em' }}>{title}</h1>
          <p className="lede">{body}</p>
          <div className="row row--wrap" style={{ justifyContent: 'center' }}>
            {primary ? (
              <button type="button" className="btn btn--primary" onClick={primary.onClick}>
                {primary.label}
              </button>
            ) : null}
            {secondary ? (
              <button type="button" className="btn btn--ghost" onClick={secondary.onClick}>
                {secondary.label}
              </button>
            ) : (
              <button type="button" className="btn btn--ghost" onClick={() => navigate('/')}>
                Back to home
              </button>
            )}
          </div>
        </div>
      </main>
    </>
  );
}
