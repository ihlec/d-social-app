// fileName: src/components/Sidebar.tsx
import React, { useState, useEffect, useRef, Suspense, lazy } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { UserState, OnlinePeer } from '../types';
import { useAppState } from '../state/useAppStorage';
import { SettingsIcon } from './Icons';
import { HomeIcon } from './Icons';
import { sanitizeText } from '../lib/utils';
import './Sidebar.css';

const SettingsDialog = lazy(() => import('./SettingsDialog'));
const UnlockSessionDialog = lazy(() => import('./UnlockSessionDialog'));

// --- Helper Component for Copy Logic ---
interface CopyableTextProps {
    value: string;
    displayValue?: string;
    className?: string;
    style?: React.CSSProperties;
    title?: string;
}

const CopyableText: React.FC<CopyableTextProps> = ({ value, displayValue, className, style, title }) => {
    const [copied, setCopied] = useState(false);

    const handleCopy = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!value) return;
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    if (copied) {
        return (
            <span 
                className={className} 
                style={{ ...style, color: 'var(--primary-color)', cursor: 'default', fontWeight: 'bold' }}
            >
                Copied!
            </span>
        );
    }

    return (
        <span 
            className={className} 
            onClick={handleCopy} 
            title={title || "Click to copy"} 
            style={{ ...style, cursor: 'pointer' }}
        >
            {displayValue || value || 'N/A'}
        </span>
    );
};


interface InfoItemProps {
  label: string;
  children: React.ReactNode;
}

