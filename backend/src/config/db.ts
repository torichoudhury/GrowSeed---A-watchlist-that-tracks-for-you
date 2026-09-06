import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

/**
 * Postgres pool (Supabase).
 *
 * The defaults are wrong for a remote, pooled database behind NAT, and the
 * failure they produce is vicious: Supabase's pooler (and any home router)
 * drops idle TLS connections, node-pg never notices, and the next query goes
 * into a black hole until TCP gives up — around 100 seconds. With `max` of
 * those zombies checked out, every request in the process queues behind them,
 * so a 200ms login turns into 80s and the app looks broken while the
 * database, Redis and the market feed are all perfectly healthy. (Observed
 * exactly that on 2026-09-05: /health 80ms, one-SQL route 101,433ms.)
 *
 * So: keepalives to stop sockets going idle-dead, an idle timeout shorter
 * than the pooler's, and hard deadlines so a broken connection fails fast
 * instead of holding a request open.
 */
export const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    // One process on a laptop can afford ten connections. A host that scales
    // horizontally cannot: every instance opens its own pool, so the ceiling
    // is instances × max. Point PG_POOL_MAX low and use Supabase's transaction
    // pooler (port 6543) there.
    max: Number(process.env.PG_POOL_MAX) > 0 ? Number(process.env.PG_POOL_MAX) : 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Client-side and server-side deadlines. Every query this app runs is a
    // single-instrument read or a small upsert; nothing legitimately takes 15s.
    query_timeout: 15_000,
    statement_timeout: 15_000,
});

// A dead pooled connection surfaces here, not at a call site. Log it and let
// pg discard the client — the next query gets a fresh socket.
pool.on('error', (err) => {
    console.error('Postgres pool error (idle client discarded):', err.message);
});

/** The subset of a pooled client a transaction body needs. */
export type Tx = Pick<PoolClient, 'query'>;

/**
 * Runs `fn` against a single pooled connection inside one transaction.
 *
 * Until this existed the app had exactly one `BEGIN` in it (the migration
 * runner), so every multi-statement sequence was a series of independent
 * autocommits — including the corporate-action re-basing, where a crash
 * between "scale the prices" and "mark it applied" silently re-scaled the same
 * history again on the next run.
 */
export async function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (e) {
        // The connection may already be dead; a failed rollback must not mask
        // the error that caused it.
        await client.query('ROLLBACK').catch(() => { /* see above */ });
        throw e;
    } finally {
        client.release();
    }
}

const SLOW_QUERY_MS = 2_000;

export async function query(text: string, params?: any[]) {
    const startedAt = Date.now();
    try {
        return await pool.query(text, params);
    } finally {
        const ms = Date.now() - startedAt;
        if (ms >= SLOW_QUERY_MS) {
            console.warn(
                `slow query ${ms}ms [pool total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount}]: `
                + text.replace(/\s+/g, ' ').trim().slice(0, 100)
            );
        }
    }
}
