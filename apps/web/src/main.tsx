import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { AppShell } from './pages/App';
import { Login } from './pages/Login';
import { loadSession, saveSession, type StoredSession } from './session';
import { socket } from './socket';
import { useStore } from './store';

function Root() {
  const [session, setSession] = useState<StoredSession | null>(() => loadSession());

  const logout = useCallback(() => {
    socket.disconnect();
    useStore.getState().reset();
    saveSession(null);
    setSession(null);
  }, []);

  useEffect(() => {
    if (!session) return;
    socket.connect(session.token, logout);
    return () => socket.disconnect();
  }, [session, logout]);

  if (!session) {
    return <Login onSignedIn={(s) => { useStore.getState().reset(); saveSession(s); setSession(s); }} />;
  }
  return <AppShell customerName={session.name} onLogout={logout} />;
}

createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>);
