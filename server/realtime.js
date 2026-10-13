import { rateLimit, clientKey } from './lib/rateLimit.js';
import { RoomError, sanitiseDisplayName } from './lib/rooms.js';

/**
 * Socket.IO transport layer.
 *
 * This module is deliberately thin: it validates input, resolves which room a
 * socket belongs to, and delegates every decision to the RoomManager. Playback
 * authority (who may press play) is enforced in the manager, not here, so a
 * malicious client cannot bypass it by hand-crafting a socket event.
 */

const CHANNEL = (code) => `room:${code}`;

function fail(ack, code, message) {
  if (typeof ack === 'function') ack({ ok: false, error: { code, message } });
}

function handleError(socket, error, ack) {
  if (error instanceof RoomError) {
    fail(ack, error.code, error.message);
    socket.emit('room:error', { code: error.code, message: error.message });
    return;
  }
  console.error('[socket] unexpected error:', error);
  fail(ack, 'SERVER_ERROR', 'Something went wrong. Please try again.');
}

function broadcastState(io, manager, room) {
  for (const participant of room.participants.values()) {
    if (!participant.connected || !participant.socketId) continue;
    const socket = io.sockets.sockets.get(participant.socketId);
    if (!socket) continue;
    socket.emit(
      'room:state',
      manager.snapshot(room, { sessionId: participant.sessionId, forHost: true }),
    );
  }
}

