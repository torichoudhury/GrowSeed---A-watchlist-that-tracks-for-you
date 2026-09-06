import { createClient, RedisClientType } from 'redis';
import dotenv from 'dotenv';
dotenv.config();

// ── In-memory fallback (used when no REDIS_URL is set) ─────────────────────
class MemoryStore {
    private store = new Map<string, { value: string; expiresAt: number | null }>();
    private subs = new Map<string, Set<(message: string, channel: string) => void>>();
    isOpen = true;

    async get(key: string): Promise<string | null> {
        const entry = this.store.get(key);
        if (!entry) return null;
        if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
            this.store.delete(key);
            return null;
        }
        return entry.value;
    }

    async mGet(keys: string[]): Promise<(string | null)[]> {
        return Promise.all(keys.map(k => this.get(k)));
    }

    async set(key: string, value: string, opts?: { NX?: boolean; PX?: number }): Promise<string | null> {
        if (opts?.NX && this.store.has(key)) return null;
        const expiresAt = opts?.PX ? Date.now() + opts.PX : null;
        this.store.set(key, { value, expiresAt });
        return 'OK';
    }

    async setEx(key: string, seconds: number, value: string): Promise<void> {
        this.store.set(key, { value, expiresAt: Date.now() + seconds * 1000 });
    }

    async del(key: string): Promise<void> {
        this.store.delete(key);
    }

    async publish(channel: string, message: string): Promise<void> {
        const handlers = this.subs.get(channel);
        if (handlers) handlers.forEach(h => h(message, channel));
    }

    duplicate(): MemoryStore { return this; } // single instance is fine

    connect(): Promise<void> { return Promise.resolve(); }

    on(_event: string, _handler: (...args: any[]) => void): this { return this; }

    async subscribe(channel: string, handler: (message: string, channel: string) => void): Promise<void> {
        if (!this.subs.has(channel)) this.subs.set(channel, new Set());
        this.subs.get(channel)!.add(handler);
    }

    async unsubscribe(channel: string, handler: (message: string, channel: string) => void): Promise<void> {
        this.subs.get(channel)?.delete(handler);
    }
}

// ── Export: real Redis if REDIS_URL is set, otherwise in-memory fallback ───
const useRealRedis = !!process.env.REDIS_URL;

let _client: any;

if (useRealRedis) {
    let url = process.env.REDIS_URL || '';
    if (url.startsWith('redis://') && url.includes('upstash.io')) {
        url = url.replace('redis://', 'rediss://');
    }
    _client = createClient({ url });
    _client.on('error', (err: any) => console.error('Redis Client Error', err));
} else {
    console.warn('⚠️  No REDIS_URL found — using in-memory cache (not suitable for production)');
    _client = new MemoryStore();
}

export const redisClient = _client;

export async function connectRedis(): Promise<void> {
    if (useRealRedis && !redisClient.isOpen) {
        await redisClient.connect();
        console.log('Connected to Redis');
    }
}
