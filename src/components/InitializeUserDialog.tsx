// fileName: src/components/InitializeUserDialog.tsx
import React from 'react';

interface InitializeUserDialogProps {
  isOpen: boolean;
  onInitialize: () => void;
  onRetry: () => void;
}

/**
 * A modal dialog shown when a user's state cannot be found on login.
 * Offers the user the choice to retry fetching or initialize a new profile.
 */
const InitializeUserDialog: React.FC<InitializeUserDialogProps> = ({ isOpen, onInitialize, onRetry }) => {
  if (!isOpen) {
    return null;
  }

  // Reuse styles from expanded-post-backdrop and expanded-post-container
  // Add a high z-index to ensure it's on top of everything.
  return (
    <div className="expanded-post-backdrop" style={{ zIndex: 3000, backgroundColor: 'rgba(0, 0, 0, 0.9)' }}>
      <div 
        className="expanded-post-container" 
        style={{ maxWidth: '500px', padding: '1.5rem', textAlign: 'left', cursor: 'default' }}
        onClick={(e) => e.stopPropagation()} // Prevent closing on inner click
      >
        <h2>User State Not Found</h2>
        <p style={{ color: 'var(--text-secondary-color)', margin: '1rem 0', whiteSpace: 'pre-wrap', lineHeight: '1.6' }}>
          We could not find an existing user state for this profile.
          
          This might be a temporary network issue, or this profile may not have been initialized yet.
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1.5rem' }}>
          <button 
            onClick={onRetry} 
            className="back-to-feed-button" // Reuse style
            style={{ margin: 0, padding: '.6em 1.2em' }} // Match button padding
          >
            Retry
          </button>
          <button 
            onClick={onInitialize} 
            style={{ backgroundColor: '#c44' }} // Use a distinct "warning" color
          >
            Initialize New Profile
          </button>
        </div>
      </div>
    </div>
  );
};

export default InitializeUserDialog;