// fileName: src/features/auth/Login.tsx
import React, { useState } from 'react';
import { Tooltip } from '../../components/Tooltip';
import { InfoIcon } from '../../components/Icons';

interface LoginProps {
    onLoginKubo: (apiUrl: string, keyName: string, username?: string, password?: string) => Promise<void>;
}

const Login: React.FC<LoginProps> = ({ onLoginKubo }) => {
    const [isLoading, setIsLoading] = useState(false);
    const [showCredentials, setShowCredentials] = useState(false);

    const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setIsLoading(true);
        const formData = new FormData(event.currentTarget);
        
        try {
            const apiUrl = formData.get('apiUrl') as string;
            const keyName = formData.get('keyName') as string;
            const username = formData.get('username') as string || undefined;
            const password = formData.get('password') as string || undefined;

            if (!apiUrl || !keyName) {
                alert("API URL and Key Name are required.");
                setIsLoading(false);
                return;
            }

            await onLoginKubo(apiUrl, keyName, username, password);
        } catch (error) {
            console.error("Login failed", error);
            setIsLoading(false);
        }
    };

    return (
        <div className="login-container">
            <h1>Welcome to dSocial</h1>
            <p style={{ color: '#888', margin: '1rem 0' }}>Connect to your local Kubo node to enter the decentralized social graph.</p>
            
            <form onSubmit={handleSubmit} className="login-form">
                
                {/* 1. API URL Input with Tooltip */}
                <div className="input-with-tooltip-container">
                    <input 
                        type="text" 
                        name="apiUrl" 
                        placeholder="RPC API URL (e.g., http://127.0.0.1:5001)" 
                        defaultValue="http://127.0.0.1:5001"
                        className="login-input"
                        disabled={isLoading}
                    />
                    <Tooltip text={
                        <div style={{ textAlign: 'left' }}>
                            <strong>Required CORS Config:</strong><br/>
                            <code>ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '["*"]'</code><br/><br/>

                            <code>ipfs config --json API.HTTPHeaders.Access-Control-Allow-Methods '["POST", "GET"]'</code><br/><br/>

                            <code>ipfs config --json Pubsub.Enabled true</code><br/><br/>

                            <code>ipfs config --json Ipns.UsePubsub true</code>
                        </div>
                    }>
                        <InfoIcon />
                    </Tooltip>
                </div>
                
                {/* 2. Key Name Input */}
                <div className="input-with-tooltip-container">
                    <input 
                        type="text" 
                        name="keyName" 
                        placeholder="IPNS Key Name (Identity)" 
                        className="login-input"
                        disabled={isLoading}
                    />
                     <Tooltip text={<span>The name of the key in your Kubo node (e.g., 'self' or 'my-identity'). If it doesn't exist, it will be generated.</span>}>
                        <InfoIcon />
                    </Tooltip>
                </div>

                {/* 3. Advanced Credentials */}
                {showCredentials && (
                    <div className="login-credentials-section">
                        <div className="input-with-tooltip-container" style={{ marginTop: '1rem' }}>
                            <input 
                                type="text" 
                                name="username" 
                                placeholder="Username (optional)" 
                                className="login-input"
                                disabled={isLoading} 
                            />
                             <Tooltip text={<span>Optional username for Kubo RPC API basic authentication.</span>}>
                                <InfoIcon />
                            </Tooltip>
                        </div>
                        <div className="input-with-tooltip-container" style={{ marginTop: '0.5rem' }}>
                            <input 
                                type="password" 
                                name="password" 
                                placeholder="Password (optional)" 
                                className="login-input"
                                disabled={isLoading} 
                            />
                            <Tooltip text={<span>Optional password for Kubo RPC API basic authentication.</span>}>
                                <InfoIcon />
                            </Tooltip>
                        </div>
                    </div>
                )}

                <button
                    type="button"
                    onClick={() => setShowCredentials(!showCredentials)}
                    disabled={isLoading}
                    className="toggle-credentials-button"
                >
                    {showCredentials ? 'Hide Advanced Credentials' : 'Show Advanced Credentials'}
                </button>

                <button type="submit" disabled={isLoading} className="login-button">
                    {isLoading ? 'Connecting...' : 'Connect'}
                </button>
            </form>
        </div>
    );
};

export default Login;