const InfoItem: React.FC<InfoItemProps> = ({ label, children }) => {
  return (
    <div className="info-item">
      <strong>{label}</strong>
      <div style={{ display: 'block', wordBreak: 'break-all', fontFamily: 'monospace', fontSize: '0.85em', color: 'var(--primary-color)' }}>
         {children}
      </div>
    </div>
  );
};

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void; 
  userState: UserState | null;
  ipnsKey: string; 
  peerId: string;
  latestCid: string;
  unresolvedFollows: string[];
  otherUsers: OnlinePeer[];
  onFollow: (ipnsKey: string) => Promise<void>;
  onUnfollow: (ipnsKey: string) => Promise<void>;
  onViewProfile: (ipnsKey: string) => void;
  onLogout: () => void;
  onRefreshHome?: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  isOpen,
  onClose,
  userState,
  peerId,
  latestCid,
  unresolvedFollows,
  otherUsers,
  onFollow,
  onUnfollow,
  onViewProfile,
  onLogout,
  onRefreshHome
}) => {
  const { userProfilesMap, fetchUser, isSessionLocked, unlockSession } = useAppState();
  const navigate = useNavigate();
  const location = useLocation();

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isUnlockOpen, setIsUnlockOpen] = useState(false);
  const [manualFollowKey, setManualFollowKey] = useState('');
  const [isAdding, setIsAdding] = useState(false);

  // FIX: Track attempted fetches to prevent "hammering" the API on re-renders
  const attemptedAutoFetch = useRef<Set<string>>(new Set());

  // 2. AUTO-RESOLVE NAMES: If a friend is missing from cache, fetch them.
  useEffect(() => {
      if (!userState || !isOpen) return;

      userState.follows.forEach(follow => {
          // Check if missing from cache AND not yet attempted in this session
          if (!userProfilesMap.has(follow.ipnsKey) && !attemptedAutoFetch.current.has(follow.ipnsKey)) {
              
              // Mark as attempted immediately
              attemptedAutoFetch.current.add(follow.ipnsKey);
              
              // console.log(`[Sidebar] Auto-fetching profile for ${follow.ipnsKey}`);
              fetchUser(follow.ipnsKey); 
          }
      });
  }, [isOpen, userState, userProfilesMap, fetchUser]);


  const handleManualFollow = async () => {
      if (!manualFollowKey.trim()) return;
      setIsAdding(true);
      try {
          await onFollow(manualFollowKey.trim());
          setManualFollowKey('');
      } catch (error) {
          console.error("Manual follow failed", error);
      } finally {
          setIsAdding(false);
      }
  };

  const handleHomeClick = () => {
      // Check if we are already at the home root (or hash root)
      if (location.pathname === '/' || location.hash === '#/') {
          if (onRefreshHome) onRefreshHome();
      } else {
          navigate('/');
      }
      onClose();
  };

  return (
    <>
    <div 
        className={`sidebar-overlay ${isOpen ? 'open' : ''}`} 
        onClick={onClose}
    />

    <div className={`sidebar ${isOpen ? 'open' : 'closed'}`}>
      
      <div className="sidebar-header">
        <h2 
            onClick={handleHomeClick} 
            className="sidebar-home-icon"
            title="Go to Home Feed"
        >
            <HomeIcon/>
        </h2>
        <div className="sidebar-actions">
            {isSessionLocked && (
                <button
                    onClick={() => setIsUnlockOpen(true)}
                    className="icon-button sidebar-action-btn sidebar-lock-btn"
                    title="Session Locked (Read-Only). Click to Unlock."
                >
                    🔒
                </button>
            )}
            <button 
                onClick={() => setIsSettingsOpen(true)}
                className="icon-button sidebar-action-btn"
                title="Settings"
            >
                <SettingsIcon />
            </button>
        </div>
      </div>

      <InfoItem label="Display Name">
          <span 
            onClick={() => { onViewProfile(peerId); onClose(); }}
            className="sidebar-link"
            title="Go to my profile"
          >
            {sanitizeText(userState?.profile.name) || "Anonymous"}
          </span>
      </InfoItem>
      
      <InfoItem label="My IPNS Key">
          <CopyableText value={peerId} />
      </InfoItem>

      <InfoItem label="Latest State CID">
          <CopyableText value={latestCid} />
      </InfoItem>
      
      {/* 1. Following List Section */}
      {userState && (
          <div className="sidebar-section">
              <h3>Following ({userState.follows.length})</h3>
              
              {userState.follows.length > 0 ? (
                  <ul className="peer-list">
                      {userState.follows.map(follow => {
                          // PRIORITY: 1. Live Cache, 2. Saved Snapshot, 3. Fallback
                          const cachedProfile = userProfilesMap.get(follow.ipnsKey);
                          let displayName = cachedProfile?.name;
                          
                          if (!displayName) {
                              displayName = follow.name;
                              if (!displayName || displayName === follow.ipnsKey) {
                                  displayName = follow.ipnsKey.substring(0, 8) + '...';
                              }
                          }
                          
                          return (
                            <li key={follow.ipnsKey}>
                                <div className="peer-item-content">
                                    <span 
                                        className="peer-name"
                                        onClick={() => { onViewProfile(follow.ipnsKey); onClose(); }}
                                        style={{ cursor: 'pointer', textDecoration: 'underline' }}
                                    >
                                        {sanitizeText(displayName)}
                                    </span>
                                    <CopyableText 
                                        value={follow.ipnsKey} 
                                        displayValue={follow.ipnsKey} 
                                        className="peer-key"
                                        title={follow.ipnsKey}
                                    />
                                </div>
                                <button 
                                    className="unfollow-button-small"
                                    onClick={() => onUnfollow(follow.ipnsKey)}
                                >
                                    Unfollow
                                </button>
                            </li>
                          );
                      })}
                  </ul>
              ) : (
                  <p className="sidebar-empty-msg">
                      You are not following anyone yet.
                  </p>
              )}

              <div className="sidebar-add-row">
                  <input
                      type="text"
                      placeholder="Add Key (k51...)"
                      value={manualFollowKey}
                      onChange={(e) => setManualFollowKey(e.target.value)}
                      className="sidebar-add-input"
                  />
                  <button
                      onClick={handleManualFollow}
                      disabled={!manualFollowKey.trim() || isAdding}
                      className="follow-button-small sidebar-add-btn"
                      title="Follow this IPNS Key"
                  >
                      {isAdding ? '...' : '+'}
                  </button>
              </div>
          </div>
      )}

      {unresolvedFollows.length > 0 && (
          <div className="info-item" style={{ borderColor: 'orange', marginTop: '1rem' }}>
              <strong>Resolving Follows...</strong>
              <code>{unresolvedFollows.length} pending</code>
          </div>
      )}

      {/* 2. Online Peers Section */}
      <div className="sidebar-section">
         <h3>Online Peers ({otherUsers.length})</h3>
         <ul className="peer-list">
             {otherUsers.map(user => {
                 const isFollowing = userState?.follows.some(f => f.ipnsKey === user.ipnsKey);
                 return (
                     <li key={user.ipnsKey}>
                          <div className="peer-item-content">
                            <span 
                                className="peer-name" 
                                onClick={() => { onViewProfile(user.ipnsKey); onClose(); }}
                                style={{ cursor: 'pointer', textDecoration: 'underline' }}
                            >
                                {sanitizeText(user.name) || user.ipnsKey.substring(0,8) + '...'}
                            </span>
                            {user.ipnsKey ? (
                                <CopyableText 
                                    value={user.ipnsKey}
                                    displayValue={user.ipnsKey}
                                    className="peer-key"
                                    title={user.ipnsKey}
                                />
                             ) : (
                                 <span className="peer-key">ID Unavailable</span>
                             )}
                          </div>
                          
                          {userState && user.ipnsKey && (
                              isFollowing ? (
                                <button 
                                    className="unfollow-button-small" 
                                    onClick={() => onUnfollow(user.ipnsKey)} 
                                >
                                    Unfollow
                                </button>
                              ) : (
                                <button 
                                    className="follow-button-small" 
                                    onClick={() => onFollow(user.ipnsKey)} 
                                >
                                    Follow
                                </button>
                              )
                          )}
                     </li>
                 );
             })}
             {otherUsers.length === 0 && <li className="sidebar-empty-list-item"><small>No other users found online.</small></li>}
         </ul>

        <div className="sidebar-logout-container">
          <button onClick={onLogout} className="new-post-button sidebar-logout-btn">Logout</button>
        </div>
      </div>
    </div>
    
    <Suspense fallback={null}>
        {isSettingsOpen && (
            <SettingsDialog 
                isOpen={isSettingsOpen} 
                onClose={() => setIsSettingsOpen(false)} 
            />
        )}
        
        {isUnlockOpen && (
            <UnlockSessionDialog
                isOpen={isUnlockOpen}
                onClose={() => setIsUnlockOpen(false)}
                onUnlock={unlockSession}
                onLogout={() => { setIsUnlockOpen(false); onLogout(); }}
            />
        )}
    </Suspense>
    </>
  );
};

export default Sidebar;