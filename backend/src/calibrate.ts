import { query, pool } from './config/db';
import { connectRedis, redisClient } from './config/redis';
import {
    Candle, loadCandles, computeStockStatistics, computeMarketRegime, VIX_INSTRUMENT_ID,
} from './services/statistics.service';
import { calculateMetrics, computeRegime } from './services/metrics.service';
import { detectEvents, EventType, FundamentalsContext, EMPTY_FUNDAMENTALS } from './services/eventDetection.service';
import { calculateScore } from './services/attentionScore.service';
import { generateExplanations } from './services/explanation.service';
import { BENCHMARK_INSTRUMENT_ID, SEVERITY_BANDS, FUNDAMENTALS } from './config/thresholds';
import { SCORE_CALIBRATION } from './config/calibration';
import { NormalizedQuote, MarketStatus } from './models/quote';

/**
 * Calibration harness (`npm run calibrate`): replays the exact production
 * scoring pipeline over every historical stock-day we hold, using only data
 * that existed BEFORE that day, and reports the empirical distribution of
 * scores and event firings. Thresholds are then set to target base rates
 * instead of guessed — e.g. "CRITICAL should be ~1–2% of stock-days".
 *
 * Persona replayed: a daily checker (baseline = previous close), which is the
 * persona for which "since your last visit" == "today". Nothing is written.
 */

const WARMUP_DAYS = 120;              // market model needs 90, windows 30
const TARGET_BASE_RATES = {           // share of stock-days AT OR ABOVE each band
    CRITICAL: 0.015,
    HIGH: 0.06,
    MEDIUM: 0.15,
    LOW: 0.35,
};

interface StockDayResult {
    instrumentId: string; date: string; todayBps: number;
    score: number; rawScore: number; severity: string; events: EventType[]; reasons: string[];
}

function quoteFromCandle(instrumentId: string, today: Candle, prev: Candle): NormalizedQuote {
    const ts = new Date(`${today.date}T10:00:00Z`); // 15:30 IST — session close
    return {
        instrumentId,
        lastPricePaise: today.close, previousClosePaise: prev.close,
        openPaise: today.open, highPaise: today.high, lowPaise: today.low, volume: today.volume,
        dataTimestamp: ts, retrievedAt: ts,
        marketStatus: MarketStatus.CLOSED, source: 'replay',
    };
}

async function loadEventsByInstrument(ids: string[]): Promise<Map<string, { type: string; date: string; amount: number | null; subject: string }[]>> {
    const res = await query(
        `SELECT instrument_id, event_type, event_date::text AS event_date, amount_paise, subject
         FROM corporate_events WHERE instrument_id = ANY($1) ORDER BY event_date`,
        [ids]
    );
    const out = new Map<string, any[]>();
    for (const r of res.rows) {
        (out.get(r.instrument_id) ?? out.set(r.instrument_id, []).get(r.instrument_id)!)
            .push({ type: r.event_type, date: r.event_date, amount: r.amount_paise ? parseInt(r.amount_paise, 10) : null, subject: r.subject });
    }
    return out;
}

function fundamentalsFor(events: { type: string; date: string; amount: number | null; subject: string }[] | undefined, today: string): FundamentalsContext {
    const ctx: FundamentalsContext = { ...EMPTY_FUNDAMENTALS, recentAnnouncements: [] };
    if (!events) return ctx;
    const dayDiff = (d: string) => Math.round((Date.parse(d) - Date.parse(today)) / 86_400_000);
    for (const e of events) {
        const d = dayDiff(e.date);
        if (e.type === 'RESULTS' && d >= -FUNDAMENTALS.ResultsDaysAfter && d <= FUNDAMENTALS.ResultsDaysBefore) {
            if (ctx.resultsDaysFromNow === null || Math.abs(d) < Math.abs(ctx.resultsDaysFromNow)) { ctx.resultsDate = e.date; ctx.resultsDaysFromNow = d; }
        } else if (e.type === 'DIVIDEND' && d >= 0 && d <= FUNDAMENTALS.ExDividendDaysBefore) {
            ctx.exDividendDate = e.date; ctx.exDividendDaysFromNow = d; ctx.dividendAmountPaise = e.amount;
        } else if ((e.type === 'SPLIT' || e.type === 'BONUS') && d === 0) {
            ctx.corporateActionToday = { type: e.type, subject: e.subject };
        } else if (e.type === 'OTHER' && d <= 0 && d >= -FUNDAMENTALS.AnnouncementDays && ctx.recentAnnouncements.length < 3) {
            ctx.recentAnnouncements.push(e.subject);
        }
    }
    return ctx;
}