export function attachRealtime(io, manager) {
  // ------------------------------------------------------- manager -> clients
  manager.on('room:changed', (room) => broadcastState(io, manager, room));
  manager.on('room:tracks', (room) => broadcastState(io, manager, room));

  manager.on('player:command', ({ room, command }) => {
    io.to(CHANNEL(room.code)).emit('player:command', command);
  });

  manager.on('room:ended', ({ room, reason }) => {
    io.to(CHANNEL(room.code)).emit('room:ended', { code: room.code, reason });
  });

  manager.on('host:promoted', ({ room, sessionId, hostKey }) => {
    const participant = room.participants.get(sessionId);
    const socket = participant?.socketId ? io.sockets.sockets.get(participant.socketId) : null;
    socket?.emit('host:promoted', { hostKey });
    io.to(CHANNEL(room.code)).emit('host:changed', {
      hostSessionId: sessionId,
      code: room.code,
    });
    broadcastState(io, manager, room);
  });

  manager.on('room:created', (room) => broadcastState(io, manager, room));

  // ------------------------------------------------------------- connections
  io.on('connection', (socket) => {
    socket.data.roomCode = null;
    socket.data.sessionId = null;

    // --- clock synchronisation -------------------------------------------------
    // Clients probe this a handful of times and keep the lowest-RTT sample to
    // estimate their offset from server time. Cheap and stateless on purpose.
    socket.on('clock:sync', (payload = {}, ack) => {
      const gate = rateLimit('clock:sync', socket.id);
      if (!gate.allowed) return;
      const t0 = Number(payload.t0);
      if (typeof ack === 'function') {
        ack({ t0: Number.isFinite(t0) ? t0 : null, serverTime: Date.now() });
      }
    });

    // --- room create / join ---------------------------------------------------
    socket.on('room:create', (payload = {}, ack) => {
      const gate = rateLimit('room:create', clientKey(socket));
      if (!gate.allowed) {
        return fail(ack, 'RATE_LIMITED', 'Too many sessions created. Please wait a moment.');
      }
      try {
        const sessionId = typeof payload.sessionId === 'string' && payload.sessionId.length <= 64
          ? payload.sessionId
          : undefined;
        const room = manager.createRoom({
          displayName: sanitiseDisplayName(payload.displayName, 'Host'),
          sessionId,
        });

        const { participant, claimsHost } = manager.joinRoom(room.code, {
          sessionId: room.hostSessionId,
          displayName: payload.displayName,
          socketId: socket.id,
        });

        socket.data.roomCode = room.code;
        socket.data.sessionId = participant.sessionId;
        socket.join(CHANNEL(room.code));

        const state = manager.snapshot(room, { sessionId: participant.sessionId, forHost: true });
        if (typeof ack === 'function') {
          ack({ ok: true, code: room.code, sessionId: participant.sessionId, hostKey: claimsHost ? room.hostKey : undefined, state });
        }
        broadcastState(io, manager, room);
      } catch (error) {
        handleError(socket, error, ack);
      }
    });

    socket.on('room:join', (payload = {}, ack) => {
      const gate = rateLimit('room:join', clientKey(socket));
      if (!gate.allowed) {
        return fail(ack, 'RATE_LIMITED', 'Too many join attempts. Please wait a moment.');
      }
      try {
        const { room, participant, claimsHost } = manager.joinRoom(payload.code, {
          sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : undefined,
          displayName: sanitiseDisplayName(payload.displayName, 'Listener'),
          socketId: socket.id,
          hostKey: typeof payload.hostKey === 'string' ? payload.hostKey : undefined,
        });

        socket.data.roomCode = room.code;
        socket.data.sessionId = participant.sessionId;
        socket.join(CHANNEL(room.code));

        const state = manager.snapshot(room, { sessionId: participant.sessionId, forHost: true });
        if (typeof ack === 'function') {
          ack({
            ok: true,
            code: room.code,
            sessionId: participant.sessionId,
            hostKey: claimsHost ? room.hostKey : undefined,
            state,
          });
        }
        broadcastState(io, manager, room);
      } catch (error) {
        handleError(socket, error, ack);
      }
    });

    // --- authoritative state resync ------------------------------------------
    // Called periodically by clients so their drift correction is anchored to
    // the server's timeline rather than to their own clock.
    socket.on('room:sync', (_payload, ack) => {
      const room = manager.peekRoom(socket.data.roomCode);
      if (!room) return fail(ack, 'NOT_FOUND', 'Session not found.');
      const state = manager.snapshot(room, { sessionId: socket.data.sessionId, forHost: true });
      if (typeof ack === 'function') ack({ ok: true, state });
      else socket.emit('room:state', state);
    });

    // --- playback commands (host only, enforced by the manager) ---------------
    const commands = {
      'player:play': (room, sessionId, payload) => manager.play(room, sessionId, payload),
      'player:pause': (room, sessionId, payload) => manager.pause(room, sessionId, payload),
      'player:seek': (room, sessionId, payload) => manager.seek(room, sessionId, payload),
      'player:next': (room, sessionId) => manager.next(room, sessionId),
      'player:previous': (room, sessionId) => manager.previous(room, sessionId),
      'player:track': (room, sessionId, payload) =>
        manager.setTrack(room, sessionId, payload?.index, { autoplay: payload?.autoplay }),
      'player:end': (room, sessionId) => {
        if (room.hostSessionId !== sessionId) throw new RoomError('NOT_HOST', 'Only the host can end the session.');
        manager.endRoom(room, 'host-ended');
      },
    };

    for (const [event, run] of Object.entries(commands)) {
      socket.on(event, (payload = {}, ack) => {
        const room = manager.peekRoom(socket.data.roomCode);
        if (!room) return fail(ack, 'NOT_FOUND', 'Session not found.');
        try {
          run(room, socket.data.sessionId, payload);
          if (typeof ack === 'function') ack({ ok: true });
        } catch (error) {
          handleError(socket, error, ack);
        }
      });
    }

    // --- leave / disconnect ---------------------------------------------------
    const detach = (reason) => {
      const room = manager.peekRoom(socket.data.roomCode);
      if (!room) return;
      const result = manager.leaveBySocket(room, socket.id);
      if (result.changed) broadcastState(io, manager, room);
      socket.data.roomCode = null;
      if (reason === 'leave') socket.leave(CHANNEL(room.code));
    };

    socket.on('room:leave', () => detach('leave'));
    socket.on('disconnect', () => detach('disconnect'));
  });

  return { broadcastState, CHANNEL };
}

export { CHANNEL };
export const _internal = { broadcastState };
