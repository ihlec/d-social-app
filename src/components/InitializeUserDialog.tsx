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

  return (
    <div className="expanded-post-backdrop dialog-backdrop">
      <div 
        className="expanded-post-container dialog-container" 
        onClick={(e) => e.stopPropagation()} 
      >
        <h2>User State Not Found</h2>
        <p className="dialog-message">
          We could not find an existing user state for this profile.
          
          This might be a temporary network issue, or this profile may not have been initialized yet.
        </p>
        <div className="dialog-buttons">
          <button 
            onClick={onRetry} 
            className="dialog-btn-retry" 
          >
            Retry
          </button>
          <button 
            onClick={onInitialize} 
            className="dialog-btn-init"
          >
            Initialize New Profile
          </button>
        </div>
      </div>
    </div>
  );
};

export default InitializeUserDialog;