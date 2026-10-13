import { useEffect, useRef, useState } from 'react';
import {
  Crown,
  Headphones,
  Music,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  Zap,
} from 'lucide-react';
import { Visualizer } from './Visualizer.jsx';
import { StatusPill } from './StatusPill.jsx';
import { formatTime, pluralise, stripExtension } from '../lib/format.js';
import { SYNC_STATE } from '../lib/syncEngine.js';
import { getVolume } from '../lib/identity.js';

const TICK_MS = 250;

export function Player({
  roomState,
  isHost,
  syncState,
  connection,
  audioRef,
  onPlay,
  onPause,
  onSeek,
  onNext,
  onPrevious,
  onRetryAudio,
  onVolumeChange,
  onToggleMute,
}) {
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [scrubbing, setScrubbing] = useState(null);
  const [volume, setVolume] = useState(() => getVolume());
  const [muted, setMuted] = useState(false);
  const scrubbingRef = useRef(false);

  const track = roomState?.currentTrack ?? null;
  const isPlaying = Boolean(roomState?.isPlaying);
  const connected = roomState?.connectedCount ?? 0;
  const hasTrack = Boolean(track);
  const displayDuration = duration || track?.duration || 0;

  // Local progress readout. Playback is driven by the sync engine, not the UI.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    const timer = setInterval(() => {
      if (scrubbingRef.current) return;
      setPosition(audio.currentTime || 0);
      setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [audioRef]);

  const commitSeek = (value) => {
    scrubbingRef.current = false;
    setScrubbing(null);
    if (!isHost) return;
    onSeek(value);
  };

  const progressPercent = displayDuration > 0 ? Math.min(100, (position / displayDuration) * 100) : 0;
  const blocked = syncState === SYNC_STATE.BLOCKED;

  return (
    <section className="player">
      <div className="row row--between" style={{ zIndex: 1 }}>
        <span className={`tag${isHost ? ' tag--host' : ''}`}>
          {isHost ? <Crown style={{ width: 13, height: 13 }} aria-hidden="true" /> : <Headphones style={{ width: 13, height: 13 }} aria-hidden="true" />}
          {isHost ? 'You are the host' : 'Listening'}
        </span>
        <span className="tag tag--live">
          <Zap style={{ width: 13, height: 13 }} aria-hidden="true" />
          {pluralise(connected, 'device')} synced
        </span>
      </div>

      <div className={`artwork${isPlaying ? ' artwork--playing' : ''}`}>
        <span className={`artwork__badge${isHost ? ' artwork__badge--host' : ''}`}>
          {isPlaying ? 'PLAYING' : hasTrack ? 'READY' : 'WAITING'}
        </span>
        {hasTrack ? (
          <Visualizer active={isPlaying} />
        ) : (
          <div className="artwork__empty">
            <Music aria-hidden="true" />
            <p>
              {isHost
                ? 'Upload an audio file to start the session.'
                : 'Waiting for the host to add audio…'}
            </p>
          </div>
        )}
      </div>

      <div className="track-meta">
        <h2 className="track-meta__title" title={track?.name}>
          {track ? stripExtension(track.name) : 'Nothing playing yet'}
        </h2>
        <p className="track-meta__sub">
          {track ? track.name : isHost ? 'Add audio from the queue below' : 'Waiting for the host'}
        </p>
      </div>

      <div className="progress">
        <div className="progress__times">
          <span>{formatTime(scrubbing ?? position)}</span>
          <span>{formatTime(displayDuration)}</span>
        </div>
        <input
          className="range"
          type="range"
          min={0}
          max={Math.max(displayDuration, 1)}
          step={0.05}
          value={Math.min(scrubbing ?? position, Math.max(displayDuration, 1))}
          style={{ '--fill': `${progressPercent}%` }}
          disabled={!isHost || !hasTrack}
          aria-label="Seek"
          onPointerDown={() => {
            if (!isHost) return;
            scrubbingRef.current = true;
            setScrubbing(position);
          }}
          onChange={(event) => {
            const value = Number(event.target.value);
            setScrubbing(value);
            // Pointer events cover mouse + touch; keyboard users commit on change.
            if (!event.nativeEvent?.pointerType) {
              scrubbingRef.current = true;
            }
          }}
          onPointerUp={(event) => commitSeek(Number(event.currentTarget.value))}
          onKeyUp={(event) => commitSeek(Number(event.currentTarget.value))}
          onBlur={(event) => {
            if (scrubbingRef.current) commitSeek(Number(event.currentTarget.value));
          }}
        />
      </div>

      <div className="controls">
        <button
          type="button"
          className="controls__side"
          onClick={() => onPrevious()}
          disabled={!isHost || !hasTrack}
          aria-label="Previous track"
          title={isHost ? 'Previous' : 'Host controls playback'}
        >
          <SkipBack />
        </button>

        <button
          type="button"
          className="controls__play"
          onClick={() => (isPlaying ? onPause() : onPlay())}
          disabled={!isHost || !hasTrack}
          aria-label={isPlaying ? 'Pause' : 'Play'}
          title={isHost ? (isPlaying ? 'Pause' : 'Play') : 'Host controls playback'}
        >
          {isPlaying ? <Pause /> : <Play />}
        </button>

        <button
          type="button"
          className="controls__side"
          onClick={() => onNext()}
          disabled={!isHost || !hasTrack}
          aria-label="Next track"
          title={isHost ? 'Next' : 'Host controls playback'}
        >
          <SkipForward />
        </button>
      </div>

      <div className="volume">
        <button
          type="button"
          onClick={() => setMuted(Boolean(onToggleMute()))}
          aria-label={muted ? 'Unmute this device' : 'Mute this device'}
          style={{ display: 'flex', alignItems: 'center' }}
        >
          {muted || volume === 0 ? (
            <VolumeX className="volume__icon" aria-hidden="true" />
          ) : (
            <Volume2 className="volume__icon" aria-hidden="true" />
          )}
        </button>
        <input
          className="range"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          style={{ '--fill': `${volume * 100}%` }}
          aria-label="Volume for this device"
          onChange={(event) => {
            const value = Number(event.target.value);
            setVolume(value);
            if (muted) setMuted(false);
            onVolumeChange(value);
          }}
        />
        <span className="people__meta" style={{ minWidth: 34, textAlign: 'right' }}>
          {Math.round(volume * 100)}%
        </span>
      </div>

      {blocked ? (
        <div className="autoplay-banner">
          <p>Your browser needs a tap before it can start audio.</p>
          <button type="button" className="btn btn--primary" onClick={onRetryAudio}>
            <Play aria-hidden="true" />
            Tap to Start Audio
          </button>
        </div>
      ) : null}

      <div className="host-bar">
        {isHost ? (
          <>
            <span className="host-bar__label">
              <Crown aria-hidden="true" />
              Host controls playback
            </span>
            <span className="people__meta">Everyone hears what you play</span>
          </>
        ) : (
          <>
            <span className="host-bar__label">
              <Headphones aria-hidden="true" />
              Host controls playback
            </span>
            <span className="people__meta">You control your own volume only</span>
          </>
        )}
      </div>

      <div className="row row--between" style={{ zIndex: 1 }}>
        <span className="people__meta">Synchronized playback — devices start together and self-correct drift.</span>
        <StatusPill connection={connection} syncState={syncState} />
      </div>
    </section>
  );
}
