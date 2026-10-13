import { useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  ListMusic,
  Loader2,
  Music,
  Play,
  Trash2,
  Upload,
} from 'lucide-react';
import { uploadWithProgress, apiFetch } from '../lib/api.js';
import { formatBytes, formatTime, pluralise, stripExtension } from '../lib/format.js';
import { useToast } from './ToastProvider.jsx';

/** Read the duration of a local file without uploading it first. */
function readDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(value);
    };
    audio.preload = 'metadata';
    audio.addEventListener('loadedmetadata', () =>
      finish(Number.isFinite(audio.duration) ? audio.duration : 0),
    );
    audio.addEventListener('error', () => finish(0));
    setTimeout(() => finish(0), 8000);
    audio.src = url;
  });
}

export function Queue({ code, roomState, isHost, sessionId, onPlayTrack, uploadProgress, setUploadProgress }) {
  const toast = useToast();
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [busyTrackId, setBusyTrackId] = useState(null);

  const tracks = roomState?.tracks ?? [];
  const currentTrackId = roomState?.currentTrackId ?? null;
  const uploading = uploadProgress !== null && uploadProgress !== undefined;

  const uploadFiles = async (fileList) => {
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;

    for (const file of files) {
      try {
        setUploadProgress(0);
        const duration = await readDuration(file);
        await uploadWithProgress({
          url: `/api/rooms/${code}/tracks`,
          headers: { 'x-session-id': sessionId },
          file: {
            blob: file,
            name: file.name,
            fields: { name: file.name, duration: String(duration || '') },
          },
          onProgress: setUploadProgress,
        });
        toast({ type: 'success', message: `${stripExtension(file.name)} added to the queue.` });
      } catch (error) {
        toast({ type: 'error', message: error.message || 'Audio upload failed.' });
      } finally {
        setUploadProgress(null);
      }
    }
    if (inputRef.current) inputRef.current.value = '';
  };

  const removeTrack = async (track) => {
    setBusyTrackId(track.id);
    try {
      await apiFetch(`/api/rooms/${code}/tracks/${track.id}`, {
        method: 'DELETE',
        headers: { 'x-session-id': sessionId },
      });
      toast({ type: 'info', message: `${stripExtension(track.name)} removed.` });
    } catch (error) {
      toast({ type: 'error', message: error.message });
    } finally {
      setBusyTrackId(null);
    }
  };

  const move = async (index, direction) => {
    const next = [...tracks];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setBusyTrackId(tracks[index].id);
    try {
      await apiFetch(`/api/rooms/${code}/queue`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-session-id': sessionId },
        body: JSON.stringify({ orderedIds: next.map((track) => track.id) }),
      });
    } catch (error) {
      toast({ type: 'error', message: error.message });
    } finally {
      setBusyTrackId(null);
    }
  };

  return (
    <section className="card">
      <div className="card__head">
        <span className="card__title">
          <ListMusic aria-hidden="true" />
          Queue
        </span>
        <span className="count-badge">{pluralise(tracks.length, 'track')}</span>
      </div>

      {isHost ? (
        <div
          className={`upload${dragging ? ' upload--drop' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            uploadFiles(event.dataTransfer.files);
          }}
          style={{ marginBottom: 14 }}
        >
          <div className="upload__icon">
            {uploading ? <Loader2 className="spinner" aria-hidden="true" /> : <Upload aria-hidden="true" />}
          </div>
          <p>{uploading ? `Uploading… ${uploadProgress}%` : 'Upload Audio'}</p>
          <small>MP3, WAV, OGG, M4A — stored temporarily for this session</small>
          {uploading ? (
            <div className="progress-line">
              <div className="progress-line__fill" style={{ width: `${uploadProgress}%` }} />
            </div>
          ) : (
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
            >
              <Music aria-hidden="true" />
              Choose files
            </button>
          )}
          <input
            ref={inputRef}
            type="file"
            accept="audio/*,.mp3,.wav,.ogg,.oga,.m4a,.aac,.flac,.opus,.webm"
            multiple
            className="sr-only"
            onChange={(event) => uploadFiles(event.target.files)}
          />
        </div>
      ) : null}

      {tracks.length === 0 ? (
        <div className="empty">
          <Music aria-hidden="true" />
          <p>The queue is empty.</p>
          {isHost ? (
            <p style={{ marginTop: 4 }}>Upload a track to start the session.</p>
          ) : (
            <p style={{ marginTop: 4 }}>Waiting for the host to add audio.</p>
          )}
        </div>
      ) : (
        <ul>
          {tracks.map((track, index) => {
            const isActive = track.id === currentTrackId;
            return (
              <li className={`queue__item${isActive ? ' queue__item--active' : ''}`} key={track.id}>
                <span className="queue__index">{String(index + 1).padStart(2, '0')}</span>

                <button
                  type="button"
                  className="queue__body"
                  onClick={() => (isHost ? onPlayTrack(index) : undefined)}
                  disabled={!isHost}
                  style={{ cursor: isHost ? 'pointer' : 'default' }}
                  title={isHost ? 'Play this track' : 'Only the host can change tracks'}
                >
                  <span className="queue__name">{stripExtension(track.name)}</span>
                  <span className="queue__sub">
                    {track.duration ? formatTime(track.duration) : 'audio'}
                    {track.size ? ` · ${formatBytes(track.size)}` : ''}
                    {isActive ? ' · now playing' : ''}
                  </span>
                </button>

                {isHost ? (
                  <div className="queue__actions">
                    <button
                      type="button"
                      className="queue__mini"
                      onClick={() => onPlayTrack(index)}
                      disabled={busyTrackId === track.id}
                      aria-label={`Play ${track.name}`}
                    >
                      <Play />
                    </button>
                    <button
                      type="button"
                      className="queue__mini"
                      onClick={() => move(index, -1)}
                      disabled={index === 0 || busyTrackId === track.id}
                      aria-label={`Move ${track.name} up`}
                    >
                      <ChevronUp />
                    </button>
                    <button
                      type="button"
                      className="queue__mini"
                      onClick={() => move(index, 1)}
                      disabled={index === tracks.length - 1 || busyTrackId === track.id}
                      aria-label={`Move ${track.name} down`}
                    >
                      <ChevronDown />
                    </button>
                    <button
                      type="button"
                      className="queue__mini is-danger"
                      onClick={() => removeTrack(track)}
                      disabled={busyTrackId === track.id}
                      aria-label={`Remove ${track.name}`}
                    >
                      {busyTrackId === track.id ? <Loader2 className="spinner" /> : <Trash2 />}
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