async function main() {
    await connectRedis();

    const watched = await query('SELECT DISTINCT instrument_id FROM watchlist_items ORDER BY 1');
    const stockIds: string[] = watched.rows.map(r => r.instrument_id);
    const sectorRes = await query('SELECT instrument_id, sector_index_id FROM stock_sectors WHERE instrument_id = ANY($1)', [stockIds]);
    const sectorOf = new Map<string, string | null>(sectorRes.rows.map(r => [r.instrument_id, r.sector_index_id]));

    const bench = await loadCandles(BENCHMARK_INSTRUMENT_ID);
    const vix = await loadCandles(VIX_INSTRUMENT_ID);
    const candlesById = new Map<string, Candle[]>();
    for (const id of stockIds) candlesById.set(id, await loadCandles(id));
    for (const sid of new Set(Array.from(sectorOf.values()).filter(Boolean) as string[])) candlesById.set(sid, await loadCandles(sid));
    const eventsById = await loadEventsByInstrument(stockIds);

    const benchByDate = new Map(bench.map(c => [c.date, c]));
    const results: StockDayResult[] = [];
    const eventCounts = new Map<string, number>();

    // Trading days = benchmark's dates; each stock-day uses history strictly before it.
    const days = bench.map(c => c.date);
    for (let t = WARMUP_DAYS; t < days.length; t++) {
        const date = days[t];
        const benchHist = bench.slice(0, t + 1);
        const regimeRow = computeMarketRegime(benchHist.slice(0, t), vix.filter(c => c.date < date));
        const regime = computeRegime(regimeRow);

        // Breadth for this day across the replayed universe.
        const daySigns: number[] = [];
        const perStock: { id: string; quote: NormalizedQuote; stats: any; sectorQuote: NormalizedQuote | null; sectorId: string | null }[] = [];
        for (const id of stockIds) {
            const cs = candlesById.get(id)!;
            const idx = cs.findIndex(c => c.date === date);
            if (idx < 1) continue;
            const hist = cs.slice(0, idx); // strictly before today
            if (hist.length < 30) continue;
            const sectorId = sectorOf.get(id) ?? null;
            const sectorCs = sectorId ? candlesById.get(sectorId) ?? null : null;
            const stats = computeStockStatistics(id, hist, benchHist.slice(0, t), sectorCs ? sectorCs.filter(c => c.date < date) : null);
            if (!stats) continue;
            const quote = quoteFromCandle(id, cs[idx], cs[idx - 1]);
            let sectorQuote: NormalizedQuote | null = null;
            if (sectorCs) {
                const si = sectorCs.findIndex(c => c.date === date);
                if (si >= 1) sectorQuote = quoteFromCandle(sectorId!, sectorCs[si], sectorCs[si - 1]);
            }
            daySigns.push(Math.sign(cs[idx].close - cs[idx - 1].close));
            perStock.push({ id, quote, stats, sectorQuote, sectorId });
        }
        const ups = daySigns.filter(s => s > 0).length, downs = daySigns.filter(s => s < 0).length;
        const breadthFor = (s: number) => daySigns.length >= 5 ? (s > 0 ? ups : s < 0 ? downs : 0) / daySigns.length : 0;

        const benchToday = benchByDate.get(date)!;
        const benchQuote = quoteFromCandle(BENCHMARK_INSTRUMENT_ID, benchToday, bench[t - 1]);

        for (const p of perStock) {
            // Daily-checker baseline: last seen at yesterday's close.
            const userState = { last_seen_price_paise: p.quote.previousClosePaise, last_seen_at: new Date(Date.parse(date) - 86_400_000), is_initial_state: false };
            const fundamentals = fundamentalsFor(eventsById.get(p.id), date);
            const metrics = calculateMetrics(p.quote, p.stats, userState, benchQuote, p.sectorQuote, p.sectorId, regime);
            const events = detectEvents(metrics, p.quote, p.stats, userState, [], fundamentals);
            const { score, severity, breakdown } = calculateScore(metrics, events, { fundamentals, breadthSameDirection: breadthFor(Math.sign(metrics.todayChangeBps)) });
            const reasons = generateExplanations(events, metrics, userState, [], { fundamentals });
            results.push({ instrumentId: p.id, date, todayBps: metrics.todayChangeBps, score, rawScore: breakdown.rawScore, severity, events, reasons });
            for (const e of events) eventCounts.set(e, (eventCounts.get(e) ?? 0) + 1);
        }
    }

    // ── Report ─────────────────────────────────────────────────────────────
    const n = results.length;
    const raws = results.map(r => r.rawScore).sort((a, b) => a - b);
    const q = (p: number) => raws[Math.min(n - 1, Math.floor(p * n))];
    console.log(`\nReplayed ${n} stock-days across ${stockIds.length} stocks, ${days.length - WARMUP_DAYS} trading days (daily-checker persona).\n`);

    console.log('RAW score distribution (pre-calibration):');
    for (const p of [0.5, 0.75, 0.9, 0.95, 0.98, 0.99]) console.log(`  p${Math.round(p * 100)}: ${q(p)}`);
    console.log(`  max: ${raws[n - 1]}`);

    console.log(`\nCALIBRATED bands → realized base rate (anchors from ${SCORE_CALIBRATION.calibratedAt}; targets in brackets):`);
    for (const b of SEVERITY_BANDS.filter(b => b.min > 0)) {
        const share = results.filter(r => r.score >= b.min).length / n;
        const target = (TARGET_BASE_RATES as any)[b.label];
        console.log(`  ${b.label.padEnd(9)} ≥${String(b.min).padStart(3)}  ${(share * 100).toFixed(2)}%  [target ${(target * 100).toFixed(1)}%]`);
    }

    console.log('\nAnchors that would hit the targets on THIS history (paste into config/calibration.ts if signals changed):');
    const anchorFor = (rate: number) => raws[Math.max(0, Math.floor((1 - rate) * n))];
    const anchors: [number, number][] = [
        [0, 0],
        [anchorFor(TARGET_BASE_RATES.LOW), 21],
        [anchorFor(TARGET_BASE_RATES.MEDIUM), 41],
        [anchorFor(TARGET_BASE_RATES.HIGH), 61],
        [anchorFor(TARGET_BASE_RATES.CRITICAL), 81],
        [raws[n - 1], 100],
    ];
    console.log('  anchors:', JSON.stringify(anchors));
    const monotone = anchors.every((a, i) => i === 0 || a[0] > anchors[i - 1][0]);
    if (!monotone) console.log('  WARNING: anchors are not strictly increasing — too little history for these targets.');

    console.log('\nEvent firing rates (share of stock-days):');
    for (const [e, c] of Array.from(eventCounts.entries()).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${e.padEnd(28)} ${((c / n) * 100).toFixed(2)}%`);
    }

    console.log('\nTop 12 stock-days — do these correspond to real events?');
    for (const r of [...results].sort((a, b) => b.score - a.score).slice(0, 12)) {
        console.log(`  ${r.date} ${r.instrumentId.padEnd(15)} ${(r.todayBps / 100).toFixed(2).padStart(7)}%  score ${String(r.score).padStart(3)} (raw ${String(r.rawScore).padStart(2)}) ${r.severity.padEnd(8)} ${r.reasons.join(' / ')}`);
    }

    console.log('\nPer-stock mean score and share of days ≥ MEDIUM:');
    for (const id of stockIds) {
        const rs = results.filter(r => r.instrumentId === id);
        if (!rs.length) continue;
        const meanScore = rs.reduce((a, r) => a + r.score, 0) / rs.length;
        const medShare = rs.filter(r => r.score >= 41).length / rs.length;
        console.log(`  ${id.padEnd(15)} mean ${meanScore.toFixed(1).padStart(5)}  ≥MEDIUM ${(medShare * 100).toFixed(1).padStart(5)}%`);
    }
}

main()
    .catch(err => { console.error('Calibration failed:', err); process.exitCode = 1; })
    .finally(async () => { await pool.end(); if (redisClient.isOpen) await redisClient.quit(); });
