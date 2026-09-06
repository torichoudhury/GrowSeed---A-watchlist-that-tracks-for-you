import { query } from '../../config/db';
import { DEMO } from '../clock';
import { demoBaselineSnapshot } from './baseline';

export async function resetDemoWatchlist(userId: string, watchlistId: string, minutesIntoSession: number | null = null): Promise<void> {
    if (!DEMO) {
        throw new Error('DEMO_AS_OF is not set — nothing to reset.');
    }

    const items = await query('SELECT instrument_id FROM watchlist_items WHERE watchlist_id = $1', [watchlistId]);
    const instrumentIds: string[] = items.rows.map(r => r.instrument_id);

    if (minutesIntoSession === null) {
        // Baseline = the fixed demo baseline moment
        for (const instrumentId of instrumentIds) {
            const snapshot = await demoBaselineSnapshot(instrumentId);
            if (snapshot) {
                await upsert(userId, watchlistId, instrumentId, snapshot.pricePaise, snapshot.volume, snapshot.dataTimestamp);
            }
        }
    } else {
        // Baseline = the price this many minutes into the replayed session.
        const at = new Date(Date.parse(`${DEMO.asOf}T09:15:00+05:30`) + minutesIntoSession * 60_000);
        const bars = await query(
            `SELECT DISTINCT ON (instrument_id) instrument_id, close_paise, volume, bar_ts
             FROM intraday_bars
             WHERE instrument_id = ANY($1) AND bar_ts <= $2
             ORDER BY instrument_id, bar_ts DESC`,
            [instrumentIds, at.toISOString()]
        );
        for (const row of bars.rows) {
            await upsert(userId, watchlistId, row.instrument_id, parseInt(row.close_paise, 10), parseInt(row.volume, 10), new Date(row.bar_ts).toISOString());
        }
    }
}

function upsert(userId: string, watchlistId: string, instrumentId: string, pricePaise: number, volume: number, seenAt: string) {
    return query(
        `INSERT INTO user_stock_state
           (user_id, watchlist_id, instrument_id, last_seen_price_paise, last_seen_volume, last_seen_at, last_seen_data_timestamp, is_initial_state)
         VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$6::timestamptz,false)
         ON CONFLICT (user_id, watchlist_id, instrument_id) DO UPDATE SET
           last_seen_price_paise = EXCLUDED.last_seen_price_paise,
           last_seen_volume = EXCLUDED.last_seen_volume,
           last_seen_at = EXCLUDED.last_seen_at,
           last_seen_data_timestamp = EXCLUDED.last_seen_data_timestamp,
           is_initial_state = false, updated_at = now()`,
        [userId, watchlistId, instrumentId, pricePaise, volume, seenAt]
    );
}
