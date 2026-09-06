import { query, pool } from './config/db';
import { connectRedis, redisClient } from './config/redis';
import { recalculateStatistics, recalculateMarketRegime } from './services/statistics.service';

/**
 * On-demand equivalent of the nightly stats job: rebuild stock_statistics
 * for every instrument that has candles (indices first, so each stock's
 * market model sees fresh benchmark/sector series) and refresh the market
 * regime. `npm run stats`.
 */
async function main() {
    await connectRedis();
    const result = await query(
        `SELECT DISTINCT dc.instrument_id, (i.name ILIKE 'NIFTY%' OR i.name ILIKE '%Vix%' OR i.name ILIKE 'Bse%') AS is_index
         FROM daily_candles dc JOIN instruments i ON i.instrument_id = dc.instrument_id
         ORDER BY is_index DESC, dc.instrument_id`
    );
    console.log(`Recalculating statistics for ${result.rows.length} instruments...`);
    for (const row of result.rows) {
        await recalculateStatistics(row.instrument_id);
    }
    await recalculateMarketRegime();
    const regime = await query('SELECT * FROM market_regime');
    console.log('Market regime:', regime.rows[0]);
    console.log('Done.');
}

main()
    .catch(err => { console.error('Stats recalculation failed:', err); process.exitCode = 1; })
    .finally(async () => { await pool.end(); if (redisClient.isOpen) await redisClient.quit(); });
