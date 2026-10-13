import { Crown, Smartphone, Users } from 'lucide-react';
import { initials, pluralise } from '../lib/format.js';

export function Participants({ roomState, code, onShare }) {
  const participants = roomState?.participants ?? [];
  const connected = roomState?.connectedCount ?? participants.filter((person) => person.connected).length;

  return (
    <section className="card">
      <div className="card__head">
        <span className="card__title">
          <Users aria-hidden="true" />
          People in this session
        </span>
        <span className="count-badge">
          <b>{pluralise(connected, 'device')}</b> connected
        </span>
      </div>

      <ul className="people">
        {participants.map((person) => (
          <li className="people__item" key={person.sessionId}>
            <span className={`avatar${person.connected ? '' : ' avatar--muted'}`}>
              {initials(person.name)}
            </span>
            <span style={{ minWidth: 0, flex: 1 }}>
              <span className="people__name">
                <span>{person.name}</span>
                {person.isHost ? (
                  <span className="tag tag--host">
                    <Crown style={{ width: 12, height: 12 }} aria-hidden="true" />
                    Host
                  </span>
                ) : null}
                {!person.connected ? <span className="tag">offline</span> : null}
              </span>
              <span className="people__meta">
                {person.isHost ? 'Controls playback' : 'Listening device'}
              </span>
            </span>
            <span
              className={`people__dot${person.connected ? '' : ' people__dot--off'}`}
              title={person.connected ? 'Connected' : 'Disconnected'}
            />
          </li>
        ))}
      </ul>

      {participants.length <= 1 ? (
        <div className="banner banner--info" style={{ marginTop: 14 }}>
          <Smartphone aria-hidden="true" />
          <span>
            Waiting for friends… Tap <b>Show QR</b> or share the Room ID <b>{code}</b> so they can join.
          </span>
        </div>
      ) : null}

      {onShare ? (
        <button type="button" className="btn btn--ghost btn--block" style={{ marginTop: 14 }} onClick={onShare}>
          Invite more devices
        </button>
      ) : null}
    </section>
  );
}
