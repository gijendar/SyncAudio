import fs from 'node:fs/promises';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../config.js';

/**
 * S3-compatible object storage adapter for uploaded audio.
 *
 * Defaults to local-disk mode when S3 credentials are absent, so development
 * stays zero-config. In production, point S3_BUCKET + S3_REGION + the key/
 * secret env vars at any S3-compatible provider (AWS S3, Cloudflare R2,
 * Backblaze B2, MinIO, etc.).
 */

// eslint-disable-next-line no-unused-vars
const s3Disabled = {
  type: 'local-disabled',
  async putObject(_roomId, _key, _body, _contentType) {
    throw new Error('S3 is not configured and local disk storage is also disabled.');
  },
  async getSignedUrl(_roomId, _key, _expiresMs) {
    throw new Error('S3 is not configured.');
  },
  async deleteObject(_roomId, _key) {
    /* best-effort */
  },
};

let s3Client = null;

function getClient() {
  if (s3Client) return s3Client;
  const { s3Endpoint, s3Region, s3AccessKeyId, s3SecretAccessKey } = config.s3;
  if (!s3Endpoint || !s3Region || !s3AccessKeyId || !s3SecretAccessKey) {
    return null;
  }
  s3Client = new S3Client({
    region: s3Region,
    endpoint: s3Endpoint,
    credentials: {
      accessKeyId: s3AccessKeyId,
      secretAccessKey: s3SecretAccessKey,
    },
    forcePathStyle: s3Endpoint && !s3Endpoint.includes('.amazonaws.com'),
  });
  return s3Client;
}

export function storageType() {
  const client = getClient();
  if (!client) return 'local';
  return 's3';
}

/**
 * Put an audio blob into storage. Returns the public URL (or signed-url base)
 * that clients use to fetch the track.
 */
export async function putObject(roomId, key, body, contentType) {
  const client = getClient();
  if (!client) {
    // Local-disk fallback: write into the configured upload dir under a room
    // subfolder so a future disk-cleanup sweep can prune per-room data.
    const dir = config.uploadDir;
    const roomDir = `${dir}/${roomId}`;
    await fs.mkdir(roomDir, { recursive: true });
    const filePath = `${roomDir}/${key}`;
    await fs.writeFile(filePath, body);
    return `/api/tracks/${key}`;
  }

  await client.send(
    new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: `${roomId}/${key}`,
      Body: body,
      ContentType: contentType,
    }),
  );

  if (config.s3.public) {
    return `/${config.s3.bucket}/${roomId}/${key}`;
  }
  // Private bucket: clients fetch via a short-lived signed URL.
  return `/${config.s3.bucket}/${roomId}/${key}?signed`;
}

/** Best-effort deletion. Missing objects are ignored. */
export async function deleteObject(roomId, key) {
  const client = getClient();
  if (!client) {
    const filePath = `${config.uploadDir}/${roomId}/${key}`;
    await fs.unlink(filePath).catch((error) => {
      if (error.code !== 'ENOENT') console.warn('[storage] could not remove', filePath, error.message);
    });
    return;
  }
  await client
    .send(
      new DeleteObjectCommand({
        Bucket: config.s3.bucket,
        Key: `${roomId}/${key}`,
      }),
    )
    .catch((error) => {
      if (error.name !== 'NoSuchKey' && error.name !== 'NotFound') {
        console.warn('[storage] failed to delete object', key, error.name);
      }
    });
}

/**
 * Return a readable stream for a track stored in S3. When using local disk
 * this falls back to reading the file from disk. The server uses this to proxy
 * S3 objects through a stable `/api/tracks/:id` endpoint so clients never see
 * bucket credentials and range requests keep working.
 */
export async function getTrackStream(roomId, key) {
  const client = getClient();
  if (!client) {
    const filePath = `${config.uploadDir}/${roomId}/${key}`;
    const buffer = await fs.readFile(filePath);
    return {
      stream: buffer,
      length: buffer.length,
      contentType: 'audio/mpeg',
      local: true,
    };
  }

  const response = await client.send(
    new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: `${roomId}/${key}`,
    }),
  );
  return {
    stream: response.Body,
    length: response.ContentLength || 0,
    contentType: response.ContentType || 'audio/mpeg',
    local: false,
  };
}


