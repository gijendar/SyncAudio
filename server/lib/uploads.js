import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { config } from '../config.js';
import { storageType, putObject, deleteObject } from './storage.js';

/**
 * Audio upload handler.
 *
 * The host uploads once; every participant fetches a local copy over HTTP and
 * plays it from their own device. WebSocket traffic stays limited to tiny
 * control messages, which is what keeps the sync cheap on mobile data.
 *
 * Storage backend is selected at startup: S3-compatible object storage when
 * S3_* env vars are set, otherwise local disk under `config.uploadDir`.
 */

const ALLOWED_EXTENSIONS = new Set([
  '.mp3', '.m4a', '.mp4', '.aac', '.wav', '.ogg', '.oga', '.opus', '.flac', '.weba', '.webm',
]);

// Ensure the local fallback directory exists (no-op when using S3).
if (storageType() === 'local') {
  fs.mkdirSync(config.uploadDir, { recursive: true });
}

/**
 * In-memory multer storage that buffers the upload into a Buffer so we can
 * decide the backend (local vs S3) once we know the room code + a generated
 * key. This also lets us avoid writing to disk when S3 is enabled.
 */
const memoryStorage = multer.memoryStorage();

export const uploadAudio = multer({
  storage: memoryStorage,
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const looksLikeAudio =
      (file.mimetype || '').startsWith('audio/') ||
      (file.mimetype || '').startsWith('video/') || // m4a is often reported as video/mp4
      ALLOWED_EXTENSIONS.has(ext);

    if (!looksLikeAudio) {
      const error = new Error('Unsupported audio format. Try MP3, WAV, OGG or M4A.');
      error.code = 'UNSUPPORTED_FORMAT';
      cb(error);
      return;
    }
    cb(null, true);
  },
}).single('audio');

/**
 * Persist an already-buffered file into the active storage backend.
 *
 * Called by the route handler after multer has attached `req.file` (in-memory
 * buffer). Returns the storage `key`; the room manager turns that into the
 * public `/api/tracks/:trackId` URL clients fetch (the storage key itself is an
 * internal detail and never leaves the server).
 */
export async function persistUpload(roomCode, file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const key = `${crypto.randomUUID()}${ALLOWED_EXTENSIONS.has(ext) ? ext : '.audio'}`;

  await putObject(roomCode, key, file.buffer, file.mimetype);

  return { key };
}

// Debug: expose the storage module's type.
export { storageType } from './storage.js';

/**
 * Delete a previously-persisted track from the active storage backend.
 */
export async function deleteUpload(roomCode, key) {
  await deleteObject(roomCode, key);
}
