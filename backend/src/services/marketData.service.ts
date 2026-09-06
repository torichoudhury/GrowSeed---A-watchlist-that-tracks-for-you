import { redisClient } from '../config/redis';
import { query } from '../config/db';
import { NormalizedQuote, MarketStatus } from '../models/quote';
import { fetchQuote } from './marketProvider';
import { getMarketStatus } from './marketStatus';
import { DEMO } from './clock';
import { createBreaker } from './circuitBreaker';
import { CACHE_TTL, PROVIDER_MAX_CONCURRENCY } from '../config/thresholds';

// ─── Circuit breaker (BUILD_SPEC §5.3) ──────────────────────────────────────
// Same state machine as before, now shared so other upstreams get one too
// (services/circuitBreaker.ts). Global rather than per-instrument: the thing
// that actually fails is the provider connection itself.
const quoteBreaker = createBreaker('market-data', { threshold: 5, openMs: 30_000 });

// ─── Provider concurrency gate ──────────────────────────────────────────────
// One shared semaphore across every caller (summary, cron, WS): the limit
// belongs to the upstream feed, not to a request.
let inFlight = 0;
const waiting: (() => void)[] = [];

// The cap exists to be polite to a free public feed. A replay reads its own
// database, so throttling it only makes the first load of a demo slower.
const concurrencyLimit = () => (DEMO ? 16 : PROVIDER_MAX_CONCURRENCY);

async function withProviderSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (inFlight >= concurrencyLimit()) {
        await new Promise<void>(resolve => waiting.push(resolve));
    }
    inFlight++;
    try {
        return await fn();
    } finally {
        inFlight--;
        waiting.shift()?.();
    }
}

// ─── Cache lifetime ─────────────────────────────────────────────────────────

function reviveQuote(json: string): NormalizedQuote {
    const parsed = JSON.parse(json);
    parsed.dataTimestamp = new Date(parsed.dataTimestamp);
    parsed.retrievedAt = new Date(parsed.retrievedAt);
    return parsed;
}

function cacheTtlSec(quote: NormalizedQuote): number {
    return quote.marketStatus === MarketStatus.CLOSED ? CACHE_TTL.QuoteClosedSec : CACHE_TTL.QuoteSec;
}

/** A quote cached while the market was closed is useless once a session
 * starts, however long its TTL still has to run. */
function cacheIsUsable(quote: NormalizedQuote): boolean {
    const now = getMarketStatus();
    if (quote.marketStatus === MarketStatus.CLOSED && now !== MarketStatus.CLOSED) return false;
    return true;
}

// ─── Fallback (BUILD_SPEC §5.2) ─────────────────────────────────────────────

export async function getFallbackQuote(instrumentId: string): Promise<NormalizedQuote> {
    const result = await query(
        'SELECT * FROM market_snapshots WHERE instrument_id = $1 ORDER BY data_timestamp DESC LIMIT 1',
        [instrumentId]
    );

    if (result.rows.length === 0) {
        return {
            instrumentId,
            lastPricePaise: 0,
            previousClosePaise: 0,
            openPaise: 0,
            highPaise: 0,
            lowPaise: 0,
            volume: 0,
            dataTimestamp: new Date(0),
            retrievedAt: new Date(),
            marketStatus: MarketStatus.UNKNOWN,
            source: 'DATA_MISSING',
        };
    }

    const row = result.rows[0];
    return {
        instrumentId,
        lastPricePaise: parseInt(row.price_paise, 10),
        previousClosePaise: parseInt(row.previous_close_paise, 10),
        openPaise: parseInt(row.open_paise, 10),
        highPaise: parseInt(row.high_paise, 10),
        lowPaise: parseInt(row.low_paise, 10),
        volume: parseInt(row.volume, 10),
        dataTimestamp: row.data_timestamp,
        retrievedAt: new Date(),
        marketStatus: row.market_status as MarketStatus,
        source: 'PROVIDER_DOWN',
    };
}

// ─── Single quote, cached + single-flight (BUILD_SPEC §5.1) ────────────────

/**
 * Redis is a cache, not a dependency. Every access here is best-effort: with
 * Redis down we lose single-flight and go straight to the provider, but the
 * request still succeeds. Unguarded, a rejected `get`/`mGet` propagated out of
 * the summary route as a 500 — the acceptance criterion says killing Redis
 * must degrade to direct provider calls, and it did not.
 */
