import { THRESHOLDS, NOISE_FLOOR, TIME_SERIES, EXTERNAL } from '../config/thresholds';
import { Metrics } from './metrics.service';
import { NormalizedQuote } from '../models/quote';

export enum EventType {
    // spec §8
    LARGE_PRICE_MOVE = 'LARGE_PRICE_MOVE',
    UNUSUAL_VOLUME = 'UNUSUAL_VOLUME',
    EXTREME_VOLUME = 'EXTREME_VOLUME',
    VOLATILITY_SPIKE = 'VOLATILITY_SPIKE',
    EXTREME_VOLATILITY = 'EXTREME_VOLATILITY',
    NEW_7D_HIGH = 'NEW_7D_HIGH', NEW_7D_LOW = 'NEW_7D_LOW',
    NEW_30D_HIGH = 'NEW_30D_HIGH', NEW_30D_LOW = 'NEW_30D_LOW',
    NEW_52W_HIGH = 'NEW_52W_HIGH', NEW_52W_LOW = 'NEW_52W_LOW',
    MARKET_OUTPERFORMANCE = 'MARKET_OUTPERFORMANCE',
    MARKET_UNDERPERFORMANCE = 'MARKET_UNDERPERFORMANCE',
    USER_PRICE_TARGET_REACHED = 'USER_PRICE_TARGET_REACHED',
    USER_PRICE_FLOOR_REACHED = 'USER_PRICE_FLOOR_REACHED',
    DATA_STALE = 'DATA_STALE',
    PROVIDER_DOWN = 'PROVIDER_DOWN',
    INSUFFICIENT_HISTORY = 'INSUFFICIENT_HISTORY',
    /** The move over the user's horizon, when that is longer than a day. */
    HORIZON_MOVE = 'HORIZON_MOVE',
    // time-series extensions
    GAP_UP = 'GAP_UP', GAP_DOWN = 'GAP_DOWN',
    VOL_REGIME_SHIFT = 'VOL_REGIME_SHIFT',
    STREAK_UP = 'STREAK_UP', STREAK_DOWN = 'STREAK_DOWN',
    DRAWDOWN_FROM_HIGH = 'DRAWDOWN_FROM_HIGH',
    RUNUP_FROM_LOW = 'RUNUP_FROM_LOW',
    LEVEL_SHIFT = 'LEVEL_SHIFT',
    ACCUMULATION = 'ACCUMULATION',
    // external extensions
    IDIOSYNCRATIC_MOVE = 'IDIOSYNCRATIC_MOVE',
    SECTOR_DIVERGENCE = 'SECTOR_DIVERGENCE',
    // internal / fundamentals
    RESULTS_UPCOMING = 'RESULTS_UPCOMING',
    RESULTS_JUST_OUT = 'RESULTS_JUST_OUT',
    EX_DIVIDEND_UPCOMING = 'EX_DIVIDEND_UPCOMING',
    EX_DIVIDEND_TODAY = 'EX_DIVIDEND_TODAY',
    CORPORATE_ACTION_ADJUSTMENT = 'CORPORATE_ACTION_ADJUSTMENT',
    /** Statistical guard: a split/bonus-shaped jump with nothing on the calendar. */
    SUSPECTED_PRICE_ADJUSTMENT = 'SUSPECTED_PRICE_ADJUSTMENT',
    RECENT_ANNOUNCEMENT = 'RECENT_ANNOUNCEMENT',
}

/** Company-internal context for one instrument, resolved by the caller from
 * corporate_events against today's date and the approved windows. */
export interface FundamentalsContext {
    resultsDate: string | null;        // nearest board-meeting-for-results date inside the window
    resultsDaysFromNow: number | null; // negative = already happened
    exDividendDate: string | null;
    exDividendDaysFromNow: number | null;
    dividendAmountPaise: number | null;
    corporateActionToday: { type: 'SPLIT' | 'BONUS'; subject: string } | null;
    recentAnnouncements: string[];
}

export const EMPTY_FUNDAMENTALS: FundamentalsContext = {
    resultsDate: null, resultsDaysFromNow: null, exDividendDate: null, exDividendDaysFromNow: null,
    dividendAmountPaise: null, corporateActionToday: null, recentAnnouncements: [],
};

