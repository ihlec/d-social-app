// fileName: src/components/SettingsDialog.tsx
import React, { useState, useEffect } from 'react';
import { PUBLIC_CONTENT_GATEWAYS, PUBLIC_IPNS_GATEWAYS } from '../constants';

interface SettingsDialogProps {
    isOpen: boolean;
    onClose: () => void;
}

// Default values to fallback to if localStorage is empty
const DEFAULT_GATEWAYS = PUBLIC_CONTENT_GATEWAYS.join(',');
const DEFAULT_IPNS_GATEWAYS = PUBLIC_IPNS_GATEWAYS.join(',');
const DEFAULT_CHANNELS = "d-social-general";

const SettingsDialog: React.FC<SettingsDialogProps> = ({ isOpen, onClose }) => {
    const [gateways, setGateways] = useState('');
    const [ipnsGateways, setIpnsGateways] = useState('');
    const [channels, setChannels] = useState('');

    // Load from LocalStorage on open
    useEffect(() => {
        if (isOpen) {
            setGateways(localStorage.getItem('custom_gateways') || DEFAULT_GATEWAYS);
            setIpnsGateways(localStorage.getItem('custom_ipns_gateways') || DEFAULT_IPNS_GATEWAYS);
            setChannels(localStorage.getItem('custom_channels') || DEFAULT_CHANNELS);
        }
    }, [isOpen]);

    const handleSave = () => {
        localStorage.setItem('custom_gateways', gateways);
        localStorage.setItem('custom_ipns_gateways', ipnsGateways);
        localStorage.setItem('custom_channels', channels);
        // Force a reload to apply network changes safely
        if (confirm("Settings saved. The app needs to reload to apply network changes. Reload now?")) {
            window.location.reload();
        } else {
            onClose();
        }
    };

    if (!isOpen) return null;

    return (
        <div className="settings-backdrop" onClick={onClose}>
            <div className="settings-container" onClick={e => e.stopPropagation()}>
                <h3 style={{ marginTop: 0 }}>App Settings</h3>
                
                <div className="form-group">
                    <label>IPFS Content Gateways (comma separated)</label>
                    <textarea 
                        rows={3}
                        value={gateways}
                        onChange={e => setGateways(e.target.value)}
                        placeholder="https://ipfs.io/ipfs/, ..."
                    />
                    <small style={{ display: 'block', color: '#888', marginTop: '0.25rem' }}>
                        For fetching images, videos, and post data. Supports <code>{'{cid}'}</code> subdomain pattern.
                    </small>
                </div>

                <div className="form-group" style={{ marginTop: '1rem' }}>
                    <label>IPNS Resolution Gateways (comma separated)</label>
                    <textarea 
                        rows={2}
                        value={ipnsGateways}
                        onChange={e => setIpnsGateways(e.target.value)}
                        placeholder="https://ipfs.io/ipns/, ..."
                    />
                    <small style={{ display: 'block', color: '#888', marginTop: '0.25rem' }}>
                        For resolving user profiles and updates.
                    </small>
                </div>

                <div className="form-group" style={{ marginTop: '1.5rem' }}>
                    <label>PubSub Channels (comma separated)</label>
                    <input 
                        type="text"
                        value={channels}
                        onChange={e => setChannels(e.target.value)}
                        placeholder="d-social-v1, ..."
                    />
                    <small style={{ display: 'block', color: '#888', marginTop: '0.25rem' }}>
                        Channels to listen on for peer discovery.
                    </small>
                </div>

                <div className="settings-actions">
                    <button onClick={onClose} className="cancel-button">Cancel</button>
                    <button onClick={handleSave} className="save-button">Save & Reload</button>
                </div>
            </div>
        </div>
    );
};

export default SettingsDialog;