import { NormalizedQuote } from '../../models/quote';
import { getMarketStatus } from '../marketStatus';

/**
 * Yahoo Finance chart endpoint (the same undocumented API `yfinance` wraps).
 * Free, no account, but unofficial and ~15 minutes delayed for NSE — the
 * development/calibration source while Groww market-data access is pending.
 * Same provider contract as ../groww/provider.ts so the switch is one env var.
 */

const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

// An unofficial endpoint under load does not fail, it tarpits: responses go
// from 250ms to tens of seconds while the socket stays open. Without a
// deadline those requests accumulate, and since bcryptjs hashes in
// setImmediate chunks, a starved event loop turns a 100ms login into minutes.
// A slow provider must become a fast failure that routes into the snapshot
// fallback (BUILD_SPEC §5.2) instead of holding a request open.
const QUOTE_TIMEOUT_MS = 6_000;
const HISTORY_TIMEOUT_MS = 20_000;   // 170-day chunks are legitimately bigger

// Yahoo's NSE feed is delayed; freshness is judged net of this so a normal
// delayed tick doesn't read as STALE all session (metrics.service.ts).
export const YAHOO_FEED_DELAY_SEC = 15 * 60;

// Internal ids come from Groww's instrument master (EXCHANGE:SYMBOL). Yahoo
// uses .NS/.BO suffixes for equities and its own tickers for indices — only
// the index tickers verified against the live endpoint are listed; an
// unmapped index throws, which routes into the DATA_MISSING fallback rather
// than guessing a ticker and quietly returning the wrong series.
const INDEX_TICKERS: Record<string, string> = {
    'NSE:NIFTY': '^NSEI',
    'NSE:INDIAVIX': '^INDIAVIX',
    'NSE:BANKNIFTY': '^NSEBANK',
    'NSE:FINNIFTY': 'NIFTY_FIN_SERVICE.NS',
    'NSE:NIFTYIT': '^CNXIT',
    'NSE:NIFTYPHARMA': '^CNXPHARMA',
    'NSE:NIFTYAUTO': '^CNXAUTO',
    'NSE:NIFTYMETAL': '^CNXMETAL',
    'NSE:NIFTYFMCG': '^CNXFMCG',
    'NSE:NIFTYREALTY': '^CNXREALTY',
    'NSE:NIFTYMEDIA': '^CNXMEDIA',
    'NSE:NIFTYPSUBANK': '^CNXPSUBANK',
    'NSE:NIFTYENERGY': '^CNXENERGY',
};

// Index instruments from Groww's master that aren't in INDEX_TICKERS must
// not fall through to the equity `.NS` form — Yahoo would 404 on a wrong
// ticker, or worse, resolve it to something unrelated.
const INDEX_SYMBOL_RE = /^(NIFTY|BANKNIFTY|FINNIFTY|INDIAVIX|MIDCAP|SENSEX|BANKEX|BSE)/;

export function toYahooTicker(instrumentId: string): string {
    if (INDEX_TICKERS[instrumentId]) return INDEX_TICKERS[instrumentId];
    const [exchange, symbol] = instrumentId.split(':');
    if (INDEX_SYMBOL_RE.test(symbol)) {
        throw new Error(`No Yahoo ticker mapping for index ${instrumentId}`);
    }
    if (exchange === 'NSE') return `${symbol}.NS`;
    if (exchange === 'BSE') return `${symbol}.BO`;
    throw new Error(`No Yahoo ticker mapping for ${instrumentId}`);
}

