import React, { useState, useEffect, useCallback } from 'react';
import {
    DEFAULT_NOSTR_RELAYS,
    BOOTSTRAP_ROOM_STORAGE_KEY,
} from '../constants';
import { isBootstrapRoomEnabled } from '../lib/peerShards';
import {
    formatBytes,
    getStorageEstimate,
    requestPersistentStorage,
    type StorageEstimate,
} from '../lib/storageQuota';
import { useAppState } from '../state/useAppStorage';

interface SettingsDialogProps {
    isOpen: boolean;
    onClose: () => void;
}

const DEFAULT_RELAYS = DEFAULT_NOSTR_RELAYS.join(',');

const SettingsDialog: React.FC<SettingsDialogProps> = ({ isOpen, onClose }) => {
    const { clearMediaCache, isLoggedIn } = useAppState();
    const [channels, setChannels] = useState('');
    const [relays, setRelays] = useState('');
    const [turnServers, setTurnServers] = useState('');
    const [bootstrapRoom, setBootstrapRoom] = useState(true);
    const [storageEst, setStorageEst] = useState<StorageEstimate | null>(null);
    const [storageBusy, setStorageBusy] = useState(false);

    const refreshStorage = useCallback(async () => {
        setStorageEst(await getStorageEstimate());
    }, []);

    useEffect(() => {
        if (!isOpen) return;
        setChannels(localStorage.getItem('custom_channels') || '');
        setRelays(localStorage.getItem('custom_nostr_relays') || DEFAULT_RELAYS);
        const storedTurn = localStorage.getItem('custom_turn_servers');
        setTurnServers(storedTurn === null ? '' : storedTurn);
        setBootstrapRoom(isBootstrapRoomEnabled());
        void refreshStorage();
    }, [isOpen, refreshStorage]);

    const handleSave = () => {
        localStorage.setItem('custom_channels', channels);
        localStorage.setItem('custom_nostr_relays', relays);
        if (bootstrapRoom) {
            localStorage.removeItem(BOOTSTRAP_ROOM_STORAGE_KEY);
        } else {
            localStorage.setItem(BOOTSTRAP_ROOM_STORAGE_KEY, '0');
        }
        const turnTrim = turnServers.trim();
        if (!turnTrim) {
            localStorage.removeItem('custom_turn_servers');
        } else if (turnTrim === '[]' || turnTrim === 'off') {
            localStorage.setItem('custom_turn_servers', '');
        } else {
            try {
                JSON.parse(turnTrim);
                localStorage.setItem('custom_turn_servers', turnTrim);
            } catch {
                alert('TURN servers must be valid JSON, or leave blank for defaults.');
                return;
            }
        }
        if (confirm('Settings saved. Reload to apply network changes?')) {
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

                <div className="form-group" style={{ marginTop: '1rem' }}>
                    <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', cursor: 'pointer' }}>
                        <input
                            type="checkbox"
                            checked={bootstrapRoom}
                            onChange={e => setBootstrapRoom(e.target.checked)}
                            style={{ marginTop: '0.2rem' }}
                        />
                        <span>Public bootstrap room</span>
                    </label>
                    <small className="settings-hint">Find other people on this app without following them.</small>
                </div>

                <div className="form-group" style={{ marginTop: '1.25rem' }}>
                    <label>Storage</label>
                    {storageEst ? (
                        <p style={{ margin: '0.35rem 0', fontSize: '0.95rem' }}>
                            {formatBytes(storageEst.usage)} / {formatBytes(storageEst.quota)}
                            {' · '}{formatBytes(storageEst.remaining)} free
                            {storageEst.persisted ? ' · persistent' : ''}
                        </p>
                    ) : (
                        <p style={{ margin: '0.35rem 0', color: '#888' }}>Estimate unavailable.</p>
                    )}
                    {storageEst && storageEst.remaining < 16 * 1024 * 1024 && (
                        <p style={{ margin: '0.35rem 0', color: 'var(--danger-color, #c44)', fontSize: '0.9rem' }}>
                            Low space — clear unused media before large uploads.
                        </p>
                    )}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.75rem' }}>
                        <button
                            type="button"
                            className="cancel-button"
                            disabled={storageBusy}
                            onClick={() => void refreshStorage()}
                        >
                            Refresh
                        </button>
                        <button
                            type="button"
                            className="cancel-button"
                            disabled={storageBusy || !isLoggedIn}
                            onClick={async () => {
                                setStorageBusy(true);
                                try {
                                    await clearMediaCache();
                                    await refreshStorage();
                                } finally {
                                    setStorageBusy(false);
                                }
                            }}
                        >
                            Clear unused media
                        </button>
                        <button
                            type="button"
                            className="cancel-button"
                            disabled={storageBusy || storageEst?.persisted}
                            onClick={async () => {
                                setStorageBusy(true);
                                try {
                                    await requestPersistentStorage();
                                    await refreshStorage();
                                } finally {
                                    setStorageBusy(false);
                                }
                            }}
                        >
                            Request persistent storage
                        </button>
                    </div>
                </div>

                <details className="settings-advanced">
                    <summary>Network</summary>
                    <div className="form-group">
                        <label>Nostr relays</label>
                        <textarea
                            rows={2}
                            value={relays}
                            onChange={e => setRelays(e.target.value)}
                            placeholder={DEFAULT_RELAYS}
                        />
                    </div>
                    <div className="form-group" style={{ marginTop: '1rem' }}>
                        <label>TURN (optional)</label>
                        <textarea
                            rows={2}
                            value={turnServers}
                            onChange={e => setTurnServers(e.target.value)}
                            placeholder='Blank = defaults. [] or "off" = disable.'
                        />
                    </div>
                    <div className="form-group" style={{ marginTop: '1rem' }}>
                        <label>Extra channels</label>
                        <input
                            type="text"
                            value={channels}
                            onChange={e => setChannels(e.target.value)}
                            placeholder="my-club, local-meetup"
                        />
                    </div>
                </details>

                <div className="settings-actions">
                    <button onClick={onClose} className="cancel-button">Cancel</button>
                    <button onClick={handleSave} className="save-button">Save & Reload</button>
                </div>
            </div>
        </div>
    );
};

export default SettingsDialog;
