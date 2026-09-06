import bcrypt from 'bcryptjs';
import { query, pool } from './config/db';
import { connectRedis, redisClient } from './config/redis';
import { syncInstrumentsFromGroww } from './services/groww/provider';

const DEMO_EMAIL = 'demo@growwatch.local';
const DEMO_PASSWORD = 'Demo@12345';

// A representative Nifty spread across sectors — every symbol here is
// verified against Groww's real instrument feed (a couple of the obvious
// picks turned out stale, e.g. Tata Motors demerged into TMPV/TMCV).
const DEFAULT_SYMBOLS = [
    'NSE:RELIANCE', 'NSE:TCS', 'NSE:INFY', 'NSE:HDFCBANK', 'NSE:ICICIBANK',
    'NSE:TMPV', 'NSE:SBIN', 'NSE:BHARTIARTL', 'NSE:ITC', 'NSE:LT',
];
const BENCHMARK = 'NSE:NIFTY';

async function seed() {
    console.log('Connecting...');
    await connectRedis();

    console.log('Syncing the real instrument universe from Groww (no mock data)...');
    const { upserted, delisted } = await syncInstrumentsFromGroww();
    console.log(`  upserted ${upserted} instruments, marked ${delisted} delisted`);

    // Clean slate for anything left over from an earlier placeholder seed
    // that hand-typed fake prices — those rows have no user scope, so they
    // silently leak into ANY user's summary via the PROVIDER_DOWN fallback
    // chain once a real quote fails. Targeted, not blanket: only removes
    // rows a real fetch/backfill could never have produced, so re-running
    // seed after a real `npm run backfill` won't erase that real data.
    console.log('Clearing any previously-seeded fixture data...');
    await query(`DELETE FROM market_snapshots WHERE data_source = 'SEED'`);
    await query(`DELETE FROM stock_statistics WHERE trading_days_observed = 0`);
    await query(`DELETE FROM users WHERE email = $1`, [DEMO_EMAIL]);
    await query(`DELETE FROM users WHERE email = 'demo@groww.app'`); // the old placeholder seed's user

    console.log('Creating demo user...');
    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
    const userRes = await query(
        `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
        [DEMO_EMAIL, passwordHash]
    );
    const userId = userRes.rows[0].id;

    console.log('Creating default watchlist...');
    const watchlistRes = await query(
        `INSERT INTO watchlists (user_id, name) VALUES ($1, 'My Watchlist') RETURNING id`,
        [userId]
    );
    const watchlistId = watchlistRes.rows[0].id;

    let attached = 0;
    for (const instrumentId of DEFAULT_SYMBOLS) {
        const exists = await query('SELECT 1 FROM instruments WHERE instrument_id = $1', [instrumentId]);
        if (exists.rows.length === 0) {
            console.warn(`  skipping ${instrumentId} — not found in the synced instrument universe`);
            continue;
        }
        await query(
            `INSERT INTO watchlist_items (watchlist_id, instrument_id) VALUES ($1, $2)
             ON CONFLICT (watchlist_id, instrument_id) DO NOTHING`,
            [watchlistId, instrumentId]
        );
        // Epoch data-timestamp so the first real acknowledge always supersedes
        // the placeholder (the monotonic guard in POST /acknowledge).
        await query(
            `INSERT INTO user_stock_state
               (user_id, instrument_id, last_seen_price_paise, last_seen_volume, last_seen_at, last_seen_data_timestamp, is_initial_state)
             VALUES ($1, $2, 0, 0, now(), to_timestamp(0), true)
             ON CONFLICT (user_id, instrument_id) DO NOTHING`,
            [userId, instrumentId]
        );
        attached++;
    }
    console.log(`  attached ${attached}/${DEFAULT_SYMBOLS.length} default symbols`);

    const benchmarkExists = await query('SELECT 1 FROM instruments WHERE instrument_id = $1', [BENCHMARK]);
    if (benchmarkExists.rows.length === 0) {
        console.warn(`  WARNING: benchmark instrument ${BENCHMARK} not found — market-relative metrics will read 0 until it is`);
    }

    console.log('\n✅ Seed complete.');
    console.log(`   Log in with: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
    console.log('   No price history has been seeded — market_snapshots/daily_candles are');
    console.log('   genuinely empty until the Groww API key has live-data + historical-data');
    console.log('   scope, at which point `npm run backfill` populates real history and the');
    console.log('   market-refresh cron job keeps live snapshots current on its own.');
}

seed()
    .catch(err => {
        console.error('❌ Seed failed:', err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
        if (redisClient.isOpen) await redisClient.quit();
    });
