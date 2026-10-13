# SyncAudio

Turn every device in the room into one synchronized speaker. The host picks a
track once; everyone who joins hears it at the same moment — no speaker, no app
store, just a browser.

## How it works

The one rule that keeps sync cheap: **audio never travels over the WebSocket.**

1. The host uploads an audio file once. It is stored temporarily on the server.
2. Every device downloads that file over plain HTTP (with range requests, so
   seeking is instant) and plays its own local copy.
3. Only tiny control messages — play, pause, seek, track change — go over
   Socket.IO. That keeps mobile data low and the timing precise.

The server is authoritative. When a client asks to transition, `RoomManager`
schedules it against a **future server timestamp**, and every device lines its
playback up to that moment using the clock sync it established on join.
`client/src/lib/syncEngine.js` continuously nudges each device's playback
position/rate toward the server's anchor so small drift never becomes an echo.

## Stack

- **Backend:** Node 18+ / Express / Socket.IO
- **Frontend:** React 18 + Vite (premium dark UI)
- **Optional persistence:** Supabase (PostgreSQL). Runs fully in memory by default.
- **Sharing:** room link + QR code, generated on the server with `qrcode`.

## Quick start

```bash
npm install
cp .env.example .env     # optional — sensible defaults are built in
npm run dev              # server on :4000, client on :5173
```

Open http://localhost:5173, start a room, share the QR code, and have another
device open the link.

### Production

```bash
npm run build            # builds client/dist
npm start                # Express serves the API, sockets AND the built client
```

`npm start` serves everything from a single port (default `4000`).

## Configuration

All variables are optional; defaults are in `server/config.js`. Copy
`.env.example` and adjust as needed.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4000` | Server port |
| `PUBLIC_APP_URL` | `http://localhost:5173` | Base URL used in share links / QR codes |
| `CLIENT_ORIGINS` | localhost dev origins | Comma-separated CORS/Socket.IO allow-list |
| `MAX_UPLOAD_MB` | `80` | Max size of one uploaded file |
| `MAX_ROOM_STORAGE_MB` | `400` | Total temp storage per room |
| `ROOM_IDLE_TTL_MINUTES` | `30` | How long an inactive room is kept |
| `HOST_GRACE_MS` | `20000` | Host reconnect grace window |
| `UPLOAD_DIR` | `.syncaudio-uploads` | On-disk temp audio location |
| `SUPABASE_URL` | — | Optional persistence |
| `SUPABASE_SERVICE_ROLE_KEY` | — | Optional persistence (server-only, never sent to clients) |

Uploaded audio and rooms are temporary: files are deleted when a track is
removed, a session ends, or a room expires.

## Optional: Supabase persistence

Leave `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` blank to run in memory (fine
for local use). To persist rooms across restarts, create these tables:

```sql
create table rooms (
  id text primary key,
  room_code text,
  host_id text,
  status text,
  current_track text,
  current_position numeric default 0,
  is_playing boolean default false,
  created_at timestamptz,
  updated_at timestamptz
);

create table participants (
  id text primary key,
  room_id text references rooms(id) on delete cascade,
  display_name text,
  session_id text,
  joined_at timestamptz,
  last_seen timestamptz,
  is_connected boolean default false
);

create table tracks (
  id text primary key,
  room_id text references rooms(id) on delete cascade,
  file_name text,
  file_url text,
  duration numeric default 0,
  position_in_queue int default 0,
  created_at timestamptz
);
```

Persistence is best-effort: if Supabase is unreachable the app keeps working
from memory and logs the failure.

## Verifying sync

A dependency-light smoke test exercises the realtime flow end to end — clock
sync, host authority, upload permissions, command fan-out, range requests,
reconnect resync, queue edits and session end:

```bash
node scripts/verify-sync.mjs
```

It spawns its own server on `PORT` (default `4000`). To test a running server
instead:

```bash
BASE_URL=http://localhost:4000 node scripts/verify-sync.mjs
```

## Project layout

```
server/            Express + Socket.IO
  index.js         HTTP API, static client, server bootstrap
  realtime.js      socket event handlers
  lib/rooms.js     authoritative RoomManager (the sync brain)
  lib/uploads.js   multer temp storage
  lib/db.js        optional Supabase persistence
  lib/rateLimit.js per-key rate limiting
client/src/
  lib/syncEngine.js   drift correction + scheduled playback
  lib/useRoomSession.js  room lifecycle hook
  components/         Landing, CreateSession, JoinSession, Room, Player, Queue…
scripts/verify-sync.mjs  realtime smoke test
```
