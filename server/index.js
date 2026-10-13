import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';
import cors from 'cors';
import { Server as SocketServer } from 'socket.io';

import { config, limits } from './config.js';
import { createDb } from './lib/db.js';
import { RoomManager, RoomError, normaliseRoomCode } from './lib/rooms.js';
import { uploadAudio, persistUpload } from './lib/uploads.js';
import { rateLimit, clientKey, startRateLimitSweeper } from './lib/rateLimit.js';
import { attachRealtime } from './realtime.js';
import * as storage from './lib/storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.resolve(__dirname, '../client/dist');

const db = createDb();
const manager = new RoomManager({ db, storage });

const app = express();
app.set('trust proxy', config.trustProxy ? 1 : false);
app.disable('x-powered-by');

app.use(
  cors({
    origin(origin, callback) {
      // Same-origin requests (no Origin header) and the allow-list are accepted.
      if (!origin || config.clientOrigins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
  }),
);
app.use(compression());
app.use(express.json({ limit: '64kb' }));

// --------------------------------------------------------------------- helpers

function requireRoom(req, res) {
  try {
    return manager.getRoom(req.params.code);
  } catch (error) {
    const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'ENDED' ? 410 : 400;
    res.status(status).json({ error: { code: error.code, message: error.message } });
    return null;
  }
}

/**
 * Upload/queue mutations require the caller to be the room host. The check runs
 * before multer touches the disk so unauthorised uploads never land in storage.
 */
function requireHost(req, res, next) {
  const room = requireRoom(req, res);
  if (!room) return;
  const sessionId = req.get('x-session-id');
  if (!sessionId || room.hostSessionId !== sessionId) {
    res.status(403).json({
      error: { code: 'NOT_HOST', message: 'Only the host can manage audio for this session.' },
    });
    return;
  }
  req.room = room;
  next();
}

// ------------------------------------------------------------------ public API

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    rooms: manager.rooms.size,
    persistence: db.enabled ? 'supabase' : 'memory',
    storage: storage.storageType(),
  });
});

app.get('/api/config', (_req, res) => {
  res.json({
    publicAppUrl: config.publicAppUrl,
    maxUploadBytes: config.maxUploadBytes,
    maxParticipantsPerRoom: limits.maxParticipantsPerRoom,
    sync: {
      playAheadMs: limits.playAheadMs,
      commandAheadMs: limits.commandAheadMs,
      trackChangeAheadMs: limits.trackChangeAheadMs,
    },
  });
});

/** Public room probe used by the Join screen to give precise error messages. */
app.get('/api/rooms/:code', (req, res) => {
  const code = normaliseRoomCode(req.params.code);
  const room = manager.peekRoom(code);
  if (!room) {
    return res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'Session not found. Please check the Room ID.' },
    });
  }
  return res.json({
    code: room.code,
    status: room.status,
    ended: room.status === 'ended',
    isPlaying: room.isPlaying,
    connectedCount: [...room.participants.values()].filter((p) => p.connected).length,
    trackCount: room.tracks.length,
    currentTrack: room.currentTrackIndex >= 0 ? room.tracks[room.currentTrackIndex]?.name ?? null : null,
  });
});

// -------------------------------------------------------------------- uploads

app.post('/api/rooms/:code/tracks', requireHost, uploadAudio, async (req, res) => {
  const gate = rateLimit('track:upload', clientKey(req));
  if (!gate.allowed) {
    return res.status(429).json({
      error: { code: 'RATE_LIMITED', message: 'Too many uploads. Please wait a moment.' },
    });
  }

  const room = manager.peekRoom(req.params.code);
  if (!req.file || !room) {
    console.error('[upload] file missing:', req.file ? 'no room' : 'no file', req.file);
    return res.status(400).json({ error: { code: 'UPLOAD_FAILED', message: 'Audio upload failed.' } });
  }

  try {
    const { key } = await persistUpload(req.params.code, req.file);
    const track = manager.addTrack(room, req.get('x-session-id'), {
      name: req.body?.name || req.file.originalname,
      storageKey: key,
      // The room manager builds the stable `/api/tracks/:trackId` URL that the
      // client fetches; the raw storage key is never exposed to the browser.
      mime: req.file.mimetype,
      size: req.file.size,
      duration: Number(req.body?.duration),
    });

    return res.status(201).json({
      ok: true,
      track: {
        id: track.id,
        name: track.name,
        url: track.url,
        size: track.size,
        duration: track.duration,
        mime: track.mime,
      },
    });
  } catch (addError) {
    const message = addError instanceof RoomError ? addError.message : 'Audio upload failed.';
    const code = addError instanceof RoomError ? addError.code : 'UPLOAD_FAILED';
    return res.status(400).json({ error: { code, message } });
  }
});

