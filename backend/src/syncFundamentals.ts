import { pool } from './config/db';
import { connectRedis, redisClient } from './config/redis';
import { syncSectorMap } from './services/sectors/sync';
import { syncFundamentalsForWatched } from './services/fundamentals/sync';

/**
 * One-off / on-demand: refresh the stock->sector map from NSE's constituent
 * files and pull company-internal events (corporate actions, results
 * calendar, announcements) for every watched instrument. `npm run sync:fundamentals`.
 * The daily cron does the same on a schedule.
 */
async function main() {
    await connectRedis();

    console.log('Syncing sector map from niftyindices.com...');
    const sectors = await syncSectorMap();
    console.log(`  mapped ${sectors.mapped} Nifty 500 stocks, ${sectors.withIndex} with a sector index`);

    console.log('Syncing company-internal events from NSE...');
    const f = await syncFundamentalsForWatched();
    if (!f) {
        // The scheduled job holds the lock. Running anyway would apply every
        // pending corporate action a second time.
        console.log('  another fundamentals sync is already running — nothing done.');
        return;
    }
    console.log(`  ${f.instruments} instruments, ${f.events} events upserted, ${f.adjusted} split/bonus adjustments applied to history`);
}

main()
    .catch(err => {
        console.error('Sync failed:', err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
        if (redisClient.isOpen) await redisClient.quit();
    });
