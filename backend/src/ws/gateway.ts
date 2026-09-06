import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { URL } from 'url';
import { redisClient } from '../config/redis';
import { query } from '../config/db';
import { verifyToken } from '../middleware/auth';

// BUILD_SPEC §13.3 — a live ticker; a full outbound queue should drop the
// newest tick rather than block the fan-out loop or grow unbounded.
const MAX_PENDING_SENDS = 256;
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 60_000;
// Connection setup needs the user's instruments, and a reconnecting client
// asks for the same answer over and over. Keeping it in Redis for a moment
// means a reconnect loop costs a cache read instead of a Postgres round trip
// — the difference between a nuisance and a self-inflicted outage.
const USER_INSTRUMENTS_TTL_SEC = 30;

async function userInstruments(userId: string): Promise<string[]> {
    const cacheKey = `ws:instruments:${userId}`;
    const cached = await redisClient.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const result = await query(
        `SELECT DISTINCT wi.instrument_id
         FROM watchlist_items wi
         JOIN watchlists w ON w.id = wi.watchlist_id
         WHERE w.user_id = $1`,
        [userId]
    );
    const ids = result.rows.map(r => r.instrument_id);
    await redisClient.setEx(cacheKey, USER_INSTRUMENTS_TTL_SEC, JSON.stringify(ids));
    return ids;
}

interface ConnState {
    subscribed: Set<string>;
    pendingSends: number;
    lastPongAt: number;
}

export function setupWebSocketGateway(server: Server) {
    const wss = new WebSocketServer({ server, path: '/ws' });
    const connState = new WeakMap<WebSocket, ConnState>();

    // Refcounted shared Redis subscription per instrument — one upstream
    // subscription regardless of how many client connections want that tick.
    const instrumentRefcounts = new Map<string, number>();
    const subscriber = redisClient.duplicate();
    subscriber.on('error', (e: any) => console.error('WS Redis subscriber error', e));
    subscriber.connect().catch(console.error);

    const handleMessage = (message: string, channel: string) => {
        const instrumentId = channel.slice('tick:'.length);
        wss.clients.forEach(client => {
            if (client.readyState !== WebSocket.OPEN) return;
            const state = connState.get(client);
            if (!state || !state.subscribed.has(instrumentId)) return;

            if (state.pendingSends >= MAX_PENDING_SENDS) return; // drop — see §13.3 above

            state.pendingSends++;
            client.send(JSON.stringify({ type: 'tick', quote: JSON.parse(message) }), () => {
                state.pendingSends--;
            });
        });
    };

    async function addSubscriptions(state: ConnState, instrumentIds: string[]) {
        for (const iid of instrumentIds) {
            if (state.subscribed.has(iid)) continue;
            state.subscribed.add(iid);
            const count = instrumentRefcounts.get(iid) || 0;
            if (count === 0) {
                await subscriber.subscribe(`tick:${iid}`, handleMessage);
            }
            instrumentRefcounts.set(iid, count + 1);
        }
    }

    async function removeSubscriptions(state: ConnState, instrumentIds: string[]) {
        for (const iid of instrumentIds) {
            if (!state.subscribed.has(iid)) continue;
            state.subscribed.delete(iid);
            const count = instrumentRefcounts.get(iid) || 0;
            if (count <= 1) {
                instrumentRefcounts.delete(iid);
                await subscriber.unsubscribe(`tick:${iid}`, handleMessage);
            } else {
                instrumentRefcounts.set(iid, count - 1);
            }
        }
    }

    wss.on('connection', async (ws: WebSocket, request) => {
        const url = new URL(request.url || '', 'http://internal');
        const token = url.searchParams.get('token');
        const claims = token ? verifyToken(token) : null;

        if (!claims) {
            ws.close(4401, 'Unauthorized');
            return;
        }
        const userId = claims.sub;

        const state: ConnState = { subscribed: new Set(), pendingSends: 0, lastPongAt: Date.now() };
        connState.set(ws, state);

        try {
            await addSubscriptions(state, await userInstruments(userId));
        } catch (e) {
            console.error('WS connection setup failed:', (e as Error).message);
            ws.close(4500, 'Server error');
            return;
        }

        const heartbeat = setInterval(() => {
            if (Date.now() - state.lastPongAt > PONG_TIMEOUT_MS) {
                ws.terminate();
                return;
            }
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'ping' }));
            }
        }, PING_INTERVAL_MS);

        ws.on('message', async raw => {
            let parsed: any;
            try {
                parsed = JSON.parse(raw.toString());
            } catch {
                return;
            }

            if (parsed.type === 'pong') {
                state.lastPongAt = Date.now();
            } else if (parsed.type === 'subscribe' && Array.isArray(parsed.instrumentIds)) {
                await addSubscriptions(state, parsed.instrumentIds.map((s: string) => String(s).toUpperCase()));
            } else if (parsed.type === 'unsubscribe' && Array.isArray(parsed.instrumentIds)) {
                await removeSubscriptions(state, parsed.instrumentIds.map((s: string) => String(s).toUpperCase()));
            }
        });

        ws.on('close', async () => {
            clearInterval(heartbeat);
            await removeSubscriptions(state, Array.from(state.subscribed));
        });

        ws.on('error', e => console.error('WS client error', e));
    });

    return wss;
}
