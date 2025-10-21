// src/components/Layout/Sidebar.tsx
import React, { useState } from 'react';
import { UserState, Follow, OnlinePeer } from '../types';

interface InfoItemProps {
  label: string;
  value: string;
}

const InfoItem: React.FC<InfoItemProps> = ({ label, value }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    if (!value) return;
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="info-item">
      <strong>{label}</strong>
      <code onClick={handleCopy} title={value ? "Click to copy" : ""} style={{ cursor: value ? 'pointer' : 'default' }}>
        {value || 'N/A'}
        {copied && <span className="copy-feedback">Copied!</span>}
      </code>
    </div>
  );
};

interface SidebarProps {
  isOpen: boolean;
  userState: UserState | null;
  ipnsKey: string; 
  latestCid: string;
  unresolvedFollows: string[];
   otherUsers: OnlinePeer[];
  onFollow: (ipnsKey: string) => Promise<void>;
  onUnfollow: (ipnsKey: string) => Promise<void>;
  onViewProfile: (ipnsKey: string) => void;
  onLogout: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  isOpen,
  userState,
  ipnsKey, 
  latestCid,
  unresolvedFollows,
  otherUsers,
  onFollow,
  onUnfollow,
  onViewProfile,
  onLogout,
}) => {
  const [followInput, setFollowInput] = useState('');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleFollowSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (followInput.trim()) {
      onFollow(followInput.trim());
      setFollowInput('');
    }
  };

   const handleCopyKey = (key: string) => {
        if (!key) return;
        navigator.clipboard.writeText(key);
        setCopiedKey(key);
        setTimeout(() => setCopiedKey(null), 2000);
    };

    // Get the display name/label (might be Kubo key name or Filebase label)
    const displayName = userState?.profile?.name || localStorage.getItem("currentUserLabel") || 'Loading...';

  return (
    <div className={`sidebar ${isOpen ? 'open' : ''}`}>
      <div className="sidebar-content">
        <h2>Profile Info</h2>
         <div className="info-item">
             <strong>Your Name / Label</strong>
             <span
                 className="user-name"
                 style={{cursor: 'pointer'}}
                 onClick={() => ipnsKey && onViewProfile(ipnsKey)}
                 title="View your profile"
             >
                {displayName} {/* Display the name/label here */}
             </span>
        </div>
        <InfoItem label="Your IPNS Key (Peer ID)" value={ipnsKey} />
        <InfoItem label="Latest State CID" value={latestCid} />

        <h2>Follow a User</h2>
        <form onSubmit={handleFollowSubmit} className="follow-form">
          <input type="text" value={followInput} onChange={(e) => setFollowInput(e.target.value)} placeholder="Enter IPNS Key (Peer ID)"/>
          <button type="submit">Follow</button>
        </form>

        <h2>Following ({userState?.follows?.length || 0})</h2>
        <ul className="followed-users-list">
          {userState?.follows?.map((follow: Follow, index: number) => {
              if (!follow?.ipnsKey) return null; 
              const isUnresolved = unresolvedFollows.includes(follow.ipnsKey);
              return (
                 <li key={follow.ipnsKey || `follow-${index}`} className={isUnresolved ? 'unresolved' : ''}>
                     <div className="user-details">
                         <span className="user-name" onClick={() => onViewProfile(follow.ipnsKey)} title={isUnresolved ? "Unresolved" : `View ${follow.name || 'user'}'s profile`}>
                            {follow.name || 'Unknown User'} {isUnresolved ? '(?)': ''}
                         </span>
                         <span className="user-key" title={follow.ipnsKey} onClick={() => handleCopyKey(follow.ipnsKey)}>
                            {`${follow.ipnsKey.substring(0, 8)}...`}
                             {copiedKey === follow.ipnsKey && <span className="copy-feedback-inline">Copied!</span>}
                        </span>
                     </div>
                    <button className="unfollow-button" onClick={() => onUnfollow(follow.ipnsKey)}>Unfollow</button>
                 </li>
              );
            })}
          {(!userState?.follows || userState.follows.length === 0) && <li style={{ background: 'none', paddingLeft: '0' }}><small>Not following anyone yet.</small></li>}
        </ul>

         <h2>Other Users Online</h2>
         <ul className="followed-users-list">
             {otherUsers.map((user: OnlinePeer) => (
                 <li key={user.ipnsKey}>
                      <div className="user-details">
                         <span className="user-name" onClick={() => user.ipnsKey && onViewProfile(user.ipnsKey)} title={`View ${user.name}'s profile`}>{user.name}</span>
                         <span className="user-key" title={user.ipnsKey} onClick={() => handleCopyKey(user.ipnsKey)}>
                             {`${user.ipnsKey.substring(0, 8)}...`}
                             {copiedKey === user.ipnsKey && <span className="copy-feedback-inline">Copied!</span>}
                         </span>
                      </div>
                 </li>
             ))}
             {otherUsers.length === 0 && <li style={{ background: 'none', paddingLeft: '0' }}><small>No other users found online.</small></li>}
         </ul>

        <div className="info-item" style={{ marginTop: '2rem' }}>
          <button onClick={onLogout} className="new-post-button">Logout</button>
        </div>
      </div>
    </div>
  );
};

export default Sidebar;