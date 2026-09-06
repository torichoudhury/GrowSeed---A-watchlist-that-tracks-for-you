import { query } from '../../config/db';
import { DEMO } from '../clock';

/**
 * The demo's "you last checked" baseline, resolved to a real market snapshot.
 *
 * The baseline moment is DEMO.baselineAt (fixture: Monday 2026-07-20 10:00 IST).
 * A timestamp alone is worthless — if `last_seen_price_paise` were the current
 * price, "since you last checked" would read 0.00% and the demo prove nothing.
 * So the helper resolves the price/volume that genuinely belonged to that
 * baseline moment, from the same seeded tables the replay provider reads
 * (services/demo/provider.ts):
 *
 *   1. the 5-minute bar at-or-before the baseline moment — the exact 10:00
 *      print when intraday data exists for that day; else
 *   2. that day's daily-candle OPEN — the real first print, the closest honest
 *      daily snapshot to 10:00.
 *
 * Both paths return the most recent data preceding the baseline and both are
 * stored in the replay dataset by `npm run demo:seed`, so nothing here is
 * fabricated and nothing touches production user state — this is a demo fixture
 * only, aligned with the demo clock.
 */
export interface DemoBaselineSnapshot {
    pricePaise: number;
    volume: number;
    /** The app-clock moment the user "checked" — DEMO.baselineAt, verbatim. */
    dataTimestamp: string;
}

export async function demoBaselineSnapshot(instrumentId: string): Promise<DemoBaselineSnapshot | null> {
    if (!DEMO) return null;

    const baselineAt = DEMO.baselineAt;
    const moment = new Date(baselineAt);
    const day = baselineAt.slice(0, 10);

    const bar = await query(
        `SELECT close_paise, volume FROM intraday_bars
         WHERE instrument_id = $1 AND bar_ts <= $2
         ORDER BY bar_ts DESC LIMIT 1`,
        [instrumentId, moment.toISOString()]
    );
    if (bar.rows[0]) {
        return {
            pricePaise: parseInt(bar.rows[0].close_paise, 10),
            volume: parseInt(bar.rows[0].volume, 10),
            dataTimestamp: baselineAt,
        };
    }

    const dayCandle = await query(
        `SELECT open_paise FROM daily_candles
         WHERE instrument_id = $1 AND trade_date = $2`,
        [instrumentId, day]
    );
    if (dayCandle.rows[0]) {
        return {
            pricePaise: parseInt(dayCandle.rows[0].open_paise, 10),
            volume: 0,
            dataTimestamp: baselineAt,
        };
    }

    return null;
}