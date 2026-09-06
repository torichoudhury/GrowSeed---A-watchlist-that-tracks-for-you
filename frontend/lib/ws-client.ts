/**
 * Live tick client (BUILD_SPEC §13/§14.4). Authenticates with the JWT in the
 * query string, answers the server's application-level pings, and reconnects
 * with exponential backoff (1s → 30s). The app must work fully with this
 * disabled — the summary query's 30s refetch is the fallback.
 */
export interface TickMessage {
    type: 'tick';
    quote: {
        instrumentId: string;
        lastPricePaise: number;
        previousClosePaise: number;
        volume: number;
        dataTimestamp: string;
    };
}

export class WSClient {
    private ws: WebSocket | null = null;
    private reconnectAttempts = 0;
    private readonly maxReconnectDelay = 30_000;
    private readonly baseDelay = 1_000;
    // A backoff that resets the moment the socket opens is not a backoff: a
    // server that accepts the handshake and then closes it (ours does exactly
    // that when its own setup fails) becomes a 1-second reconnect loop, and
    // every attempt costs the server a database round trip. Only a connection
    // that has STAYED up counts as healthy enough to reset the backoff.
    private readonly stableAfterMs = 10_000;
    private stableTimer: ReturnType<typeof setTimeout> | null = null;
    private stopped = false;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    public onTick: (tick: TickMessage) => void = () => {};
    public onStatus: (connected: boolean) => void = () => {};

    constructor(private readonly url: string, private readonly getToken: () => string | null) {}

    connect() {
        this.stopped = false;
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
        const token = this.getToken();
        if (!token) return;

        const ws = new WebSocket(`${this.url}?token=${encodeURIComponent(token)}`);
        this.ws = ws;

        ws.onopen = () => {
            this.onStatus(true);
            if (this.stableTimer) clearTimeout(this.stableTimer);
            this.stableTimer = setTimeout(() => { this.reconnectAttempts = 0; }, this.stableAfterMs);
        };

        ws.onmessage = event => {
            let data: unknown;
            try { data = JSON.parse(event.data); } catch { return; }
            if (typeof data !== 'object' || data === null) return;
            const type = (data as { type?: unknown }).type;
            if (type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
            } else if (type === 'tick') {
                this.onTick(data as TickMessage);
            }
        };

        ws.onclose = () => {
            this.onStatus(false);
            if (this.stableTimer) { clearTimeout(this.stableTimer); this.stableTimer = null; }
            if (!this.stopped) this.scheduleReconnect();
        };

        ws.onerror = () => {
            // onclose follows; the reconnect logic lives there.
        };
    }

    subscribe(instrumentIds: string[]) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'subscribe', instrumentIds }));
        }
    }

    private scheduleReconnect() {
        // Full jitter, so many tabs recovering from one server blip don't
        // arrive together and re-create the storm they are recovering from.
        const ceiling = Math.min(this.baseDelay * 2 ** this.reconnectAttempts, this.maxReconnectDelay);
        const delay = ceiling / 2 + Math.random() * (ceiling / 2);
        this.reconnectAttempts++;
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
    }

    disconnect() {
        this.stopped = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.stableTimer) { clearTimeout(this.stableTimer); this.stableTimer = null; }
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
            this.ws = null;
        }
        this.onStatus(false);
    }
}
