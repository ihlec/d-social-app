// src/api/peers.ts
import { OnlinePeer } from '../types';

// --- API Calls ---
const PEERS_API_URL = "https://crnls.uber.space/online-peers";
const API_KEY = "thisstringisonlyheretopreventrandomwebsnifferspollingtheapiifsomeonewantstopolltheapihecan";


export async function fetchOnlinePeers(myIpnsKey: string, myName: string): Promise<OnlinePeer[]> {
    if (!myIpnsKey || !myName) {
        console.warn("Cannot fetch online peers without IPNS key and name.");
        return [];
    }
    try {
        const response = await fetch(`${PEERS_API_URL}/?ipnsKey=${encodeURIComponent(myIpnsKey)}&name=${encodeURIComponent(myName)}`, {
            method: "GET",
            headers: {
                "X-API-Key": API_KEY,
            },
        });

        if (!response.ok) {
            throw new Error(`Server responded with status ${response.status}`);
        }

        const data = await response.json();
        // Add basic type validation
        if (Array.isArray(data?.otherUsers)) {
             return data.otherUsers.filter((user: any): user is OnlinePeer =>
                 typeof user?.ipnsKey === 'string' && typeof user?.name === 'string'
             );
        }
        return [];
    } catch (error) {
        console.error("Failed to fetch other users:", error);
        return []; // Return empty array on error
    }
}