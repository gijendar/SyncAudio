import { Route, Routes } from 'react-router-dom';
import { Aurora } from './components/Aurora.jsx';
import { ToastProvider } from './components/ToastProvider.jsx';
import { Landing } from './components/Landing.jsx';
import { CreateSession } from './components/CreateSession.jsx';
import { JoinSession } from './components/JoinSession.jsx';
import { Room } from './components/Room.jsx';

function NotFound() {
  return (
    <main className="page centered">
      <div className="stack" style={{ textAlign: 'center' }}>
        <span className="kicker">404</span>
        <h1 style={{ fontSize: '2rem', letterSpacing: '-0.03em' }}>That page doesn&rsquo;t exist</h1>
        <a className="btn btn--primary" href="/">
          Back to SyncAudio
        </a>
      </div>
    </main>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Aurora />
      <div className="shell">
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/create" element={<CreateSession />} />
          <Route path="/join" element={<JoinSession />} />
          <Route path="/room/:code" element={<Room />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </div>
    </ToastProvider>
  );
}
