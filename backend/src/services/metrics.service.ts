import {
    FRESHNESS_SEC, EXTERNAL, TIME_SERIES, NOISE_FLOOR, HORIZONS, ADJUSTMENT_GUARD, type HorizonKey,
} from '../config/thresholds';
import { matchCommonRatio } from './fundamentals/splitDetector';
import { NormalizedQuote, MarketStatus } from '../models/quote';

/**
 * Per-stock metrics for one summary request. Three lenses feed the score:
 *   time-series  — how unusual is today vs this stock's own history
 *   external     — how much of the move is the market/sector, how much is
 *                  the stock (beta-adjusted residuals), what regime we're in
 *   internal     — company events (attached by the caller as context)
 * All money integer paise, all percentages integer bps; z-scores and ratios
 * are dimensionless floats.
 */

export type RarityBand = 'NONE' | 'P90' | 'P95' | 'P98' | 'P99' | 'MAX';

export interface MarketRegime {
    volRatio: number;            // benchmark 20d / 250d realized vol
    vixPctile: number | null;    // 0..1
    dampen: number;              // 0.6..1 multiplier applied to the score
}

export interface Metrics {
    // spec §7
    todayChangeBps: number;
    sinceLastVisitBps: number;
    daysSinceLastVisit: number;
    magnitudePerDayBps: number;
    volumeRatio: number;
    volumeZ: number;
    movementAnomaly: number;
    relativeToBenchBps: number;
    new7dHigh: boolean; new7dLow: boolean;
    new30dHigh: boolean; new30dLow: boolean;
    new52wHigh: boolean; new52wLow: boolean;
    dataAgeSec: number;
    dataStatus: string;
    // horizon (the user's own checking cadence — see HORIZONS)
    horizon: HorizonKey;
    horizonSessions: number;
    horizonLabel: string;
    horizonShort: string;
    horizonReturnBps: number | null; // move over the horizon window, null if history is short
    // time-series extensions
    gapBps: number;
    rarityBand: RarityBand;          // where the horizon move sits in the stock's own year
    rarityFraction: number;          // 0..1 for scoring
    rarityMoveBps: number;           // the move the band refers to (today's, or the horizon's)
    rarityWindowLabel: string;       // 'daily' | 'weekly' | 'monthly'
    rarityFallback: boolean;         // horizon cutpoints estimated by √t scaling, not measured
    priceFloorBps: number;           // noise floor for this horizon
    /** Looks like an unrecorded split/bonus — every price comparison is
     * mechanical until the calendar catches up (splitDetector.ts). */
    suspectedAdjustment: { factor: number; label: string } | null;
    volumeRarityBand: RarityBand;
    volumeRarityFraction: number;
    volRegimeRatio: number;          // EWMA vol / 90d realized vol
    streakDays: number;              // signed, including today
    drawdownFrom30dHighBps: number | null;   // state, as of now
    runupFrom30dLowBps: number | null;       // state, as of now
    drawdownCrossedToday: boolean;   // event: first day beyond the drawdown threshold
    runupCrossedToday: boolean;      // event: first day beyond the run-up threshold
    levelShiftZ: number;             // last-5d mean vs 30d mean, scaled by 90d vol of signed returns
    priceVolumeConfirm: number;      // min(movementAnomaly, volumeZ) when both agree
    // external extensions
    betaMarket: number | null;
    residualMarketBps: number | null;   // today − (α + β·market)
    residualMarketZ: number | null;
    sectorIndexId: string | null;
    sectorTodayBps: number | null;
    residualSectorBps: number | null;
    residualSectorZ: number | null;
    regime: MarketRegime;
}

const num = (v: unknown, fallback = 0): number => {
    if (v === null || v === undefined) return fallback;
    const n = typeof v === 'number' ? v : parseFloat(String(v));
    return Number.isFinite(n) ? n : fallback;
};

/** Rounds, matching `dailyReturnsBps` in statistics.service — the live figure
 * and the distribution it is compared against must use the same convention.
 * (`Math.floor` biased every negative move one basis point further from zero.) */
const bpsChange = (now: number, base: number) => (base > 0 ? Math.round(((now - base) * 10000) / base) : 0);

