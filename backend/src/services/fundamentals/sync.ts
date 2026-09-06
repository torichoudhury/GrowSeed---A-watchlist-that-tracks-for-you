import { query, withTransaction } from '../../config/db';
import { withJobLock } from '../jobLock';
import {
    fetchCorporateActions, fetchEventCalendar, fetchAnnouncements, parseNseDate, politeDelay,
} from '../nse/client';
import { parseCorporateActionSubject, classifyMeetingPurpose, priceAdjustmentFactor } from './parse';

/**
 * Pulls company-internal events for every instrument anyone is watching and
 * upserts them into corporate_events. Then applies any not-yet-applied
 * split/bonus to that instrument's stored history so a 1:1 bonus never
 * shows up as a fabricated -50% move (architecture doc §61.B3).
 */

async function watchedNseSymbols(): Promise<{ instrumentId: string; symbol: string }[]> {
    const res = await query(
        `SELECT DISTINCT i.instrument_id, i.symbol
         FROM watchlist_items wi JOIN instruments i ON i.instrument_id = wi.instrument_id
         WHERE i.exchange = 'NSE'`
    );
    return res.rows.map(r => ({ instrumentId: r.instrument_id, symbol: r.symbol }));
}

async function upsertEvent(e: {
    instrumentId: string; eventType: string; eventDate: string; ratioNum: number | null; ratioDen: number | null;
    amountPaise: number | null; subject: string; source: string;
}): Promise<void> {
    await query(
        `INSERT INTO corporate_events
           (instrument_id, event_type, event_date, ratio_num, ratio_den, amount_paise, subject, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (instrument_id, event_type, event_date, subject) DO NOTHING`,
        [e.instrumentId, e.eventType, e.eventDate, e.ratioNum, e.ratioDen, e.amountPaise, e.subject.slice(0, 500), e.source]
    );
}

export const FUNDAMENTALS_JOB = 'fundamentals-sync';
const FUNDAMENTALS_LOCK_MS = 30 * 60 * 1000;

/**
 * Locked here rather than at the caller, because there are two callers: the
 * 18:30 cron and `npm run sync:fundamentals`. Only the cron used to take the
 * lock, so an operator running the script during the job double-applied every
 * pending corporate action. Returns null when another run holds the lock.
 */
export function syncFundamentalsForWatched() {
    return withJobLock(FUNDAMENTALS_JOB, FUNDAMENTALS_LOCK_MS, runFundamentalsSync);
}

async function runFundamentalsSync(): Promise<{ instruments: number; events: number; adjusted: number }> {
    const targets = await watchedNseSymbols();
    let events = 0;

    for (const { instrumentId, symbol } of targets) {
        try {
            const actions = await fetchCorporateActions(symbol);
            for (const a of actions) {
                const exDate = parseNseDate(a.exDate) || parseNseDate(a.recDate);
                if (!exDate) continue;
                const parsed = parseCorporateActionSubject(a.subject);
                await upsertEvent({
                    instrumentId, eventType: parsed.eventType, eventDate: exDate,
                    ratioNum: parsed.ratioNum, ratioDen: parsed.ratioDen, amountPaise: parsed.amountPaise,
                    subject: a.subject, source: 'NSE_CA',
                });
                events++;
            }
            await politeDelay();

            const meetings = await fetchEventCalendar(symbol);
            for (const m of meetings) {
                const date = parseNseDate(m.date);
                if (!date) continue;
                await upsertEvent({
                    instrumentId, eventType: classifyMeetingPurpose(m.purpose), eventDate: date,
                    ratioNum: null, ratioDen: null, amountPaise: null,
                    subject: `${m.purpose}: ${m.bm_desc}`.slice(0, 500), source: 'NSE_EVENT_CAL',
                });
                events++;
            }
            await politeDelay();

            // Announcements are noisy free text; keep only categories that plausibly
            // move a price and store them as OTHER context.
            const announcements = await fetchAnnouncements(symbol);
            for (const an of announcements.slice(0, 40)) {
                const date = parseNseDate(an.an_dt);
                if (!date) continue;
                // NSE wraps every filing in "<Company> has informed the Exchange
                // about <Category> - ..." — strip that so the 80 chars a reason
                // line can show are the substance, not the boilerplate.
                const substance = (an.attchmntText || an.desc || '')
                    .replace(/^.*?has informed the Exchange (?:about|regarding)\s*/i, '')
                    .replace(/^(?:Disclosure under Regulation \d+[^-–:]*[-–:]\s*)/i, '')
                    .replace(/^In continuation to our earlier letter[^,]*,\s*/i, '')
                    .trim();
                const text = substance ? `${an.desc}: ${substance}` : an.desc;
                if (!/result|buy ?back|acquisition|merger|demerger|fund ?raising|rights|preferential|order|contract|rating|issuance|notes|bond/i.test(text)) continue;
                await upsertEvent({
                    instrumentId, eventType: 'OTHER', eventDate: date,
                    ratioNum: null, ratioDen: null, amountPaise: null,
                    subject: text, source: 'NSE_ANN',
                });
                events++;
            }
            await politeDelay();
        } catch (e) {
            console.error(`fundamentals: ${symbol} failed — ${(e as Error).message}`);
        }
    }

    const adjusted = await applyPendingPriceAdjustments();
    return { instruments: targets.length, events, adjusted };
}

