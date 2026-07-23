import React, { useState } from 'react';

interface UnlockSessionDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onUnlock: (password: string) => Promise<boolean>;
    onLogout: () => void;
}

const UnlockSessionDialog: React.FC<UnlockSessionDialogProps> = ({ 
    isOpen, 
    onClose, 
    onUnlock,
    onLogout 
}) => {
    const [password, setPassword] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    if (!isOpen) return null;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsLoading(true);
        try {
            const success = await onUnlock(password);
            if (success) {
                setPassword('');
                onClose();
            }
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="settings-backdrop" onClick={onClose}>
            <div className="settings-container" onClick={e => e.stopPropagation()} style={{ maxWidth: '400px' }}>
                <h3 style={{ marginTop: 0 }}>Unlock session</h3>
                
                <p style={{ color: '#ccc', fontSize: '0.9rem', marginBottom: '1.5rem' }}>
                    Enter your keychain passphrase to post and update after a page reload.
                </p>

                <form onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label>Keychain passphrase</label>
                        <input 
                            type="password"
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            placeholder="Enter passphrase..."
                            autoFocus
                        />
                    </div>

                    <div className="settings-actions" style={{ marginTop: '2rem' }}>
                        <button 
                            type="button" 
                            onClick={onLogout} 
                            className="cancel-button"
                            style={{ marginRight: 'auto' }} // Push to left
                        >
                            Logout
                        </button>
                        <button 
                            type="button" 
                            onClick={onClose} 
                            className="cancel-button"
                            disabled={isLoading}
                        >
                            Cancel
                        </button>
                        <button 
                            type="submit" 
                            className="save-button"
                            disabled={isLoading}
                        >
                            {isLoading ? 'Unlocking...' : 'Unlock'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default UnlockSessionDialog;