import cron from 'node-cron';
import { query } from '../config/db';
import { acquireLock } from '../services/jobLock';
import { getQuote } from '../services/marketData.service';
import { recalculateStatistics, recalculateMarketRegime } from '../services/statistics.service';
import { syncInstrumentsFromGroww } from '../services/groww/provider';
import { syncFundamentalsForWatched } from '../services/fundamentals/sync';
import { scanForMissedAdjustments } from '../services/fundamentals/adjustmentScan';
import { syncSectorMap } from '../services/sectors/sync';
import { getMarketStatus } from '../services/marketStatus';
import { DEMO } from '../services/clock';
import { MarketStatus } from '../models/quote';

// Locks live in services/jobLock.ts so scripts can take the same ones.

export function startJobs() {
    // A host that scales to zero cannot run a timer: with no traffic there is
    // no process, and every cold start would restart the schedule. Worse, the
    // write-side jobs would run on however many instances happen to be warm.
    // Skip them entirely and let a platform scheduler drive anything periodic.
    if (process.env.VERCEL || process.env.DISABLE_JOBS === '1') {
        console.log('Background jobs disabled (serverless host) — periodic work must come from a platform scheduler.');
        return;
    }

    // In replay mode only the refresh loop makes sense — it is what pushes
    // ticks to connected clients. Every other job WRITES (rolls today's
    // snapshots into a candle, rebuilds statistics, syncs instruments), and
    // "today" is a month ago, so they would corrupt real history with replayed
    // prices. They stay off until the demo does (services/clock.ts).
    if (DEMO) {
        console.log(`Replay mode (${DEMO.asOf} at ${DEMO.speed}×): only the market-refresh job runs; write-side jobs are disabled.`);
    }

    // ── Market refresh: every 30s while OPEN, else every 5m (BUILD_SPEC §12) ──
    cron.schedule('*/30 * * * * *', async () => {
        const marketStatus = getMarketStatus();
        const isOpenSession = marketStatus === MarketStatus.OPEN
            || marketStatus === MarketStatus.PRE_MARKET
            || marketStatus === MarketStatus.POST_MARKET;
        // Outside market hours drop to one refresh every 5 minutes: this
        // schedule fires twice a minute, so keep only the :00-second tick of
        // every fifth minute.
        if (!isOpenSession) {
            const now = new Date();
            if (now.getMinutes() % 5 !== 0 || now.getSeconds() >= 30) return;
        }

        const hasLock = await acquireLock('market-refresh', 25_000);
        if (!hasLock) return;

        try {
            const result = await query('SELECT DISTINCT instrument_id FROM watchlist_items');
            const instrumentIds = result.rows.map(row => row.instrument_id);

            for (const iid of instrumentIds) {
                try {
                    const q = await getQuote(iid);
                    // Persist only genuine provider ticks — a fallback quote is
                    // itself read from market_snapshots and must not be
                    // re-written, and a replayed tick is already stored history.
                    if (!DEMO && q.source !== 'PROVIDER_DOWN' && q.source !== 'DATA_MISSING') {
                        await query(
                            `INSERT INTO market_snapshots
                               (instrument_id, price_paise, open_paise, high_paise, low_paise,
                                previous_close_paise, volume, market_status, data_timestamp, retrieved_at, data_source)
                             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
                            [iid, q.lastPricePaise, q.openPaise, q.highPaise, q.lowPaise,
                             q.previousClosePaise, q.volume, q.marketStatus, q.dataTimestamp, q.retrievedAt, q.source]
                        );
                    }
                } catch (e) {
                    console.error(`market-refresh: quote failed for ${iid}`, (e as Error).message);
                }
            }
        } catch (e) {
            console.error('Market refresh job failed:', e);
        }
    });

    if (DEMO) return;

    // ── Statistics recalculation: daily, 30m after close (BUILD_SPEC §12) ──
    cron.schedule('0 16 * * *', async () => {
        const hasLock = await acquireLock('stats-recalc', 10 * 60 * 1000);
        if (!hasLock) return;

        try {
            // Indices first so every stock's market model sees fresh benchmark
            // and sector series; only instruments that actually have candles.
            const result = await query(
                `SELECT DISTINCT dc.instrument_id, (i.name ILIKE 'NIFTY%' OR i.name ILIKE '%Vix%' OR i.name ILIKE 'Bse%') AS is_index
                 FROM daily_candles dc JOIN instruments i ON i.instrument_id = dc.instrument_id
                 ORDER BY is_index DESC, dc.instrument_id`
            );
            for (const row of result.rows) {
                await recalculateStatistics(row.instrument_id).catch(console.error);
            }
            await recalculateMarketRegime().catch(console.error);
        } catch (e) {
            console.error('Stats recalc job failed:', e);
        }
    }, { timezone: 'Asia/Kolkata' });

    // ── Company-internal events: daily after close (approved NSE source) ──
    // The lock is taken inside syncFundamentalsForWatched so the CLI shares it;
    // taking it again here would deadlock the job against itself.
    cron.schedule('30 18 * * 1-5', async () => {
        try {
            const r = await syncFundamentalsForWatched();
            if (!r) return;   // another run holds the lock
            console.log(`fundamentals-sync: ${r.instruments} instruments, ${r.events} events, ${r.adjusted} adjustments`);
        } catch (e) {
            console.error('Fundamentals sync job failed:', e);
        }
    }, { timezone: 'Asia/Kolkata' });

    // ── Missed corporate actions: weekly, from the numbers alone ──
    // Safety net for wording our NSE parsing didn't match. Records findings
    // only; re-basing prices still needs `detect:splits -- --apply`.
    cron.schedule('0 4 * * 6', async () => {
        const hasLock = await acquireLock('adjustment-scan', 30 * 60 * 1000);
        if (!hasLock) return;
        try {
            const scan = await scanForMissedAdjustments();
            if (scan.actionable.length > 0) {
                console.warn(`adjustment-scan: ${scan.actionable.length} suspected corporate action(s) missing from the calendar, `
                    + `${scan.recorded} newly recorded — review with \`npm run detect:splits\``);
                for (const f of scan.actionable) {
                    console.warn(`  ${f.instrumentId} ${f.artifact.date} looks like a ${f.artifact.label} (${(f.artifact.returnBps / 100).toFixed(2)}%)`);
                }
            } else {
                console.log(`adjustment-scan: ${scan.scanned} instruments clean`);
            }
        } catch (e) {
            console.error('Adjustment scan job failed:', e);
        }
    }, { timezone: 'Asia/Kolkata' });

    // ── Sector map: weekly (index constituents change rarely) ──
    cron.schedule('30 2 * * 0', async () => {
        const hasLock = await acquireLock('sector-sync', 30 * 60 * 1000);
        if (!hasLock) return;
        try {
            const r = await syncSectorMap();
            console.log(`sector-sync: mapped ${r.mapped}, with index ${r.withIndex}`);
        } catch (e) {
            console.error('Sector sync job failed:', e);
        }
    }, { timezone: 'Asia/Kolkata' });

    // ── Candle rollup: daily, 15m after close (BUILD_SPEC §12) ──
    // Collapses today's market_snapshots into one daily_candles row per
    // instrument — the source data the stats job above actually reads.
    cron.schedule('45 15 * * *', async () => {
        const hasLock = await acquireLock('candle-rollup', 10 * 60 * 1000);
        if (!hasLock) return;

        try {
            const result = await query(`
                SELECT instrument_id,
                       (array_agg(open_paise ORDER BY data_timestamp ASC))[1] AS open_paise,
                       max(high_paise) AS high_paise,
                       min(low_paise) AS low_paise,
                       (array_agg(price_paise ORDER BY data_timestamp DESC))[1] AS close_paise,
                       max(volume) AS volume
                FROM market_snapshots
                WHERE data_timestamp >= CURRENT_DATE
                GROUP BY instrument_id
            `);

            for (const row of result.rows) {
                await query(
                    `INSERT INTO daily_candles (instrument_id, trade_date, open_paise, high_paise, low_paise, close_paise, volume)
                     VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6)
                     ON CONFLICT (instrument_id, trade_date) DO UPDATE SET
                       high_paise = GREATEST(daily_candles.high_paise, EXCLUDED.high_paise),
                       low_paise = LEAST(daily_candles.low_paise, EXCLUDED.low_paise),
                       close_paise = EXCLUDED.close_paise,
                       volume = EXCLUDED.volume`,
                    [row.instrument_id, row.open_paise, row.high_paise, row.low_paise, row.close_paise, row.volume]
                );
            }
        } catch (e) {
            console.error('Candle rollup job failed:', e);
        }
    }, { timezone: 'Asia/Kolkata' });

    // ── Snapshot cleanup: daily (BUILD_SPEC §12) — 7-day retention ──
    cron.schedule('30 2 * * *', async () => {
        const hasLock = await acquireLock('snapshot-cleanup', 10 * 60 * 1000);
        if (!hasLock) return;

        try {
            const result = await query("DELETE FROM market_snapshots WHERE data_timestamp < now() - interval '7 days'");
            console.log(`snapshot-cleanup: removed ${result.rowCount} rows`);
        } catch (e) {
            console.error('Snapshot cleanup job failed:', e);
        }
    }, { timezone: 'Asia/Kolkata' });

    // ── Instrument sync: daily (BUILD_SPEC §12) ──
    // Refreshes the instrument universe and statuses from Groww's own
    // instrument master (architecture doc §61.B2).
    cron.schedule('0 3 * * *', async () => {
        const hasLock = await acquireLock('instrument-sync', 10 * 60 * 1000);
        if (!hasLock) return;

        try {
            const { upserted, delisted } = await syncInstrumentsFromGroww();
            console.log(`instrument-sync: upserted ${upserted}, delisted ${delisted}`);
        } catch (e) {
            console.error('Instrument sync job failed:', e);
        }
    }, { timezone: 'Asia/Kolkata' });
}
