import { redisClient } from '../config/redis';

/**
 * Cross-process job locks.
 *
 * These used to live inside jobs/cron.ts, which meant only the cron could take
 * them: `npm run sync:fundamentals` ran the same code with no lock at all, so
 * running it during the 18:30 job applied every pending corporate action
 * twice. A lock that only one of two callers takes is not a lock.
 *
 * Caveat worth knowing: with no REDIS_URL the client falls back to an
 * in-process store (config/redis.ts), and these degrade to same-process
 * mutexes. That is fine for local development and not fine for two instances.
 */

export async function acquireLock(jobName: string, ttlMs: number): Promise<boolean> {
    const acquired = await redisClient.set(`job:lock:${jobName}`, '1', { NX: true, PX: ttlMs });
    return !!acquired;
}

export async function releaseLock(jobName: string): Promise<void> {
    await redisClient.del(`job:lock:${jobName}`).catch(() => { /* it will expire anyway */ });
}

/**
 * Runs `fn` while holding the lock, releasing it afterwards so a fast job does
 * not block the next tick for the whole TTL. Returns `null` when the lock was
 * already held — the caller decides whether that is normal (a cron tick) or
 * worth reporting (an operator running a script).
 */
export async function withJobLock<T>(jobName: string, ttlMs: number, fn: () => Promise<T>): Promise<T | null> {
    if (!(await acquireLock(jobName, ttlMs))) return null;
    try {
        return await fn();
    } finally {
        await releaseLock(jobName);
    }
}
