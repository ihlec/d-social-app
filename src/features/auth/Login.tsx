import React, { useState } from 'react';
import { Tooltip } from '../../components/Tooltip';
import { InfoIcon } from '../../components/Icons';

interface LoginProps {
    // --- REMOVED: onLoginFilebase ---
    // onLoginFilebase: (nameLabel: string, bucketCredential?: string) => Promise<void>;
    onLoginKubo: (apiUrl: string, keyName: string, username?: string, password?: string) => Promise<void>;
}

const Login: React.FC<LoginProps> = ({ onLoginKubo }) => {
    // --- REMOVED: loginMethod state ---
    // const [loginMethod, setLoginMethod] = useState<'filebase' | 'kubo'>('kubo'); // Default to Kubo
    const [isLoading, setIsLoading] = useState(false);
    // --- ADDED: State for credential visibility ---
    const [showCredentials, setShowCredentials] = useState(false);
    // --- END ADD ---

    const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setIsLoading(true);
        const formData = new FormData(event.currentTarget);
        try {
            // --- REMOVED: Filebase logic ---
            const apiUrl = formData.get('apiUrl') as string;
            const keyName = formData.get('keyName') as string;
            // --- ADDED: Get optional credentials ---
            const username = formData.get('username') as string || undefined;
            const password = formData.get('password') as string || undefined;
            // --- END ADD ---
            await onLoginKubo(apiUrl, keyName, username, password); // Pass credentials
        } catch (error) { console.error("Login submission error:", error); }
        finally { setIsLoading(false); }
    };

    return (
        <div className="login-container">
            <h1>D. Social App</h1>
            {/* --- REMOVED: Method selector --- */}
            {/*
            <div className="feed-selector login-method-selector">
                <button className={loginMethod === 'filebase' ? 'active' : ''} onClick={() => setLoginMethod('filebase')} disabled={isLoading}>Login with Filebase</button>
                <button className={loginMethod === 'kubo' ? 'active' : ''} onClick={() => setLoginMethod('kubo')} disabled={isLoading}>Login with Local Node</button>
            </div>
            */}

            {/* --- REMOVED: Filebase form --- */}

            {/* --- Kubo Form --- */}
            <>
                <h2>Login with Kubo Node</h2>
                <form onSubmit={handleSubmit}>
                    <div className="input-with-tooltip-container">
                        <input type="text" name="apiUrl" defaultValue="http://127.0.0.1:5001" placeholder="Kubo RPC API URL" required disabled={isLoading} />
                        <Tooltip text={<span> <h3>Kubo Node API URL.</h3> Enter your Kubo RPC API details. Typically <b>http://127.0.0.1:5001</b> for local nodes. For remote nodes, ensure CORS is configured correctly. </span>}>
                            <InfoIcon />
                        </Tooltip>
                    </div>
                    <div className="input-with-tooltip-container">
                        <input type="text" name="keyName" placeholder="IPNS Key Name (e.g., 'my-profile')" required disabled={isLoading} />
                        <Tooltip text={<span> <h3>IPNS key name.</h3> This is the name used to manage your profile key within Kubo. See <code>ipfs key list</code>. If it doesn't exist, it will be created.</span>}>
                            <InfoIcon />
                        </Tooltip>
                    </div>

                    {/* --- ADDED: Conditional Credential Fields --- */}
                    {showCredentials && (
                        <>
                            <div className="input-with-tooltip-container">
                                <input type="text" name="username" placeholder="Username (optional)" disabled={isLoading} />
                                <Tooltip text={<span>Optional username for Kubo RPC API basic authentication.</span>}>
                                    <InfoIcon />
                                </Tooltip>
                            </div>
                            <div className="input-with-tooltip-container">
                                <input type="password" name="password" placeholder="Password (optional)" disabled={isLoading} />
                                <Tooltip text={<span>Optional password for Kubo RPC API basic authentication.</span>}>
                                    <InfoIcon />
                                </Tooltip>
                            </div>
                        </>
                    )}
                    {/* --- END ADD --- */}

                    {/* --- ADDED: Toggle Button --- */}
                    <button
                        type="button"
                        onClick={() => setShowCredentials(!showCredentials)}
                        disabled={isLoading}
                        style={{ background: 'none', border: '1px solid var(--border-color)', color: 'var(--text-secondary-color)', marginTop: '0.5rem', marginBottom: '0.5rem', fontSize: '0.9em' }}
                    >
                        {showCredentials ? 'Hide Credentials' : 'Show Credentials (Optional)'}
                    </button>
                    {/* --- END ADD --- */}

                    <button type="submit" disabled={isLoading}>{isLoading ? 'Logging in...' : 'Login / Register'}</button>
                </form>
            </>

        </div>
    );
};

export default Login;

