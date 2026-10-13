import { apiUrl } from './api.js';

/**
 * SyncEngine — all of SyncAudio's timing intelligence lives here.
 *
 * The server never streams audio; it only says "at server time T, the track is
 * at position P". This class turns that instruction into an actual playback
 * start on *this* device by:
 *
 *   1. Estimating the offset between the local clock and the server clock
 *      (NTP-style probes, keeping the lowest round-trip samples).
 *   2. Scheduling every transition against server time rather than local time,
 *      so network jitter affects *when the command arrives*, not *when it
 *      takes effect*.
 *   3. Continuously comparing local playback against the authoritative
 *      position and nudging it — playback-rate changes for small drift, a
 *      single seek only when the drift is big enough to be heard.
 *
 * Keeping this in one dependency-free module makes the sync strategy easy to
 * replace (or unit test) without touching any UI code.
 */

export const SYNC_STATE = {
  CONNECTING: 'connecting',
  SYNCING: 'syncing',
  SYNCED: 'synced',
  LOADING: 'loading',
  LOST: 'lost',
  BLOCKED: 'blocked',
  ERROR: 'error',
};

const CLOCK_PROBES = 6;
const CLOCK_PROBE_GAP_MS = 80;
const CLOCK_PROBE_TIMEOUT_MS = 2500;

/** Drift thresholds in seconds. */
const DRIFT_SEEK = 0.32; // audible — jump straight to the right spot
const DRIFT_RATE = 0.055; // subtle — stretch playback rate instead of seeking
const RATE_NUDGE = 0.03; // ±3% is inaudible but converges quickly

const DRIFT_TICK_MS = 1500;
const RESYNC_EVERY_MS = 6000;
const MAX_RATE = 1 + RATE_NUDGE;
const MIN_RATE = 1 - RATE_NUDGE;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

export class SyncEngine {
  constructor({ audio, onStateChange, onTrackChange, onEnded, onBlocked } = {}) {
    this.audio = audio;
    this.onStateChange = onStateChange;
    this.onTrackChange = onTrackChange;
    this.onEnded = onEnded;
    this.onBlocked = onBlocked;

    this.socket = null;
    this.offset = 0; // serverTime - localTime (ms)
    this.rtt = 0;
    this.hasClock = false;

    this.objectUrls = new Map(); // trackId -> blob URL
    this.currentTrackId = null;

    /** Latest known authoritative position, used as the drift reference. */
    this.target = { position: 0, at: 0, playing: false };
    /** Timestamps before which scheduled commands are still landing. */
    this.pendingUntil = 0;

    this.state = SYNC_STATE.CONNECTING;
    this.blocked = false;
    this.hasEverPlayed = false;
    this.lastCorrection = null;
    this.destroyed = false;

    this.timers = new Set();
    this.driftTimer = null;
    this.resyncTimer = null;
  }

  // ------------------------------------------------------------------ lifecycle

  attachSocket(socket) {
    this.socket = socket;
  }

  /** Called on every socket `connect`, including automatic reconnections. */
  async initialise() {
    this.setState(SYNC_STATE.SYNCING);
    const ok = await this.syncClock();
    this.setState(ok ? SYNC_STATE.SYNCING : SYNC_STATE.LOST);
    return ok;
  }

