import { parse } from 'csv-parse/sync';
import { growwGet } from './client';
import { query } from '../../config/db';
import { NormalizedQuote, MarketStatus } from '../../models/quote';
import { getMarketStatus } from '../marketStatus';

const INSTRUMENT_CSV_URL = 'https://growwapi-assets.groww.in/instruments/instrument.csv';

function splitInstrumentId(instrumentId: string): { exchange: string; symbol: string } {
    const [exchange, symbol] = instrumentId.split(':');
    return { exchange, symbol };
}

/** Groww's live-quote timestamp format isn't pinned down in their docs —
 * parse defensively rather than assume seconds vs milliseconds vs ISO. */
function parseGrowwTimestamp(value: unknown, fallback: Date): Date {
    if (typeof value === 'string') {
        const parsed = Date.parse(value);
        if (!Number.isNaN(parsed)) return new Date(parsed);
    }
    if (typeof value === 'number' && value > 0) {
        return new Date(value < 10_000_000_000 ? value * 1000 : value);
    }
    return fallback;
}

function toIstDateTimeString(d: Date): string {
    // yyyy-MM-dd HH:mm:ss in IST, as Groww's historical-candles examples show.
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    }).formatToParts(d);
    const get = (t: string) => parts.find(p => p.type === t)?.value;
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

/** GET /live-data/quote (https://groww.in/trade-api/docs/curl/live-data). */
export async function fetchGrowwQuote(instrumentId: string): Promise<NormalizedQuote> {
    const { exchange, symbol } = splitInstrumentId(instrumentId);
    const payload = await growwGet('/live-data/quote', {
        exchange,
        segment: 'CASH',
        trading_symbol: symbol,
    });

    const retrievedAt = new Date();
    // Groww's quote payload doesn't include a market-status field, so we
    // derive it from the IST session clock rather than trusting the feed.
    const marketStatus = getMarketStatus(retrievedAt);

    let dataTimestamp = parseGrowwTimestamp(payload.last_trade_time, retrievedAt);
    if (dataTimestamp.getTime() > retrievedAt.getTime()) {
        console.warn(`Clock skew: ${instrumentId} dataTimestamp is in the future — clamping to now`);
        dataTimestamp = retrievedAt;
    }

    return {
        instrumentId,
        lastPricePaise: Math.round((payload.last_price ?? 0) * 100),
        // The live-quote OHLC block's "close" is the PREVIOUS session's
        // close during live trading — that's exactly what we need here.
        previousClosePaise: Math.round((payload.ohlc?.close ?? 0) * 100),
        openPaise: Math.round((payload.ohlc?.open ?? 0) * 100),
        highPaise: Math.round((payload.ohlc?.high ?? 0) * 100),
        lowPaise: Math.round((payload.ohlc?.low ?? 0) * 100),
        volume: payload.volume ?? 0,
        dataTimestamp,
        retrievedAt,
        marketStatus,
        source: 'groww',
    };
}

/**
 * GET /historical/candles (https://groww.in/trade-api/docs/curl/backtesting).
 * Daily interval, chunked to <=170 days per call — Groww caps a single
 * request's span (180 days for daily/weekly/monthly) well short of the
 * ~year of history the statistics job needs for a 52-week window.
 */
export async function fetchGrowwDailyCandles(
    instrumentId: string,
    from: Date,
    to: Date
): Promise<{ tradeDate: string; openPaise: number; highPaise: number; lowPaise: number; closePaise: number; volume: number }[]> {
    const { exchange, symbol } = splitInstrumentId(instrumentId);
    const growwSymbol = `${exchange}-${symbol}`;
    const CHUNK_DAYS = 170;

    const chunks: { from: Date; to: Date }[] = [];
    let chunkStart = new Date(from);
    while (chunkStart < to) {
        const chunkEnd = new Date(Math.min(chunkStart.getTime() + CHUNK_DAYS * 86_400_000, to.getTime()));
        chunks.push({ from: chunkStart, to: chunkEnd });
        chunkStart = new Date(chunkEnd.getTime() + 86_400_000);
    }

    const out: { tradeDate: string; openPaise: number; highPaise: number; lowPaise: number; closePaise: number; volume: number }[] = [];
    for (const c of chunks) {
        const payload = await growwGet('/historical/candles', {
            exchange,
            segment: 'CASH',
            groww_symbol: growwSymbol,
            start_time: toIstDateTimeString(c.from),
            end_time: toIstDateTimeString(c.to),
            candle_interval: '1day',
        });

        for (const row of payload.candles || []) {
            const [ts, open, high, low, close, volume] = row;
            const tradeDate = typeof ts === 'string' ? ts.slice(0, 10) : new Date(ts).toISOString().slice(0, 10);
            out.push({
                tradeDate,
                openPaise: Math.round(open * 100),
                highPaise: Math.round(high * 100),
                lowPaise: Math.round(low * 100),
                closePaise: Math.round(close * 100),
                volume: volume ?? 0,
            });
        }
    }
    return out;
}

