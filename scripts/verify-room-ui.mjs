/* eslint-disable no-console */
/**
 * Browser regression test for the room page.
 *
 *   node scripts/verify-room-ui.mjs                       # spawns its own server + headless Chrome
 *   APP_URL=http://localhost:4000 node scripts/verify-room-ui.mjs
 *
 * It guards the bugs that a socket-only smoke test cannot see, because they only
 * happen once React renders the page:
 *
 *   1. The room page must actually connect. The `<audio>` element has to exist
 *      before `useRoomSession` runs, otherwise the page deadlocks on "Joining
 *      room …" (no element -> no socket -> no snapshot). Because the host's
 *      create socket is closed on navigation, a stuck host page leaves the room
 *      empty and the server ends it after HOST_GRACE_MS — which is what made
 *      joiners see "This session has ended." while the host tab was open.
 *   2. That element must stay at the same position in the tree. If React
 *      remounts it, the sync engine keeps driving a detached node: the UI says
 *      "playing" and no audio is ever heard.
 *   3. A guest must be able to join, must not be handed the host role, and must
 *      follow the host's seek while staying in sync.
 *
 * Requires a built client (`npm run build`) and a Chrome/Chromium install; set
 * CHROME_PATH when it lives somewhere unusual. Without a browser the run is
 * reported as SKIPPED rather than passed.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 4291);
const APP = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const ownServer = !process.env.APP_URL;
const CDP_PORT = Number(process.env.CDP_PORT || 9333);
const HOST_GRACE_MS = Number(process.env.HOST_GRACE_MS || (ownServer ? 3000 : 20000));
const GRACE_WAIT_MS = HOST_GRACE_MS + 2500;
const SYNC_TOL = 0.5;
const SEEK_TARGET = 12;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let failures = 0;
let skipped = false;

function check(label, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function skip(reason) {
  skipped = true;
  console.log(`\nSKIPPED  ${reason}`);
}

const watchdog = setTimeout(() => {
  check('verification finished before the watchdog', false, 'timed out after 150s');
  finish(2);
}, 150_000);

let child = null;
let chrome = null;
let host = null;
let guest = null;
let finished = false;
const userDir = path.join(os.tmpdir(), `syncaudio-room-ui-${Date.now()}`);

function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  host?.close();
  guest?.close();
  if (chrome && chrome.exitCode === null) chrome.kill();
  if (child && child.exitCode === null) child.kill();
  try {
    fs.rmSync(userDir, { recursive: true, force: true });
  } catch {
    /* Chrome may still hold the profile directory on Windows */
  }
  console.log(results.join('\n'));
  if (skipped) {
    console.log('\nSKIPPED — no browser was available, so nothing was verified.');
    process.exit(0);
  }
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  process.exit(code ?? (failures === 0 ? 0 : 1));
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
}

const SAMPLE = `(() => {
  const a = document.querySelector('audio');
  if (!a) return { missing: true, now: Date.now() };
  return {
    t: a.currentTime,
    paused: a.paused,
    hasSrc: Boolean(a.currentSrc || a.src),
    now: Date.now(),
  };
})()`;

const fillAndSubmit = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'missing';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.closest('form').querySelector('button[type="submit"]').click();
  return 'submitted';
})()`;

const click = (page, selector) =>
  page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'missing'; el.click(); return 'clicked'; })()`);

const SEEK = (seconds) => `(() => {
  const el = document.querySelector('input[aria-label="Seek"]');
  if (!el) return 'missing';
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, String(${seconds}));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  return 'seeked';
})()`;

/** Build a WAV in the page and hand it to the queue's file input. */
const UPLOAD_WAV = `(() => {
  const input = document.querySelector('input[type="file"]');
  if (!input) return 'no input';
  const rate = 8000;
  const samples = rate * 40;
  const view = new DataView(new ArrayBuffer(44 + samples * 2));
  const writeStr = (offset, str) => { for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i += 1) {
    view.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), true);
  }
  const transfer = new DataTransfer();
  transfer.items.add(new File([view.buffer], 'regression-tone.wav', { type: 'audio/wav' }));
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return 'attached';
})()`;