  start() {
    if (this.driftTimer) return;
    this.driftTimer = setInterval(() => this.#correctDrift(), DRIFT_TICK_MS);
    this.resyncTimer = setInterval(() => this.requestResync(), RESYNC_EVERY_MS);
    this.audio.addEventListener('ended', this.#handleEnded);
    this.audio.addEventListener('waiting', this.#handleWaiting);
    this.audio.addEventListener('playing', this.#handlePlaying);
    this.audio.addEventListener('stalled', this.#handleWaiting);
  }

  async destroy() {
    this.destroyed = true;
    clearInterval(this.driftTimer);
    clearInterval(this.resyncTimer);
    this.driftTimer = null;
    this.resyncTimer = null;
    this.#clearTimers();
    this.audio.removeEventListener('ended', this.#handleEnded);
    this.audio.removeEventListener('waiting', this.#handleWaiting);
    this.audio.removeEventListener('playing', this.#handlePlaying);
    this.audio.removeEventListener('stalled', this.#handleWaiting);
    this.audio.pause();
    for (const url of this.objectUrls.values()) URL.revokeObjectURL(url);
    this.objectUrls.clear();
  }

  // -------------------------------------------------------------- clock sync

  serverNow() {
    return Date.now() + this.offset;
  }

  /**
   * Estimate the clock offset with several probes and keep the lowest-RTT ones.
   * Network jitter only shows up in `rtt`; the offset error is at most rtt/2.
   */
  async syncClock(attempts = CLOCK_PROBES) {
    if (!this.socket) return false;
    const samples = [];
    for (let index = 0; index < attempts; index += 1) {
      const sample = await this.#probeClock();
      if (sample) samples.push(sample);
      if (index < attempts - 1) await sleep(CLOCK_PROBE_GAP_MS);
    }
    if (samples.length === 0) return false;

    samples.sort((a, b) => a.rtt - b.rtt);
    const best = samples.slice(0, Math.min(3, samples.length));
    this.offset = best.reduce((total, sample) => total + sample.offset, 0) / best.length;
    this.rtt = best[0].rtt;
    this.hasClock = true;
    return true;
  }

  #probeClock() {
    return new Promise((resolve) => {
      const sentAt = Date.now();
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      }, CLOCK_PROBE_TIMEOUT_MS);

      this.socket.emit('clock:sync', { t0: sentAt }, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const receivedAt = Date.now();
        if (!response || !isFiniteNumber(response.serverTime)) return resolve(null);
        // Assume the server's timestamp sits at the midpoint of the round trip.
        resolve({
          rtt: receivedAt - sentAt,
          offset: response.serverTime - (sentAt + receivedAt) / 2,
          serverTime: response.serverTime,
        });
      });
    });
  }

  // ------------------------------------------------------------ track loading

  async loadTrack(track) {
    if (!track) {
      this.#stopAudio();
      this.currentTrackId = null;
      this.onTrackChange?.(null);
      return true;
    }
    if (this.currentTrackId === track.id && this.audio.src) return true;

    this.setState(SYNC_STATE.LOADING);
    try {
      let objectUrl = this.objectUrls.get(track.id);
      if (!objectUrl) {
        const response = await fetch(apiUrl(track.url));
        if (!response.ok) throw new Error(`Audio unavailable (${response.status})`);
        objectUrl = URL.createObjectURL(await response.blob());
        this.objectUrls.set(track.id, objectUrl);
      }
      if (this.destroyed) return false;

      this.audio.playbackRate = 1;
      this.audio.src = objectUrl;
      this.currentTrackId = track.id;
      this.audio.load();
      await this.#awaitMetadata();
      this.onTrackChange?.(track);
      return true;
    } catch (error) {
      console.warn('[sync] could not load track', error);
      this.setState(SYNC_STATE.ERROR);
      return false;
    }
  }

  #awaitMetadata(timeoutMs = 12000) {
    const audio = this.audio;
    if (audio.readyState >= 1 && isFiniteNumber(audio.duration)) return Promise.resolve(true);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        audio.removeEventListener('loadedmetadata', onLoaded);
        audio.removeEventListener('error', onError);
        resolve(value);
      };
      const onLoaded = () => finish(true);
      const onError = () => finish(false);
      const timer = setTimeout(() => finish(false), timeoutMs);
      audio.addEventListener('loadedmetadata', onLoaded);
      audio.addEventListener('error', onError);
    });
  }

  // ------------------------------------------------------- command application

  /** Apply a server playback command. Returns when the transition is scheduled. */
  async handleCommand(command) {
    if (!command) return;
    switch (command.action) {
      case 'track':
        return this.#applyTrackChange(command);
      case 'play':
        return this.#applyPlay(command);
      case 'pause':
        return this.#applyPause(command);
      case 'seek':
        return this.#applySeek(command);
      default:
        return undefined;
    }
  }

  async #applyTrackChange(command) {
    this.#clearTimers();
    this.pendingUntil = Math.max(this.pendingUntil, command.at ?? 0, command.playAt ?? 0);

    const loaded = await this.loadTrack(command.track);
    if (!loaded) return;

    if (command.isPlaying) {
      this.#schedule({
        at: command.playAt ?? command.at ?? this.serverNow(),
        position: 0,
        playing: true,
      });
    } else {
      this.#applyAt({ position: 0, at: this.serverNow(), playing: false });
    }
  }

  async #applyPlay(command) {
    if (command.track?.id && command.track.id !== this.currentTrackId) {
      const loaded = await this.loadTrack(command.track);
      if (!loaded) return;
    }
    await this.#awaitMetadata();
    this.#schedule({
      at: command.playAt ?? this.serverNow(),
      position: command.position ?? 0,
      playing: true,
    });
  }

  #applyPause(command) {
    this.#schedule({
      at: command.at ?? this.serverNow(),
      position: command.position ?? this.audio.currentTime ?? 0,
      playing: false,
    });
  }

  #applySeek(command) {
    this.#schedule({
      at: command.at ?? this.serverNow(),
      position: command.position ?? 0,
      playing: Boolean(command.isPlaying),
    });
  }

  /**
   * Hard sync used when joining, reconnecting, or switching tracks: jump
   * straight to the live position instead of waiting for drift correction.
   */
  async applySnapshot(state) {
    if (!state) return;
    const track = state.currentTrack ?? null;

    if (track?.id !== this.currentTrackId) {
      const loaded = await this.loadTrack(track);
      if (!loaded) return;
    }

    this.#clearTimers();
    this.pendingUntil = 0;

    if (!track) {
      this.target = { position: 0, at: this.serverNow(), playing: false };
      this.#stopAudio();
      this.setState(SYNC_STATE.SYNCED);
      return;
    }

    this.#schedule({
      at: isFiniteNumber(state.serverTime) ? state.serverTime : this.serverNow(),
      position: state.position ?? 0,
      playing: Boolean(state.isPlaying),
    });
  }

  /**
   * Soft sync used by the periodic state check: refreshes the reference
   * anchor so the drift loop measures against fresh data. It never seeks on
   * its own — that decision belongs to the drift thresholds.
   */
  resync(state) {
    if (!state || this.destroyed) return;
    if (state.currentTrack?.id !== this.currentTrackId) {
      this.applySnapshot(state);
      return;
    }
    if (this.serverNow() < this.pendingUntil + 300) return;

    this.target = {
      position: state.position ?? 0,
      at: isFiniteNumber(state.serverTime) ? state.serverTime : this.serverNow(),
      playing: Boolean(state.isPlaying),
    };
  }

  requestResync() {
    if (!this.socket?.connected) return;
    this.socket.emit('room:sync', {}, (response) => {
      if (response?.ok && response.state) {
        // Cheap, but it also tells us whether the room died while we were idle.
        this.resync(response.state);
        this.onServerState?.(response.state);
      }
    });
  }

  // ------------------------------------------------------------------ scheduling

  #later(delayMs, run) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, delayMs);
    this.timers.add(timer);
    return timer;
  }

  #clearTimers() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  /**
   * `position` is the authoritative position at server time `at`. If we are
   * already past `at` (slow audio download, long network hop) the elapsed time
   * is added so we still join the stream at the right offset.
   */
  #schedule({ at, position, playing }) {
    const anchor = isFiniteNumber(at) ? at : this.serverNow();
    this.pendingUntil = Math.max(this.pendingUntil, anchor);
    this.target = { position, at: anchor, playing };

    const delay = anchor - this.serverNow();
    if (delay > 40) {
      this.setState(SYNC_STATE.SYNCING);
      this.#later(delay, () => this.#applyAt({ position, at: anchor, playing }));
    } else {
      this.#applyAt({ position, at: anchor, playing });
    }
  }

  #applyAt({ position, at, playing }) {
    // `position` is the authoritative position at server time `at`. Only a
    // playing track moves on from there: the server anchors a paused room at
    // that exact position, so adding "overshoot" to a pause/seek/track command
    // that landed late would drift the whole room past where the server says it
    // is (a paused device would sit seconds further into the track).
    const overshoot = playing ? Math.max(0, (this.serverNow() - at) / 1000) : 0;
    const desired = Math.max(0, position + overshoot);
    const audio = this.audio;

    const duration = isFiniteNumber(audio.duration) ? audio.duration : null;
    const safe = duration ? Math.min(desired, Math.max(0, duration - 0.05)) : desired;

    try {
      if (Math.abs(audio.currentTime - safe) > 0.02) audio.currentTime = safe;
    } catch {
      /* seeking before metadata is ready is a no-op we can safely ignore */
    }

    this.target = { position, at, playing };

    if (playing) {
      this.#play();
    } else {
      audio.pause();
      audio.playbackRate = 1;
      this.setState(SYNC_STATE.SYNCED);
    }
  }

  #play() {
    const promise = this.audio.play();
    if (!promise || typeof promise.catch !== 'function') {
      this.hasEverPlayed = true;
      this.setState(SYNC_STATE.SYNCED);
      return;
    }
    promise
      .then(() => {
        this.hasEverPlayed = true;
        this.blocked = false;
        this.setState(SYNC_STATE.SYNCED);
      })
      .catch((error) => {
        if (error?.name === 'NotAllowedError') {
          // Browser autoplay policy: we need a real tap from the user.
          this.blocked = true;
          this.setState(SYNC_STATE.BLOCKED);
          this.onBlocked?.();
        } else if (error?.name !== 'AbortError') {
          console.warn('[sync] playback error', error);
          this.setState(SYNC_STATE.ERROR);
        }
      });
  }

  /** Called from a user gesture to satisfy the browser autoplay policy. */
  async retry() {
    this.blocked = false;
    this.setState(SYNC_STATE.SYNCING);
    await this.#awaitMetadata(4000);
    if (this.target.playing) {
      this.#applyAt(this.target);
    } else {
      this.setState(SYNC_STATE.SYNCED);
    }
  }

  // --------------------------------------------------------------- drift control

  #handleEnded = () => {
    // Do not advance locally: the host (or the server) owns what plays next.
    this.target = { ...this.target, playing: false, position: this.audio.duration || 0 };
    this.onEnded?.();
  };

  #handleWaiting = () => {
    if (this.target.playing && !this.blocked) this.setState(SYNC_STATE.SYNCING);
  };

  #handlePlaying = () => {
    this.hasEverPlayed = true;
    this.blocked = false;
    this.setState(SYNC_STATE.SYNCED);
  };

  #expectedPosition(now = this.serverNow()) {
    if (!this.target.playing) return this.target.position;
    return this.target.position + Math.max(0, now - this.target.at) / 1000;
  }

  #correctDrift() {
    const audio = this.audio;
    if (this.destroyed || !audio.src || this.blocked) return;

    // A command is still in flight — let it land before judging the drift.
    if (this.serverNow() < this.pendingUntil + 250) return;
    if (audio.ended) return;

    const now = this.serverNow();
    const expected = this.#expectedPosition(now);

    // Paused rooms only need to keep a stable position, not tight sync.
    if (!this.target.playing) {
      if (audio.paused && Math.abs(audio.currentTime - expected) > 0.4) {
        try {
          audio.currentTime = expected;
        } catch {
          /* ignore */
        }
      }
      return;
    }

    if (audio.paused) {
      // Buffering finished but playback stopped for another reason.
      this.#play();
      return;
    }

    const duration = isFiniteNumber(audio.duration) ? audio.duration : null;
    if (duration !== null && expected > duration - 0.1) {
      // The track is done on the server timeline; wait for the next command.
      audio.pause();
      this.setState(SYNC_STATE.SYNCED);
      return;
    }

    const drift = audio.currentTime - expected;

    if (Math.abs(drift) > DRIFT_SEEK) {
      try {
        audio.currentTime = expected;
      } catch {
        /* ignore */
      }
      audio.playbackRate = 1;
      this.lastCorrection = { type: 'seek', drift, at: Date.now() };
      this.setState(SYNC_STATE.SYNCING);
      return;
    }

    if (Math.abs(drift) > DRIFT_RATE) {
      // Slightly speed up or slow down to converge without an audible jump.
      audio.playbackRate = Math.min(MAX_RATE, Math.max(MIN_RATE, drift > 0 ? MIN_RATE : MAX_RATE));
      this.lastCorrection = { type: 'rate', drift, at: Date.now() };
    } else if (audio.playbackRate !== 1) {
      audio.playbackRate = 1;
    }

    this.setState(SYNC_STATE.SYNCED);
  }

  // -------------------------------------------------------------------- local

  #stopAudio() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.currentTrackId = null;
  }

  setVolume(volume) {
    this.audio.volume = Math.min(1, Math.max(0, volume));
  }

  setMuted(muted) {
    this.audio.muted = Boolean(muted);
  }

  setState(next) {
    if (this.state === next) return;
    this.state = next;
    this.onStateChange?.(next);
  }
}