/** IST calendar date of a timestamp — the exchange's day, not the server's. */
const istDate = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

function modifiedZ(value: number, median: number, madValue: number): number {
    return (0.6745 * (value - median)) / Math.max(1, madValue);
}

function isCrossing(hasWindow: boolean, lastSeen: number, current: number, threshold: number, direction: 'up' | 'down'): boolean {
    if (!hasWindow || !threshold || lastSeen <= 0) return false;
    return direction === 'up' ? lastSeen <= threshold && current > threshold : lastSeen >= threshold && current < threshold;
}

/** Place a value against the stock's own stored percentile cutpoints. */
function rarity(value: number, p90: number, p95: number, p98: number, p99: number, max: number): { band: RarityBand; fraction: number } {
    if (!p90 || !p95) return { band: 'NONE', fraction: 0 };
    if (max && value >= max) return { band: 'MAX', fraction: 1 };
    if (p99 && value >= p99) return { band: 'P99', fraction: 0.9 };
    if (p98 && value >= p98) return { band: 'P98', fraction: 0.8 };
    if (value >= p95) return { band: 'P95', fraction: 0.6 };
    if (value >= p90) return { band: 'P90', fraction: 0.4 };
    return { band: 'NONE', fraction: Math.max(0, Math.min(0.39, (value / p90) * 0.4)) };
}

/**
 * The stock's own percentile cutpoints for the horizon's window. Measured
 * from overlapping N-session returns when the stats job has computed them;
 * otherwise scaled from the daily distribution by √sessions (random-walk
 * scaling — right on average, blind to mean reversion, hence the flag).
 * No p99 is stored for multi-session windows: with ~245 overlapping samples
 * it would rest on two observations, so it is interpolated toward the max.
 */
function horizonCutpoints(stats: any, horizon: HorizonKey) {
    const daily = {
        p90: num(stats.abs_return_p90_bps), p95: num(stats.abs_return_p95_bps),
        p98: num(stats.abs_return_p98_bps), p99: num(stats.abs_return_p99_bps),
        max: num(stats.abs_return_max_bps),
    };
    if (horizon === 'DAY') return { ...daily, fallback: false };

    const prefix = horizon === 'WEEK' ? '5d' : '20d';
    const p95 = num(stats[`abs_return_${prefix}_p95_bps`]);
    if (p95 > 0) {
        const p98 = num(stats[`abs_return_${prefix}_p98_bps`]);
        const max = num(stats[`abs_return_${prefix}_max_bps`]);
        return {
            p90: num(stats[`abs_return_${prefix}_p90_bps`]), p95, p98,
            p99: Math.round(p98 + (Math.max(p98, max) - p98) * 0.5),
            max, fallback: false,
        };
    }
    const scale = Math.sqrt(HORIZONS[horizon].sessions);
    return {
        p90: Math.round(daily.p90 * scale), p95: Math.round(daily.p95 * scale),
        p98: Math.round(daily.p98 * scale), p99: Math.round(daily.p99 * scale),
        max: Math.round(daily.max * scale), fallback: daily.p95 > 0,
    };
}

export function computeRegime(regimeRow: any | null): MarketRegime {
    if (!regimeRow) return { volRatio: 1, vixPctile: null, dampen: 1 };
    const v20 = num(regimeRow.realized_vol_20d_bps), v250 = num(regimeRow.realized_vol_250d_bps);
    const volRatio = v250 > 0 ? v20 / v250 : 1;
    const vixPctile = regimeRow.vix_pctile_1y_x10000 == null ? null : num(regimeRow.vix_pctile_1y_x10000) / 10000;

    // In a high-vol regime every stock is noisy; raise the bar smoothly.
    let dampen = 1;
    if (volRatio > EXTERNAL.RegimeDampenStartRatio) {
        dampen = Math.max(EXTERNAL.RegimeMaxDampen, EXTERNAL.RegimeDampenStartRatio / volRatio);
    }
    if (vixPctile !== null && vixPctile >= EXTERNAL.VixPctileDampen) dampen *= EXTERNAL.VixDampenFactor;
    return { volRatio, vixPctile, dampen: Math.max(EXTERNAL.RegimeMaxDampen, dampen) };
}

