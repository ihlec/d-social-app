import React, { useState, useEffect, useRef, Suspense, lazy } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { UserState, OnlinePeer } from '../types';
import { useAppState } from '../state/useAppStorage';
import { SettingsIcon, HomeIcon, LockIcon } from './Icons';
import { sanitizeText, shortId, parseFollowTarget } from '../lib/utils';
import './Sidebar.css';

const SettingsDialog = lazy(() => import('./SettingsDialog'));
const UnlockSessionDialog = lazy(() => import('./UnlockSessionDialog'));

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
  onFollow: (ipnsKey: string, opts?: { name?: string; stateCid?: string }) => Promise<void>;
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
  const [showIdentity, setShowIdentity] = useState(false);
  const [manualFollowKey, setManualFollowKey] = useState('');
  const [isAdding, setIsAdding] = useState(false);

  const attemptedAutoFetch = useRef<Set<string>>(new Set());

  useEffect(() => {
      if (!userState || !isOpen) return;

      userState.follows.forEach(follow => {
          if (!userProfilesMap.has(follow.ipnsKey) && !attemptedAutoFetch.current.has(follow.ipnsKey)) {
              attemptedAutoFetch.current.add(follow.ipnsKey);
              fetchUser(follow.ipnsKey);
          }
      });
  }, [isOpen, userState, userProfilesMap, fetchUser]);


  const handleManualFollow = async () => {
      const target = parseFollowTarget(manualFollowKey);
      if (!target) return;
      setIsAdding(true);
      try {
          await onFollow(target);
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
                    title="Session locked (read-only). Click to unlock."
                >
                    <LockIcon />
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

      <details
        className="sidebar-advanced"
        open={showIdentity}
        onToggle={(e) => setShowIdentity((e.target as HTMLDetailsElement).open)}
      >
        <summary>Identity &amp; debug</summary>
        <p className="sidebar-advanced-hint">
          Your keys and content stay in this browser. Peers sync over WebRTC when online.
        </p>
        <InfoItem label="My ID (copy to share / follow)">
          <CopyableText value={peerId} displayValue={shortId(peerId)} title={peerId} />
        </InfoItem>
        <InfoItem label="Latest tip (debug)">
          <CopyableText value={latestCid} displayValue={shortId(latestCid)} title={latestCid} />
        </InfoItem>
      </details>
      
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

                          if (!displayName || displayName.startsWith('k51')) {
                              displayName = follow.name;
                              if (!displayName || displayName === follow.ipnsKey || displayName.startsWith('k51')) {
                                  displayName = shortId(follow.ipnsKey);
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
                                        displayValue={shortId(follow.ipnsKey)} 
                                        className="peer-key"
                                        title={`Copy ID: ${follow.ipnsKey}`}
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

              <div className={`sidebar-add-row ${otherUsers.length === 0 ? 'sidebar-add-row--emphasize' : ''}`}>
                  <input
                      type="text"
                      placeholder="Paste ID or profile link"
                      value={manualFollowKey}
                      onChange={(e) => setManualFollowKey(e.target.value)}
                      className="sidebar-add-input"
                      data-testid="follow-id-input"
                  />
                  <button
                      onClick={handleManualFollow}
                      disabled={!manualFollowKey.trim() || isAdding}
                      className="follow-button-small sidebar-add-btn"
                      title="Follow this person"
                      data-testid="follow-id-submit"
                  >
                      {isAdding ? '...' : '+'}
                  </button>
              </div>
              {otherUsers.length === 0 && (
                  <p className="sidebar-bootstrap-hint">
                      No peers online yet — paste someone’s ID to follow and sync.
                  </p>
              )}
          </div>
      )}

      {unresolvedFollows.length > 0 && (
          <div className="info-item" style={{ borderColor: 'orange', marginTop: '1rem' }}>
              <strong>Waiting for peers…</strong>
              <code>{unresolvedFollows.length} pending</code>
              <small style={{ display: 'block', color: '#888', marginTop: '0.35rem', fontSize: '0.75rem' }}>
                  No tip yet. Online follows sync over WebRTC when they appear.
              </small>
          </div>
      )}

      {/* 2. Online Peers Section */}
      <div className="sidebar-section">
         <h3>Online Peers ({otherUsers.length})</h3>
         <ul className="peer-list">
             {otherUsers.map(user => {
                 const isFollowing = userState?.follows?.some(f => f.ipnsKey === user.ipnsKey) ?? false;
                 return (
                     <li key={user.ipnsKey}>
                          <div className="peer-item-content">
                            <span 
                                className="peer-name" 
                                onClick={() => { onViewProfile(user.ipnsKey); onClose(); }}
                                style={{ cursor: 'pointer', textDecoration: 'underline' }}
                            >
                                {sanitizeText(user.name) || shortId(user.ipnsKey)}
                            </span>
                            {user.ipnsKey ? (
                                <CopyableText 
                                    value={user.ipnsKey}
                                    displayValue={shortId(user.ipnsKey)}
                                    className="peer-key"
                                    title={`Copy ID: ${user.ipnsKey}`}
                                />
                             ) : (
                                 <span className="peer-key">ID Unavailable</span>
                             )}
                          </div>
                          
                          {userState && user.ipnsKey && (
                              isFollowing ? (
                                <button 
                                    type="button"
                                    className="unfollow-button-small" 
                                    onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        void onUnfollow(user.ipnsKey);
                                    }}
                                >
                                    Unfollow
                                </button>
                              ) : (
                                <button 
                                    type="button"
                                    className="follow-button-small" 
                                    onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        void onFollow(user.ipnsKey, {
                                            name: user.name,
                                            stateCid: user.stateCid,
                                        });
                                    }}
                                >
                                    Follow
                                </button>
                              )
                          )}
                     </li>
                 );
             })}
             {otherUsers.length === 0 && (
                 <li className="sidebar-empty-list-item">
                     <small>Looking for peers…</small>
                     <small className="sidebar-mesh-hint">
                         Peers sync over WebRTC when online. Paste an ID above to bootstrap if the mesh is quiet.
                     </small>
                 </li>
             )}
         </ul>

        <div className="sidebar-logout-container">
          <button type="button" onClick={onLogout} className="sidebar-logout-btn" data-testid="logout-button">
            Logout
          </button>
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