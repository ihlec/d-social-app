import { fetchKubo, toMultibase, getAuthHeaders, KuboAuth } from './kuboClient';

export async function publishToPubsub(apiUrl: string, topic: string, data: any, auth?: KuboAuth): Promise<void> {
    const serialized = JSON.stringify(data);
    const encodedTopic = toMultibase(topic); 
    const formData = new FormData();
    const blob = new Blob([serialized], { type: 'application/json' });
    formData.append('file', blob, 'data.json'); 
    await fetchKubo(apiUrl, '/api/v0/pubsub/pub', { arg: encodedTopic }, formData, auth);
}

export async function subscribeToPubsub(apiUrl: string, topic: string, onMessage: (msg: any) => void, abortSignal: AbortSignal, auth?: KuboAuth): Promise<void> {
    const encodedTopic = toMultibase(topic);
    const url = new URL(`${apiUrl}/api/v0/pubsub/sub`);
    url.searchParams.append('arg', encodedTopic);
    url.searchParams.append('discover', 'true');
    const headers = getAuthHeaders(auth); 

    try {
        const response = await fetch(url.toString(), { method: 'POST', headers, signal: abortSignal });
        if (!response.ok) throw new Error(`PubSub failed: ${response.status}`);
        if (!response.body) throw new Error('No body');

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try { 
                        const parsed = JSON.parse(line);
                        if (parsed && parsed.data) {
                            let base64 = parsed.data.startsWith('u') ? parsed.data.slice(1) : parsed.data;
                            base64 = base64.replace(/-/g, '+').replace(/_/g, '/');
                            while (base64.length % 4) base64 += '=';
                            const jsonStr = new TextDecoder().decode(Uint8Array.from(atob(base64), c => c.charCodeAt(0)));
                            onMessage(JSON.parse(jsonStr));
                        }
                    } catch (e) { /* ignore */ }
                }
            }
        }
    } catch (e) {
        if (e instanceof Error && e.name !== 'AbortError') console.error("PubSub error:", e);
    }
}
