import { query } from '../../config/db';
import { NormalizedQuote } from '../../models/quote';
import { getMarketStatus } from '../marketStatus';
import { now as clockNow, DEMO } from '../clock';

/**
 * Replay provider: serves a real past session as if it were happening now.
 *
 * Every number it returns was actually traded — these are the day's real
 * 5-minute bars (table `intraday_bars`, filled by `npm run demo:seed`) and the
 * real previous close. The only fiction is the clock (services/clock.ts):
 * the bar that "just printed" is whichever one the replayed session has
 * reached, so price, day high/low and cumulative volume all build through the
 * session exactly as they did on the day.
 *
 * In demo mode, previousClosePaise is anchored to the BASELINE day's close
 * (DEMO.baselineAt) rather than the session's calendar previous close, so
 * "today" in the UI means "change since the baseline" — the whole point of
 * the demo's "what changed while you were away" story.
 *
 * An instrument with no bars for that day falls back to its daily candle, so
 * anything outside the demo watchlist still renders (statically) instead of
 * erroring.
 */

interface Bar {
    ts: number;
    open: number; high: number; low: number; close: number; volume: number;
}

interface DayData {
    bars: Bar[];
    previousClose: number;
    /** Close on the baseline day — the anchor for "today" in the UI. */
    baselineClose: number;
    /** Bar spacing in seconds — the replay's equivalent of a feed delay. */
    intervalSec: number;
    /** Set when there are no intraday bars — a static day from the daily candle. */
    dailyOnly: { open: number; high: number; low: number; close: number; volume: number; ts: number } | null;
}

// The replayed day never changes, so it is read once per instrument.
const cache = new Map<string, DayData | null>();

async function loadDay(instrumentId: string): Promise<DayData | null> {
    if (cache.has(instrumentId)) return cache.get(instrumentId)!;
    if (!DEMO) return null;

    const dayStart = `${DEMO.asOf}T00:00:00+05:30`;
    const dayEnd = `${DEMO.asOf}T23:59:59+05:30`;
    const baselineDate = DEMO.baselineAt.slice(0, 10);

    const [barsRes, prevRes, todayRes, baselineRes] = await Promise.all([
        query(
            `SELECT bar_ts, open_paise, high_paise, low_paise, close_paise, volume
             FROM intraday_bars
             WHERE instrument_id = $1 AND bar_ts BETWEEN $2 AND $3
             ORDER BY bar_ts ASC`,
            [instrumentId, dayStart, dayEnd]
        ),
        query(
            `SELECT close_paise FROM daily_candles
             WHERE instrument_id = $1 AND trade_date < $2
             ORDER BY trade_date DESC LIMIT 1`,
            [instrumentId, DEMO.asOf]
        ),
        query(
            `SELECT open_paise, high_paise, low_paise, close_paise, volume FROM daily_candles
             WHERE instrument_id = $1 AND trade_date = $2`,
            [instrumentId, DEMO.asOf]
        ),
        query(
            `SELECT close_paise FROM daily_candles
             WHERE instrument_id = $1 AND trade_date = $2::date`,
            [instrumentId, baselineDate]
        ),
    ]);

    const previousClose = prevRes.rows[0] ? parseInt(prevRes.rows[0].close_paise, 10) : 0;
    // Baseline close: the close on the day the user "last checked".
    // Falls back to previousClose if no daily candle exists for the baseline day.
    const baselineClose = baselineRes.rows[0]
        ? parseInt(baselineRes.rows[0].close_paise, 10)
        : previousClose;
    const bars: Bar[] = barsRes.rows.map(r => ({
        ts: new Date(r.bar_ts).getTime(),
        open: parseInt(r.open_paise, 10), high: parseInt(r.high_paise, 10),
        low: parseInt(r.low_paise, 10), close: parseInt(r.close_paise, 10),
        volume: parseInt(r.volume, 10),
    }));

    // A 5-minute bar is, by construction, up to 5 minutes behind the tape.
    // Declaring that as the feed's delay is what keeps freshness honest —
    // metrics judges age NET of it, so the replay reads LIVE rather than
    // drifting into STALE (and halving every score) between prints.
    const intervalSec = bars.length >= 2 ? Math.round((bars[1].ts - bars[0].ts) / 1000) : 300;

    const t = todayRes.rows[0];
    const day: DayData | null = bars.length === 0 && !t ? null : {
        bars,
        previousClose,
        baselineClose,
        intervalSec,
        dailyOnly: bars.length > 0 || !t ? null : {
            open: parseInt(t.open_paise, 10), high: parseInt(t.high_paise, 10),
            low: parseInt(t.low_paise, 10), close: parseInt(t.close_paise, 10),
            volume: parseInt(t.volume, 10),
            ts: Date.parse(`${DEMO.asOf}T15:30:00+05:30`),
        },
    };

    cache.set(instrumentId, day);
    return day;
}

