// src/App.tsx
import { useEffect } from 'react';
import { HashRouter } from 'react-router-dom';
import { AppStateProvider } from './state/AppContext';
import AppRouter from './pages/AppRouter';
import { Toaster } from 'react-hot-toast';
function App() {
  useEffect(() => {
    // Phase 1: warm browser Helia node for content add/pin (lazy chunk)
    import('./api/heliaNode')
      .then(m => m.startHelia())
      .catch((e) => console.warn('[App] Helia start deferred', e));
  }, []);

  return (
    <AppStateProvider>
      <HashRouter>
        <AppRouter />
        <Toaster position="bottom-center" toastOptions={{ duration: 3000 }} />
      </HashRouter>
    </AppStateProvider>
  );
}

export default App;