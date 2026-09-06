import { query } from '../config/db';
import { BENCHMARK_INSTRUMENT_ID, HORIZONS } from '../config/thresholds';
import { artifactIndices } from './fundamentals/splitDetector';
import { historyCutoff } from './clock';

/**
 * Statistics (BUILD_SPEC §6, extended for the three-component "meaningful
 * change" model). The math lives in pure functions over candle arrays so the
 * nightly job, the on-demand rebuild AND the calibration harness all run the
 * identical code — a threshold tuned on the replay is a threshold tuned on
 * production behaviour.
 *
 * Money stays integer paise and percentages integer bps in storage;
 * dimensionless ratios are stored x10000. Float arithmetic only appears
 * inside the estimators, never on a price.
 */

const EWMA_LAMBDA = 0.94;
const MARKET_MODEL_WINDOW = 90;
const CORRELATION_WINDOW = 60;
const YEAR_WINDOW = 250;
export const VIX_INSTRUMENT_ID = 'NSE:INDIAVIX';

export interface Candle { date: string; open: number; high: number; low: number; close: number; volume: number; }
export interface DailyReturn { date: string; bps: number; }

/** Same shape as the stock_statistics row, so metrics.service consumes the
 * output of this function and a DB row interchangeably. */
export interface StatsRow {
    instrument_id: string;
    avg_volume_7d: number; avg_volume_30d: number;
    median_abs_return_bps_30d: number; mad_abs_return_bps_30d: number;
    median_volume_30d: number; mad_volume_30d: number;
    high_7d_paise: number | null; low_7d_paise: number | null;
    high_30d_paise: number | null; low_30d_paise: number | null;
    high_52w_paise: number | null; low_52w_paise: number | null;
    trading_days_observed: number;
    has_7d_window: boolean; has_30d_window: boolean; has_52w_window: boolean;
    abs_return_p90_bps: number; abs_return_p95_bps: number; abs_return_p98_bps: number; abs_return_p99_bps: number; abs_return_max_bps: number;
    volume_p90: number; volume_p95: number; volume_p99: number;
    ewma_vol_bps: number; realized_vol_7d_bps: number; realized_vol_30d_bps: number; realized_vol_90d_bps: number;
    median_abs_return_bps_90d: number; mad_abs_return_bps_90d: number;
    beta_market_x10000: number | null; alpha_market_bps: number | null; resid_mad_market_bps: number | null;
    beta_sector_x10000: number | null; alpha_sector_bps: number | null; resid_mad_sector_bps: number | null; corr_sector_x10000: number | null;
    last_close_paise: number; streak_days: number;
    drawdown_from_30d_high_bps: number | null; runup_from_30d_low_bps: number | null;
    mean_return_5d_bps: number; mean_return_30d_bps: number;
    // Multi-session ("horizon") return distributions — what a weekly or
    // monthly checker's own window looks like for this stock.
    abs_return_5d_p90_bps: number; abs_return_5d_p95_bps: number; abs_return_5d_p98_bps: number; abs_return_5d_max_bps: number;
    median_abs_return_5d_bps: number;
    abs_return_20d_p90_bps: number; abs_return_20d_p95_bps: number; abs_return_20d_p98_bps: number; abs_return_20d_max_bps: number;
    median_abs_return_20d_bps: number;
    close_5d_ago_paise: number | null; close_20d_ago_paise: number | null;
    /** The N-1 closes: during a live session the quote itself supplies the
     * newest session, so the base must be one step nearer or the window spans
     * N+1 sessions (see metrics.service horizonBase). */
    close_4d_ago_paise: number | null; close_19d_ago_paise: number | null;
    /** Which session the row was built from — tells "already includes today"
     * apart from "ends yesterday", which the streak and horizon both need. */
    last_candle_date: string;
    /** Audit: sessions whose return was excluded as a mechanical re-scaling. */
    ratio_artifacts_excluded: number;
}

export interface RegimeRow {
    benchmark_id: string;
    realized_vol_20d_bps: number; realized_vol_250d_bps: number;
    vix_level_x100: number | null; vix_pctile_1y_x10000: number | null;
}

// ─── Estimators ─────────────────────────────────────────────────────────────