app.delete('/api/rooms/:code/tracks/:trackId', requireHost, (req, res) => {
  const room = manager.peekRoom(req.params.code);
  if (!room) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Session not found.' } });
  try {
    manager.removeTrack(room, req.get('x-session-id'), req.params.trackId);
    res.json({ ok: true });
  } catch (error) {
    const code = error instanceof RoomError ? error.code : 'SERVER_ERROR';
    res.status(400).json({ error: { code, message: error.message || 'Could not remove that track.' } });
  }
});

app.patch('/api/rooms/:code/queue', requireHost, (req, res) => {
  const room = manager.peekRoom(req.params.code);
  if (!room) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Session not found.' } });
  try {
    manager.reorderQueue(room, req.get('x-session-id'), req.body?.orderedIds ?? []);
    res.json({ ok: true });
  } catch (error) {
    const code = error instanceof RoomError ? error.code : 'SERVER_ERROR';
    res.status(400).json({ error: { code, message: error.message || 'Could not reorder the queue.' } });
  }
});

// ------------------------------------------------------------------ audio feed

/**
 * Serves the uploaded audio so every device plays a local copy. Range requests
 * are supported so seeking is instant instead of re-downloading the file.
 *
 * When audio lives in S3 we proxy it through the server (stable URL, no client-
 * side credentials). When it lives on disk we serve the file directly.
 */
app.get('/api/tracks/:trackId', async (req, res) => {
  const entry = manager.tracks.get(req.params.trackId);
  if (!entry) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Audio track not found.' } });
  }

  try {
    const result = await storage.getTrackStream(entry.roomCode, entry.storageKey);
    const stream = result.stream;
    const length = result.length;
    const contentType = result.contentType;
    const local = result.local;

    // Parse range header.
    const rangeHeader = req.headers.range;
    let rangeStart = 0;
    let rangeEnd = length - 1;

    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      rangeStart = parseInt(parts[0], 10);
      rangeEnd = parts[1] ? parseInt(parts[1], 10) : length - 1;
    }

    const chunkSize = rangeEnd - rangeStart + 1;

    if (local) {
      // Local disk: slice the buffer and send directly.
      const buf = stream;
      const slice = buf.slice(rangeStart, rangeEnd + 1);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Range', `bytes ${rangeStart}-${rangeEnd}/${length}`);
      res.setHeader('Content-Length', slice.length);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.status(206);
      res.end(slice);
      return;
    }

    // S3 stream: skip to start, then pipe through the end position.
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Range', `bytes ${rangeStart}-${rangeEnd}/${length}`);
    res.setHeader('Content-Length', chunkSize);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.status(206);

    let piped = 0;
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (piped + buf.length <= rangeStart) {
        piped += buf.length;
        continue;
      }
      const sliceStart = Math.max(0, rangeStart - piped);
      const sliceEnd = Math.min(buf.length, (rangeEnd + 1) - piped);
      if (sliceStart < sliceEnd) {
        res.write(buf.slice(sliceStart, sliceEnd));
      }
      piped += buf.length;
      if (piped >= rangeEnd + 1) break;
    }
    res.end();
  } catch (error) {
    console.error('[tracks] stream failed', entry.storageKey, error);
    if (!res.headersSent) {
      return res.status(500).json({ error: { code: 'TRACK_UNAVAILABLE', message: 'Track unavailable.' } });
    }
  }
});

// --------------------------------------------------------------- static client

if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST, { index: false, maxAge: '1h' }));
  // SPA fallback: anything that isn't an API call or a real file renders the app.
  app.get(/^(?!\/api\/|\/socket\.io\/).*/, (_req, res) => {
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
} else if (config.isProduction) {
  console.warn('[server] client/dist not found — run `npm run build` before `npm start`.');
}

app.use((_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
});

// -------------------------------------------------------------------- sockets

const server = http.createServer(app);
const io = new SocketServer(server, {
  cors: {
    origin: config.clientOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  // Control messages only — audio never travels over the socket.
  maxHttpBufferSize: 1e6,
  pingInterval: 20000,
  pingTimeout: 25000,
  transports: ['websocket', 'polling'],
});

attachRealtime(io, manager);

// Free temporary audio as soon as a room is destroyed or expires.
manager.on('room:destroyed', () => {
  // Storage backend (local or S3) handles cleanup via the room manager.
});

startRateLimitSweeper();

const cleanup = () => {
  manager.stop();
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

/* eslint-disable no-console */
server.listen(config.port, () => {
  console.log(`\n  SyncAudio server listening on http://localhost:${config.port}`);
  console.log(`  Persistence: ${db.enabled ? 'Supabase PostgreSQL' : 'in-memory (set SUPABASE_* to persist)'}`);
  console.log(`  Storage: ${storage.storageType()}`);
  console.log(`  Allowed origins: ${config.clientOrigins.join(', ')}\n`);
});
/* eslint-enable no-console */

export { app, server, io, manager };
