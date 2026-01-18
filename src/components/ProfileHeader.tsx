// fileName: src/features/profile/ProfileHeader.tsx
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserProfile, Follow } from '../types';
import { useAppState } from '../state/useAppStorage';
import { ShareIcon } from './Icons'; 
import { getShareBaseUrl, sanitizeText } from '../lib/utils';
import toast from 'react-hot-toast';

interface ProfileHeaderProps {
  profileKey: string; 
  profile: UserProfile | null;
  isMyProfile: boolean;
}

const ProfileHeader: React.FC<ProfileHeaderProps> = ({ profileKey, profile, isMyProfile }) => {
  const { userState, followUser, unfollowUser, blockUser, unblockUser, isProcessing, updateProfile } = useAppState();
  const navigate = useNavigate();

  const [isEditingBio, setIsEditingBio] = useState(false);
  const [bioInput, setBioInput] = useState(profile?.bio || '');

  if (!profile) {
    return <div className="profile-header"><h2>Loading Profile...</h2></div>;
  }

  const isFollowing = userState?.follows?.some((f: Follow) => f.ipnsKey === profileKey) ?? false;
  const isBlocked = userState?.blockedUsers?.includes(profileKey) ?? false;

  const handleFollowClick = async () => {
    if (!userState) {
      toast("Please log in to follow.", { icon: '🔒' });
      navigate('/login');
    } else {
      isFollowing ? await unfollowUser(profileKey) : await followUser(profileKey);
    }
  };

  const handleBlockClick = async () => {
    if (!userState) return;
    if (confirm(isBlocked ? "Unblock this user?" : "Block this user? They won't be able to see you and you won't see them.")) {
        isBlocked ? await unblockUser(profileKey) : await blockUser(profileKey);
    }
  };

  const handleSaveBio = async () => {
    try {
      await updateProfile({ bio: bioInput });
      setIsEditingBio(false);
    } catch (error) {
      console.error("Failed to save bio", error);
      toast.error("Failed to save bio");
    }
  };

  const handleShareProfile = () => {
      const baseUrl = getShareBaseUrl();
      const url = `${baseUrl}/#/profile/${profileKey}`;
      navigator.clipboard.writeText(url);
      toast.success('Profile URL copied!');
  };

  return (
    <div className="profile-header">
      <h2>{sanitizeText(profile.name) || "Anonymous"}</h2>
      
      {isEditingBio ? (
        <div style={{ marginTop: '1rem' }}>
          <textarea
            value={bioInput}
            onChange={(e) => setBioInput(e.target.value)}
            className="edit-bio-textarea"
            placeholder="Tell the world about yourself..."
            autoFocus
          />
          <div className="bio-editor-actions">
            <button onClick={handleSaveBio} disabled={isProcessing} className="save-btn">
              {isProcessing ? 'Saving...' : 'Save'}
            </button>
            <button onClick={() => setIsEditingBio(false)} disabled={isProcessing} className="cancel-btn">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <p>
          {sanitizeText(profile.bio) || (isMyProfile ? <i>No bio provided. Click edit to add one.</i> : 'No bio provided.')}
          
          {/* Edit button (only for my profile) */}
          {isMyProfile && (
            <button
              className="edit-bio-button"
              onClick={() => {
                setBioInput(profile.bio || '');
                setIsEditingBio(true);
              }}
              style={{ marginLeft: '10px' }} 
            >
              Edit
            </button>
          )}

          {!isMyProfile && (
            <>
                <button
                className="edit-bio-button" 
                onClick={handleFollowClick}
                disabled={isProcessing || isBlocked}
                style={{ marginLeft: '10px' }}
                >
                {isProcessing ? '...' : (isFollowing ? 'Unfollow' : 'Follow')}
                </button>
                
                <button
                    className="edit-bio-button"
                    onClick={handleBlockClick}
                    disabled={isProcessing}
                    style={{ marginLeft: '10px', background: isBlocked ? 'gray' : '#ff4444', borderColor: 'transparent' }}
                >
                    {isBlocked ? 'Unblock' : 'Block'}
                </button>
            </>
          )}
        </p>
      )}
      
       <button onClick={handleShareProfile} className="share-profile-button" title="Share Profile">
           <ShareIcon />
       </button>
    </div>
  );
};

export default ProfileHeader;