let lastCacheWarnAt = 0;
function cacheDown(op: string, e: unknown): void {
    const now = Date.now();
    if (now - lastCacheWarnAt > 30_000) {
        lastCacheWarnAt = now;
        console.warn(`Cache unavailable (${op}) — serving without it:`, (e as Error).message);
    }
}

const cache = {
    async get(key: string): Promise<string | null> {
        try { return await redisClient.get(key); } catch (e) { cacheDown('get', e); return null; }
    },
    async mGet(keys: string[]): Promise<(string | null)[]> {
        try { return await redisClient.mGet(keys) as (string | null)[]; } catch (e) { cacheDown('mGet', e); return keys.map(() => null); }
    },
    async setEx(key: string, ttl: number, value: string): Promise<void> {
        try { await redisClient.setEx(key, ttl, value); } catch (e) { cacheDown('setEx', e); }
    },
    async del(key: string): Promise<void> {
        try { await redisClient.del(key); } catch (e) { cacheDown('del', e); }
    },
    async publish(channel: string, message: string): Promise<void> {
        try { await redisClient.publish(channel, message); } catch (e) { cacheDown('publish', e); }
    },
    /** True when we hold the single-flight lock. With Redis down nobody can
     * hold it, so everyone proceeds — correctness over efficiency. */
    async acquire(key: string, ms: number): Promise<boolean> {
        try { return !!(await redisClient.set(key, '1', { NX: true, PX: ms })); } catch (e) { cacheDown('lock', e); return true; }
    },
};

export async function getQuote(instrumentId: string): Promise<NormalizedQuote> {
    const cacheKey = `quote:${instrumentId}`;
    const lockKey = `lock:quote:${instrumentId}`;

    const cached = await cache.get(cacheKey);
    if (cached) {
        const parsed = reviveQuote(cached);
        if (cacheIsUsable(parsed)) return parsed;
    }

    if (!quoteBreaker.allows()) {
        return getFallbackQuote(instrumentId);
    }

    const acquired = await cache.acquire(lockKey, CACHE_TTL.LockMs);

    if (acquired) {
        try {
            const q = await withProviderSlot(() => fetchQuote(instrumentId));
            quoteBreaker.recordSuccess();
            const payload = JSON.stringify(q);
            await cache.setEx(cacheKey, cacheTtlSec(q), payload);
            await cache.publish(`tick:${instrumentId}`, payload);
            return q;
        } catch (error) {
            quoteBreaker.recordFailure();
            console.error(`Provider fetch failed for ${instrumentId}:`, (error as Error).message);
            return getFallbackQuote(instrumentId);
        } finally {
            await cache.del(lockKey);
        }
    }

    // Lost the lock — poll for the winner's write, 100ms x 30 = 3s max.
    for (let i = 0; i < 30; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        const result = await cache.get(cacheKey);
        if (result) return reviveQuote(result);
    }

    return getFallbackQuote(instrumentId);
}

// ─── Batch, partial-failure tolerant (BUILD_SPEC §4, §11.1 step 3) ─────────

export async function getQuotes(
    instrumentIds: string[]
): Promise<{ quotes: NormalizedQuote[]; errors: Record<string, string> }> {
    const quotes: NormalizedQuote[] = [];
    const errors: Record<string, string> = {};
    if (instrumentIds.length === 0) return { quotes, errors };

    // One MGET for the whole batch: with a remote Redis, N sequential GETs
    // were the dominant cost of a warm summary request.
    const cached = await cache.mGet(instrumentIds.map(id => `quote:${id}`));
    const misses: string[] = [];
    cached.forEach((hit, i) => {
        const revived = hit ? reviveQuote(hit) : null;
        if (revived && cacheIsUsable(revived)) quotes.push(revived);
        else misses.push(instrumentIds[i]);
    });

    // getQuote() never throws (it always resolves via the fallback chain),
    // so Promise.allSettled is defensive here rather than load-bearing —
    // kept anyway so one truly unexpected exception can't take the batch down.
    const settled = await Promise.allSettled(misses.map(id => getQuote(id)));
    settled.forEach((result, i) => {
        if (result.status === 'fulfilled') {
            quotes.push(result.value);
        } else {
            errors[misses[i]] = result.reason?.message || 'Unknown error';
        }
    });

    return { quotes, errors };
}
