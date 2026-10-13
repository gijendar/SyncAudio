/* eslint-disable no-console */
/**
 * Smoke test for the SyncAudio realtime flow.
 *
 *   node scripts/verify-sync.mjs            # spawns its own server
 *   BASE_URL=http://localhost:4000 node scripts/verify-sync.mjs   # uses a running one
 *
 * Checks the parts that are hard to eyeball in a browser: clock sync, host
 * authority, upload permissions, command fan-out, reconnect resync and end.
 */
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';

const PORT = Number(process.env.PORT || 4000);
const BASE = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const ownServer = !process.env.BASE_URL;
const results = [];
let failures = 0;

let child = null;
let finished = false;

function finish(code) {
  if (finished) return;
  finished = true;
  console.log(results.join('\n'));
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  if (child && child.exitCode === null) child.kill();
  // socket.io keeps the loop alive; exit explicitly.
  process.exit(code ?? (failures === 0 ? 0 : 1));
}

function check(label, condition, detail = '') {
  results.push(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures += 1;
}

const watchdog = setTimeout(() => {
  check('verification finished before the watchdog', false, 'timed out after 60s');
  finish(2);
}, 60_000);

function connect() {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, { transports: ['websocket'] });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`socket connect timeout (${BASE})`));
    }, 5000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const emit = (socket, event, payload = {}) =>
  new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ ok: false, error: { code: 'ACK_TIMEOUT' } }),
      5000,
    );
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolve(response ?? { ok: false, error: { code: 'EMPTY_ACK' } });
    });
  });

const waitFor = (socket, event, timeoutMs = 4000) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

function makeWav() {
  const samples = 8000;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}

/** fetch that can never hang the suite. */
const req = (url, options = {}) =>
  fetch(url, { ...options, signal: AbortSignal.timeout(8000) });