export function median(values: number[]): number {
    if (values.length === 0) return 0;
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

export function mad(values: number[], med: number): number {
    if (values.length === 0) return 0;
    return median(values.map(v => Math.abs(v - med)));
}

export function mean(values: number[]): number {
    return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

export function stddev(values: number[]): number {
    if (values.length < 2) return 0;
    const m = mean(values);
    return Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / (values.length - 1));
}

/** Nearest-rank percentile of a sample (p in 0..1). */
export function percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const s = [...values].sort((a, b) => a - b);
    const rank = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
    return s[rank];
}

/** RiskMetrics EWMA volatility of a return series, in the series' units. */
export function ewmaVol(returns: number[], lambda = EWMA_LAMBDA): number {
    if (returns.length === 0) return 0;
    const seed = returns.slice(0, Math.min(20, returns.length));
    let variance = seed.reduce((a, r) => a + r * r, 0) / seed.length;
    for (const r of returns) variance = lambda * variance + (1 - lambda) * r * r;
    return Math.sqrt(variance);
}

/** OLS market model r_s = alpha + beta * r_m; residual MAD as the robust scale. */
export function marketModel(stock: number[], market: number[]): { beta: number; alpha: number; residMad: number; corr: number } | null {
    const n = Math.min(stock.length, market.length);
    if (n < 20) return null;
    const s = stock.slice(-n), m = market.slice(-n);
    const ms = mean(s), mm = mean(m);
    let cov = 0, varM = 0, varS = 0;
    for (let i = 0; i < n; i++) {
        cov += (s[i] - ms) * (m[i] - mm);
        varM += (m[i] - mm) ** 2;
        varS += (s[i] - ms) ** 2;
    }
    // A flat benchmark gives no slope to fit. A flat STOCK is worse and used
    // to pass: beta 0, alpha 0, residuals all zero, residual MAD clamped to 1
    // — turning "I know nothing about this stock's scale" into the most
    // confident possible answer. The first real move then scored a residual
    // z in the hundreds and maxed the market-relative category.
    if (varM === 0 || varS === 0) return null;
    const beta = cov / varM;
    const alpha = ms - beta * mm;
    const resid = s.map((r, i) => r - (alpha + beta * m[i]));
    const corr = varS > 0 ? cov / Math.sqrt(varM * varS) : 0;
    return { beta, alpha, residMad: Math.max(1, mad(resid, median(resid))), corr };
}

export function dailyReturnsBps(candles: Candle[]): DailyReturn[] {
    const out: DailyReturn[] = [];
    for (let i = 1; i < candles.length; i++) {
        const prev = candles[i - 1].close;
        out.push({ date: candles[i].date, bps: prev > 0 ? Math.round(((candles[i].close - prev) * 10000) / prev) : 0 });
    }
    return out;
}

/** Returns of two series aligned on shared trade dates (skips holidays on either side). */
export function alignReturns(a: DailyReturn[], b: DailyReturn[], window: number): { a: number[]; b: number[] } {
    const bByDate = new Map(b.map(r => [r.date, r.bps]));
    const outA: number[] = [], outB: number[] = [];
    for (const r of a) {
        const other = bByDate.get(r.date);
        if (other !== undefined) { outA.push(r.bps); outB.push(other); }
    }
    return { a: outA.slice(-window), b: outB.slice(-window) };
}

/**
 * Overlapping N-session returns in bps, skipping any window that contains a
 * mechanical re-scaling. Overlapping windows are autocorrelated, so these
 * samples are not independent — fine for "how big is a normal week for this
 * stock" (a quantile of the marginal distribution), which is all we ask.
 */
export function horizonReturnsBps(candles: Candle[], sessions: number, artifactIdx: Set<number>): number[] {
    const out: number[] = [];
    for (let i = sessions; i < candles.length; i++) {
        let contaminated = false;
        for (let j = i - sessions + 1; j <= i; j++) {
            if (artifactIdx.has(j)) { contaminated = true; break; }
        }
        if (contaminated) continue;
        const base = candles[i - sessions].close;
        if (base > 0) out.push(Math.round(((candles[i].close - base) * 10000) / base));
    }
    return out;
}

function horizonStats(candles: Candle[], sessions: number, artifactIdx: Set<number>) {
    const abs = horizonReturnsBps(candles, sessions, artifactIdx).slice(-YEAR_WINDOW).map(Math.abs);
    return {
        p90: Math.round(percentile(abs, 0.90)),
        p95: Math.round(percentile(abs, 0.95)),
        p98: Math.round(percentile(abs, 0.98)),
        max: abs.length ? Math.max(...abs) : 0,
        median: Math.round(median(abs)),
    };
}