export async function fetchDemoQuote(instrumentId: string): Promise<NormalizedQuote> {
    if (!DEMO) throw new Error('Demo provider used with DEMO_AS_OF unset');

    const day = await loadDay(instrumentId);
    if (!day) throw new Error(`No replay data for ${instrumentId} on ${DEMO.asOf}`);

    const retrievedAt = clockNow();
    const marketStatus = getMarketStatus(retrievedAt);

    if (day.dailyOnly) {
        const d = day.dailyOnly;
        const nowMs = retrievedAt.getTime();
        
        // Linearly interpolate the session so daily-only benchmarks have a non-zero "today" 
        // movement at 10 AM, matching the stocks' intraday data path.
        let simulatedPrice = d.close;
        const startMs = Date.parse(`${DEMO.asOf}T09:15:00+05:30`);
        const endMs = Date.parse(`${DEMO.asOf}T15:30:00+05:30`);

        if (nowMs < startMs) {
            simulatedPrice = day.baselineClose || day.previousClose || d.open;
        } else if (nowMs < endMs) {
            const fraction = (nowMs - startMs) / (endMs - startMs);
            simulatedPrice = Math.round(d.open + fraction * (d.close - d.open));
        }

        return {
            instrumentId,
            lastPricePaise: simulatedPrice, previousClosePaise: day.baselineClose || day.previousClose || d.open,
            openPaise: d.open, highPaise: d.high, lowPaise: d.low, volume: d.volume,
            dataTimestamp: new Date(Math.min(d.ts, nowMs)), retrievedAt,
            marketStatus, source: 'replay-daily', feedDelaySec: 0,
        };
    }

    // How far into the session are we? Everything up to and including that bar
    // has "happened"; nothing after it exists yet.
    const nowMs = retrievedAt.getTime();
    let cursor = -1;
    for (let i = 0; i < day.bars.length; i++) {
        if (day.bars[i].ts <= nowMs) cursor = i; else break;
    }

    // Before the first print: the session has not started, so the last traded
    // price is still the baseline close.
    if (cursor < 0) {
        const first = day.bars[0];
        return {
            instrumentId,
            lastPricePaise: day.baselineClose || day.previousClose || first.open,
            previousClosePaise: day.baselineClose || day.previousClose || first.open,
            openPaise: 0, highPaise: 0, lowPaise: 0, volume: 0,
            dataTimestamp: new Date(Math.min(first.ts, retrievedAt.getTime())), retrievedAt,
            marketStatus, source: 'replay', feedDelaySec: day.intervalSec,
        };
    }

    const seen = day.bars.slice(0, cursor + 1);
    const last = seen[seen.length - 1];
    return {
        instrumentId,
        lastPricePaise: last.close,
        previousClosePaise: day.baselineClose || day.previousClose || seen[0].open,
        openPaise: seen[0].open,
        highPaise: Math.max(...seen.map(b => b.high)),
        lowPaise: Math.min(...seen.map(b => b.low)),
        volume: seen.reduce((a, b) => a + b.volume, 0),
        dataTimestamp: new Date(last.ts),
        retrievedAt,
        marketStatus,
        source: 'replay',
        feedDelaySec: day.intervalSec,
    };
}

/** Bars are immutable; only a re-seed invalidates them. */
export function clearDemoCache(): void {
    cache.clear();
}

/**
 * Daily candles for the chart endpoint, read from the SAME seeded table the
 * replay quotes come from — so in demo mode the price chart and the live
 * quote live in the same past. Seeded by `npm run demo:seed` (which fetches
 * the real history once); nothing here calls a live provider.
 */
export async function fetchDemoDailyCandles(
    instrumentId: string,
    from: Date,
    to: Date
): Promise<{ tradeDate: string; openPaise: number; highPaise: number; lowPaise: number; closePaise: number; volume: number }[]> {
    if (!DEMO) throw new Error('Demo provider used with DEMO_AS_OF unset');
    const startDay = from.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const endDay = to.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const result = await query(
        `SELECT trade_date::text AS trade_date, open_paise, high_paise, low_paise, close_paise, volume
         FROM daily_candles
         WHERE instrument_id = $1 AND trade_date >= $2::date AND trade_date <= $3::date
         ORDER BY trade_date ASC`,
        [instrumentId, startDay, endDay]
    );
    return result.rows.map(r => ({
        tradeDate: r.trade_date, // IST date, already text
        openPaise: parseInt(r.open_paise, 10),
        highPaise: parseInt(r.high_paise, 10),
        lowPaise: parseInt(r.low_paise, 10),
        closePaise: parseInt(r.close_paise, 10),
        volume: parseInt(r.volume, 10),
    }));
}