const num = (v: unknown, fallback = 0) => { const n = parseFloat(String(v)); return Number.isFinite(n) ? n : fallback; };

export function detectEvents(
    metrics: Metrics,
    quote: NormalizedQuote,
    stats: any,
    userState: any,
    alerts: any[],
    fundamentals: FundamentalsContext = EMPTY_FUNDAMENTALS,
    /** Filled with the arm/disarm changes the caller should persist (§8.4). */
    alertTransitions: AlertTransition[] = []
): EventType[] {
    const events: EventType[] = [];

    // §8.5 — data problems suppress everything except themselves.
    if (metrics.dataStatus === 'PROVIDER_DOWN' || metrics.dataStatus === 'DATA_MISSING') {
        events.push(EventType.PROVIDER_DOWN);
        return events;
    }

    const absToday = Math.abs(metrics.todayChangeBps);
    const aboveFloor = absToday >= NOISE_FLOOR.PriceMoveBps;
    // Rarity is measured over the user's horizon, so its noise floor is the
    // horizon's too (√t-scaled). Identical to the above when horizon = DAY.
    const aboveHorizonFloor = Math.abs(metrics.rarityMoveBps) >= metrics.priceFloorBps;

    // A split/bonus effective today makes every price comparison mechanical
    // noise until history is re-based — say so and stop (§61.B3).
    if (fundamentals.corporateActionToday) {
        events.push(EventType.CORPORATE_ACTION_ADJUSTMENT);
        pushFundamentals(events, fundamentals, /*skipCorporateAction*/ true);
        pushUserAlerts(events, quote, userState, alerts, alertTransitions);
        if (metrics.dataStatus === 'STALE') events.push(EventType.DATA_STALE);
        return events;
    }

    // Same conclusion, reached statistically: a clean corporate-action ratio
    // with nothing on our calendar. Crying "CRITICAL, down 50%" at a bonus
    // issue is the worst failure this product can have, so the guard wins the
    // tie and the day is reported as mechanical (splitDetector.ts).
    if (metrics.suspectedAdjustment) {
        events.push(EventType.SUSPECTED_PRICE_ADJUSTMENT);
        pushFundamentals(events, fundamentals, false);
        pushUserAlerts(events, quote, userState, alerts, alertTransitions);
        if (metrics.dataStatus === 'STALE') events.push(EventType.DATA_STALE);
        return events;
    }

    if (num(stats.trading_days_observed) < 5) {
        events.push(EventType.INSUFFICIENT_HISTORY);
        // Price-vs-last-visit still means something without statistics.
        if (Math.abs(metrics.sinceLastVisitBps) >= THRESHOLDS.LargePriceMoveBps) events.push(EventType.LARGE_PRICE_MOVE);
    } else {
        // ── Since last visit (spec) ───────────────────────────────────────
        if (Math.abs(metrics.sinceLastVisitBps) >= THRESHOLDS.LargePriceMoveBps) events.push(EventType.LARGE_PRICE_MOVE);

        // On a weekly or monthly lens, the window's own move is the headline
        // fact even when it is statistically ordinary — a monthly checker
        // needs to be told the stock is down 7% since roughly when they last
        // looked. It carries no score of its own; rarity already scores it.
        if (metrics.horizon !== 'DAY' && metrics.horizonReturnBps !== null
            && Math.abs(metrics.horizonReturnBps) >= metrics.priceFloorBps) {
            events.push(EventType.HORIZON_MOVE);
        }

        // ── Time-series: the stock vs its own year (empirical percentiles) ─
        // Percentiles are written unconditionally, so `abs_return_p95_bps > 0`
        // is true after six sessions — and nearest-rank on a 6-sample series
        // makes p95 = p99 = max, so a five-week-old listing scored "biggest
        // move of the past year". The spec's gate for both volatility events
        // is has_30d_window; without it the z-score fallback below (written
        // for exactly this case) was unreachable.
        const hasYear = !!stats.abs_return_p95_bps && !!stats.has_30d_window;
        if (hasYear && aboveHorizonFloor) {
            if (metrics.rarityBand === 'P99' || metrics.rarityBand === 'MAX') events.push(EventType.EXTREME_VOLATILITY);
            else if (metrics.rarityBand === 'P95' || metrics.rarityBand === 'P98') events.push(EventType.VOLATILITY_SPIKE);
        } else if (!hasYear && stats.has_30d_window && aboveFloor) {
            // Fallback to the spec's z-score bands until a year of history exists.
            if (metrics.movementAnomaly >= THRESHOLDS.MovementAnomalyExtreme) events.push(EventType.EXTREME_VOLATILITY);
            else if (metrics.movementAnomaly >= THRESHOLDS.MovementAnomalyNotable) events.push(EventType.VOLATILITY_SPIKE);
        }

        // Volume: percentile AND ratio floor AND absolute floor (§61.E2).
        if (stats.has_30d_window && quote.volume >= THRESHOLDS.VolumeAbsoluteFloor && metrics.volumeRatio >= NOISE_FLOOR.VolumeRatio) {
            const isExDivMechanical = fundamentals.exDividendDaysFromNow === 0;
            if (metrics.volumeRarityBand === 'P99' || metrics.volumeRatio >= THRESHOLDS.VolumeRatioExtreme) events.push(EventType.EXTREME_VOLUME);
            else if (metrics.volumeRarityBand === 'P95' || metrics.volumeRarityBand === 'P98' || metrics.volumeRatio >= THRESHOLDS.VolumeRatioUnusual) events.push(EventType.UNUSUAL_VOLUME);
            // Volume spike with no price move — positioning, not news yet.
            if (!isExDivMechanical && metrics.volumeZ >= TIME_SERIES.AccumulationVolumeZ && absToday < num(stats.median_abs_return_bps_30d)) {
                events.push(EventType.ACCUMULATION);
            }
        }

        // Gap at the open — overnight news. An ex-dividend drop of about the
        // dividend size is mechanical, not a gap.
        const exDivBps = fundamentals.exDividendDaysFromNow === 0 && fundamentals.dividendAmountPaise && quote.previousClosePaise > 0
            ? Math.round((fundamentals.dividendAmountPaise * 10000) / quote.previousClosePaise) : 0;
        const gapMagnitude = Math.abs(metrics.gapBps) - (metrics.gapBps < 0 ? exDivBps : 0);
        // A gap counts when it alone is a notable fraction of a notable day for this stock.
        if (hasYear && gapMagnitude >= Math.max(NOISE_FLOOR.GapBps, num(stats.abs_return_p95_bps) * 0.6)) {
            events.push(metrics.gapBps > 0 ? EventType.GAP_UP : EventType.GAP_DOWN);
        }

        if (num(stats.realized_vol_90d_bps) > 0 && metrics.volRegimeRatio >= TIME_SERIES.VolRegimeShiftRatio) events.push(EventType.VOL_REGIME_SHIFT);

        if (Math.abs(metrics.streakDays) >= TIME_SERIES.StreakDays) events.push(metrics.streakDays > 0 ? EventType.STREAK_UP : EventType.STREAK_DOWN);

        // Crossings only — the persistent state is surfaced separately as context.
        if (stats.has_30d_window && metrics.drawdownCrossedToday) events.push(EventType.DRAWDOWN_FROM_HIGH);
        if (stats.has_30d_window && metrics.runupCrossedToday) events.push(EventType.RUNUP_FROM_LOW);

        if (stats.has_30d_window && num(stats.realized_vol_90d_bps) > 0 && Math.abs(metrics.levelShiftZ) >= TIME_SERIES.LevelShiftZ) events.push(EventType.LEVEL_SHIFT);

        // ── Milestones (crossings only) ───────────────────────────────────
        if (metrics.new52wHigh) events.push(EventType.NEW_52W_HIGH);
        else if (metrics.new30dHigh) events.push(EventType.NEW_30D_HIGH);
        else if (metrics.new7dHigh) events.push(EventType.NEW_7D_HIGH);
        if (metrics.new52wLow) events.push(EventType.NEW_52W_LOW);
        else if (metrics.new30dLow) events.push(EventType.NEW_30D_LOW);
        else if (metrics.new7dLow) events.push(EventType.NEW_7D_LOW);

        // ── External: beta-adjusted, not raw difference ───────────────────
        if (metrics.residualMarketZ !== null && aboveFloor) {
            if (Math.abs(metrics.residualMarketZ) >= EXTERNAL.ResidualZNotable) {
                events.push(EventType.IDIOSYNCRATIC_MOVE);
                events.push(metrics.residualMarketBps! > 0 ? EventType.MARKET_OUTPERFORMANCE : EventType.MARKET_UNDERPERFORMANCE);
            }
        } else if (metrics.residualMarketZ === null && aboveFloor) {
            // No beta yet — fall back to the spec's raw divergence.
            if (metrics.relativeToBenchBps >= THRESHOLDS.RelativeDivergenceBps) events.push(EventType.MARKET_OUTPERFORMANCE);
            else if (metrics.relativeToBenchBps <= -THRESHOLDS.RelativeDivergenceBps) events.push(EventType.MARKET_UNDERPERFORMANCE);
        }
        if (metrics.residualSectorZ !== null && aboveFloor && Math.abs(metrics.residualSectorZ) >= EXTERNAL.ResidualZNotable) {
            events.push(EventType.SECTOR_DIVERGENCE);
        }
    }

    pushFundamentals(events, fundamentals, false);
    pushUserAlerts(events, quote, userState, alerts, alertTransitions);

    if (metrics.dataStatus === 'STALE') events.push(EventType.DATA_STALE);
    return events;
}

