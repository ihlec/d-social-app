// src/lib/utils.ts
// Removed unused OptimisticStateCookie
import { OnlinePeer } from '../types';

// --- Cookie Utils ---

export function setCookie(name: string, value: string, days?: number): void {
  let expires = "";
  if (days) {
    const date = new Date();
    date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
    expires = "; expires=" + date.toUTCString();
  }
  // Ensure secure attributes if served over HTTPS in production
  const secureAttribute = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = name + "=" + (value || "") + expires + "; path=/; SameSite=Lax" + secureAttribute;
}

export function getCookie(name: string): string | null {
  const nameEQ = name + "=";
  const ca = document.cookie.split(';');
  for (let i = 0; i < ca.length; i++) {
    let c = ca[i];
    while (c.charAt(0) === ' ') c = c.substring(1, c.length);
    if (c.indexOf(nameEQ) === 0) return c.substring(nameEQ.length, c.length);
  }
  return null;
}

export function eraseCookie(name: string): void {
   // Ensure secure attributes if served over HTTPS in production
  const secureAttribute = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = name + '=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT; SameSite=Lax' + secureAttribute;
}

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


// --- Other Utils ---

export const formatTimestamp = (timestamp: number): string => {
    if (!timestamp || isNaN(timestamp)) return "Invalid date";
    try {
        return new Date(timestamp).toLocaleString();
    } catch (e) {
        return "Invalid date";
    }
}

// Placeholder: Invalidate IPNS cache (maps to original `zm()`) - implemented in ipfs.ts
// export const invalidateIpnsCache = () => { ... } ;