import bcrypt from 'bcryptjs';
import { query, pool } from './config/db';
import { connectRedis, redisClient } from './config/redis';
import { fetchYahooDailyCandles, fetchYahooIntradayBars } from './services/yahoo/provider';
import { recalculateStatistics, recalculateMarketRegime, VIX_INSTRUMENT_ID } from './services/statistics.service';
import { syncSectorMap, referencedSectorIndices } from './services/sectors/sync';
import { demoBaselineSnapshot } from './services/demo/baseline';
import { BENCHMARK_INSTRUMENT_ID } from './config/thresholds';
import { DEMO } from './services/clock';

/**
 * `npm run demo:seed` — builds the replay dataset for DEMO_AS_OF.
 *
 * Everything it stores is real: ~18 months of true daily candles ending the
 * day before the replayed session (so every percentile, beta and sector model
 * is computed from history that genuinely preceded it), plus that session's
 * real 5-minute bars, which the replay provider serves against a shifted
 * clock. Nothing is synthesised and no date is falsified.
 *
 * It also sets the user's baseline to the fixed demo baseline (DEMO.baselineAt —
 * Monday 31 Aug 2026 10:00 IST by default), resolved against that moment's real
 * market snapshot, so the first screen of the demo answers the product's actual
 * question — what changed since you last looked — over a real multi-day window.
 */

const DEMO_USER_EMAIL = 'demo@growwatch.local';
const DEMO_PASSWORD = 'Demo@12345';
const WATCHLIST_NAME = 'Demo Watchlist';

// The five the user named, plus high-beta movers and deliberately quiet large
// caps: with nothing calm to rank against, "needs attention" proves nothing.
const SYMBOLS = [
    'ASHOKLEY', 'NEWGEN', 'ITC', 'ITCHOTELS', 'BEL',
    'MAZDOCK', 'COCHINSHIP', 'HAL', 'BDL', 'IRFC',
    'IREDA', 'RVNL', 'SUZLON', 'DIXON', 'TRENT',
    'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'SBIN',
];
const HISTORY_DAYS = 540;

const instrumentIdOf = (symbol: string) => `NSE:${symbol}`;

async function upsertDailyCandles(instrumentId: string, from: Date, to: Date): Promise<number> {
    const candles = await fetchYahooDailyCandles(instrumentId, from, to);
    if (candles.length === 0) return 0;

    // Multi-row inserts: one round trip per instrument rather than per candle.
    const BATCH = 200;
    let written = 0;
    for (let i = 0; i < candles.length; i += BATCH) {
        const slice = candles.slice(i, i + BATCH);
        const values: any[] = [];
        const tuples = slice.map((c, n) => {
            const b = n * 7;
            values.push(instrumentId, c.tradeDate, c.openPaise, c.highPaise, c.lowPaise, c.closePaise, c.volume);
            return `($${b + 1},$${b + 2}::date,$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`;
        });
        await query(
            `INSERT INTO daily_candles (instrument_id, trade_date, open_paise, high_paise, low_paise, close_paise, volume)
             VALUES ${tuples.join(',')}
             ON CONFLICT (instrument_id, trade_date) DO UPDATE SET
               open_paise = EXCLUDED.open_paise, high_paise = EXCLUDED.high_paise,
               low_paise = EXCLUDED.low_paise, close_paise = EXCLUDED.close_paise, volume = EXCLUDED.volume`,
            values
        );
        written += slice.length;
    }
    return written;
}

async function upsertIntraday(instrumentId: string, date: string): Promise<number> {
    // Yahoo sometimes appends the most recent live bar regardless of the range
    // asked for; keep only bars that really belong to the replayed session.
    const bars = (await fetchYahooIntradayBars(instrumentId, date))
        .filter(b => b.ts.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) === date);
    if (bars.length === 0) return 0;

    const values: any[] = [];
    const tuples = bars.map((b, n) => {
        const o = n * 7;
        values.push(instrumentId, b.ts.toISOString(), b.openPaise, b.highPaise, b.lowPaise, b.closePaise, b.volume);
        return `($${o + 1},$${o + 2}::timestamptz,$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7})`;
    });
    await query(
        `INSERT INTO intraday_bars (instrument_id, bar_ts, open_paise, high_paise, low_paise, close_paise, volume)
         VALUES ${tuples.join(',')}
         ON CONFLICT (instrument_id, bar_ts) DO UPDATE SET
           open_paise = EXCLUDED.open_paise, high_paise = EXCLUDED.high_paise,
           low_paise = EXCLUDED.low_paise, close_paise = EXCLUDED.close_paise, volume = EXCLUDED.volume`,
        values
    );
    return bars.length;
}

