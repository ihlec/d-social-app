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
                Sign in with a browser identity. Your key lives in this device’s local storage — sync with peers over Trystero.
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
                        data-testid="login-identity"
                    />
                     <Tooltip text={<span>A label for your identity on this device. Reuse the same name here to open the same profile. New names create a fresh identity.</span>}>
                        <InfoIcon />
                    </Tooltip>
                </div>

                {showPassphrase && (
                    <div className="login-credentials-section">
                        <div className="input-with-tooltip-container" style={{ marginTop: '1rem' }}>
                            <input 
                                type="password" 
                                name="passphrase" 
                                placeholder="Identity passphrase (optional)" 
                                className="login-input"
                                disabled={isLoading} 
                            />
                            <Tooltip text={<span>Optional passphrase that encrypts your private key on this device. Leave empty to store unencrypted. You will need the same passphrase after a refresh if you set one.</span>}>
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

                <button type="submit" disabled={isLoading} className="login-button" data-testid="login-enter">
                    {isLoading ? 'Starting…' : 'Enter'}
                </button>
            </form>
        </div>
    );
};

export default Login;
