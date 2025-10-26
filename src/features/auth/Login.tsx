import React, { useState } from 'react';
import { Tooltip } from '../../components/Tooltip';
import { InfoIcon } from '../../components/Icons';

interface LoginProps {
    // --- REMOVED: onLoginFilebase ---
    // onLoginFilebase: (nameLabel: string, bucketCredential?: string) => Promise<void>;
    onLoginKubo: (apiUrl: string, keyName: string) => Promise<void>;
}

const Login: React.FC<LoginProps> = ({ onLoginKubo }) => {
    // --- REMOVED: loginMethod state ---
    // const [loginMethod, setLoginMethod] = useState<'filebase' | 'kubo'>('filebase');
    const [isLoading, setIsLoading] = useState(false);

    const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setIsLoading(true);
        const formData = new FormData(event.currentTarget);
        try {
            // --- REMOVED: if/else logic for loginMethod ---
            const apiUrl = formData.get('apiUrl') as string;
            const keyName = formData.get('keyName') as string;
            await onLoginKubo(apiUrl, keyName);
        } catch (error) { console.error("Login submission error:", error); }
        finally { setIsLoading(false); }
    };

    return (
        <div className="login-container">
            <h1>D. Social App</h1>
            {/* --- REMOVED: Login method selector --- */}
            {/* <div className="feed-selector login-method-selector"> ... </div> */}

            {/* --- REMOVED: Conditional rendering and Filebase form --- */}
            
            {/* --- KEPT: Kubo form (no longer in an 'else' block) --- */}
            <>
                <form onSubmit={handleSubmit}>
                    <div className="input-with-tooltip-container">
                        <input type="text" name="apiUrl" defaultValue="http://127.0.0.1:5001" placeholder="Kubo RPC API URL" required disabled={isLoading} />
                        <Tooltip text={<span> <h3>Local node API.</h3> Enter your local Kubo RPC API details. Typically <b>http://127.0.0.1:5001</b>. </span>}>
                            <InfoIcon />
                        </Tooltip>
                    </div>
                    <div className="input-with-tooltip-container">
                        <input type="text" name="keyName" placeholder="IPNS Key Name (e.g., 'self')" required disabled={isLoading} />
                        <Tooltip text={<span> <h3>IPNS key name.</h3> See <code>ipfs key list</code>. </span>}>
                            <InfoIcon />
                        </Tooltip>
                    </div>
                    <button type="submit" disabled={isLoading}>{isLoading ? 'Logging in...' : 'Login'}</button>
                </form>
            </>
        </div>
    );
};

export default Login;
