import { query } from '../../config/db';
import { FUNDAMENTALS } from '../../config/thresholds';
import { FundamentalsContext, EMPTY_FUNDAMENTALS } from '../eventDetection.service';
import { now as clockNow } from '../clock';

/** IST calendar date (YYYY-MM-DD) — every event_date in corporate_events is an
 * exchange-calendar date, so "today" must be the exchange's today (and in
 * replay mode, the replayed day's). */
export function istToday(now = clockNow()): string {
    return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function daysBetween(fromIso: string, toIso: string): number {
    return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);
}

/**
 * Resolve, per instrument, the company-internal events that fall inside the
 * approved windows around today. One query for the whole watchlist.
 */
export async function loadFundamentalsContext(instrumentIds: string[], now = clockNow()): Promise<Map<string, FundamentalsContext>> {
    const out = new Map<string, FundamentalsContext>();
    if (instrumentIds.length === 0) return out;

    const today = istToday(now);
    const lookBack = Math.max(FUNDAMENTALS.ResultsDaysAfter, FUNDAMENTALS.AnnouncementDays);
    const lookAhead = Math.max(FUNDAMENTALS.ResultsDaysBefore, FUNDAMENTALS.ExDividendDaysBefore);

    const res = await query(
        `SELECT instrument_id, event_type, event_date::text AS event_date, amount_paise, subject
         FROM corporate_events
         WHERE instrument_id = ANY($1)
           AND event_date BETWEEN ($2::date - $3::int) AND ($2::date + $4::int)
         ORDER BY event_date ASC`,
        [instrumentIds, today, lookBack, lookAhead]
    );

    for (const id of instrumentIds) out.set(id, { ...EMPTY_FUNDAMENTALS, recentAnnouncements: [] });

    for (const row of res.rows) {
        const ctx = out.get(row.instrument_id)!;
        const d = daysBetween(today, row.event_date); // >0 upcoming, <0 past

        switch (row.event_type) {
            case 'RESULTS':
                if (d >= -FUNDAMENTALS.ResultsDaysAfter && d <= FUNDAMENTALS.ResultsDaysBefore) {
                    // Prefer the nearest upcoming; else the most recent past.
                    if (ctx.resultsDaysFromNow === null || (d >= 0 && (ctx.resultsDaysFromNow < 0 || d < ctx.resultsDaysFromNow)) || (d < 0 && ctx.resultsDaysFromNow < 0 && d > ctx.resultsDaysFromNow)) {
                        ctx.resultsDate = row.event_date;
                        ctx.resultsDaysFromNow = d;
                    }
                }
                break;
            case 'DIVIDEND':
                if (d >= 0 && d <= FUNDAMENTALS.ExDividendDaysBefore && (ctx.exDividendDaysFromNow === null || d < ctx.exDividendDaysFromNow)) {
                    ctx.exDividendDate = row.event_date;
                    ctx.exDividendDaysFromNow = d;
                    ctx.dividendAmountPaise = row.amount_paise ? parseInt(row.amount_paise, 10) : null;
                }
                break;
            case 'SPLIT':
            case 'BONUS':
                if (d === 0) ctx.corporateActionToday = { type: row.event_type, subject: row.subject };
                break;
            case 'OTHER':
                if (d <= 0 && d >= -FUNDAMENTALS.AnnouncementDays && ctx.recentAnnouncements.length < 3) {
                    ctx.recentAnnouncements.push(row.subject);
                }
                break;
        }
    }
    return out;
}