function pushFundamentals(events: EventType[], f: FundamentalsContext, skipCorporateAction: boolean): void {
    if (f.resultsDaysFromNow !== null) {
        events.push(f.resultsDaysFromNow >= 0 ? EventType.RESULTS_UPCOMING : EventType.RESULTS_JUST_OUT);
    }
    if (f.exDividendDaysFromNow !== null) {
        events.push(f.exDividendDaysFromNow === 0 ? EventType.EX_DIVIDEND_TODAY : EventType.EX_DIVIDEND_UPCOMING);
    }
    if (!skipCorporateAction && f.corporateActionToday) events.push(EventType.CORPORATE_ACTION_ADJUSTMENT);
    if (f.recentAnnouncements.length > 0) events.push(EventType.RECENT_ANNOUNCEMENT);
}

/**
 * A transition an alert wants recorded: it fired (disarm), or the price
 * retreated past the re-arm band (arm again). Returned rather than written,
 * so this module stays a pure function of its inputs — the caller persists.
 */
export interface AlertTransition {
    alertId: string;
    side: 'above' | 'below';
    armed: boolean;
}

function pushUserAlerts(
    events: EventType[],
    quote: NormalizedQuote,
    userState: any,
    alerts: any[],
    transitions: AlertTransition[]
): void {
    const current = quote.lastPricePaise;
    const lastSeen = num(userState.last_seen_price_paise);
    // BUILD_SPEC §8.4: an alert fires once, then stays quiet until the price
    // retreats by the re-arm band. Nothing ever wrote armed_above/armed_below,
    // so every alert re-fired on every poll and AlertRearmBandBps was dead
    // config — the baseline moving on acknowledge was the only thing that
    // accidentally stopped it.
    const rearm = (target: number, direction: 'above' | 'below') =>
        direction === 'above'
            ? Math.round((target * (10000 - THRESHOLDS.AlertRearmBandBps)) / 10000)
            : Math.round((target * (10000 + THRESHOLDS.AlertRearmBandBps)) / 10000);

    for (const alert of alerts) {
        if (!alert.enabled) continue;

        if (alert.price_above_paise) {
            const above = num(alert.price_above_paise);
            if (alert.armed_above) {
                if (lastSeen < above && current >= above) {
                    events.push(EventType.USER_PRICE_TARGET_REACHED);
                    transitions.push({ alertId: alert.id, side: 'above', armed: false });
                }
            } else if (current <= rearm(above, 'above')) {
                transitions.push({ alertId: alert.id, side: 'above', armed: true });
            }
        }

        if (alert.price_below_paise) {
            const below = num(alert.price_below_paise);
            if (alert.armed_below) {
                if (lastSeen > below && current <= below) {
                    events.push(EventType.USER_PRICE_FLOOR_REACHED);
                    transitions.push({ alertId: alert.id, side: 'below', armed: false });
                }
            } else if (current >= rearm(below, 'below')) {
                transitions.push({ alertId: alert.id, side: 'below', armed: true });
            }
        }
    }
}
