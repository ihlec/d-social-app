import React, { useState } from 'react';
import { UserProfile } from '../types';
import { useAppState } from '../hooks/useAppState';
import { ShareIcon } from '../../src2/components/Icons'; 
import toast from 'react-hot-toast';

interface ProfileHeaderProps {
  profileKey: string; 
  profile: UserProfile | null;
  isMyProfile: boolean;
}

const ProfileHeader: React.FC<ProfileHeaderProps> = ({ profileKey, profile, isMyProfile }) => {
  const { updateProfile, isProcessing } = useAppState();
  const [isEditingBio, setIsEditingBio] = useState(false);
  const [bioInput, setBioInput] = useState(profile?.bio || '');

  if (!profile) {
    return <div className="profile-header"><h2>Loading Profile...</h2></div>;
  }

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
      <h2>{profile.name}</h2>
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
        </p>
      )}
       <button onClick={handleShareProfile} className="share-profile-button" title="Share Profile">
           <ShareIcon />
       </button>
    </div>
  );
};

export default ProfileHeader;