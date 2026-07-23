import React, { useState, useEffect, useCallback } from 'react';
import {
    PUBLIC_CONTENT_GATEWAYS,
    PUBLIC_IPNS_GATEWAYS,
    DEFAULT_NOSTR_RELAYS,
    PEER_TOPIC_PREFIX_V2,
    NUM_SHARDS,
    LEGACY_PEER_BRIDGE_STORAGE_KEY,
} from '../constants';
import { isLegacyPeerBridgeEnabled } from '../lib/peerShards';
import {
    isGatewayFallbackEnabled,
    setGatewayFallbackEnabled,
} from '../lib/gatewayFallback';
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

// Default values to fallback to if localStorage is empty
const DEFAULT_GATEWAYS = PUBLIC_CONTENT_GATEWAYS.join(',');
const DEFAULT_IPNS_GATEWAYS = PUBLIC_IPNS_GATEWAYS.join(',');
const DEFAULT_RELAYS = DEFAULT_NOSTR_RELAYS.join(',');

const SettingsDialog: React.FC<SettingsDialogProps> = ({ isOpen, onClose }) => {
    const { clearMediaCache, isLoggedIn } = useAppState();
    const [gateways, setGateways] = useState('');
    const [ipnsGateways, setIpnsGateways] = useState('');
    const [channels, setChannels] = useState('');
    const [relays, setRelays] = useState('');
    const [turnServers, setTurnServers] = useState('');
    const [legacyBridge, setLegacyBridge] = useState(false);
    const [gatewayFallback, setGatewayFallback] = useState(false);
    const [storageEst, setStorageEst] = useState<StorageEstimate | null>(null);
    const [storageBusy, setStorageBusy] = useState(false);

    const refreshStorage = useCallback(async () => {
        setStorageEst(await getStorageEstimate());
    }, []);

    // Load from LocalStorage on open
    useEffect(() => {
        if (isOpen) {
            setGateways(localStorage.getItem('custom_gateways') || DEFAULT_GATEWAYS);
            setIpnsGateways(localStorage.getItem('custom_ipns_gateways') || DEFAULT_IPNS_GATEWAYS);
            setChannels(localStorage.getItem('custom_channels') || '');
            setRelays(localStorage.getItem('custom_nostr_relays') || DEFAULT_RELAYS);
            // null → built-in Open Relay; '' → disable TURN; JSON → custom
            const storedTurn = localStorage.getItem('custom_turn_servers');
            setTurnServers(storedTurn === null ? '' : storedTurn);
            setLegacyBridge(isLegacyPeerBridgeEnabled());
            setGatewayFallback(isGatewayFallbackEnabled());
            void refreshStorage();
        }
    }, [isOpen, refreshStorage]);

    const handleSave = () => {
        localStorage.setItem('custom_gateways', gateways);
        localStorage.setItem('custom_ipns_gateways', ipnsGateways);
        localStorage.setItem('custom_channels', channels);
        localStorage.setItem('custom_nostr_relays', relays);
        setGatewayFallbackEnabled(gatewayFallback);
        if (legacyBridge) {
            localStorage.setItem(LEGACY_PEER_BRIDGE_STORAGE_KEY, '1');
        } else {
            localStorage.removeItem(LEGACY_PEER_BRIDGE_STORAGE_KEY);
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
                alert('TURN servers must be valid JSON (RTCIceServer array), or leave blank for defaults.');
                return;
            }
        }
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

                <p className="settings-arch-hint">
                    <strong>Helia</strong> holds your identity and local content.
                    <strong> Trystero</strong> syncs tips, posts, and media with online peers.
                    Public IPFS gateways are <strong>off by default</strong> — opt in under Advanced if you want a cold fallback.
                </p>

                <div className="form-group" style={{ marginTop: '1rem' }}>
                    <label>Nostr signaling relays (comma separated)</label>
                    <textarea
                        rows={3}
                        value={relays}
                        onChange={e => setRelays(e.target.value)}
                        placeholder={DEFAULT_RELAYS}
                    />
                    <small style={{ display: 'block', color: '#888', marginTop: '0.25rem' }}>
                        Trystero uses these for WebRTC signaling only — data stays peer-to-peer.
                        Prefer a mix of public and community-run relays; there is no required central operator.
                    </small>
                </div>

                <div className="form-group" style={{ marginTop: '1.5rem' }}>
                    <label>TURN servers (JSON, optional)</label>
                    <textarea
                        rows={3}
                        value={turnServers}
                        onChange={e => setTurnServers(e.target.value)}
                        placeholder='Leave blank for Open Relay defaults. Use [] or "off" to disable. Example: [{"urls":["turn:host:3478"],"username":"u","credential":"p"}]'
                    />
                    <small style={{ display: 'block', color: '#888', marginTop: '0.25rem' }}>
                        Needed when WebRTC ICE fails after SDP exchange (symmetric NAT / CGNAT).
                        Blank uses public Open Relay; data is still end-to-end encrypted.
                    </small>
                </div>

                <div className="form-group" style={{ marginTop: '1.5rem' }}>
                    <label>Extra affinity channels (comma separated, optional)</label>
                    <input 
                        type="text"
                        value={channels}
                        onChange={e => setChannels(e.target.value)}
                        placeholder="my-club, local-meetup, ..."
                    />
                    <small style={{ display: 'block', color: '#888', marginTop: '0.25rem' }}>
                        Optional Trystero rooms beyond automatic shards (
                        <code>{PEER_TOPIC_PREFIX_V2}/0…{NUM_SHARDS - 1}</code>
                        ) and follow-circle rooms. Use for interest groups — not a global directory.
                    </small>
                </div>

                <div className="form-group" style={{ marginTop: '1.5rem' }}>
                    <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', cursor: 'pointer' }}>
                        <input
                            type="checkbox"
                            checked={legacyBridge}
                            onChange={e => setLegacyBridge(e.target.checked)}
                            style={{ marginTop: '0.2rem' }}
                        />
                        <span>Join legacy global peer room (migration only)</span>
                    </label>
                    <small style={{ display: 'block', color: '#888', marginTop: '0.25rem' }}>
                        Off by default. Enables <code>dsocial-peers-v1</code> — a single full-mesh room that
                        cannot scale toward 100k online users. Use only for short-term migration or local debugging;
                        prefer follow-circle / on-demand home-shard sync instead.
                    </small>
                </div>

                <div className="form-group" style={{ marginTop: '1.5rem' }}>
                    <label>Helia browser storage</label>
                    {storageEst ? (
                        <p style={{ margin: '0.35rem 0', fontSize: '0.95rem' }}>
                            {formatBytes(storageEst.usage)} used of {formatBytes(storageEst.quota)}
                            {' '}({(storageEst.usageRatio * 100).toFixed(1)}%)
                            {' · '}{formatBytes(storageEst.remaining)} free
                            {storageEst.persisted ? ' · persistent' : ' · best-effort'}
                        </p>
                    ) : (
                        <p style={{ margin: '0.35rem 0', color: '#888' }}>Storage estimate unavailable.</p>
                    )}
                    {storageEst && storageEst.remaining < 16 * 1024 * 1024 && (
                        <p style={{ margin: '0.35rem 0', color: 'var(--danger-color, #c44)', fontSize: '0.9rem' }}>
                            Low free space — uploads need ~file size + 2 MB. Use Clear unused media (may reset the Helia media store; identity stays).
                        </p>
                    )}
                    <small style={{ display: 'block', color: '#888', marginTop: '0.25rem' }}>
                        Pin policy: your posts keep full media; likes pin thumbnails only; use Save on a post to pin full video.
                        Clear unused media sweeps orphans; if Firefox still reports &lt;16 MB free it deletes the Helia media IndexedDB
                        (keeps identity keys). Each browser has its own quota (Firefox ≠ Vivaldi). Hard-reload after Vite HMR if upload still fails.
                    </small>
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
                    <summary>Advanced: public gateways (fallback)</summary>
                    <p className="settings-advanced-hint">
                        Off by default. When enabled, used only after local Helia and peer sync miss.
                        Browser-only publishes usually fail here (429 / CORS / 504) — prefer being online with a peer who has the content.
                    </p>
                    <div className="form-group">
                        <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', cursor: 'pointer' }}>
                            <input
                                type="checkbox"
                                checked={gatewayFallback}
                                onChange={e => setGatewayFallback(e.target.checked)}
                                style={{ marginTop: '0.2rem' }}
                            />
                            <span>Enable public gateway fallback</span>
                        </label>
                        <small style={{ display: 'block', color: '#888', marginTop: '0.25rem' }}>
                            Opt-in only. Leave off for Helia + Trystero-only fetches (recommended for share links).
                        </small>
                    </div>
                    <div className="form-group" style={{ marginTop: '1rem', opacity: gatewayFallback ? 1 : 0.5 }}>
                        <label>Content gateways (comma separated)</label>
                        <textarea 
                            rows={3}
                            value={gateways}
                            onChange={e => setGateways(e.target.value)}
                            placeholder="https://ipfs.io/ipfs/, ..."
                        />
                        <small style={{ display: 'block', color: '#888', marginTop: '0.25rem' }}>
                            Cold fetch for images, videos, and post JSON. Supports <code>{'{cid}'}</code> subdomain pattern.
                        </small>
                    </div>
                    <div className="form-group" style={{ marginTop: '1rem', opacity: gatewayFallback ? 1 : 0.5 }}>
                        <label>Name resolution gateways (comma separated)</label>
                        <textarea 
                            rows={2}
                            value={ipnsGateways}
                            onChange={e => setIpnsGateways(e.target.value)}
                            placeholder="https://ipfs.io/ipns/, ..."
                        />
                        <small style={{ display: 'block', color: '#888', marginTop: '0.25rem' }}>
                            Offline peers only — online follows sync tips over WebRTC instead.
                        </small>
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
