import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

/**
 * Optional Supabase persistence layer.
 *
 * Real-time playback state lives exclusively in the in-memory room manager and
 * the Socket.IO layer (see README "Why playback state is not in the database").
 * Supabase is used only for durable records: rooms, participants and tracks.
 *
 * Every call is best-effort and never blocks a socket command: if Supabase is
 * unconfigured or unreachable, SyncAudio keeps working in pure in-memory mode.
 *
 * The service-role key is read on the server only and is never exposed to the
 * browser bundle or sent over a socket payload.
 */

const disabled = {
  enabled: false,
  async upsertRoom() {},
  async updateRoom() {},
  async upsertParticipant() {},
  async markParticipantDisconnected() {},
  async insertTrack() {},
  async deleteTrack() {},
  async deleteRoom() {},
};

function logOnce(message, error) {
  if (!logOnce.seen) logOnce.seen = new Set();
  if (logOnce.seen.has(message)) return;
  logOnce.seen.add(message);
  console.warn(`[supabase] ${message}:`, error?.message || error);
}

export function createDb() {
  const { url, serviceRoleKey } = config.supabase;
  if (!url || !serviceRoleKey) {
    return { ...disabled, reason: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' };
  }

  let client;
  try {
    client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } catch (error) {
    logOnce('failed to initialise client', error);
    return disabled;
  }

  async function attempt(label, run) {
    try {
      const { error } = await run();
      if (error) logOnce(`${label} failed`, error);
    } catch (error) {
      logOnce(`${label} threw`, error);
    }
  }

  return {
    enabled: true,
    reason: null,

    upsertRoom(room) {
      return attempt('upsertRoom', () =>
        client.from('rooms').upsert({
          id: room.code,
          room_code: room.code,
          host_id: room.hostSessionId,
          status: room.status,
          current_track: room.currentTrackId,
          current_position: Math.max(0, room.anchorPosition),
          is_playing: room.isPlaying,
          created_at: room.createdAtIso,
          updated_at: new Date().toISOString(),
        }),
      );
    },

    updateRoom(room) {
      return attempt('updateRoom', () =>
        client
          .from('rooms')
          .update({
            status: room.status,
            current_track: room.currentTrackId,
            current_position: Math.max(0, room.anchorPosition),
            is_playing: room.isPlaying,
            host_id: room.hostSessionId,
            updated_at: new Date().toISOString(),
          })
          .eq('id', room.code),
      );
    },

    upsertParticipant(room, participant) {
      return attempt('upsertParticipant', () =>
        client.from('participants').upsert({
          id: `${room.code}:${participant.sessionId}`,
          room_id: room.code,
          display_name: participant.name,
          session_id: participant.sessionId,
          joined_at: participant.joinedAtIso,
          last_seen: new Date().toISOString(),
          is_connected: participant.connected,
        }),
      );
    },

    markParticipantDisconnected(room, sessionId) {
      return attempt('markParticipantDisconnected', () =>
        client
          .from('participants')
          .update({ is_connected: false, last_seen: new Date().toISOString() })
          .eq('id', `${room.code}:${sessionId}`),
      );
    },

    insertTrack(room, track) {
      return attempt('insertTrack', () =>
        client.from('tracks').insert({
          id: track.id,
          room_id: room.code,
          file_name: track.name,
          file_url: track.url,
          duration: track.duration,
          position_in_queue: track.queuePosition,
          created_at: track.createdAtIso,
        }),
      );
    },

    deleteTrack(trackId) {
      return attempt('deleteTrack', () => client.from('tracks').delete().eq('id', trackId));
    },

    deleteRoom(room) {
      return attempt('deleteRoom', () => client.from('rooms').delete().eq('id', room.code));
    },
  };
}