export function calculateMetrics(
    quote: NormalizedQuote,
    stats: any,
    userState: any,
    benchmarkQuote: NormalizedQuote | null,
    sectorQuote: NormalizedQuote | null,
    sectorIndexId: string | null,
    regime: MarketRegime,
    horizon: HorizonKey = 'DAY'
): Metrics {
    const todayChangeBps = bpsChange(quote.lastPricePaise, quote.previousClosePaise);
    const lastSeen = num(userState.last_seen_price_paise);
    const sinceLastVisitBps = lastSeen > 0 ? bpsChange(quote.lastPricePaise, lastSeen) : 0;

    const msPerDay = 86_400_000;
    const daysSince = Math.max(1, Math.floor((quote.retrievedAt.getTime() - new Date(userState.last_seen_at).getTime()) / msPerDay));
    const magnitudePerDayBps = Math.floor(sinceLastVisitBps / daysSince);

    // ── Time-series ────────────────────────────────────────────────────────
    const avgVolume30d = num(stats.avg_volume_30d) || 1;
    const volumeRatio = quote.volume / avgVolume30d;
    const volumeZ = modifiedZ(quote.volume, num(stats.median_volume_30d), num(stats.mad_volume_30d, 1));
    const movementAnomaly = modifiedZ(Math.abs(todayChangeBps), num(stats.median_abs_return_bps_30d), num(stats.mad_abs_return_bps_30d, 1));

    const gapBps = quote.openPaise > 0 ? bpsChange(quote.openPaise, quote.previousClosePaise) : 0;

    // ── Horizon: the window the user actually experiences ──────────────────
    const H = HORIZONS[horizon];
    // Does the stats row already contain the session the quote is reporting?
    // Before the 15:45 rollup it does not, so the quote adds a session the
    // stored closes have not seen and the base must be one step nearer —
    // otherwise a "5-session" move silently spans 6 and is compared against a
    // 5-session distribution (√(6/5) ≈ +9.5% on every weekly/monthly move,
    // all through the trading day).
    const statsIncludeToday = String(stats.last_candle_date ?? '').slice(0, 10) === istDate(quote.dataTimestamp);
    const horizonBase = horizon === 'DAY'
        ? quote.previousClosePaise
        : num(horizon === 'WEEK'
            ? (statsIncludeToday ? stats.close_5d_ago_paise : stats.close_4d_ago_paise)
            : (statsIncludeToday ? stats.close_20d_ago_paise : stats.close_19d_ago_paise));
    const horizonReturnBps = horizonBase > 0 ? bpsChange(quote.lastPricePaise, horizonBase) : null;
    // Rarity is judged on the horizon's move against the distribution of
    // moves over the SAME window — never today's move against weekly history.
    const rarityMoveBps = horizon === 'DAY' ? todayChangeBps : (horizonReturnBps ?? todayChangeBps);
    const cut = horizonCutpoints(stats, horizon);
    const priceFloorBps = Math.round(NOISE_FLOOR.PriceMoveBps * Math.sqrt(H.sessions));

    const r = rarity(Math.abs(rarityMoveBps), cut.p90, cut.p95, cut.p98, cut.p99, cut.max);
    // No p98 is stored for volume, so that slot gets 0 (the ladder skips a
    // zero cutpoint). It used to repeat volume_p95, and because the p98 rung
    // is tested first, every volume above p95 was graded P98 — scoring 0.8 of
    // the cap where it had earned 0.6, on roughly 4% of stock-days.
    const vr = rarity(quote.volume, num(stats.volume_p90), num(stats.volume_p95), 0, num(stats.volume_p99), 0);

    // Corporate-action guard: a clean ratio plus a session that never traded
    // near the old level is a re-scaling, not news (splitDetector.ts). The
    // intraday check is the discriminator a single quote can still make.
    const ratioMatch = matchCommonRatio(quote.previousClosePaise, quote.lastPricePaise, ADJUSTMENT_GUARD.HighConfidenceTolerance);
    const ratioRangeClear = !ratioMatch || quote.highPaise <= 0 || (ratioMatch.factor < 1
        ? quote.highPaise <= quote.previousClosePaise * (1 - ADJUSTMENT_GUARD.RangeClearanceFrac)
        : quote.lowPaise >= quote.previousClosePaise * (1 + ADJUSTMENT_GUARD.RangeClearanceFrac));
    const suspectedAdjustment = ratioMatch && ratioRangeClear
        ? { factor: ratioMatch.factor, label: ratioMatch.label }
        : null;

    const ewma = num(stats.ewma_vol_bps), rv90 = num(stats.realized_vol_90d_bps);
    const volRegimeRatio = rv90 > 0 ? ewma / rv90 : 1;

    // Streak as of the last stored candle, extended by today's sign — but ONLY
    // if that candle isn't already today's. After the 16:00 recalc it is, while
    // the quote's previous close is still yesterday's, so today's direction was
    // counted twice: four up days reported "5 straight sessions up" all evening
    // and all weekend, which is exactly when an occasional checker looks.
    let streakDays = num(stats.streak_days);
    const todaySign = Math.sign(todayChangeBps);
    if (todaySign !== 0 && !statsIncludeToday) {
        streakDays = Math.sign(streakDays) === todaySign ? streakDays + todaySign : todaySign;
    }

    const high30 = num(stats.high_30d_paise), low30 = num(stats.low_30d_paise);
    const drawdownFrom30dHighBps = high30 > 0 ? bpsChange(quote.lastPricePaise, Math.max(high30, quote.lastPricePaise)) : null;
    const runupFrom30dLowBps = low30 > 0 ? bpsChange(quote.lastPricePaise, Math.min(low30, quote.lastPricePaise)) : null;

    // Drawdown/run-up are STATES that persist for weeks; only the day the
    // threshold is first crossed is a change (same rule as spec §7.2
    // milestones). Yesterday's value is the stats row's, computed at last close.
    const yesterdayDrawdown = stats.drawdown_from_30d_high_bps == null ? null : num(stats.drawdown_from_30d_high_bps);
    const yesterdayRunup = stats.runup_from_30d_low_bps == null ? null : num(stats.runup_from_30d_low_bps);
    const drawdownCrossedToday = drawdownFrom30dHighBps !== null && drawdownFrom30dHighBps <= TIME_SERIES.DrawdownNotableBps
        && (yesterdayDrawdown === null || yesterdayDrawdown > TIME_SERIES.DrawdownNotableBps);
    const runupCrossedToday = runupFrom30dLowBps !== null && runupFrom30dLowBps >= TIME_SERIES.RunupNotableBps
        && (yesterdayRunup === null || yesterdayRunup < TIME_SERIES.RunupNotableBps);

    // Two-window level shift as a t-like statistic: the standard error of a
    // 5-day mean is σ/√5, where σ must be the dispersion of SIGNED returns
    // (the 90d realized vol) — the MAD of |returns| understates it badly.
    // The 30-day window CONTAINS the 5-day one, so the two means are
    // positively correlated and the standard error of their difference is
    // σ/√6, not σ/√5: Var(m₅ − m₃₀) = σ²/5 + σ²/30 − 2σ²/30 = σ²/6.
    // With √5 the statistic ran 8.7% small, so a threshold documented as 2.5
    // was really 2.74.
    const sigma90 = Math.max(1, num(stats.realized_vol_90d_bps));
    const levelShiftZ = (num(stats.mean_return_5d_bps) - num(stats.mean_return_30d_bps)) / (sigma90 / Math.sqrt(6));

    const priceVolumeConfirm = movementAnomaly > 0 && volumeZ > 0 ? Math.min(movementAnomaly, volumeZ) : 0;

    // ── External ───────────────────────────────────────────────────────────
    const benchmarkTodayBps = benchmarkQuote ? bpsChange(benchmarkQuote.lastPricePaise, benchmarkQuote.previousClosePaise) : 0;
    const relativeToBenchBps = todayChangeBps - benchmarkTodayBps;

    let betaMarket: number | null = null, residualMarketBps: number | null = null, residualMarketZ: number | null = null;
    if (benchmarkQuote && stats.beta_market_x10000 != null) {
        betaMarket = num(stats.beta_market_x10000) / 10000;
        residualMarketBps = Math.round(todayChangeBps - (num(stats.alpha_market_bps) + betaMarket * benchmarkTodayBps));
        residualMarketZ = modifiedZ(residualMarketBps, 0, num(stats.resid_mad_market_bps, 1));
    }

    let sectorTodayBps: number | null = null, residualSectorBps: number | null = null, residualSectorZ: number | null = null;
    if (sectorQuote && stats.beta_sector_x10000 != null) {
        sectorTodayBps = bpsChange(sectorQuote.lastPricePaise, sectorQuote.previousClosePaise);
        const betaS = num(stats.beta_sector_x10000) / 10000;
        residualSectorBps = Math.round(todayChangeBps - (num(stats.alpha_sector_bps) + betaS * sectorTodayBps));
        residualSectorZ = modifiedZ(residualSectorBps, 0, num(stats.resid_mad_sector_bps, 1));
    }

    // ── Milestone crossings (spec §7.2) ────────────────────────────────────
    const px = quote.lastPricePaise;
    const new7dHigh = isCrossing(!!stats.has_7d_window, lastSeen, px, num(stats.high_7d_paise), 'up');
    const new7dLow = isCrossing(!!stats.has_7d_window, lastSeen, px, num(stats.low_7d_paise), 'down');
    const new30dHigh = isCrossing(!!stats.has_30d_window, lastSeen, px, high30, 'up');
    const new30dLow = isCrossing(!!stats.has_30d_window, lastSeen, px, low30, 'down');
    const new52wHigh = isCrossing(!!stats.has_52w_window, lastSeen, px, num(stats.high_52w_paise), 'up');
    const new52wLow = isCrossing(!!stats.has_52w_window, lastSeen, px, num(stats.low_52w_paise), 'down');

    // ── Freshness (spec §7.3, net of the feed's own nominal delay) ─────────
    const ageSec = Math.max(0, Math.floor((quote.retrievedAt.getTime() - quote.dataTimestamp.getTime()) / 1000));
    const effectiveAgeSec = Math.max(0, ageSec - (quote.feedDelaySec ?? 0));
    let dataStatus = 'STALE';
    if (quote.source === 'PROVIDER_DOWN' || quote.source === 'DATA_MISSING') {
        dataStatus = quote.source;
    } else if (quote.marketStatus === MarketStatus.CLOSED) {
        dataStatus = 'CLOSED';
    } else {
        const mult = quote.marketStatus === MarketStatus.PRE_MARKET || quote.marketStatus === MarketStatus.POST_MARKET ? 3 : 1;
        if (effectiveAgeSec < FRESHNESS_SEC.Live * mult) dataStatus = 'LIVE';
        else if (effectiveAgeSec < FRESHNESS_SEC.Recent * mult) dataStatus = 'RECENT';
        else if (effectiveAgeSec < FRESHNESS_SEC.Delayed * mult) dataStatus = 'DELAYED';
    }

    return {
        todayChangeBps, sinceLastVisitBps, daysSinceLastVisit: daysSince, magnitudePerDayBps,
        volumeRatio, volumeZ, movementAnomaly, relativeToBenchBps,
        new7dHigh, new7dLow, new30dHigh, new30dLow, new52wHigh, new52wLow,
        dataAgeSec: ageSec, dataStatus,
        horizon, horizonSessions: H.sessions, horizonLabel: H.label, horizonShort: H.short, horizonReturnBps,
        gapBps, rarityBand: r.band, rarityFraction: r.fraction,
        rarityMoveBps, rarityWindowLabel: H.windowLabel, rarityFallback: cut.fallback, priceFloorBps,
        suspectedAdjustment,
        volumeRarityBand: vr.band, volumeRarityFraction: vr.fraction,
        volRegimeRatio, streakDays, drawdownFrom30dHighBps, runupFrom30dLowBps, drawdownCrossedToday, runupCrossedToday, levelShiftZ, priceVolumeConfirm,
        betaMarket, residualMarketBps, residualMarketZ,
        sectorIndexId, sectorTodayBps, residualSectorBps, residualSectorZ,
        regime,
    };
}