async function chart(ticker: string, params: Record<string, string>, timeoutMs = QUOTE_TIMEOUT_MS): Promise<any> {
    const url = new URL(`${YAHOO_BASE}/${encodeURIComponent(ticker)}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    let res: Response;
    try {
        res = await fetch(url.toString(), {
            headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (e) {
        const err = e as Error;
        throw new Error(err.name === 'TimeoutError' || err.name === 'AbortError'
            ? `Yahoo chart ${ticker} timed out after ${timeoutMs}ms`
            : `Yahoo chart ${ticker}: ${err.message}`);
    }
    if (!res.ok) {
        throw new Error(`Yahoo chart ${ticker} -> ${res.status}`);
    }
    const data = await res.json();
    if (data.chart?.error) {
        throw new Error(`Yahoo chart ${ticker}: ${data.chart.error.code} ${data.chart.error.description || ''}`);
    }
    const result = data.chart?.result?.[0];
    if (!result) throw new Error(`Yahoo chart ${ticker}: empty result`);
    return result;
}

const toPaise = (rupees: number | null | undefined) => Math.round((rupees ?? 0) * 100);

const istDate = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

export async function fetchYahooQuote(instrumentId: string): Promise<NormalizedQuote> {
    const ticker = toYahooTicker(instrumentId);
    const result = await chart(ticker, { range: '5d', interval: '1d' });
    const meta = result.meta;
    const q = result.indicators?.quote?.[0] || {};
    const ts: number[] = result.timestamp || [];

    // Only bars with a close are real sessions (Yahoo pads with nulls).
    const bars = ts
        .map((t, i) => ({ date: istDate(new Date(t * 1000)), open: q.open?.[i], high: q.high?.[i], low: q.low?.[i], close: q.close?.[i], volume: q.volume?.[i] }))
        .filter(b => b.close != null);
    if (bars.length === 0) throw new Error(`Yahoo chart ${ticker}: no session bars`);

    const retrievedAt = new Date();
    let dataTimestamp = meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000) : retrievedAt;
    if (dataTimestamp.getTime() > retrievedAt.getTime()) {
        console.warn(`Clock skew: ${instrumentId} dataTimestamp is in the future — clamping to now`);
        dataTimestamp = retrievedAt;
    }

    // `meta.chartPreviousClose` is the close before the REQUESTED RANGE (here:
    // five sessions ago), not yesterday's — using it made every "today"
    // change a five-day change. The previous close is the bar before today's;
    // if the newest bar isn't today's session (pre-open, weekend), that bar
    // itself is the previous close and there is no session yet.
    const last = bars[bars.length - 1];
    const hasTodayBar = last.date === istDate(retrievedAt);
    const todayBar = hasTodayBar ? last : null;
    const prevClose = hasTodayBar ? (bars.length >= 2 ? bars[bars.length - 2].close : null) : last.close;

    return {
        instrumentId,
        lastPricePaise: toPaise(meta.regularMarketPrice ?? last.close),
        previousClosePaise: toPaise(prevClose),
        openPaise: toPaise(todayBar?.open),
        highPaise: toPaise(todayBar ? (meta.regularMarketDayHigh ?? todayBar.high) : null),
        lowPaise: toPaise(todayBar ? (meta.regularMarketDayLow ?? todayBar.low) : null),
        volume: todayBar ? (meta.regularMarketVolume ?? todayBar.volume ?? 0) : 0,
        dataTimestamp,
        retrievedAt,
        // Yahoo gives no session flag we trust; derive from the IST clock.
        marketStatus: getMarketStatus(retrievedAt),
        source: 'yahoo',
        feedDelaySec: YAHOO_FEED_DELAY_SEC,
    };
}

/**
 * Real intra-session bars for ONE past date, used to seed the replay demo
 * (services/demo/provider.ts). Yahoo keeps 5-minute history for roughly 60
 * days, which is what bounds how far back a demo date can be.
 */
export async function fetchYahooIntradayBars(
    instrumentId: string,
    istDate: string,
    interval: '1m' | '5m' | '15m' = '5m'
): Promise<{ ts: Date; openPaise: number; highPaise: number; lowPaise: number; closePaise: number; volume: number }[]> {
    const ticker = toYahooTicker(instrumentId);
    const start = new Date(`${istDate}T00:00:00+05:30`);
    const end = new Date(start.getTime() + 86_400_000);
    const result = await chart(ticker, {
        period1: String(Math.floor(start.getTime() / 1000)),
        period2: String(Math.floor(end.getTime() / 1000)),
        interval,
    }, HISTORY_TIMEOUT_MS);

    const ts: number[] = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const out: { ts: Date; openPaise: number; highPaise: number; lowPaise: number; closePaise: number; volume: number }[] = [];
    for (let i = 0; i < ts.length; i++) {
        // Yahoo pads the grid with nulls outside the session.
        if (q.close?.[i] == null) continue;
        out.push({
            ts: new Date(ts[i] * 1000),
            openPaise: toPaise(q.open?.[i] ?? q.close[i]),
            highPaise: toPaise(q.high?.[i] ?? q.close[i]),
            lowPaise: toPaise(q.low?.[i] ?? q.close[i]),
            closePaise: toPaise(q.close[i]),
            volume: q.volume?.[i] ?? 0,
        });
    }
    return out;
}

export async function fetchYahooDailyCandles(
    instrumentId: string,
    from: Date,
    to: Date
): Promise<{ tradeDate: string; openPaise: number; highPaise: number; lowPaise: number; closePaise: number; volume: number }[]> {
    const ticker = toYahooTicker(instrumentId);
    const result = await chart(ticker, {
        period1: String(Math.floor(from.getTime() / 1000)),
        period2: String(Math.floor(to.getTime() / 1000)),
        interval: '1d',
    }, HISTORY_TIMEOUT_MS);

    const ts: number[] = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const out: { tradeDate: string; openPaise: number; highPaise: number; lowPaise: number; closePaise: number; volume: number }[] = [];

    for (let i = 0; i < ts.length; i++) {
        // Yahoo pads holidays/partial rows with nulls — a candle with no close
        // is not a trading day and must not enter the statistics.
        if (q.close?.[i] == null) continue;
        // Bar timestamps are session-start in exchange time; take the IST date.
        const tradeDate = new Date(ts[i] * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        out.push({
            tradeDate,
            openPaise: toPaise(q.open?.[i] ?? q.close[i]),
            highPaise: toPaise(q.high?.[i] ?? q.close[i]),
            lowPaise: toPaise(q.low?.[i] ?? q.close[i]),
            closePaise: toPaise(q.close[i]),
            volume: q.volume?.[i] ?? 0,
        });
    }
    return out;
}
