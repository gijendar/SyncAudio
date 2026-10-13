import { io } from 'socket.io-client';

/**\n * In development Vite proxies `/api` and `/socket.io` to the Node server, and in\n * production Express serves this bundle, so the default (same-origin) works in\n * both. Set VITE_API_URL only when the API lives on a different host.\n */
const RAW_BASE = (import.meta.env.VITE_API_URL || '').trim();
export const API_BASE = RAW_BASE.replace(/\/+$/, '');

export function apiUrl(path) {
  return `${API_BASE}${path}`;
}

export async function apiFetch(path, options = {}) {
  const response = await fetch(apiUrl(path), options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error?.message || 'Request failed.');
    error.code = data?.error?.code || 'REQUEST_FAILED';
    error.status = response.status;
    throw error;
  }
  return data;
}

/** Upload progress needs XHR (fetch has no upload progress in Safari). */
export function uploadWithProgress({ url, file, headers, onProgress }) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    const request = new XMLHttpRequest();

    request.open('POST', apiUrl(url), true);
    for (const [key, value] of Object.entries(headers || {})) {
      if (value) request.setRequestHeader(key, value);
    }

    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    });

    request.addEventListener('load', () => {
      let data = {};
      try {
        data = JSON.parse(request.responseText);
      } catch {
        /* ignore parse failures */
      }
      if (request.status >= 200 && request.status < 300) return resolve(data);
      const error = new Error(data?.error?.message || 'Audio upload failed.');
      error.code = data?.error?.code || 'UPLOAD_FAILED';
      return reject(error);
    });

    request.addEventListener('error', () => reject(new Error('Network error during upload.')));
    request.addEventListener('abort', () => reject(new Error('Upload cancelled.')));

    for (const [key, value] of Object.entries(file.fields || {})) form.append(key, value);
    form.append('audio', file.blob, file.name);
    request.send(form);
  });
}

/**
 * Socket.IO client. Reconnection is handled by the library; the room page
 * re-joins on every `connect` event so a dropped participant silently
 * resynchronises without a page reload.
 */
export function createSocket() {
  return io(API_BASE || undefined, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 600,
    reconnectionDelayMax: 5000,
    randomizationFactor: 0.4,
    timeout: 10000,
  });
}