export function signedStreak(returns: number[]): number {
    if (returns.length === 0) return 0;
    const lastSign = Math.sign(returns[returns.length - 1]);
    if (lastSign === 0) return 0;
    let n = 0;
    for (let i = returns.length - 1; i >= 0 && Math.sign(returns[i]) === lastSign; i--) n++;
    return lastSign * n;
}

// ─── Pure computation ───────────────────────────────────────────────────────

/**
 * All statistics for one instrument from its candles (ascending), the
 * benchmark's candles, and optionally its sector index's candles. Pass
 * `benchCandles = null` for the benchmark itself.
 */
export function computeStockStatistics(
    instrumentId: string,
    candles: Candle[],
    benchCandles: Candle[] | null,
    sectorCandles: Candle[] | null
): StatsRow | null {
    const tradingDaysObserved = candles.length;
    if (tradingDaysObserved === 0) return null;

    // A split or bonus we never adjusted for leaves a -50%-shaped return in
    // the series. Left in, it becomes this stock's "normal worst day" for a
    // year and silences every real signal, so drop those sessions from the
    // distribution before anything is estimated (splitDetector.ts). Highs and
    // lows are deliberately NOT touched here — re-basing the stored candles is
    // the corporate-actions path's job, not an estimator's.
    const { indices: artifactIdx, artifacts } = artifactIndices(candles);
    const artifactDates = new Set(artifacts.map(a => a.date));

    const returns = dailyReturnsBps(candles).filter(r => !artifactDates.has(r.date));
    const bps = returns.map(r => r.bps);
    const absBps = bps.map(Math.abs);

    // Highs, lows and volumes are NOT re-based here (re-basing is the
    // corporate-actions path's job), so any window spanning an unadjusted
    // re-scaling is meaningless: after a 1:1 bonus the "30-day high" stays at
    // twice the price for thirty sessions, firing DRAWDOWN_FROM_HIGH and
    // NEW_52W_LOW every single day. The day-of guard in metrics only catches
    // the session it happens on. So path statistics look back only as far as
    // the most recent artifact — a short honest window beats a long wrong one.
    const lastArtifactIndex = artifacts.reduce((max, a) => Math.max(max, a.index), -1);
    const priceHistory = lastArtifactIndex >= 0 ? candles.slice(lastArtifactIndex) : candles;

    const last7 = priceHistory.slice(-7), last30 = priceHistory.slice(-30), last52w = priceHistory.slice(-YEAR_WINDOW);
    const abs30 = absBps.slice(-30), abs90 = absBps.slice(-90), absYear = absBps.slice(-YEAR_WINDOW);
    const vol30 = last30.map(c => c.volume), volYear = last52w.map(c => c.volume);

    const medianAbs30 = Math.round(median(abs30));
    const medianAbs90 = Math.round(median(abs90));
    const medianVol30 = Math.round(median(vol30));

    const hi = (cs: Candle[]) => (cs.length ? Math.max(...cs.map(c => c.high)) : null);
    const lo = (cs: Candle[]) => (cs.length ? Math.min(...cs.map(c => c.low)) : null);
    const lastClose = candles[candles.length - 1].close;
    const high30 = hi(last30), low30 = lo(last30);

    let mm: ReturnType<typeof marketModel> = null;
    let sm: ReturnType<typeof marketModel> = null;
    if (benchCandles) {
        const bench = dailyReturnsBps(benchCandles);
        const aligned = alignReturns(returns, bench, MARKET_MODEL_WINDOW);
        mm = marketModel(aligned.a, aligned.b);
    }
    if (sectorCandles) {
        const sector = dailyReturnsBps(sectorCandles);
        const alignedS = alignReturns(returns, sector, MARKET_MODEL_WINDOW);
        sm = marketModel(alignedS.a, alignedS.b);
        if (sm) {
            const c60 = alignReturns(returns, sector, CORRELATION_WINDOW);
            const cm = marketModel(c60.a, c60.b);
            if (cm) sm.corr = cm.corr;
        }
    }

    const x10000 = (v: number | null | undefined) => (v == null ? null : Math.round(v * 10000));

    const h5 = horizonStats(candles, HORIZONS.WEEK.sessions, artifactIdx);
    const h20 = horizonStats(candles, HORIZONS.MONTH.sessions, artifactIdx);
    const closeSessionsAgo = (n: number) => {
        const c = candles[candles.length - 1 - n];
        return c ? c.close : null;
    };

    return {
        instrument_id: instrumentId,
        avg_volume_7d: Math.round(mean(last7.map(c => c.volume))),
        avg_volume_30d: Math.round(mean(vol30)),
        median_abs_return_bps_30d: medianAbs30,
        mad_abs_return_bps_30d: Math.max(1, Math.round(mad(abs30, medianAbs30))),
        median_volume_30d: medianVol30,
        mad_volume_30d: Math.max(1, Math.round(mad(vol30, medianVol30))),
        high_7d_paise: hi(last7), low_7d_paise: lo(last7),
        high_30d_paise: high30, low_30d_paise: low30,
        high_52w_paise: hi(last52w), low_52w_paise: lo(last52w),
        trading_days_observed: tradingDaysObserved,
        has_7d_window: tradingDaysObserved >= 5,
        has_30d_window: tradingDaysObserved >= 20,
        has_52w_window: tradingDaysObserved >= 200,
        abs_return_p90_bps: Math.round(percentile(absYear, 0.90)),
        abs_return_p95_bps: Math.round(percentile(absYear, 0.95)),
        abs_return_p98_bps: Math.round(percentile(absYear, 0.98)),
        abs_return_p99_bps: Math.round(percentile(absYear, 0.99)),
        abs_return_max_bps: absYear.length ? Math.max(...absYear) : 0,
        volume_p90: Math.round(percentile(volYear, 0.90)),
        volume_p95: Math.round(percentile(volYear, 0.95)),
        volume_p99: Math.round(percentile(volYear, 0.99)),
        ewma_vol_bps: Math.round(ewmaVol(bps)),
        realized_vol_7d_bps: Math.round(stddev(bps.slice(-7))),
        realized_vol_30d_bps: Math.round(stddev(bps.slice(-30))),
        realized_vol_90d_bps: Math.round(stddev(bps.slice(-90))),
        median_abs_return_bps_90d: medianAbs90,
        mad_abs_return_bps_90d: Math.max(1, Math.round(mad(abs90, medianAbs90))),
        beta_market_x10000: x10000(mm?.beta),
        alpha_market_bps: mm ? Math.round(mm.alpha) : null,
        resid_mad_market_bps: mm ? Math.round(mm.residMad) : null,
        beta_sector_x10000: x10000(sm?.beta),
        alpha_sector_bps: sm ? Math.round(sm.alpha) : null,
        resid_mad_sector_bps: sm ? Math.round(sm.residMad) : null,
        corr_sector_x10000: x10000(sm?.corr),
        last_close_paise: lastClose,
        streak_days: signedStreak(bps),
        drawdown_from_30d_high_bps: high30 ? Math.round(((lastClose - high30) * 10000) / high30) : null,
        runup_from_30d_low_bps: low30 ? Math.round(((lastClose - low30) * 10000) / low30) : null,
        mean_return_5d_bps: Math.round(mean(bps.slice(-5))),
        mean_return_30d_bps: Math.round(mean(bps.slice(-30))),
        abs_return_5d_p90_bps: h5.p90, abs_return_5d_p95_bps: h5.p95, abs_return_5d_p98_bps: h5.p98,
        abs_return_5d_max_bps: h5.max, median_abs_return_5d_bps: h5.median,
        abs_return_20d_p90_bps: h20.p90, abs_return_20d_p95_bps: h20.p95, abs_return_20d_p98_bps: h20.p98,
        abs_return_20d_max_bps: h20.max, median_abs_return_20d_bps: h20.median,
        close_5d_ago_paise: closeSessionsAgo(HORIZONS.WEEK.sessions),
        close_20d_ago_paise: closeSessionsAgo(HORIZONS.MONTH.sessions),
        close_4d_ago_paise: closeSessionsAgo(HORIZONS.WEEK.sessions - 1),
        close_19d_ago_paise: closeSessionsAgo(HORIZONS.MONTH.sessions - 1),
        last_candle_date: candles[candles.length - 1].date,
        ratio_artifacts_excluded: artifacts.length,
    };
}