class Page {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
  }

  async open() {
    // Node >= 22 has a global WebSocket; older runtimes fall back to ws (already
    // installed as a socket.io dependency).
    const WebSocketImpl = globalThis.WebSocket || (await import('ws')).WebSocket;
    this.ws = new WebSocketImpl(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    return this;
  }

  send(method, params = {}) {
    const id = (this.id += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  }

  goto(url) {
    return this.send('Page.navigate', { url });
  }

  text() {
    return this.evaluate('document.body ? document.body.innerText : ""');
  }

  path() {
    return this.evaluate('location.pathname');
  }

  async waitFor(expression, timeoutMs = 20000) {
    const started = Date.now();
    for (;;) {
      try {
        if (await this.evaluate(expression)) return true;
      } catch {
        /* page is navigating */
      }
      if (Date.now() - started > timeoutMs) return false;
      await sleep(200);
    }
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

const probe = (code) => fetch(`${APP}/api/rooms/${code}`).then((r) => r.json());

async function waitForProbe(code, predicate, timeoutMs = 15000) {
  const started = Date.now();
  let state;
  for (;;) {
    state = await probe(code).catch(() => ({}));
    if (predicate(state)) return state;
    if (Date.now() - started > timeoutMs) return state;
    await sleep(250);
  }
}

async function newTab() {
  const target = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, {
    method: 'PUT',
  }).then((r) => r.json());
  return new Page(target.webSocketDebuggerUrl).open();
}

/** Sample both pages as close together as possible, projected to one instant. */
async function sampleBoth() {
  const [a, b] = await Promise.all([host.evaluate(SAMPLE), guest.evaluate(SAMPLE)]);
  const common = Math.max(a.now, b.now);
  const projA = a.paused ? a.t : a.t + (common - a.now) / 1000;
  const projB = b.paused ? b.t : b.t + (common - b.now) / 1000;
  return { projA, projB, delta: Math.abs(projA - projB) };
}

const fmt = (value) => (typeof value === 'number' ? value.toFixed(3) : String(value));

async function startServer() {
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST_GRACE_MS: String(HOST_GRACE_MS) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));

  for (let i = 0; i < 60; i += 1) {
    try {
      const health = await fetch(`${APP}/api/health`);
      if (health.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  return false;
}

async function main() {
  if (ownServer) {
    if (!fs.existsSync(path.join(ROOT, 'client/dist/index.html'))) {
      skip('client/dist is missing — run `npm run build` first.');
      return;
    }
    if (!(await startServer())) {
      check('server started', false, `no /api/health response on ${APP}`);
      return;
    }
    check('server started', true, `${APP} (host grace ${HOST_GRACE_MS}ms)`);
  } else {
    const health = await fetch(`${APP}/api/health`).then((r) => r.json()).catch(() => null);
    check('server reachable', Boolean(health?.ok), APP);
    if (!health?.ok) return;
  }

  const chromePath = findChrome();
  if (!chromePath) {
    skip('no Chrome/Chromium binary found — set CHROME_PATH to run this test.');
    return;
  }

  fs.mkdirSync(userDir, { recursive: true });
  chrome = spawn(
    chromePath,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      // Audio playback and timers must not be throttled: two tabs share one
      // browser and the unfocused one would otherwise be slowed down.
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let up = false;
  for (let i = 0; i < 60 && !up; i += 1) {
    try {
      up = (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok;
    } catch {
      /* not up yet */
    }
    if (!up) await sleep(250);
  }
  check('headless Chrome started', up);
  if (!up) return;

  // ---------------------------------------------------------- host creates
  host = await newTab();
  await host.goto(`${APP}/create`);
  const createReady = await host.waitFor('!!document.querySelector("#host-name")');
  check('create page renders', createReady);
  if (createReady) await host.evaluate(fillAndSubmit('#host-name', 'Host Device'));
  const inRoom = await host.waitFor('location.pathname.startsWith("/room/")');
  check('host lands on the room page', inRoom);
  if (!inRoom) return;
  const code = (await host.path()).split('/').pop();
  check('room code captured', /^[A-Z0-9]{6}$/.test(code), code);

  const hostRoomVisible = await host.waitFor('document.body.innerText.toLowerCase().includes("sync room")', 15000);
  check('host room page connects (not stuck on "Joining room…")', hostRoomVisible);
  const connected = await waitForProbe(code, (s) => s.connectedCount >= 1, 10000);
  check('host holds a live socket connection', connected.connectedCount >= 1, JSON.stringify(connected));

  // -------------------------------------------------- upload + playback
  const attached = await host.evaluate(UPLOAD_WAV);
  check('audio attached to the queue input', attached === 'attached', String(attached));
  const uploaded = await waitForProbe(code, (s) => s.trackCount >= 1, 20000);
  check('audio uploaded through the queue UI', uploaded.trackCount >= 1, JSON.stringify(uploaded));
  const loaded = await host.waitFor(
    '(() => { const a = document.querySelector("audio"); return !!a && Boolean(a.currentSrc || a.src); })()',
    15000,
  );
  check('the page\'s <audio> element is the one the engine loads', loaded);
  check('host pressed play', (await click(host, '.controls__play')) === 'clicked');
  const hostPlaying = await host.waitFor(
    '(() => { const a = document.querySelector("audio"); return !!a && !a.paused && a.currentTime > 0.5; })()',
    25000,
  );
  check('pressing play actually plays audio in the DOM', hostPlaying);

  // ------------------------------------------------------- survives the grace
  await sleep(GRACE_WAIT_MS);
  const afterGrace = await probe(code).catch(() => ({}));
  const hostTextAfterGrace = await host.text();
  check(
    'room is still alive after the host-grace window',
    afterGrace.ended === false,
    `${JSON.stringify(afterGrace)} waited ${GRACE_WAIT_MS}ms`,
  );
  check(
    'host still connected after the grace window',
    afterGrace.connectedCount >= 1,
    `connectedCount=${afterGrace.connectedCount}`,
  );
  check('host page still shows the room', hostTextAfterGrace.toLowerCase().includes('sync room'));

  // ------------------------------------------------------------ guest joins
  guest = await newTab();
  await guest.goto(`${APP}/join?code=${code}`);
  const joinReady = await guest.waitFor('!!document.querySelector("#listener-name")');
  check('join page renders', joinReady);
  if (joinReady) await guest.evaluate(fillAndSubmit('#listener-name', 'Guest Device'));
  const guestInRoom = await guest.waitFor('location.pathname.startsWith("/room/")');
  check('guest lands on the room page', guestInRoom);
  const guestText = await guest.text().catch(() => '');
  check('guest is not told the session ended', !guestText.includes('This session has ended.') && !guestText.includes('Session Ended'));
  check('guest is not handed the host role', !guestText.includes('You are the host'));
  const bothIn = await waitForProbe(code, (s) => s.connectedCount === 2, 10000);
  check('both devices are connected to the same room', bothIn.connectedCount === 2, JSON.stringify(bothIn));
  const guestPlaying = await guest.waitFor(
    '(() => { const a = document.querySelector("audio"); return !!a && Boolean(a.currentSrc || a.src); })()',
    15000,
  );
  check('guest loads the host\'s track', guestPlaying);

  // -------------------------------------------------- seek while paused syncs
  check('host pressed pause', (await click(host, '.controls__play')) === 'clicked');
  const [hostPaused, guestPaused] = await Promise.all([
    host.waitFor('(() => { const a = document.querySelector("audio"); return !!a && a.paused; })()', 10000),
    guest.waitFor('(() => { const a = document.querySelector("audio"); return !!a && a.paused; })()', 10000),
  ]);
  check('both devices paused', hostPaused && guestPaused);

  await host.evaluate(SEEK(SEEK_TARGET));
  await sleep(2000);
  const seeked = await sampleBoth();
  check('host lands exactly on the seek target', Math.abs(seeked.projA - SEEK_TARGET) < 0.15, `host=${fmt(seeked.projA)}`);
  check('guest follows the seek', Math.abs(seeked.projB - SEEK_TARGET) < 0.15, `guest=${fmt(seeked.projB)}`);

  // --------------------------------------------------- drift self-correction
  check('host resumed playback', (await click(host, '.controls__play')) === 'clicked');
  await sleep(2500);
  await guest.evaluate(`(() => { const a = document.querySelector('audio'); a.currentTime += 2; return a.currentTime; })()`);
  await sleep(3500);
  const corrected = await sampleBoth();
  check('engine pulls a drifted device back into sync', corrected.delta < SYNC_TOL, `|A-B|=${fmt(corrected.delta)}s after an injected +2s drift`);
}

main()
  .catch((error) => check('verification ran without crashing', false, error?.message || String(error)))
  .finally(() => finish());
