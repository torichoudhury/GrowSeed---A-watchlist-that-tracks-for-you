import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createServer, Server } from 'http';
import { connectRedis, redisClient } from './config/redis';
import { pool } from './config/db';
import { startJobs } from './jobs/cron';
import { setupWebSocketGateway } from './ws/gateway';
import { redact } from './services/log';
import { ValidationError } from './services/validate';
import { breakerStates } from './services/circuitBreaker';
import { DEMO, now as clockNow } from './services/clock';
import authRouter from './routes/auth';
import watchlistsRouter from './routes/watchlists';
import marketRouter from './routes/market';
import instrumentsRouter from './routes/instruments';
import stocksRouter from './routes/stocks';
import exploreRouter from './routes/explore';
import demoRouter from './routes/demo';

dotenv.config();

let healthy = true;
let httpServer: Server | null = null;
let shuttingDown = false;

/**
 * Stop accepting, let in-flight requests finish, then release the pool and
 * both Redis sockets. Without this, a deploy cut live requests and left
 * connections dangling on the server side.
 */
async function shutdown(signal: string, code = 0): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    healthy = false;
    console.log(`${signal} received — draining`);

    const forced = setTimeout(() => {
        console.error('Drain timed out — exiting anyway');
        process.exit(code || 1);
    }, 10_000);
    forced.unref();

    try {
        await new Promise<void>(resolve => (httpServer ? httpServer.close(() => resolve()) : resolve()));
        await pool.end().catch((e: unknown) => console.error('pool.end failed:', redact(e)));
        if (redisClient.isOpen) await redisClient.quit().catch((e: unknown) => console.error('redis.quit failed:', redact(e)));
    } finally {
        clearTimeout(forced);
        process.exit(code);
    }
}

// A rejection that reaches here is a bug in an error boundary, not a
// condition to absorb: log it (redacted) and keep serving, but say so loudly.
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', redact(reason));
});

// An uncaught exception leaves the runtime in an undefined state. The previous
// handler logged and carried on, which is how a process ends up half-alive and
// still passing health checks. Fail fast and let the supervisor restart us.
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception — shutting down:', redact(err));
    healthy = false;
    void shutdown('uncaughtException', 1);
});

const app = express();
const port = process.env.PORT || 8080;

const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000,http://localhost:3001')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
const allowAllOrigins = allowedOrigins.includes('*');

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (server-to-server calls, curl, mobile apps, etc.)
        if (!origin) {
            return callback(null, true);
        }
        // Wildcard or explicit matches
        if (allowAllOrigins || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        // Localhost development ports
        if (/^http:\/\/localhost:\d+$/.test(origin)) {
            return callback(null, true);
        }
        // Any Vercel deployment preview / production domain
        if (/\.vercel\.app$/.test(origin.replace(/^https?:\/\//, ''))) {
            return callback(null, true);
        }
        callback(new Error('Not allowed by CORS'));
    },
    credentials: true
}));
// Bounded: the parser's 100kb default was the only limit on any request body.
app.use(express.json({ limit: '64kb' }));

// Enough to see whether the process is worth routing traffic to, and why not
// if it isn't. A breaker nobody can observe is a breaker nobody trusts.
app.get('/health', (req, res) => {
    res.status(healthy ? 200 : 503).json({
        status: healthy ? 'ok' : 'unhealthy',
        clock: DEMO ? { mode: 'replay', asOf: DEMO.asOf, now: clockNow().toISOString() } : { mode: 'live' },
        db: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
        redis: redisClient.isOpen ? 'open' : 'closed',
        breakers: breakerStates(),
    });
});

app.use('/api/auth', authRouter);
app.use('/api/watchlists', watchlistsRouter);
app.use('/api/market', marketRouter);
app.use('/api/instruments', instrumentsRouter);
app.use('/api/stocks', stocksRouter);
app.use('/api/explore', exploreRouter);
app.use('/api/demo', demoRouter);

app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// Last-resort handler: a malformed JSON body throws inside express.json()
// before any route runs, and any route that forgot a try/catch would
// otherwise 500 with an HTML stack trace instead of JSON.
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err?.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Malformed JSON body' });
    }
    // Body-parser's size rejection used to fall through to the 500 below, so
    // an over-size request was reported as our fault rather than the caller's.
    if (err?.type === 'entity.too.large') {
        return res.status(413).json({ error: 'Request body is too large' });
    }
    // Express 5 forwards async rejections here, so every route's input
    // validation can simply throw (services/validate.ts).
    if (err instanceof ValidationError) {
        return res.status(400).json({ error: err.message });
    }
    console.error('Unhandled error:', redact(err));
    res.status(500).json({ error: 'Internal Server Error' });
});

import { resetDemoWatchlist } from './services/demo/reset';

app.get('/api/admin/migrate', async (req, res) => {
    try {
        await runAutoMigrations();
        res.json({ status: 'ok', message: 'Migrations verified and executed.' });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

async function runAutoMigrations(): Promise<void> {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                filename TEXT PRIMARY KEY,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);

        const check006 = await pool.query(`
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'user_stock_state' AND column_name = 'watchlist_id'
        `);

        if (check006.rows.length === 0) {
            console.log('[Migration] Applying 006_user_stock_state_watchlist_isolation...');
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query('TRUNCATE TABLE user_stock_state');
                await client.query('ALTER TABLE user_stock_state ADD COLUMN watchlist_id UUID REFERENCES watchlists(id) ON DELETE CASCADE');
                await client.query('ALTER TABLE user_stock_state ALTER COLUMN watchlist_id SET NOT NULL');
                await client.query('ALTER TABLE user_stock_state DROP CONSTRAINT IF EXISTS user_stock_state_user_id_instrument_id_key');
                await client.query('ALTER TABLE user_stock_state ADD CONSTRAINT user_stock_state_user_id_watchlist_id_instrument_id_key UNIQUE(user_id, watchlist_id, instrument_id)');
                await client.query(`
                    INSERT INTO schema_migrations (filename) 
                    VALUES ('006_user_stock_state_watchlist_isolation.sql') 
                    ON CONFLICT (filename) DO NOTHING
                `);
                await client.query('COMMIT');
                console.log('[Migration] Migration 006 applied successfully.');
            } catch (err) {
                await client.query('ROLLBACK');
                console.error('[Migration] Migration 006 failed:', err);
                throw err;
            } finally {
                client.release();
            }

            // Seed initial baseline for existing watchlists
            try {
                const watchlists = await pool.query('SELECT id, user_id FROM watchlists');
                for (const w of watchlists.rows) {
                    await resetDemoWatchlist(w.user_id, w.id);
                }
                console.log(`[Migration] Seeded baseline for ${watchlists.rows.length} watchlists.`);
            } catch (seedErr) {
                console.warn('[Migration] Failed to seed initial baseline:', seedErr);
            }
        }
    } catch (e) {
        console.error('[Migration] Auto-migration error:', e);
    }
}

async function start() {
    try {
        await runAutoMigrations();

        await connectRedis();
        console.log('Connected to Redis');

        startJobs();
        console.log('Background jobs started');

        httpServer = createServer(app);
        setupWebSocketGateway(httpServer);

        httpServer.listen(port, () => {
            console.log(`Server listening on port ${port}`);
        });

        for (const signal of ['SIGTERM', 'SIGINT'] as const) {
            process.on(signal, () => void shutdown(signal));
        }
    } catch (e) {
        console.error('Failed to start server:', e);
        process.exit(1);
    }
}

start();
