// src/router/AppRouter.tsx
import { Routes, Route, Navigate } from 'react-router-dom';
import HomePage from './HomePage';
import ProfilePage from 'src/features/profile/ProfilePage';
import PostPage from 'src/components/PostPage';
import Login from 'src/features/auth/Login';
import { useAppState } from '@/state/useAppStorage'; // Import the context hook
import LoadingSpinner from 'src/components/LoadingSpinner';

function AppRouter() {
  const { isLoggedIn, loginWithFilebase, loginWithKubo } = useAppState();

  // --- FIX: Add loading state ---
  if (isLoggedIn === null) {
    // We are still checking the session.
    // Display a full-page spinner or a minimal layout.
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <LoadingSpinner />
      </div>
    );
  }
  // --- End Fix ---

  // --- FIX: Restructured routing for public pages ---
  // The router no longer has a single "logged in" or "logged out" block.
  // We define all routes and protect them individually.
  return (
    <Routes>
      {/* PUBLIC ROUTES:
        These routes are accessible to everyone, logged in or not.
      */}
      <Route path="/post/:cid" element={<PostPage />} />
      <Route path="/profile/:key" element={<ProfilePage />} />
      
      {/* LOGIN ROUTE:
        If logged out, shows the Login page.
        If logged in, redirects to the main feed.
      */}
      <Route
        path="/login"
        element={
          !isLoggedIn ? (
            <Login
              onLoginFilebase={loginWithFilebase}
              onLoginKubo={loginWithKubo}
            />
          ) : (
            <Navigate to="/" replace />
          )
        }
      />

      {/* PROTECTED ROUTES:
        These routes require a user to be logged in.
      */}
      <Route
        path="/"
        element={
          isLoggedIn ? <HomePage /> : <Navigate to="/login" replace />
        }
      />

      {/* CATCH-ALL:
        Redirects any other path to the main feed,
        which will then handle the auth redirect if necessary.
      */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
  // --- END FIX ---
}

export default AppRouter;