export function computeMarketRegime(benchCandles: Candle[], vixCandles: Candle[]): RegimeRow | null {
    if (benchCandles.length < 30) return null;
    const bps = dailyReturnsBps(benchCandles).map(r => r.bps);

    let vixLevel: number | null = null, vixPctile: number | null = null;
    if (vixCandles.length > 0) {
        const closes = vixCandles.slice(-YEAR_WINDOW).map(c => c.close); // paise already == VIX*100
        const last = closes[closes.length - 1];
        vixLevel = last;
        vixPctile = Math.round((closes.filter(c => c <= last).length / closes.length) * 10000);
    }
    return {
        benchmark_id: BENCHMARK_INSTRUMENT_ID,
        realized_vol_20d_bps: Math.round(stddev(bps.slice(-20))),
        realized_vol_250d_bps: Math.round(stddev(bps.slice(-YEAR_WINDOW))),
        vix_level_x100: vixLevel,
        vix_pctile_1y_x10000: vixPctile,
    };
}

// ─── Data access + persistence ──────────────────────────────────────────────

export async function loadCandles(instrumentId: string): Promise<Candle[]> {
    // In replay mode the future has not happened yet: candles dated after the
    // replayed day must not reach any estimator (services/clock.ts).
    const cutoff = historyCutoff();
    const res = await query(
        `SELECT trade_date, open_paise, high_paise, low_paise, close_paise, volume
         FROM daily_candles
         WHERE instrument_id = $1 ${cutoff ? 'AND trade_date <= $2' : ''}
         ORDER BY trade_date ASC`,
        cutoff ? [instrumentId, cutoff] : [instrumentId]
    );
    return res.rows.map(r => ({
        date: new Date(r.trade_date).toISOString().slice(0, 10),
        open: parseInt(r.open_paise, 10), high: parseInt(r.high_paise, 10),
        low: parseInt(r.low_paise, 10), close: parseInt(r.close_paise, 10),
        volume: parseInt(r.volume, 10),
    }));
}

