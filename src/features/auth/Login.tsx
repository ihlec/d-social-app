// fileName: src/features/auth/Login.tsx
import React, { useState } from 'react';
import { Tooltip } from '../../components/Tooltip';
import { InfoIcon } from '../../components/Icons';

interface LoginProps {
    onLoginHelia: (keyName: string, passphrase?: string) => Promise<void>;
}

const Login: React.FC<LoginProps> = ({ onLoginHelia }) => {
    const [isLoading, setIsLoading] = useState(false);
    const [showPassphrase, setShowPassphrase] = useState(false);

    const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setIsLoading(true);
        const formData = new FormData(event.currentTarget);
        
        try {
            const keyName = (formData.get('keyName') as string)?.trim();
            const passphrase = (formData.get('passphrase') as string) || undefined;

            if (!keyName) {
                alert("Identity name is required.");
                setIsLoading(false);
                return;
            }

            await onLoginHelia(keyName, passphrase);
        } catch (error) {
            console.error("Login failed", error);
            setIsLoading(false);
        }
    };

    return (
        <div className="login-container">
            <h1>Welcome to dSocial</h1>
            <p style={{ color: '#888', margin: '1rem 0' }}>
                Sign in with a browser identity. Your key lives in this device’s Helia keychain — no local Kubo node required.
            </p>
            
            <form onSubmit={handleSubmit} className="login-form">
                <div className="input-with-tooltip-container">
                    <input 
                        type="text" 
                        name="keyName" 
                        placeholder="Identity name (e.g. alice)" 
                        className="login-input"
                        disabled={isLoading}
                        autoFocus
                    />
                     <Tooltip text={<span>A label for your IPNS key in this browser. Reuse the same name on this device to open the same identity. New names create a fresh profile.</span>}>
                        <InfoIcon />
                    </Tooltip>
                </div>

                {showPassphrase && (
                    <div className="login-credentials-section">
                        <div className="input-with-tooltip-container" style={{ marginTop: '1rem' }}>
                            <input 
                                type="password" 
                                name="passphrase" 
                                placeholder="Keychain passphrase (optional)" 
                                className="login-input"
                                disabled={isLoading} 
                            />
                            <Tooltip text={<span>Optional passphrase that encrypts your Helia keychain on this device. Leave empty for the default. You will need the same passphrase after a refresh to post.</span>}>
                                <InfoIcon />
                            </Tooltip>
                        </div>
                    </div>
                )}

                <button
                    type="button"
                    onClick={() => setShowPassphrase(!showPassphrase)}
                    disabled={isLoading}
                    className="toggle-credentials-button"
                >
                    {showPassphrase ? 'Hide Passphrase' : 'Add Passphrase (optional)'}
                </button>

                <button type="submit" disabled={isLoading} className="login-button">
                    {isLoading ? 'Starting Helia...' : 'Enter'}
                </button>
            </form>
        </div>
    );
};

export default Login;