async function ensureDemoUser(): Promise<string> {
    const existing = await query('SELECT id FROM users WHERE email = $1', [DEMO_USER_EMAIL]);
    if (existing.rows.length > 0) return existing.rows[0].id;
    const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
    const created = await query('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [DEMO_USER_EMAIL, hash]);
    return created.rows[0].id;
}

async function main() {
    if (!DEMO) {
        console.error('DEMO_AS_OF is not set in backend/.env — set it to the trading day you want to replay (e.g. 2026-08-03).');
        process.exitCode = 1;
        return;
    }
    const asOf = DEMO.asOf;
    console.log(`Seeding the replay of ${asOf} (speed ${DEMO.speed}×, session opens ${DEMO.sessionStart} IST)\n`);
    await connectRedis();

    const instrumentIds = SYMBOLS.map(instrumentIdOf);

    // Every symbol must exist in the real instrument universe.
    const known = await query(
        `SELECT instrument_id FROM instruments WHERE instrument_id = ANY($1)`,
        [instrumentIds]
    );
    const knownIds = new Set(known.rows.map(r => r.instrument_id));
    const missing = instrumentIds.filter(id => !knownIds.has(id));
    if (missing.length > 0) {
        console.error(`Not in the instruments table: ${missing.join(', ')}\nRun \`npm run seed\` first to sync the instrument master.`);
        process.exitCode = 1;
        return;
    }

    const to = new Date(`${asOf}T23:59:59+05:30`);
    const from = new Date(to.getTime() - HISTORY_DAYS * 86_400_000);

    // ── 1. Daily history for the 20 ───────────────────────────────────────
    console.log(`Daily candles (${HISTORY_DAYS} days ending ${asOf}):`);
    for (const id of instrumentIds) {
        try {
            const n = await upsertDailyCandles(id, from, to);
            console.log(`  ${id.padEnd(18)} ${String(n).padStart(4)} sessions`);
        } catch (e) {
            console.error(`  ${id.padEnd(18)} FAILED — ${(e as Error).message}`);
        }
    }

    // ── 2. Sector map, then the indices those stocks actually need ────────
    console.log('\nSector map:');
    const sectors = await syncSectorMap();
    console.log(`  mapped ${sectors.mapped} stocks, ${sectors.withIndex} with a sector index`);

    const indexIds = Array.from(new Set<string>([
        BENCHMARK_INSTRUMENT_ID, VIX_INSTRUMENT_ID, ...(await referencedSectorIndices()),
    ]));
    console.log('\nIndex history:');
    for (const id of indexIds) {
        try {
            const n = await upsertDailyCandles(id, from, to);
            console.log(`  ${id.padEnd(18)} ${String(n).padStart(4)} sessions`);
        } catch (e) {
            console.error(`  ${id.padEnd(18)} skipped — ${(e as Error).message}`);
        }
    }

    // ── 3. The replayed session itself ────────────────────────────────────
    console.log(`\nIntraday 5-minute bars for ${asOf}:`);
    let barTotal = 0;
    for (const id of [...instrumentIds, BENCHMARK_INSTRUMENT_ID]) {
        try {
            const n = await upsertIntraday(id, asOf);
            barTotal += n;
            console.log(`  ${id.padEnd(18)} ${String(n).padStart(3)} bars${n === 0 ? '  (none — will replay statically from the daily candle)' : ''}`);
        } catch (e) {
            console.error(`  ${id.padEnd(18)} FAILED — ${(e as Error).message}`);
        }
    }

    // The baseline moment's own 5-minute bars, so "you last checked Monday
    // 10:00" resolves to that day's real 10:00 print rather than the day's
    // open. Same day as the replay session shares the upsert above.
    const baselineDay = DEMO.baselineAt.slice(0, 10);
    if (baselineDay !== asOf) {
        console.log(`\nIntraday 5-minute bars for the baseline day ${baselineDay}:`);
        for (const id of instrumentIds) {
            try {
                const n = await upsertIntraday(id, baselineDay);
                console.log(`  ${id.padEnd(18)} ${String(n).padStart(3)} bars${n === 0 ? "  (none — baseline falls back to the day's open)" : ''}`);
            } catch (e) {
                console.error(`  ${id.padEnd(18)} FAILED — ${(e as Error).message}`);
            }
        }
    }

    // ── 4. Statistics from history that genuinely preceded the session ────
    console.log('\nStatistics (history is cut off at the replay date):');
    for (const id of [...indexIds, ...instrumentIds]) {
        await recalculateStatistics(id).catch(e => console.error(`  ${id}: ${e.message}`));
    }
    await recalculateMarketRegime().catch(e => console.error(`  regime: ${e.message}`));
    console.log(`  done for ${indexIds.length + instrumentIds.length} instruments`);

    // ── 5. Watchlist + the baseline that makes "what changed" meaningful ──
    const userId = await ensureDemoUser();
    let wl = await query('SELECT id FROM watchlists WHERE user_id = $1 AND name = $2', [userId, WATCHLIST_NAME]);
    if (wl.rows.length === 0) {
        wl = await query('INSERT INTO watchlists (user_id, name) VALUES ($1, $2) RETURNING id', [userId, WATCHLIST_NAME]);
    }
    const watchlistId = wl.rows[0].id;

    // The user's "last seen" is the fixed demo baseline (DEMO.baselineAt,
    // fixture: Monday 2026-07-20 10:00 IST), resolved through the replay
    // dataset to the real snapshot that belonged to that moment — so the demo
    // opens on a real multi-day window, not a zero. Data-derived only
    // (services/demo/baseline.ts); nothing is fabricated.
    const baselineMark = new Date(DEMO.baselineAt);
    let attached = 0, based = 0;
    for (const id of instrumentIds) {
        await query(
            `INSERT INTO watchlist_items (watchlist_id, instrument_id) VALUES ($1, $2)
             ON CONFLICT (watchlist_id, instrument_id) DO NOTHING`,
            [watchlistId, id]
        );
        attached++;

        const snapshot = await demoBaselineSnapshot(id);
        if (snapshot) {
            await query(
                `INSERT INTO user_stock_state
                   (user_id, instrument_id, last_seen_price_paise, last_seen_volume, last_seen_at, last_seen_data_timestamp, is_initial_state)
                 VALUES ($1,$2,$3,$4,$5::timestamptz,$5::timestamptz,false)
                 ON CONFLICT (user_id, instrument_id) DO UPDATE SET
                   last_seen_price_paise = EXCLUDED.last_seen_price_paise,
                   last_seen_volume = EXCLUDED.last_seen_volume,
                   last_seen_at = EXCLUDED.last_seen_at,
                   last_seen_data_timestamp = EXCLUDED.last_seen_data_timestamp,
                   is_initial_state = false, updated_at = now()`,
                [userId, id, snapshot.pricePaise, snapshot.volume, snapshot.dataTimestamp]
            );
            based++;
        }
    }

    // The gateway caches the user's instruments; drop it so the new list ticks.
    await redisClient.del(`ws:instruments:${userId}`).catch(() => {});

    console.log(`\n✅ Replay ready.`);
    console.log(`   Watchlist "${WATCHLIST_NAME}": ${attached} stocks, ${based} with a baseline at ${baselineMark.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`);
    console.log(`   ${barTotal} real 5-minute bars stored for ${asOf}`);
    console.log(`   Log in as ${DEMO_USER_EMAIL} / ${DEMO_PASSWORD}`);
    console.log(`   Restart the backend to start the session at ${DEMO.sessionStart} IST on ${asOf}.`);
}

main()
    .catch(err => { console.error('Demo seed failed:', err); process.exitCode = 1; })
    .finally(async () => {
        await pool.end();
        if (redisClient.isOpen) await redisClient.quit();
    });
