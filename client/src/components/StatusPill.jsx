import { SYNC_STATE } from '../lib/syncEngine.js';

/**
 * Friendly, non-technical connection + synchronisation feedback.
 * We never surface raw WebSocket errors, and we never promise millisecond
 * accuracy — the wording stays honest ("Synchronized", not "perfect sync").
 */
export function StatusPill({ connection, syncState }) {
  if (connection === 'lost' || syncState === SYNC_STATE.LOST) {
    return (
      <span className="status status--lost" title="Trying to reconnect automatically">
        <span className="status__dot" />
        Connection lost — reconnecting…
      </span>
    );
  }

  if (connection === 'connecting' || syncState === SYNC_STATE.CONNECTING) {
    return (
      <span className="status status--syncing">
        <span className="status__dot" />
        Connecting…
      </span>
    );
  }

  if (syncState === SYNC_STATE.BLOCKED) {
    return (
      <span className="status status--blocked">
        <span className="status__dot" />
        Tap to start audio
      </span>
    );
  }

  if (syncState === SYNC_STATE.ERROR) {
    return (
      <span className="status status--lost">
        <span className="status__dot" />
        Audio issue
      </span>
    );
  }

  if (syncState === SYNC_STATE.LOADING) {
    return (
      <span className="status status--syncing">
        <span className="status__dot" />
        Loading audio…
      </span>
    );
  }

  if (syncState === SYNC_STATE.SYNCING) {
    return (
      <span className="status status--syncing">
        <span className="status__dot" />
        Synchronizing…
      </span>
    );
  }

  return (
    <span className="status status--synced">
      <span className="status__dot" />
      Synchronized
    </span>
  );
}