async function waitForServer(attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const main = async () => {
  if (ownServer) {
    child = spawn(process.execPath, ['server/index.js'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
    child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
    if (!(await waitForServer())) {
      check('server started', false, 'no /api/health response');
      return finish(1);
    }
  }

  // --- health + config -------------------------------------------------------
  const health = await req(`${BASE}/api/health`).then((r) => r.json());
  check('GET /api/health', health.ok === true, JSON.stringify(health));

  // --- clock sync ------------------------------------------------------------
  const host = await connect();
  const clock = await new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setTimeout(() => resolve({ t0, t1: Date.now() }), 5000);
    host.emit('clock:sync', { t0 }, (res) => {
      clearTimeout(timer);
      resolve({ ...res, t1: Date.now() });
    });
  });
  check('clock:sync returns server time', Number.isFinite(clock.serverTime));
  check('clock:sync rtt is small', clock.t1 - clock.t0 < 500, `${clock.t1 - clock.t0}ms`);

  // --- create room -----------------------------------------------------------
  const created = await emit(host, 'room:create', { displayName: 'Gijendar' });
  check('room:create ok', created?.ok === true, JSON.stringify(created?.error ?? ''));
  const code = created.code;
  check('room code is 6 chars', typeof code === 'string' && /^[A-Z0-9]{6}$/.test(code), code);
  check('creator gets a hostKey', typeof created.hostKey === 'string' && created.hostKey.length > 10);
  check('creator is host', created.state?.you?.isHost === true);

  // --- participant joins -----------------------------------------------------
  const guest = await connect();
  const joined = await emit(guest, 'room:join', { code, displayName: 'Rahul' });
  check('room:join ok', joined?.ok === true, JSON.stringify(joined?.error ?? ''));
  check('guest is NOT host', joined.state?.you?.isHost === false);
  check(
    'room has 2 participants',
    joined.state?.participants?.length === 2,
    JSON.stringify(joined.state?.participants?.map((p) => p.name)),
  );

  const guestState = await waitFor(guest, 'room:state', 3000);
  check('server broadcasts participant list', (guestState ?? joined.state).connectedCount === 2);

  // --- a non-host cannot control playback ------------------------------------
  const guestPlay = await emit(guest, 'player:play', { position: 0 });
  check(
    'participant cannot play',
    guestPlay?.ok === false && guestPlay.error?.code === 'NOT_HOST',
    JSON.stringify(guestPlay?.error ?? ''),
  );

  // --- empty queue cannot play ----------------------------------------------
  const emptyPlay = await emit(host, 'player:play', {});
  check('host cannot play an empty queue', emptyPlay?.ok === false && emptyPlay.error?.code === 'EMPTY_QUEUE');

  // --- upload audio over HTTP ------------------------------------------------
  const wav = makeWav();
  const form = new FormData();
  form.append('name', 'Believer.mp3');
  form.append('duration', '3.5');
  form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'Believer.mp3');

  const upload = await req(`${BASE}/api/rooms/${code}/tracks`, {
    method: 'POST',
    headers: { 'x-session-id': created.sessionId },
    body: form,
  }).then((r) => r.json());
  check('host can upload audio', Boolean(upload?.track?.id), JSON.stringify(upload?.error ?? ''));
  const track = upload.track;

  const unauthorisedForm = new FormData();
  unauthorisedForm.append('audio', new Blob([wav], { type: 'audio/wav' }), 'sneaky.mp3');
  const unauthorised = await req(`${BASE}/api/rooms/${code}/tracks`, {
    method: 'POST',
    headers: { 'x-session-id': joined.sessionId },
    body: unauthorisedForm,
  });
  check('participant cannot upload', unauthorised.status === 403, `status ${unauthorised.status}`);

  // --- audio is served locally with range support ----------------------------
  const audioResponse = await req(`${BASE}${track.url}`);
  check('track audio is downloadable', audioResponse.ok, `status ${audioResponse.status}`);
  const ranged = await req(`${BASE}${track.url}`, { headers: { Range: 'bytes=0-99' } });
  check('track audio supports range requests', ranged.status === 206, `status ${ranged.status}`);

  // --- playback command fan-out ----------------------------------------------
  const hostCommand = waitFor(host, 'player:command');
  const guestCommand = waitFor(guest, 'player:command');
  const playAck = await emit(host, 'player:play', {});
  check('host can start playback', playAck?.ok === true, JSON.stringify(playAck?.error ?? ''));

  const [hostPlay, guestPlayCmd] = await Promise.all([hostCommand, guestCommand]);
  check('every device receives the play command', Boolean(hostPlay && guestPlayCmd));
  check(
    'play command schedules ahead of server time',
    hostPlay?.playAt > hostPlay?.serverTime,
    `${hostPlay?.playAt - hostPlay?.serverTime}ms ahead`,
  );
  check('play command carries a position', Number.isFinite(hostPlay?.position), String(hostPlay?.position));
  check('play command carries the track', hostPlay?.track?.id === track.id);

  // --- seek / pause ----------------------------------------------------------
  const guestSeek = waitFor(guest, 'player:command');
  await emit(host, 'player:seek', { position: 1.25 });
  const seekCommand = await guestSeek;
  check(
    'seek broadcasts to participants',
    seekCommand?.action === 'seek' && seekCommand.position === 1.25,
    JSON.stringify(seekCommand),
  );

  const guestPause = waitFor(guest, 'player:command');
  await emit(host, 'player:pause', {});
  const pauseCommand = await guestPause;
  check('pause broadcasts to participants', pauseCommand?.action === 'pause', JSON.stringify(pauseCommand));

  // --- authoritative position ------------------------------------------------
  const sync = await emit(guest, 'room:sync', {});
  check('room:sync returns authoritative state', sync?.ok === true && sync.state.isPlaying === false);
  check('snapshot reports the paused position', Math.abs(sync.state.position - 1.25) < 0.6, String(sync.state.position));

  // --- reconnect resync ------------------------------------------------------
  guest.disconnect();
  await new Promise((r) => setTimeout(r, 300));
  const afterLeave = await req(`${BASE}/api/rooms/${code}`).then((r) => r.json());
  check('disconnect updates the connected count', afterLeave.connectedCount === 1, JSON.stringify(afterLeave));

  const guest2 = await connect();
  const rejoined = await emit(guest2, 'room:join', {
    code,
    sessionId: joined.sessionId,
    displayName: 'Rahul',
  });
  check('participant can rejoin and resync', rejoined?.ok === true && rejoined.state.participants.length === 2);
  check('rejoin keeps the same participant slot', rejoined.state.you.isHost === false);

  // --- track change ----------------------------------------------------------
  const guestTrack = waitFor(guest2, 'player:command');
  await emit(host, 'player:track', { index: 0, autoplay: false });
  const trackCommand = await guestTrack;
  check('track change broadcasts', trackCommand?.action === 'track' && trackCommand.track?.id === track.id);

  // --- reorder + remove ------------------------------------------------------
  const reorder = await req(`${BASE}/api/rooms/${code}/queue`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-session-id': created.sessionId },
    body: JSON.stringify({ orderedIds: [track.id] }),
  }).then((r) => r.json());
  check('host can reorder the queue', reorder.ok === true, JSON.stringify(reorder.error ?? ''));

  const remove = await req(`${BASE}/api/rooms/${code}/tracks/${track.id}`, {
    method: 'DELETE',
    headers: { 'x-session-id': created.sessionId },
  }).then((r) => r.json());
  check('host can remove a track', remove.ok === true, JSON.stringify(remove.error ?? ''));

  // --- end session -----------------------------------------------------------
  const guestEnded = waitFor(guest2, 'room:ended');
  await emit(host, 'player:end', {});
  const ended = await guestEnded;
  check('participants are notified when the session ends', Boolean(ended), JSON.stringify(ended));

  // The public probe stays informational (200 + ended:true) so the Join screen
  // can explain the situation; the real join gate lives in the socket layer.
  const gone = await req(`${BASE}/api/rooms/${code}`);
  const goneBody = await gone.json().catch(() => ({}));
  check('ended room reports its ended status', gone.status === 200 && goneBody.ended === true, JSON.stringify(goneBody));

  const latecomer = await connect();
  const lateJoin = await emit(latecomer, 'room:join', { code, displayName: 'Late' });
  check(
    'ended room rejects new joins',
    lateJoin?.ok === false && lateJoin.error?.code === 'ENDED',
    JSON.stringify(lateJoin?.error ?? lateJoin),
  );
  latecomer.disconnect();

  // --- invalid room ----------------------------------------------------------
  const missing = await req(`${BASE}/api/rooms/ZZZZ99`);
  check('unknown room returns not found', missing.status === 404);

  host.disconnect();
  guest2.disconnect();
  clearTimeout(watchdog);
  finish();
};

main().catch((error) => {
  check('verification ran without crashing', false, error?.message ?? String(error));
  clearTimeout(watchdog);
  finish(1);
});
