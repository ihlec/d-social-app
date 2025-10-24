import React, { useState } from 'react';
import { Tooltip } from '../../components/Tooltip';
import { InfoIcon } from '../../components/Icons';

interface LoginProps {
    onLoginFilebase: (nameLabel: string, bucketCredential?: string) => Promise<void>;
    onLoginKubo: (apiUrl: string, keyName: string) => Promise<void>;
}

const Login: React.FC<LoginProps> = ({ onLoginFilebase, onLoginKubo }) => {
    const [loginMethod, setLoginMethod] = useState<'filebase' | 'kubo'>('filebase');
    const [isLoading, setIsLoading] = useState(false);

    const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setIsLoading(true);
        const formData = new FormData(event.currentTarget);
        try {
            if (loginMethod === 'filebase') {
                const nameLabel = formData.get('nameLabel') as string;
                const bucketCredential = formData.get('bucketCredential') as string;
                await onLoginFilebase(nameLabel, bucketCredential);
            } else {
                const apiUrl = formData.get('apiUrl') as string;
                const keyName = formData.get('keyName') as string;
                await onLoginKubo(apiUrl, keyName);
            }
        } catch (error) { console.error("Login submission error:", error); }
        finally { setIsLoading(false); }
    };

    return (
        <div className="login-container">
            <h1>D. Social App</h1>
            <div className="feed-selector login-method-selector">
                <button className={loginMethod === 'filebase' ? 'active' : ''} onClick={() => setLoginMethod('filebase')} disabled={isLoading}>Login with Filebase</button>
                <button className={loginMethod === 'kubo' ? 'active' : ''} onClick={() => setLoginMethod('kubo')} disabled={isLoading}>Login with Local Node</button>
            </div>

            {loginMethod === 'filebase' ? (
                <>
                    <form onSubmit={handleSubmit}>
                        <div className="input-with-tooltip-container">
                            <input type="text" name="nameLabel" placeholder="Your IPNS Name Label" required disabled={isLoading} />
                            <Tooltip text={<span> Enter your Filebase IPNS Name and S3 Credentials. </span>}>
                                <InfoIcon />
                            </Tooltip>
                        </div>
                        <div className="input-with-tooltip-container">
                            {/* Fix: Updated placeholder and tooltip */}
                            <input type="password" name="bucketCredential" placeholder="Filebase S3 Credential (Key:Secret)" required disabled={isLoading} />
                            <Tooltip text={
                                <span>
                                    <h3>Your S3 Access Key ID and Secret.</h3>
                                    1. Go to the Filebase <a href="https://console.filebase.com/keys">Access Keys</a> page.<br /><br />
                                    2. Find or create an **S3 API Endpoint Key** (NOT the IPFS one).<br /><br />
                                    3. Enter the **Key** and **Secret** separated by a colon (e.g., `KEY:SECRET`).<br /><br />
                                    4. Ensure your <a href="https://console.filebase.com/buckets">Bucket</a>'s <a href="https://ipfs.io/ipfs/QmRe8rBXbs58UNyHRbxGNPtKRM5uS4BQgzpu2emkuXkmrJ/">CORS Config</a> is updated.
                                </span>
                            }>
                                <InfoIcon />
                            </Tooltip>
                        </div>
                        <button type="submit" disabled={isLoading}>{isLoading ? 'Logging in...' : 'Login'}</button>
                    </form>
                </>
            ) : (
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
            )}
        </div>
    );
};

export default Login;