// src/App.tsx
// Removed unused React import
import { HashRouter } from 'react-router-dom';
import { AppStateProvider } from './state/AppContext';
import AppRouter from './pages/AppRouter';
import { Toaster } from 'react-hot-toast';

function App() {
  return (
    <AppStateProvider>
      <HashRouter>
        <AppRouter />
        {/* Toaster for notifications */}
        <Toaster position="bottom-center" toastOptions={{ duration: 3000 }} />
      </HashRouter>
    </AppStateProvider>
  );
}

export default App;