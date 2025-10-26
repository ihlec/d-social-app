// fileName: src/pages/AppRouter.tsx
// fileName: src/pages/AppRouter.tsx
// src/router/AppRouter.tsx
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import HomePage from './HomePage';
import ProfilePage from 'src/features/profile/ProfilePage';
import PostPage from 'src/components/PostPage';
import Login from 'src/features/auth/Login';
import { useAppState } from '@/state/useAppStorage'; // Import the context hook
import LoadingSpinner from 'src/components/LoadingSpinner';
import InitializeUserDialog from 'src/components/InitializeUserDialog';

function AppRouter() {
  const { 
    isLoggedIn, 
    // --- REMOVED: loginWithFilebase ---
    // loginWithFilebase, 
    loginWithKubo,
    isInitializeDialogOpen,
    onInitializeUser,
    onRetryLogin
  } = useAppState();
  const location = useLocation();
  const backgroundLocation = location.state?.backgroundLocation;

  if (isLoggedIn === null) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <>
      <Routes location={backgroundLocation || location}>
        <Route path="/profile/:key" element={<ProfilePage />} />

        {/* LOGIN ROUTE: */}
        <Route
          path="/login"
          element={
            !isLoggedIn ? (
              <Login
                // --- REMOVED: onLoginFilebase prop ---
                // onLoginFilebase={loginWithFilebase}
                onLoginKubo={loginWithKubo}
              />
            ) : (
              <Navigate to="/" replace />
            )
          }
        />

        {/* PROTECTED ROUTES: */}
        <Route
          path="/"
          element={
            isLoggedIn ? <HomePage /> : <Navigate to="/login" replace />
          }
        />

         <Route path="*" element={<Navigate to={isLoggedIn ? "/" : "/login"} replace />} />
      </Routes>

      {/* Render the modal route *only* if backgroundLocation exists */}
      {backgroundLocation && (
        <Routes>
          <Route path="/post/:cid" element={<PostPage />} />
        </Routes>
      )}

      <InitializeUserDialog
        isOpen={isInitializeDialogOpen}
        onInitialize={onInitializeUser || (() => {})} // Pass handlers
        onRetry={onRetryLogin || (() => {})}
      />
    </>
  );
}

export default AppRouter;
