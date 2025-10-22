// src/features/profile/ProfileHeader.tsx
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserProfile, Follow } from '../../types';
import { useAppState } from '../../state/useAppStorage';
import { ShareIcon } from '../../components/Icons'; 
import toast from 'react-hot-toast';

interface ProfileHeaderProps {
  profileKey: string; 
  profile: UserProfile | null;
  isMyProfile: boolean;
}

const ProfileHeader: React.FC<ProfileHeaderProps> = ({ profileKey, profile, isMyProfile }) => {
  const { userState, followUser, unfollowUser, isProcessing, updateProfile } = useAppState();
  const navigate = useNavigate();

  const [isEditingBio, setIsEditingBio] = useState(false);
  const [bioInput, setBioInput] = useState(profile?.bio || '');

  if (!profile) {
    return <div className="profile-header"><h2>Loading Profile...</h2></div>;
  }

  const isFollowing = userState?.follows?.some((f: Follow) => f.ipnsKey === profileKey) ?? false;

  const handleFollowClick = () => {
    if (!userState) {
      toast("Please log in to follow.", { icon: '🔒' });
      navigate('/login');
    } else {
      isFollowing ? unfollowUser(profileKey) : followUser(profileKey);
    }
  };

  const handleSaveBio = async () => {
    try {
      await updateProfile({ bio: bioInput });
      setIsEditingBio(false);
    } catch (error) {
      console.error("Failed to save bio:", error);
    }
  };

  const handleShareProfile = () => {
    const profileUrl = `${window.location.origin}${window.location.pathname}#/profile/${profileKey}`;
    navigator.clipboard.writeText(profileUrl)
      .then(() => toast.success("Profile link copied!"))
      .catch(() => toast.error("Failed to copy link."));
  };

  return (
    <div className="profile-header">
      <h2>
        {profile.name}
        {/* --- FIX: Button moved from here --- */}
      </h2>

      {isEditingBio ? (
        <div className="bio-editor">
          <textarea
            value={bioInput}
            onChange={(e) => setBioInput(e.target.value)}
            rows={3}
            maxLength={160} 
            placeholder="Tell us about yourself..."
          />
          <div className="bio-editor-actions">
            <button onClick={handleSaveBio} disabled={isProcessing}>
              {isProcessing ? 'Saving...' : 'Save'}
            </button>
            <button onClick={() => setIsEditingBio(false)} disabled={isProcessing}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <p>
          {profile.bio || (isMyProfile ? <i>No bio provided. Click edit to add one.</i> : 'No bio provided.')}
          
          {/* Edit button (only for my profile) */}
          {isMyProfile && !isEditingBio && (
            <button
              className="edit-bio-button"
              onClick={() => {
                setBioInput(profile.bio || '');
                setIsEditingBio(true);
              }}
            >
              Edit
            </button>
          )}

          {/* --- FIX: Follow/Unfollow Button moved here --- */}
          {!isMyProfile && (
            <button
              className="edit-bio-button" // Use same class as Edit for positioning
              onClick={handleFollowClick}
              disabled={isProcessing}
            >
              {isProcessing ? '...' : (isFollowing ? 'Unfollow' : 'Follow')}
            </button>
          )}
          {/* --- End Fix --- */}
        </p>
      )}
       <button onClick={handleShareProfile} className="share-profile-button" title="Share Profile">
           <ShareIcon />
       </button>
    </div>
  );
};

export default ProfileHeader;