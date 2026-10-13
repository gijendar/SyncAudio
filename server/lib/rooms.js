import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { config, limits } from '../config.js';

/**
 * Authoritative room + playback state.
 *
 * Every room lives in this in-memory manager. The manager is the single source
 * of truth for playback position; clients never get to assert where playback is.
 * A client (the host) asks for a state transition, the manager applies it at a
 * future *server* timestamp, and every device schedules against that timestamp.
 * That is what turns N independent phones into one speaker system.
 *
 * The manager emits high-level events ("room:changed", "player:command", ...)
 * and the Socket.IO layer in `server/realtime.js` decides how to deliver them.
 * Keeping the transport out of here is what makes the sync logic testable and
 * replaceable later.
 */

/** Ambiguous characters (0/O, 1/I) are intentionally excluded from room codes. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const ROOM_STATUS = {
  WAITING: 'waiting',
  ACTIVE: 'active',
  PAUSED: 'paused',
  ENDED: 'ended',
};

export class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoomError';
    this.code = code;
  }
}

function generateRoomCode(length = 6) {
  let code = '';
  for (let index = 0; index < length; index += 1) {
    code += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return code;
}

export function normaliseRoomCode(input) {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export function sanitiseDisplayName(input, fallback = 'Listener') {
  const cleaned = String(input ?? '')
    // Strip control characters that could break rendering or logs.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limits.maxDisplayNameLength);
  return cleaned || fallback;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function trackMeta(track) {
  return {
    id: track.id,
    name: track.name,
    url: track.url,
    mime: track.mime,
    size: track.size,
    duration: track.duration,
  };
}

export class RoomManager extends EventEmitter {
  constructor({ db, storage } = {}) {
    super();
    this.rooms = new Map();
    this.tracks = new Map(); // trackId -> { roomCode, storageKey }
    this.db = db ?? null;
    this.storage = storage ?? null;
    this.sweepTimer = setInterval(() => this.sweep(), 60 * 1000);
    this.sweepTimer.unref?.();
  }

  // ---------------------------------------------------------------- lifecycle

  createRoom({ displayName, sessionId } = {}) {
    const session = sessionId || crypto.randomUUID();

    let code = generateRoomCode();
    let guard = 0;
    while (this.rooms.has(code) && guard < 50) {
      code = generateRoomCode();
      guard += 1;
    }

    const now = Date.now();
    const room = {
      code,
      status: ROOM_STATUS.WAITING,
      hostSessionId: session,
      hostKey: crypto.randomUUID(),
      createdAt: now,
      createdAtIso: new Date(now).toISOString(),
      updatedAt: now,
      tracks: [],
      storageBytes: 0,
      currentTrackIndex: -1,
      currentTrackId: null,
      // Playback anchor: at `anchorServerTime` the position is `anchorPosition`.
      anchorPosition: 0,
      anchorServerTime: now,
      isPlaying: false,
      participants: new Map(),
      emptySince: now,
      hostGraceTimer: null,
    };

    this.rooms.set(code, room);

    const participant = this.#upsertParticipant(room, {
      sessionId: session,
      displayName,
      socketId: null,
      isHost: true,
    });

    this.db?.upsertRoom(room);
    this.db?.upsertParticipant(room, participant);
    this.emit('room:created', room);
    return room;
  }

  getRoom(rawCode) {
    const code = normaliseRoomCode(rawCode);
    if (code.length !== 6) {
      throw new RoomError('INVALID_CODE', 'Please enter a valid 6-character Room ID.');
    }
    const room = this.rooms.get(code);
    if (!room) {
      throw new RoomError('NOT_FOUND', 'Session not found. Please check the Room ID.');
    }
    if (room.status === ROOM_STATUS.ENDED) {
      throw new RoomError('ENDED', 'This session has ended.');
    }
    return room;
  }

  peekRoom(rawCode) {
    return this.rooms.get(normaliseRoomCode(rawCode)) ?? null;
  }

  // --------------------------------------------------------------- membership

  #upsertParticipant(room, { sessionId, displayName, socketId, isHost }) {
    let participant = room.participants.get(sessionId);
    const now = Date.now();

    if (!participant) {
      if (room.participants.size >= limits.maxParticipantsPerRoom) {
        throw new RoomError('ROOM_FULL', 'This session is full.');
      }
      participant = {
        sessionId,
        name: sanitiseDisplayName(displayName),
        isHost: Boolean(isHost),
        socketId: socketId ?? null,
        connected: Boolean(socketId),
        joinedAt: now,
        joinedAtIso: new Date(now).toISOString(),
        lastSeen: now,
      };
      room.participants.set(sessionId, participant);
    } else {
      // Reconnect or rename: keep join order, refresh presence.
      if (displayName) participant.name = sanitiseDisplayName(displayName, participant.name);
      if (socketId) participant.socketId = socketId;
      participant.connected = Boolean(socketId);
      participant.lastSeen = now;
      if (isHost) participant.isHost = true;
    }

    room.emptySince = null;
    if (room.hostGraceTimer) {
      clearTimeout(room.hostGraceTimer);
      room.hostGraceTimer = null;
    }
    room.updatedAt = now;
    return participant;
  }

  joinRoom(rawCode, { sessionId, displayName, socketId, hostKey } = {}) {
    const room = this.getRoom(rawCode);
    const session = sessionId || crypto.randomUUID();

    const claimsHost = session === room.hostSessionId || (hostKey && hostKey === room.hostKey);
    if (claimsHost) room.hostSessionId = session;

    const participant = this.#upsertParticipant(room, {
      sessionId: session,
      displayName,
      socketId,
      isHost: claimsHost,
    });

    this.db?.upsertParticipant(room, participant);
    return { room, participant, claimsHost };
  }

  markConnected(room, sessionId, socketId) {
    const participant = room.participants.get(sessionId);
    if (!participant) return null;
    participant.socketId = socketId;
    participant.connected = true;
    participant.lastSeen = Date.now();
    room.emptySince = null;
    if (room.hostGraceTimer) {
      clearTimeout(room.hostGraceTimer);
      room.hostGraceTimer = null;
    }
    return participant;
  }

  /**
   * Mark a socket as gone. Returns the room so callers can broadcast. The room
   * itself is only destroyed once its idle TTL expires, which is what lets a
   * participant reconnect and resynchronise without a reload.
   */
  leaveBySocket(room, socketId) {
    let changed = false;
    let leftSessionId = null;

    for (const participant of room.participants.values()) {
      if (participant.socketId === socketId) {
        participant.connected = false;
        participant.socketId = null;
        participant.lastSeen = Date.now();
        leftSessionId = participant.sessionId;
        changed = true;
        this.db?.markParticipantDisconnected(room, participant.sessionId);
      }
    }

    if (!changed) return { changed: false, room };

    const anyConnected = [...room.participants.values()].some((p) => p.connected);
    if (!anyConnected) {
      room.emptySince = Date.now();
      this.#scheduleHostGrace(room);
    }

    room.updatedAt = Date.now();
    return { changed: true, room, sessionId: leftSessionId };
  }

  /**
   * If the host is gone we give them a short grace period. If they come back,
   * nothing happens. If they don't, we hand the room to the longest-connected
   * remaining device (host migration), or end the session when nobody is left.
   */
  #scheduleHostGrace(room) {
    if (room.hostGraceTimer) clearTimeout(room.hostGraceTimer);
    room.hostGraceTimer = setTimeout(() => {
      room.hostGraceTimer = null;
      const host = room.participants.get(room.hostSessionId);

      if (host?.connected) return;

      const successor = [...room.participants.values()]
        .filter((p) => p.connected)
        .sort((a, b) => a.joinedAt - b.joinedAt)[0];

      if (successor) {
        const previousHostSessionId = room.hostSessionId;
        room.hostSessionId = successor.sessionId;
        room.hostKey = crypto.randomUUID();
        for (const participant of room.participants.values()) {
          participant.isHost = participant.sessionId === successor.sessionId;
        }
        this.emit('host:promoted', {
          room,
          sessionId: successor.sessionId,
          hostKey: room.hostKey,
          previousHostSessionId,
        });
        this.db?.upsertParticipant(room, successor);
        this.emit('room:changed', room);
        return;
      }

      this.endRoom(room, 'host-left');
    }, config.hostGraceMs);
    room.hostGraceTimer.unref?.();
  }

  // ------------------------------------------------------------- playback core

  /** Authoritative position (seconds) of the room at server time `now`. */
  currentPosition(room, now = Date.now()) {
    if (!room.isPlaying) return room.anchorPosition;
    const elapsed = Math.max(0, now - room.anchorServerTime) / 1000;
    return room.anchorPosition + elapsed;
  }

  #currentTrack(room) {
    if (room.currentTrackIndex < 0) return null;
    return room.tracks[room.currentTrackIndex] ?? null;
  }

  #assertHost(room, sessionId) {
    if (room.hostSessionId !== sessionId) {
      throw new RoomError('NOT_HOST', 'Only the host controls playback.');
    }
  }

  #clampToTrack(room, position) {
    const track = this.#currentTrack(room);
    const duration = track?.duration;
    if (typeof duration === 'number' && duration > 0) {
      return clamp(position, 0, Math.max(0, duration - 0.05));
    }
    return Math.max(0, position);
  }

  #emitCommand(room, command) {
    room.updatedAt = Date.now();
    this.emit('player:command', { room, command });
    this.emit('room:changed', room);
    this.db?.updateRoom(room);
  }

  play(room, sessionId, { position } = {}) {
    this.#assertHost(room, sessionId);
    if (room.tracks.length === 0) {
      throw new RoomError('EMPTY_QUEUE', 'Add an audio track before starting playback.');
    }
    if (room.currentTrackIndex < 0) {
      room.currentTrackIndex = 0;
      room.currentTrackId = room.tracks[0].id;
    }

    const now = Date.now();
    const target = this.#clampToTrack(
      room,
      Number.isFinite(position) ? position : this.currentPosition(room, now),
    );

    room.anchorPosition = target;
    room.anchorServerTime = now + limits.playAheadMs;
    room.isPlaying = true;
    room.status = ROOM_STATUS.ACTIVE;

    const track = this.#currentTrack(room);
    this.#emitCommand(room, {
      action: 'play',
      position: target,
      playAt: room.anchorServerTime,
      serverTime: now,
      isPlaying: true,
      trackIndex: room.currentTrackIndex,
      track: track ? trackMeta(track) : null,
    });
  }

  pause(room, sessionId, { position } = {}) {
    this.#assertHost(room, sessionId);
    const now = Date.now();
    const at = now + limits.commandAheadMs;
    const target = this.#clampToTrack(
      room,
      Number.isFinite(position) ? position : this.currentPosition(room, now),
    );

    room.anchorPosition = target;
    room.anchorServerTime = at;
    room.isPlaying = false;
    room.status = room.tracks.length ? ROOM_STATUS.PAUSED : ROOM_STATUS.WAITING;

    this.#emitCommand(room, {
      action: 'pause',
      position: target,
      at,
      playAt: at,
      serverTime: now,
      isPlaying: false,
      trackIndex: room.currentTrackIndex,
    });
  }

  seek(room, sessionId, { position } = {}) {
    this.#assertHost(room, sessionId);
    const now = Date.now();
    const at = now + limits.commandAheadMs;
    const target = this.#clampToTrack(room, Number(position));

    room.anchorPosition = target;
    room.anchorServerTime = at;

    const track = this.#currentTrack(room);
    this.#emitCommand(room, {
      action: 'seek',
      position: target,
      at,
      playAt: at,
      serverTime: now,
      isPlaying: room.isPlaying,
      trackIndex: room.currentTrackIndex,
      track: track ? trackMeta(track) : null,
    });
  }

  setTrack(room, sessionId, index, { autoplay } = {}) {
    this.#assertHost(room, sessionId);
    const next = Math.trunc(Number(index));
    if (!Number.isFinite(next) || next < 0 || next >= room.tracks.length) {
      throw new RoomError('BAD_TRACK', 'That track is not available.');
    }

    const shouldPlay = autoplay ?? room.isPlaying;
    const now = Date.now();
    const at = now + limits.trackChangeAheadMs;

    room.currentTrackIndex = next;
    room.currentTrackId = room.tracks[next].id;
    room.anchorPosition = 0;
    room.anchorServerTime = at;
    room.isPlaying = shouldPlay;
    room.status = shouldPlay ? ROOM_STATUS.ACTIVE : ROOM_STATUS.PAUSED;

    this.#emitCommand(room, {
      action: 'track',
      trackIndex: next,
      track: trackMeta(room.tracks[next]),
      position: 0,
      playAt: shouldPlay ? at : null,
      at,
      serverTime: now,
      isPlaying: shouldPlay,
    });
  }

  next(room, sessionId) {
    if (room.tracks.length === 0) throw new RoomError('EMPTY_QUEUE', 'The queue is empty.');
    const nextIndex = room.currentTrackIndex + 1;
    if (nextIndex >= room.tracks.length) {
      if (room.isPlaying) return this.pause(room, sessionId, { position: 0 });
      room.anchorPosition = 0;
      room.anchorServerTime = Date.now();
      this.#emitCommand(room, {
        action: 'seek',
        position: 0,
        at: Date.now(),
        serverTime: Date.now(),
        isPlaying: false,
        trackIndex: room.currentTrackIndex,
      });
      return;
    }
    this.setTrack(room, sessionId, nextIndex, { autoplay: room.isPlaying });
  }

  previous(room, sessionId) {
    if (room.tracks.length === 0) throw new RoomError('EMPTY_QUEUE', 'The queue is empty.');
    const current = room.currentPosition(room);
    // Match the behaviour people expect: restart the track unless we're near the top.
    if (current > 3 || room.currentTrackIndex <= 0) {
      this.seek(room, sessionId, { position: 0 });
      return;
    }
    this.setTrack(room, sessionId, room.currentTrackIndex - 1, { autoplay: room.isPlaying });
  }

  endRoom(room, reason = 'host-ended') {
    if (room.status === ROOM_STATUS.ENDED) return;
    room.status = ROOM_STATUS.ENDED;
    room.isPlaying = false;
    room.anchorPosition = this.currentPosition(room);
    room.anchorServerTime = Date.now();
    room.updatedAt = Date.now();
    if (room.hostGraceTimer) {
      clearTimeout(room.hostGraceTimer);
      room.hostGraceTimer = null;
    }
    this.emit('room:ended', { room, reason });
    this.db?.updateRoom(room);
  }

  // -------------------------------------------------------------------- tracks

  addTrack(room, sessionId, { name, storageKey, url, mime, size, duration }) {
    this.#assertHost(room, sessionId);
    if (room.tracks.length >= limits.maxTracksPerRoom) {
      throw new RoomError('QUEUE_FULL', 'The queue is full. Remove a track to add more.');
    }
    if (room.storageBytes + size > config.maxRoomStorageBytes) {
      throw new RoomError('STORAGE_FULL', 'This room has reached its temporary storage limit.');
    }

    const id = crypto.randomUUID();
    const track = {
      id,
      name: sanitiseDisplayName(name, 'audio'),
      storageKey,
      // Clients fetch the audio over HTTP so they always play a local copy.
      url: typeof url === 'string' ? url : `/api/tracks/${id}`,
      mime: mime || 'audio/mpeg',
      size,
      duration: Number.isFinite(Number(duration)) ? Number(duration) : 0,
      queuePosition: room.tracks.length,
      createdAtIso: new Date().toISOString(),
    };

    room.tracks.push(track);
    room.storageBytes += size;
    this.tracks.set(track.id, { roomCode: room.code, storageKey: track.storageKey });
    room.updatedAt = Date.now();

    // First track uploaded to an idle room becomes the selected track.
    if (room.currentTrackIndex < 0) {
      room.currentTrackIndex = 0;
      room.currentTrackId = track.id;
      room.anchorPosition = 0;
      room.anchorServerTime = Date.now();
    }

    this.db?.insertTrack(room, track);
    this.emit('room:tracks', room);
    this.emit('room:changed', room);
    return track;
  }    removeTrack(room, sessionId, trackId) {
    this.#assertHost(room, sessionId);
    const index = room.tracks.findIndex((track) => track.id === trackId);
    if (index === -1) throw new RoomError('BAD_TRACK', 'That track is no longer in the queue.');

    const [removed] = room.tracks.splice(index, 1);
    room.storageBytes = Math.max(0, room.storageBytes - removed.size);
    this.tracks.delete(removed.id);
    this.db?.deleteTrack(removed.id);
    this.storage?.deleteUpload?.(room.code, removed.storageKey).catch((error) => {
      console.warn('[rooms] could not delete upload', removed.storageKey, error?.message);
    });

    room.tracks.forEach((track, position) => {
      track.queuePosition = position;
    });

    if (room.tracks.length === 0) {
      room.currentTrackIndex = -1;
      room.currentTrackId = null;
      room.anchorPosition = 0;
      room.anchorServerTime = Date.now();
      room.isPlaying = false;
      room.status = ROOM_STATUS.WAITING;
    } else if (index === room.currentTrackIndex) {
      // Removed the playing track: fall back to the track that slid into place.
      const nextIndex = Math.min(index, room.tracks.length - 1);
      room.currentTrackIndex = nextIndex;
      room.currentTrackId = room.tracks[nextIndex].id;
      room.anchorPosition = 0;
      room.anchorServerTime = Date.now() + limits.trackChangeAheadMs;
      this.#emitCommand(room, {
        action: 'track',
        trackIndex: nextIndex,
        track: trackMeta(room.tracks[nextIndex]),
        position: 0,
        playAt: room.isPlaying ? room.anchorServerTime : null,
        at: room.anchorServerTime,
        serverTime: Date.now(),
        isPlaying: room.isPlaying,
      });
    } else if (index < room.currentTrackIndex) {
      room.currentTrackIndex -= 1;
      room.currentTrackId = room.tracks[room.currentTrackIndex].id;
    }

    room.updatedAt = Date.now();
    this.emit('room:tracks', room);
    this.emit('room:changed', room);
    return removed;
  }

  reorderQueue(room, sessionId, orderedIds = []) {
    this.#assertHost(room, sessionId);
    const byId = new Map(room.tracks.map((track) => [track.id, track]));
    const reordered = orderedIds.map((id) => byId.get(id)).filter(Boolean);
    // Anything the client forgot to include keeps its relative order at the end.
    for (const track of room.tracks) {
      if (!orderedIds.includes(track.id)) reordered.push(track);
    }
    if (reordered.length !== room.tracks.length) {
      throw new RoomError('BAD_ORDER', 'Could not reorder the queue.');
    }

    const playingId = room.currentTrackId;
    room.tracks = reordered;
    room.tracks.forEach((track, position) => {
      track.queuePosition = position;
    });
    room.currentTrackIndex = room.tracks.findIndex((track) => track.id === playingId);

    room.updatedAt = Date.now();
    this.emit('room:tracks', room);
    this.emit('room:changed', room);
    return room.tracks;
  }

  // ------------------------------------------------------------------- reading

  participants(room) {
    return [...room.participants.values()]
      .sort((a, b) => {
        if (a.isHost !== b.isHost) return a.isHost ? -1 : 1;
        return a.joinedAt - b.joinedAt;
      })
      .map((participant) => ({
        sessionId: participant.sessionId,
        name: participant.name,
        isHost: participant.sessionId === room.hostSessionId,
        connected: participant.connected,
        joinedAt: participant.joinedAt,
      }));
  }

  /** Serialisable snapshot used for (re)joining clients. */
  snapshot(room, { sessionId, forHost = false } = {}) {
    const now = Date.now();
    const track = this.#currentTrack(room);
    return {
      code: room.code,
      status: room.status,
      isPlaying: room.isPlaying,
      position: this.currentPosition(room, now),
      anchorPosition: room.anchorPosition,
      playAt: room.isPlaying ? room.anchorServerTime : null,
      serverTime: now,
      currentTrackIndex: room.currentTrackIndex,
      currentTrackId: room.currentTrackId,
      currentTrack: track ? trackMeta(track) : null,
      tracks: room.tracks.map(trackMeta),
      participants: this.participants(room),
      connectedCount: [...room.participants.values()].filter((p) => p.connected).length,
      hostSessionId: room.hostSessionId,
      createdAt: room.createdAtIso,
      ended: room.status === ROOM_STATUS.ENDED,
      you: {
        sessionId,
        isHost: room.hostSessionId === sessionId,
        hostKey: forHost && room.hostSessionId === sessionId ? room.hostKey : undefined,
      },
    };
  }

  /** Remove rooms that have been empty for longer than the idle TTL. */
  sweep() {
    const now = Date.now();
    for (const [, room] of this.rooms) {
      const anyConnected = [...room.participants.values()].some((p) => p.connected);
      if (anyConnected) continue;
      if (!room.emptySince) room.emptySince = now;
      if (now - room.emptySince < config.roomIdleTtlMs) continue;

      if (room.status !== ROOM_STATUS.ENDED) {
        this.endRoom(room, 'expired');
      }
      this.destroyRoom(room);
    }
  }

  destroyRoom(room) {
    this.rooms.delete(room.code);
    for (const track of room.tracks) {
      this.tracks.delete(track.id);
      this.storage?.deleteUpload?.(room.code, track.storageKey).catch((error) => {
        console.warn('[rooms] could not delete upload on destroy', track.storageKey, error?.message);
      });
    }
    room.tracks = [];
    if (room.hostGraceTimer) {
      clearTimeout(room.hostGraceTimer);
      room.hostGraceTimer = null;
    }
    this.db?.deleteRoom(room);
    this.emit('room:destroyed', { room, files: [] });
  }

  stop() {
    clearInterval(this.sweepTimer);
  }
}

export { ROOM_STATUS };
