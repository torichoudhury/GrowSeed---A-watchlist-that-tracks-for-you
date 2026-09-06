import { query } from '../../config/db';
import { loadCandles, VIX_INSTRUMENT_ID } from '../statistics.service';
import { detectRatioArtifacts, type RatioArtifact } from './splitDetector';
import { ADJUSTMENT_GUARD, BENCHMARK_INSTRUMENT_ID } from '../../config/thresholds';

/**
 * Sweeps stored history for corporate actions the NSE parsing missed and
 * records the actionable ones as SUSPECTED_ADJUSTMENT rows. Recording only:
 * those rows are not in the ('SPLIT','BONUS') set that re-bases prices, so an
 * inference can never rewrite history on its own. `npm run detect:splits`
 * reports them; `-- --apply` promotes them.
 */

export interface AdjustmentFinding {
    instrumentId: string;
    artifact: RatioArtifact;
    /** A SPLIT/BONUS already on the calendar within the window, if any. */
    knownEvent: string | null;
}

export interface AdjustmentScan {
    scanned: number;
    findings: AdjustmentFinding[];
    /** HIGH confidence with nothing on the calendar — what a human should look at. */
    actionable: AdjustmentFinding[];
    recorded: number;
}

export async function scanForMissedAdjustments(): Promise<AdjustmentScan> {
    // Companies only. Indices have no corporate actions, and the India VIX
    // legitimately falls 20% in a session — scanning them produces nothing but
    // noise for a human to dismiss.
    const res = await query(
        `SELECT id FROM (
             SELECT DISTINCT instrument_id AS id FROM watchlist_items
             UNION SELECT DISTINCT instrument_id FROM daily_candles
         ) t
         WHERE id <> $1 AND id <> $2
           AND id NOT IN (SELECT sector_index_id FROM stock_sectors WHERE sector_index_id IS NOT NULL)
         ORDER BY id`,
        [BENCHMARK_INSTRUMENT_ID, VIX_INSTRUMENT_ID]
    );
    const ids: string[] = res.rows.map(r => r.id);

    const findings: AdjustmentFinding[] = [];
    for (const instrumentId of ids) {
        const candles = await loadCandles(instrumentId);
        if (candles.length < 10) continue;
        for (const artifact of detectRatioArtifacts(candles)) {
            const near = await query(
                `SELECT event_type, event_date::text AS event_date FROM corporate_events
                 WHERE instrument_id = $1 AND event_type IN ('SPLIT','BONUS')
                   AND event_date BETWEEN $2::date - $3::int AND $2::date + $3::int
                 LIMIT 1`,
                [instrumentId, artifact.date, ADJUSTMENT_GUARD.KnownEventWindowDays]
            );
            findings.push({
                instrumentId,
                artifact,
                knownEvent: near.rows[0] ? `${near.rows[0].event_type} ${near.rows[0].event_date}` : null,
            });
        }
    }

    const actionable = findings.filter(f => f.artifact.confidence === 'HIGH' && !f.knownEvent);
    let recorded = 0;
    for (const f of actionable) {
        const a = f.artifact;
        const subject = `Detected ${a.label}: close moved ${(a.returnBps / 100).toFixed(2)}% `
            + `(implied factor ${a.impliedFactor.toFixed(4)}, error ${(a.relError * 100).toFixed(2)}%), `
            + `session traded clear of the old level, next session calm`;
        // UNIQUE (instrument_id, event_type, event_date, subject) makes repeat
        // scans idempotent.
        const ins = await query(
            `INSERT INTO corporate_events (instrument_id, event_type, event_date, ratio_num, ratio_den, amount_paise, subject, source)
             VALUES ($1, 'SUSPECTED_ADJUSTMENT', $2, NULL, NULL, NULL, $3, 'STATISTICAL')
             ON CONFLICT (instrument_id, event_type, event_date, subject) DO NOTHING
             RETURNING id`,
            [f.instrumentId, a.date, subject]
        );
        if (ins.rows.length) recorded++;
    }

    return { scanned: ids.length, findings, actionable, recorded };
}