export async function sectorIndexFor(instrumentId: string): Promise<string | null> {
    const res = await query('SELECT sector_index_id FROM stock_sectors WHERE instrument_id = $1', [instrumentId]);
    return res.rows[0]?.sector_index_id ?? null;
}

export async function upsertStatistics(row: StatsRow): Promise<void> {
    const cols = Object.keys(row);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
    const updates = cols.filter(c => c !== 'instrument_id').map(c => `${c} = EXCLUDED.${c}`).join(', ');
    await query(
        `INSERT INTO stock_statistics (${cols.join(',')}, calculated_at) VALUES (${placeholders}, now())
         ON CONFLICT (instrument_id) DO UPDATE SET ${updates}, calculated_at = now()`,
        cols.map(c => (row as any)[c])
    );
}

export async function recalculateStatistics(instrumentId: string): Promise<void> {
    const candles = await loadCandles(instrumentId);
    if (candles.length === 0) return;

    const isBenchmark = instrumentId === BENCHMARK_INSTRUMENT_ID;
    const benchCandles = isBenchmark ? null : await loadCandles(BENCHMARK_INSTRUMENT_ID);
    const sectorId = isBenchmark ? null : await sectorIndexFor(instrumentId);
    const sectorCandles = sectorId ? await loadCandles(sectorId) : null;

    const row = computeStockStatistics(instrumentId, candles, benchCandles, sectorCandles);
    if (row) await upsertStatistics(row);
}

export async function recalculateMarketRegime(): Promise<void> {
    const row = computeMarketRegime(await loadCandles(BENCHMARK_INSTRUMENT_ID), await loadCandles(VIX_INSTRUMENT_ID));
    if (!row) return;
    await query(
        `INSERT INTO market_regime (benchmark_id, realized_vol_20d_bps, realized_vol_250d_bps, vix_level_x100, vix_pctile_1y_x10000, calculated_at)
         VALUES ($1,$2,$3,$4,$5, now())
         ON CONFLICT (benchmark_id) DO UPDATE SET
           realized_vol_20d_bps = EXCLUDED.realized_vol_20d_bps, realized_vol_250d_bps = EXCLUDED.realized_vol_250d_bps,
           vix_level_x100 = EXCLUDED.vix_level_x100, vix_pctile_1y_x10000 = EXCLUDED.vix_pctile_1y_x10000, calculated_at = now()`,
        [row.benchmark_id, row.realized_vol_20d_bps, row.realized_vol_250d_bps, row.vix_level_x100, row.vix_pctile_1y_x10000]
    );
}
