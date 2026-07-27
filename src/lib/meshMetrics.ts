/**
 * Optional mesh debug metrics for verifying 100k-scale room budgets.
 * Enable: localStorage.dsocial_debug_mesh = '1' or ?debugMesh=1
 */

import { DEBUG_MESH_STORAGE_KEY } from '../constants';

export type MeshMetricsSnapshot = {
    enabled: boolean;
    roomsJoined: number;
    roomsLeft: number;
    presenceReceived: number;
    syncOk: number;
    syncFail: number;
    joinErrors: number;
    stickyRooms: number;
    mappedPeers: number;
    peersByTopic: Record<string, number>;
    stickyTopics: string[];
    /** Active `dsocial-cid/<cid>` rooms (guest/share rendezvous). */
    contentTopics: string[];
    /** Active time-sliced meetup lobbies (`dsocial-meetup/<n>`). */
    meetupTopics: string[];
    ts: number;
};

type MeshGauges = {
    stickyRooms: number;
    mappedPeers: number;
    peersByTopic: Record<string, number>;
    stickyTopics: string[];
    contentTopics: string[];
    meetupTopics: string[];
};

const counters = {
    roomsJoined: 0,
    roomsLeft: 0,
    presenceReceived: 0,
    syncOk: 0,
    syncFail: 0,
    joinErrors: 0,
};

let gauges: MeshGauges = {
    stickyRooms: 0,
    mappedPeers: 0,
    peersByTopic: {},
    stickyTopics: [],
    contentTopics: [],
    meetupTopics: [],
};

let enabled = false;
let logTimer: ReturnType<typeof setInterval> | null = null;
const LOG_INTERVAL_MS = 30000;

declare global {
    interface Window {
        __dsocialMesh?: MeshMetricsSnapshot;
    }
}

export function isMeshDebugEnabled(): boolean {
    return enabled;
}

/** Call once at boot — honors ?debugMesh=1 and persists to localStorage. */
export function initMeshDebugFromUrl(): void {
    try {
        if (typeof window === 'undefined') return;
        const params = new URLSearchParams(window.location.search);
        if (params.get('debugMesh') === '1') {
            localStorage.setItem(DEBUG_MESH_STORAGE_KEY, '1');
        }
        enabled = localStorage.getItem(DEBUG_MESH_STORAGE_KEY) === '1';
        if (enabled) startMeshDebugLogging();
    } catch {
        enabled = false;
    }
}

export function setMeshDebugEnabled(on: boolean): void {
    enabled = on;
    try {
        if (on) localStorage.setItem(DEBUG_MESH_STORAGE_KEY, '1');
        else localStorage.removeItem(DEBUG_MESH_STORAGE_KEY);
    } catch { /* ignore */ }
    if (on) startMeshDebugLogging();
    else stopMeshDebugLogging();
}

function startMeshDebugLogging(): void {
    if (logTimer || typeof window === 'undefined') return;
    publishSnapshot();
    logTimer = setInterval(() => {
        const snap = publishSnapshot();
        console.info('[MeshMetrics]', snap);
    }, LOG_INTERVAL_MS);
    console.info('[MeshMetrics] enabled — inspect window.__dsocialMesh');
}

function stopMeshDebugLogging(): void {
    if (logTimer) {
        clearInterval(logTimer);
        logTimer = null;
    }
    try {
        if (typeof window !== 'undefined') delete window.__dsocialMesh;
    } catch { /* ignore */ }
}

export function bumpRoomsJoined(): void {
    if (!enabled) return;
    counters.roomsJoined += 1;
}

export function bumpRoomsLeft(): void {
    if (!enabled) return;
    counters.roomsLeft += 1;
}

export function bumpPresenceReceived(): void {
    if (!enabled) return;
    counters.presenceReceived += 1;
}

export function bumpSyncOk(): void {
    if (!enabled) return;
    counters.syncOk += 1;
}

export function bumpSyncFail(): void {
    if (!enabled) return;
    counters.syncFail += 1;
}

export function bumpJoinError(): void {
    if (!enabled) return;
    counters.joinErrors += 1;
}

export function updateMeshGauges(next: MeshGauges): void {
    gauges = next;
    if (enabled) publishSnapshot();
}

export function getMeshMetricsSnapshot(): MeshMetricsSnapshot {
    return {
        enabled,
        ...counters,
        stickyRooms: gauges.stickyRooms,
        mappedPeers: gauges.mappedPeers,
        peersByTopic: { ...gauges.peersByTopic },
        stickyTopics: [...gauges.stickyTopics],
        contentTopics: [...gauges.contentTopics],
        meetupTopics: [...(gauges.meetupTopics || [])],
        ts: Date.now(),
    };
}

function publishSnapshot(): MeshMetricsSnapshot {
    const snap = getMeshMetricsSnapshot();
    try {
        if (typeof window !== 'undefined') window.__dsocialMesh = snap;
    } catch { /* ignore */ }
    return snap;
}
