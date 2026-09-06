import { query, pool } from './config/db';
import { connectRedis, redisClient } from './config/redis';
import { fetchDailyCandles, activeProvider } from './services/marketProvider';
import { recalculateStatistics } from './services/statistics.service';
import { BENCHMARK_INSTRUMENT_ID } from './config/thresholds';

/**
 * Backfill ~370 days of real daily candles and rebuild statistics for every
 * watched instrument plus the market benchmark, India VIX and every sector
 * index the sector map references. `npm run backfill`. Idempotent (upserts);
 * each instrument's candles land in one multi-row INSERT so a transient error
 * can't leave a half-written series behind.
 */

const VIX_INSTRUMENT_ID = 'NSE:INDIAVIX';
const CANDLE_COLUMNS = 7;

async function targetInstruments(): Promise<string[]> {
    const res = await query(
        `SELECT DISTINCT instrument_id FROM watchlist_items
         UNION SELECT $1
         UNION SELECT $2
         UNION SELECT sector_index_id FROM stock_sectors WHERE sector_index_id IS NOT NULL`,
        [BENCHMARK_INSTRUMENT_ID, VIX_INSTRUMENT_ID]
    );
    // Only instruments we actually know about (VIX/sector rows may be absent
    // until instrument + sector syncs have run).
    const known = await query('SELECT instrument_id FROM instruments WHERE instrument_id = ANY($1)', [res.rows.map(r => r.instrument_id)]);
    return known.rows.map(r => r.instrument_id).sort();
}

async function upsertCandles(instrumentId: string, candles: Awaited<ReturnType<typeof fetchDailyCandles>>): Promise<void> {
    const BATCH = 200;
    for (let i = 0; i < candles.length; i += BATCH) {
        const batch = candles.slice(i, i + BATCH);
        const values: string[] = [];
        const params: any[] = [];
        batch.forEach((c, idx) => {
            const b = idx * CANDLE_COLUMNS;
            values.push(`($${b + 1}, $${b + 2}::date, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7})`);
            params.push(instrumentId, c.tradeDate, c.openPaise, c.highPaise, c.lowPaise, c.closePaise, c.volume);
        });
        await query(
            `INSERT INTO daily_candles (instrument_id, trade_date, open_paise, high_paise, low_paise, close_paise, volume)
             VALUES ${values.join(',')}
             ON CONFLICT (instrument_id, trade_date) DO UPDATE SET
               open_paise = EXCLUDED.open_paise, high_paise = EXCLUDED.high_paise,
               low_paise = EXCLUDED.low_paise, close_paise = EXCLUDED.close_paise, volume = EXCLUDED.volume`,
            params
        );
    }
}

async function main() {
    await connectRedis();

    const instrumentIds = await targetInstruments();
    console.log(`Backfilling ${instrumentIds.length} instruments via ${activeProvider()}...`);

    const to = new Date();
    const from = new Date(to.getTime() - 370 * 86_400_000);

    let ok = 0, failed = 0;
    for (const instrumentId of instrumentIds) {
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const candles = await fetchDailyCandles(instrumentId, from, to);
                if (candles.length === 0) {
                    console.warn(`  ${instrumentId}: no candles returned`);
                    break;
                }
                await upsertCandles(instrumentId, candles);
                await recalculateStatistics(instrumentId);
                console.log(`  ${instrumentId}: ${candles.length} candles, statistics recalculated`);
                ok++;
                break;
            } catch (e) {
                if (attempt === 2) {
                    console.error(`  ${instrumentId}: FAILED — ${(e as Error).message}`);
                    failed++;
                } else {
                    await new Promise(r => setTimeout(r, 1500));
                }
            }
        }
    }

    console.log(`\nDone: ${ok} ok, ${failed} failed.`);
}

main()
    .catch(err => {
        console.error('Backfill failed:', err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
        if (redisClient.isOpen) await redisClient.quit();
    });
