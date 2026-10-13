import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createSocket } from './api.js';
import { SyncEngine, SYNC_STATE } from './syncEngine.js';
import { getSessionId, getHostKey, setHostKey, getVolume, setVolume } from './identity.js';

/**
 * Owns the whole live session for one room:
 *   - the Socket.IO connection (with automatic reconnection),
 *   - the authoritative room snapshot pushed by the server,
 *   - the SyncEngine bound to this page's <audio> element.
 *
 * The component tree stays presentational: it renders `roomState` and calls the
 * command emitters returned here.
 */
export function useRoomSession({ code, displayName, audioRef, enabled = true, onToast }) {
  const sessionId = useMemo(() => getSessionId(), []);

  const [roomState, setRoomState] = useState(null);
  const [connection, setConnection] = useState('connecting');
  const [syncState, setSyncState] = useState(SYNC_STATE.CONNECTING);
  const [error, setError] = useState(null);
  const [ended, setEnded] = useState(null);
  const [loadedTrack, setLoadedTrack] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(null);

  const socketRef = useRef(null);
  const engineRef = useRef(null);
  const roomStateRef = useRef(null);
  const nameRef = useRef(displayName);
  const advanceGuardRef = useRef(0);
  const toastRef = useRef(onToast);

  nameRef.current = displayName;
  toastRef.current = onToast;

  const isHost = Boolean(roomState?.you?.isHost);

  // ------------------------------------------------------------------ lifecycle
  useEffect(() => {
    if (!enabled || !code || !audioRef.current) return undefined;

    const socket = createSocket();
    const engine = new SyncEngine({
      audio: audioRef.current,
      onStateChange: setSyncState,
      onTrackChange: setLoadedTrack,
      onServerState: (state) => setRoomState(state),
      onBlocked: () => {
        toastRef.current?.({
          type: 'warn',
          message: 'Your browser needs a tap before audio can play.',
        });
      },
      onEnded: () => {
        // The host drives the queue forward when a track finishes. Participants
        // just wait for the next command so they can never fight the host.
        const state = roomStateRef.current;
        if (!state?.you?.isHost || !state?.isPlaying) return;
        const now = Date.now();
        if (now - advanceGuardRef.current < 2500) return;
        advanceGuardRef.current = now;
        socket.emit('player:next', {});
      },
    });

    socketRef.current = socket;
    engineRef.current = engine;
    engine.attachSocket(socket);
    engine.start();
    engine.setVolume(getVolume());

    const join = () => {
      socket.emit(
        'room:join',
        {
          code,
          sessionId,
          displayName: nameRef.current,
          hostKey: getHostKey(code),
        },
        async (response) => {
          if (!response?.ok) {
            setConnection('failed');
            setError(response?.error ?? { code: 'SERVER_ERROR', message: 'Could not join the session.' });
            return;
          }
          if (response.hostKey) setHostKey(code, response.hostKey);
          setError(null);
          setConnection('connected');
          setRoomState(response.state);
          roomStateRef.current = response.state;
          setEnded(null);
          await engine.initialise();
          // Jump straight to the live playback position (first join/reconnect).
          await engine.applySnapshot(response.state);
        },
      );
    };

    const handleState = (state) => {
      roomStateRef.current = state;
      setRoomState(state);
    };

    socket.on('connect', () => {
      setConnection('connected');
      join();
    });
    socket.on('disconnect', () => setConnection('lost'));
    socket.on('connect_error', () => setConnection('lost'));
    socket.on('room:state', handleState);
    socket.on('player:command', (command) => engine.handleCommand(command));
    socket.on('room:ended', (payload) => {
      engine.destroy();
      setEnded(payload?.reason ?? 'host-ended');
    });
    socket.on('host:changed', (payload) => {
      setRoomState((previous) =>
        previous ? { ...previous, hostSessionId: payload.hostSessionId } : previous,
      );
    });
    socket.on('host:promoted', ({ hostKey }) => {
      setHostKey(code, hostKey);
      toastRef.current?.({ type: 'info', message: 'The host left — you are the host now.' });
    });
    socket.on('room:error', (payload) => {
      if (payload?.code === 'NOT_HOST') return; // participants can't trigger this
      toastRef.current?.({ type: 'error', message: payload?.message || 'Something went wrong.' });
    });

    if (!socket.connected) socket.connect();

    return () => {
      engine.destroy();
      engineRef.current = null;
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [code, enabled, sessionId, audioRef]);

  // Room state arriving from the server is the source of truth for the ref the
  // engine's onEnded handler reads, without re-subscribing the socket.
  useEffect(() => {
    roomStateRef.current = roomState;
  }, [roomState]);

  // ------------------------------------------------------------------- actions
  const sendCommand = useCallback(
    (event, payload = {}) => {
      const socket = socketRef.current;
      if (!socket?.connected) {
        toastRef.current?.({ type: 'error', message: 'Connection lost — reconnecting…' });
        return;
      }
      socket.emit(event, payload, (response) => {
        if (response && response.ok === false) {
          toastRef.current?.({
            type: 'error',
            message: response.error?.message || 'That action could not be completed.',
          });
        }
      });
    },
    [],
  );

  const play = useCallback((position) => sendCommand('player:play', { position }), [sendCommand]);
  const pause = useCallback((position) => sendCommand('player:pause', { position }), [sendCommand]);
  const seek = useCallback((position) => sendCommand('player:seek', { position }), [sendCommand]);
  const next = useCallback(() => sendCommand('player:next', {}), [sendCommand]);
  const previous = useCallback(() => sendCommand('player:previous', {}), [sendCommand]);
  const playTrack = useCallback(
    (index, autoplay = true) => sendCommand('player:track', { index, autoplay }),
    [sendCommand],
  );
  const endSession = useCallback(() => sendCommand('player:end', {}), [sendCommand]);

  const changeVolume = useCallback(
    (value) => {
      setVolume(value);
      engineRef.current?.setVolume(value);
    },
    [],
  );

  const toggleMute = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = !audio.muted;
    return audio.muted;
  }, [audioRef]);

  const retryAudio = useCallback(() => engineRef.current?.retry(), []);

  const leave = useCallback(() => {
    socketRef.current?.emit('room:leave');
  }, []);

  return {
    roomState,
    connection,
    syncState,
    error,
    ended,
    isHost,
    loadedTrack,
    sessionId,
    engineRef,
    audioRef,
    uploadProgress,
    setUploadProgress,
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
    sendCommand,
  };
}
