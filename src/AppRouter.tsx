// src/router/index.tsx
// Removed unused React import
import { Routes, Route, Navigate } from 'react-router-dom';
import HomePage from 'src/pages/HomePage';
import ProfilePage from 'src/features/profile/ProfilePage';
import PostPage from 'src/components/PostPage';
import Login from 'src/features/auth/Login';
import { useAppState } from '@/state/useAppStorage'; // Import the context hook

function AppRouter() {
  const { isLoggedIn, loginWithFilebase, loginWithKubo } = useAppState();

  // Show login page if not logged in
  if (!isLoggedIn) {
    return (
      <Routes>
        <Route
          path="/login"
          element={
            <Login
              onLoginFilebase={loginWithFilebase}
              onLoginKubo={loginWithKubo}
            />
          }
        />
        {/* Redirect any other path to login */}
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  // Logged-in routes
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/post/:cid" element={<PostPage />} />
      <Route path="/profile/:key" element={<ProfilePage />} />
      {/* Redirect login path to home if already logged in */}
      <Route path="/login" element={<Navigate to="/" replace />} />
      {/* Optional: Handle unknown routes */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default AppRouter;