// fileName: src/pages/AppRouter.tsx
import { Suspense, lazy } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAppState } from '../state/useAppStorage';
import LoadingSpinner from '../components/LoadingSpinner';
import InitializeUserDialog from '../components/InitializeUserDialog';

const HomePage = lazy(() => import('./HomePage'));
const ProfilePage = lazy(() => import('./ProfilePage'));
const PostPage = lazy(() => import('./PostPage'));
const Login = lazy(() => import('../features/auth/Login'));

function AppRouter() {
  const { 
    isLoggedIn, 
    loginWithKubo,
    isInitializeDialogOpen,
    onInitializeUser,
    onRetryLogin
  } = useAppState();
  
  const location = useLocation();
  const backgroundLocation = location.state?.backgroundLocation;

  return (
    <>
      {isLoggedIn === null && (
        <div className="center-screen-loader">
          <LoadingSpinner />
        </div>
      )}

      {isLoggedIn !== null && (
        <Suspense fallback={<div className="center-screen-loader"><LoadingSpinner /></div>}>
            <Routes location={backgroundLocation || location}>
          {/* PUBLIC ROUTES (Accessible without login) */}
          <Route path="/profile/:key" element={<ProfilePage />} />
          <Route path="/profile/:key/:tab" element={<ProfilePage />} />
          <Route path="/post/:cid" element={<PostPage />} />

          {/* LOGIN ROUTE */}
          <Route
            path="/login"
            element={
              !isLoggedIn ? (
                <Login onLoginKubo={loginWithKubo} />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />

          {/* PROTECTED ROUTES */}
          <Route
            path="/"
            element={
              isLoggedIn ? <HomePage /> : <Navigate to="/login" replace />
            }
          />

          {/* Catch-all: Redirect based on auth status */}
          <Route path="*" element={<Navigate to={isLoggedIn ? "/" : "/login"} replace />} />
            </Routes>
        </Suspense>
      )}

      {/* Render the modal route *only* if backgroundLocation exists (Modal View) */}
      {backgroundLocation && isLoggedIn !== null && (
        <Suspense fallback={null}>
            <Routes>
              <Route path="/post/:cid" element={<PostPage />} />
            </Routes>
        </Suspense>
      )}

      <InitializeUserDialog
        isOpen={isInitializeDialogOpen}
        onInitialize={onInitializeUser || (() => {})}
        onRetry={onRetryLogin || (() => {})}
      />
    </>
  );
}

export default AppRouter;