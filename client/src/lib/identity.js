/**
 * Anonymous identity.
 *
 * There is no account system by design. Every browser tab gets a random
 * session id kept in `sessionStorage`, so:
 *   - a reload or a temporary disconnect reclaims the same participant slot,
 *   - two tabs on the same laptop behave as two separate devices, which is
 *     exactly what you want when demoing SyncAudio.
 * The display name is remembered in `localStorage` for convenience only.
 *
 * The host key lives in `sessionStorage` for the same reason: it proves "this
 * tab created the room". In `localStorage` it would be shared by every tab of
 * the browser, so a second tab opening the invite link would silently steal the
 * host role from the page that is actually hosting.
 */

const SESSION_KEY = 'syncaudio.sessionId';
const NAME_KEY = 'syncaudio.displayName';
const HOST_KEY_PREFIX = 'syncaudio.hostKey.';
const VOLUME_KEY = 'syncaudio.volume';

function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `s_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export function getSessionId() {
  try {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id = randomId();
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    return randomId();
  }
}

export function getDisplayName() {
  try {
    return localStorage.getItem(NAME_KEY) || '';
  } catch {
    return '';
  }
}

export function setDisplayName(name) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* storage unavailable — the session still works */
  }
}

export function getHostKey(code) {
  try {
    return sessionStorage.getItem(`${HOST_KEY_PREFIX}${code}`) || undefined;
  } catch {
    return undefined;
  }
}

export function setHostKey(code, hostKey) {
  if (!code || !hostKey) return;
  try {
    sessionStorage.setItem(`${HOST_KEY_PREFIX}${code}`, hostKey);
  } catch {
    /* ignore */
  }
}

export function getVolume() {
  try {
    const stored = Number(localStorage.getItem(VOLUME_KEY));
    return Number.isFinite(stored) && stored >= 0 && stored <= 1 ? stored : 0.9;
  } catch {
    return 0.9;
  }
}

export function setVolume(volume) {
  try {
    localStorage.setItem(VOLUME_KEY, String(volume));
  } catch {
    /* ignore */
  }
}

/** Human-friendly device hint shown in the participant list. */
export function deviceHint() {
  const ua = navigator.userAgent || '';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android device';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Web browser';
}