/**
 * For each SPLIT/BONUS not yet applied whose ex-date falls inside our stored
 * history, scale every candle BEFORE the ex-date by the adjustment factor so
 * the series is continuous, and re-base user_stock_state baselines that
 * pre-date the event the same way. Idempotent via applied_to_history.
 */
// A real split or bonus moves the price by a clean ratio inside this band.
// Anything outside it is a mis-parsed subject line, and acting on it would
// rewrite a year of history by an arbitrary factor.
const MIN_ADJUSTMENT_FACTOR = 0.01;
const MAX_ADJUSTMENT_FACTOR = 100;

export async function applyPendingPriceAdjustments(): Promise<number> {
    const pending = await query(
        `SELECT id, instrument_id, event_type, event_date::text AS event_date, ratio_num, ratio_den
         FROM corporate_events
         WHERE event_type IN ('SPLIT','BONUS') AND applied_to_history = false
           AND ratio_num IS NOT NULL AND ratio_den IS NOT NULL`
    );

    let applied = 0;
    for (const ev of pending.rows) {
        const factor = priceAdjustmentFactor({
            eventType: ev.event_type, ratioNum: ev.ratio_num, ratioDen: ev.ratio_den, amountPaise: null,
        });

        // Sanity bound first, for every event type. The previous form was
        // `!factor || factor <= 0 || factor >= 1.000001 && type === 'BONUS'`,
        // where `&&` binds tighter than `||` and the inner guard only skipped
        // BONUS — so a SPLIT parsed with an inverted ratio scaled the whole
        // stored history upward and then marked itself applied.
        if (factor === null || !Number.isFinite(factor)
            || factor < MIN_ADJUSTMENT_FACTOR || factor > MAX_ADJUSTMENT_FACTOR) {
            console.warn(`price-adjust: skipping ${ev.instrument_id} ${ev.event_type} ${ev.event_date} — implausible factor ${factor}`);
            continue;
        }
        // A bonus issue can only ever lower the price.
        if (ev.event_type === 'BONUS' && factor >= 1) {
            console.warn(`price-adjust: skipping ${ev.instrument_id} BONUS ${ev.event_date} — factor ${factor} would raise the price`);
            continue;
        }

        // Claim and re-base in ONE transaction. Claiming first means a crash
        // rolls back to "not applied" rather than leaving history scaled but
        // unflagged, which the next run would scale a second time (factor²).
        const didApply = await withTransaction(async tx => {
            const claim = await tx.query(
                `UPDATE corporate_events SET applied_to_history = true
                 WHERE id = $1 AND applied_to_history = false
                 RETURNING id`,
                [ev.id]
            );
            if ((claim.rowCount ?? 0) === 0) return false;   // another run got there first

            // Only meaningful if we hold candles from before the ex-date. The
            // claim still stands: there is nothing to re-base, now or later.
            const hasPre = await tx.query(
                'SELECT 1 FROM daily_candles WHERE instrument_id = $1 AND trade_date < $2::date LIMIT 1',
                [ev.instrument_id, ev.event_date]
            );
            if ((hasPre.rowCount ?? 0) === 0) return false;

            // Integer-safe: scale in SQL with ROUND, volume scales inversely.
            await tx.query(
                `UPDATE daily_candles SET
                   open_paise  = ROUND(open_paise  * $3::numeric),
                   high_paise  = ROUND(high_paise  * $3::numeric),
                   low_paise   = ROUND(low_paise   * $3::numeric),
                   close_paise = ROUND(close_paise * $3::numeric),
                   volume      = ROUND(volume / $3::numeric)
                 WHERE instrument_id = $1 AND trade_date < $2::date`,
                [ev.instrument_id, ev.event_date, factor]
            );
            // The user's baseline volume was left un-adjusted here, so every
            // volume comparison against a pre-split baseline was off by the
            // ratio until the next acknowledge.
            await tx.query(
                `UPDATE user_stock_state SET
                   last_seen_price_paise = ROUND(last_seen_price_paise * $3::numeric),
                   last_seen_volume      = ROUND(last_seen_volume / $3::numeric),
                   updated_at = now()
                 WHERE instrument_id = $1 AND last_seen_data_timestamp < $2::date`,
                [ev.instrument_id, ev.event_date, factor]
            );
            return true;
        });

        if (didApply) applied++;
    }
    return applied;
}
