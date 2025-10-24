// fileName: src/pages/AppRouter.tsx
// src/router/AppRouter.tsx
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import HomePage from './HomePage';
import ProfilePage from 'src/features/profile/ProfilePage';
import PostPage from 'src/components/PostPage';
import Login from 'src/features/auth/Login';
import { useAppState } from '@/state/useAppStorage'; // Import the context hook
import LoadingSpinner from 'src/components/LoadingSpinner';

function AppRouter() {
  const { isLoggedIn, loginWithFilebase, loginWithKubo } = useAppState();
  const location = useLocation();
  // Check for the background location state passed by PostItem
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
      {/* Render the main routes using the background location if it exists, otherwise the current location */}
      <Routes location={backgroundLocation || location}>
        {/* PUBLIC ROUTES: Render normally */}
        {/* --- FIX: Removed full-page PostPage route --- */}
        {/* <Route path="/post/:cid" element={<PostPage />} /> */}
        <Route path="/profile/:key" element={<ProfilePage />} />

        {/* LOGIN ROUTE: */}
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

        {/* PROTECTED ROUTES: */}
        <Route
          path="/"
          element={
            isLoggedIn ? <HomePage /> : <Navigate to="/login" replace />
          }
        />

        {/* CATCH-ALL: Redirects any other path */}
        {/* Adjusted catch-all to redirect based on login status */}
         <Route path="*" element={<Navigate to={isLoggedIn ? "/" : "/login"} replace />} />
      </Routes>

      {/* Render the modal route *only* if backgroundLocation exists */}
      {backgroundLocation && (
        <Routes>
          {/* --- FIX: Route now renders PostPage without isModal prop --- */}
          <Route path="/post/:cid" element={<PostPage />} />
          {/* Add other modal routes here if needed */}
        </Routes>
      )}
    </>
  );
}

export default AppRouter;