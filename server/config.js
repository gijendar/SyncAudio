import 'dotenv/config';
import path from 'node:path';

function bool(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const isProduction = process.env.NODE_ENV === 'production';

export const config = {
  isProduction,
  port: number(process.env.PORT, 4000),
  publicAppUrl: (process.env.PUBLIC_APP_URL || 'http://localhost:5173').replace(/\/+$/, ''),
  clientOrigins: (process.env.CLIENT_ORIGINS || 'http://localhost:5173,http://localhost:4000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  maxUploadBytes: number(process.env.MAX_UPLOAD_MB, 80) * 1024 * 1024,
  maxRoomStorageBytes: number(process.env.MAX_ROOM_STORAGE_MB, 400) * 1024 * 1024,
  roomIdleTtlMs: number(process.env.ROOM_IDLE_TTL_MINUTES, 30) * 60 * 1000,
  hostGraceMs: number(process.env.HOST_GRACE_MS, 20000),
  uploadDir: path.resolve(process.cwd(), process.env.UPLOAD_DIR || '.syncaudio-uploads'),
  trustProxy: bool(process.env.TRUST_PROXY) || isProduction,
  supabase: {
    url: process.env.SUPABASE_URL || '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  },
  s3: {
    endpoint: process.env.S3_ENDPOINT || '',
    region: process.env.S3_REGION || '',
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
    bucket: process.env.S3_BUCKET || '',
    public: bool(process.env.S3_PUBLIC) || false,
  },
};

export const limits = {
  /** Max participants (devices) allowed in a single room. */
  maxParticipantsPerRoom: 32,
  /** Max tracks the host may queue in one room. */
  maxTracksPerRoom: 50,
  /** Max display-name length after sanitisation. */
  maxDisplayNameLength: 24,
  /** How far in the future the server schedules a play command. */
  playAheadMs: 1500,
  /** How far in the future pause/seek/track commands take effect. */
  commandAheadMs: 400,
  trackChangeAheadMs: 1200,
  rateLimits: {
    'room:create': { windowMs: 60000, max: 12 },
    'room:join': { windowMs: 60000, max: 60 },
    'track:upload': { windowMs: 60000, max: 40 },
    'clock:sync': { windowMs: 10000, max: 60 },
  },
};