interface GrowwInstrumentRow {
    exchange: string;
    trading_symbol: string;
    name: string;
    instrument_type: string;
    segment: string;
    series: string;
}

/**
 * Groww exposes no search API — only a bulk CSV of every tradable
 * instrument (https://groww.in/trade-api/docs/curl/instruments). This
 * downloads and upserts it into our own `instruments` table so `GET
 * /api/instruments/search` can query it locally, and marks anything that
 * dropped out of the feed as DELISTED (architecture doc §61.B2).
 */
export async function syncInstrumentsFromGroww(): Promise<{ upserted: number; delisted: number }> {
    const res = await fetch(INSTRUMENT_CSV_URL);
    if (!res.ok) throw new Error(`Instrument CSV fetch failed: ${res.status}`);
    const csvText = await res.text();

    const rows: GrowwInstrumentRow[] = parse(csvText, { columns: true, skip_empty_lines: true });

    // Cash-market equities and index quotes only. `instrument_type === 'EQ'`
    // alone is too loose — it also covers listed bonds/NCDs (series N0/N1/…),
    // SGBs (series SG/GB), rights entitlements, etc. `series === 'EQ'` is
    // NSE/BSE's actual "this is a plain equity share" marker; IDX rows carry
    // no series at all, so that check only applies to the EQ branch.
    const relevant = rows.filter(r =>
        r.segment === 'CASH' &&
        (r.instrument_type === 'IDX' || (r.instrument_type === 'EQ' && r.series === 'EQ'))
    );

    // Dedupe BEFORE batching (not per-batch) so every batch is dense — a
    // dropped duplicate must never leave a gap in a later batch's $N
    // numbering, which silently misaligns every param after it.
    const seenIds = new Set<string>();
    const deduped: { instrumentId: string; symbolForId: string; exchange: string; name: string }[] = [];
    for (const r of relevant) {
        const symbolForId = r.trading_symbol.replace(/\s+/g, '').toUpperCase();
        const instrumentId = `${r.exchange}:${symbolForId}`;
        if (seenIds.has(instrumentId)) continue; // same-exchange duplicate row, keep first
        seenIds.add(instrumentId);
        deduped.push({ instrumentId, symbolForId, exchange: r.exchange, name: r.name || symbolForId });
    }

    const BATCH_SIZE = 500;
    for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
        const batch = deduped.slice(i, i + BATCH_SIZE);
        const values: string[] = [];
        const params: any[] = [];
        batch.forEach((r, idx) => {
            const base = idx * 4;
            values.push(`($${base + 1}::text, $${base + 2}::text, $${base + 3}::text, $${base + 4}::text, 'ACTIVE', now())`);
            params.push(r.instrumentId, r.symbolForId, r.exchange, r.name);
        });

        await query(
            `INSERT INTO instruments (instrument_id, symbol, exchange, name, status, updated_at)
             VALUES ${values.join(',')}
             ON CONFLICT (instrument_id) DO UPDATE SET
               name = EXCLUDED.name, status = 'ACTIVE', updated_at = now()`,
            params
        );
    }

    let delisted = 0;
    // Sanity floor: only trust this feed to delist things if it actually
    // returned a plausible universe — a truncated/empty CSV must not wipe
    // out every instrument's status.
    if (seenIds.size > 500) {
        const delistRes = await query(
            `UPDATE instruments SET status = 'DELISTED', updated_at = now()
             WHERE status = 'ACTIVE' AND NOT (instrument_id = ANY($1))
             RETURNING instrument_id`,
            [Array.from(seenIds)]
        );
        delisted = delistRes.rowCount ?? 0;
    }

    return { upserted: seenIds.size, delisted };
}
