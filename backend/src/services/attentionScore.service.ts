import { SCORE_CAPS, CORRELATION_DISCOUNT, SEVERITY_BANDS, EXTERNAL, FUNDAMENTALS } from '../config/thresholds';
import { calibrateScore } from '../config/calibration';
import { Metrics } from './metrics.service';
import { EventType, FundamentalsContext, EMPTY_FUNDAMENTALS } from './eventDetection.service';

/** Linear ramp clamped to [0, cap]. The lower clamp matters: z-scores go
 * NEGATIVE on quiet days, and without it a calm day would subtract. */
function ramp(value: number, maxInput: number, cap: number): number {
    return cap * Math.min(1, Math.max(0, value / maxInput));
}

export interface ScoreBreakdown {
    price: number; volume: number; volatility: number; milestone: number;
    marketRelative: number; sectorRelative: number; fundamentals: number; user: number;
    correlationDiscount: number; regimeDampen: number; breadthDampen: number; freshnessPenalty: number;
    /** Pre-calibration score (0–100 theoretical); what `npm run calibrate` anchors on. */
    rawScore: number;
    /** True when a split/bonus (recorded or detected) makes the price numbers
     * mechanical, so none of them contributed to the score. */
    mechanical: boolean;
}

export interface ScoreContext {
    fundamentals?: FundamentalsContext;
    /** Fraction (0..1) of the watchlist moving in the same direction as this
     * stock today — a move the whole list made is expected, not news. */
    breadthSameDirection?: number;
}

export function calculateScore(
    metrics: Metrics,
    events: EventType[],
    context: ScoreContext = {}
): { score: number; severity: string; breakdown: ScoreBreakdown } {
    const has = (e: EventType) => events.includes(e);
    const f = context.fundamentals ?? EMPTY_FUNDAMENTALS;

    // A split/bonus — recorded, or caught by the statistical guard — re-scales
    // the price. Every price, volume and relative number is then arithmetic,
    // not information, so none of them may earn a single point; only the
    // calendar and the user's own alerts survive.
    const mechanical = has(EventType.CORPORATE_ACTION_ADJUSTMENT) || has(EventType.SUSPECTED_PRICE_ADJUSTMENT);

    // ── Time-series (50) ──────────────────────────────────────────────────
    // Price: the larger of "rate of change since your last visit" (spec §9,
    // magnitude per day so a 3-month drift can't dominate) and "how rare is
    // this move for THIS stock over the user's own horizon" (empirical percentile).
    const price = mechanical ? 0 : Math.max(
        ramp(Math.abs(metrics.magnitudePerDayBps), 500, SCORE_CAPS.Price),
        SCORE_CAPS.Price * metrics.rarityFraction
    );
    // Volume: percentile of today's volume, lifted when price confirms it.
    const volume = mechanical ? 0 : Math.max(
        SCORE_CAPS.Volume * metrics.volumeRarityFraction,
        ramp(metrics.priceVolumeConfirm, 3.5, SCORE_CAPS.Volume)
    );
    // Volatility: today's anomaly vs its own range, or a regime shift in progress.
    const volatility = mechanical ? 0 : Math.max(
        ramp(metrics.movementAnomaly, 3.5, SCORE_CAPS.Volatility),
        ramp(metrics.volRegimeRatio - 1, 1.5, SCORE_CAPS.Volatility)
    );
    // Milestones/path: strongest single signal, never summed.
    let milestone = 0;
    if (has(EventType.NEW_52W_HIGH) || has(EventType.NEW_52W_LOW)) milestone = SCORE_CAPS.Milestone;
    else if (has(EventType.NEW_30D_HIGH) || has(EventType.NEW_30D_LOW)) milestone = SCORE_CAPS.Milestone * 0.75;
    else if (has(EventType.NEW_7D_HIGH) || has(EventType.NEW_7D_LOW)) milestone = SCORE_CAPS.Milestone * 0.5;
    if (has(EventType.STREAK_UP) || has(EventType.STREAK_DOWN)) milestone = Math.max(milestone, SCORE_CAPS.Milestone * 0.5);
    if (has(EventType.DRAWDOWN_FROM_HIGH) || has(EventType.RUNUP_FROM_LOW)) milestone = Math.max(milestone, SCORE_CAPS.Milestone * 0.5);
    if (has(EventType.LEVEL_SHIFT)) milestone = Math.max(milestone, SCORE_CAPS.Milestone * 0.5);

    // ── External (25) ─────────────────────────────────────────────────────
    const marketRelative = mechanical ? 0 : metrics.residualMarketZ !== null
        ? ramp(Math.abs(metrics.residualMarketZ), 3.5, SCORE_CAPS.MarketRelative)
        : ramp(Math.abs(metrics.relativeToBenchBps), 400, SCORE_CAPS.MarketRelative);
    const sectorRelative = mechanical || metrics.residualSectorZ === null
        ? 0
        : ramp(Math.abs(metrics.residualSectorZ), 3.5, SCORE_CAPS.SectorRelative);

    // ── Internal / fundamentals (20) ──────────────────────────────────────
    let results = 0;
    if (f.resultsDaysFromNow !== null) {
        // Peak on the day and the day after; ramp in over the days before.
        // Clamped at 0: beyond the ramp this goes negative, and `fundamentals`
        // below is only capped from above — a far-future results date would
        // have SUBTRACTED from the score.
        results = f.resultsDaysFromNow <= 0
            ? SCORE_CAPS.FundamentalsResults
            : Math.max(0, SCORE_CAPS.FundamentalsResults * (1 - f.resultsDaysFromNow / (FUNDAMENTALS.ResultsDaysBefore + 1)));
    }
    const corporate = f.corporateActionToday ? SCORE_CAPS.FundamentalsCorporateAction
        : f.exDividendDaysFromNow !== null ? SCORE_CAPS.FundamentalsCorporateAction * 0.5 : 0;
    const announcement = f.recentAnnouncements.length > 0 ? SCORE_CAPS.FundamentalsAnnouncement : 0;
    const fundamentals = Math.min(
        SCORE_CAPS.FundamentalsResults + SCORE_CAPS.FundamentalsCorporateAction + SCORE_CAPS.FundamentalsAnnouncement,
        results + corporate + announcement
    );

    // ── User (5) ──────────────────────────────────────────────────────────
    const user = has(EventType.USER_PRICE_TARGET_REACHED) || has(EventType.USER_PRICE_FLOOR_REACHED) ? SCORE_CAPS.UserSignal : 0;

    let raw = price + volume + volatility + milestone + marketRelative + sectorRelative + fundamentals + user;

    // §9 correlation discount: price/volume/volatility are three views of one move.
    let n = 0;
    if (price > 0) n++;
    if (volume > 0) n++;
    if (volatility > 0) n++;
    const correlationDiscount = n >= 3 ? CORRELATION_DISCOUNT.ThreeCorrelated : n === 2 ? CORRELATION_DISCOUNT.TwoCorrelated : 1;
    raw *= correlationDiscount;

    // External dampeners: a high-vol regime and a whole-watchlist move both
    // mean "this is not the stock's own story".
    const regimeDampen = metrics.regime.dampen;
    raw *= regimeDampen;
    const breadthDampen = (context.breadthSameDirection ?? 0) * 100 >= EXTERNAL.BreadthSameDirectionPct ? EXTERNAL.BreadthDampenFactor : 1;
    raw *= breadthDampen;

    // Freshness penalty (spec §9).
    let freshnessPenalty = 1;
    if (metrics.dataStatus === 'STALE') freshnessPenalty = 0.5;
    else if (metrics.dataStatus === 'PROVIDER_DOWN' || metrics.dataStatus === 'DATA_MISSING') freshnessPenalty = 0;
    raw *= freshnessPenalty;

    const rawScore = Math.max(0, Math.min(100, Math.round(raw)));
    // Calibrated so the spec's bands hit their target base rates on real
    // history (config/calibration.ts). A data problem still pins to 0.
    const score = freshnessPenalty === 0 ? 0 : calibrateScore(rawScore);
    // Sorted here rather than trusting the array's order: the loop takes the
    // first band the score clears, so a reordered config would silently
    // mislabel every stock.
    let severity = 'QUIET';
    for (const band of [...SEVERITY_BANDS].sort((a, b) => b.min - a.min)) {
        if (score >= band.min) { severity = band.label; break; }
    }

    return {
        score, severity,
        breakdown: {
            price: Math.round(price), volume: Math.round(volume), volatility: Math.round(volatility), milestone: Math.round(milestone),
            marketRelative: Math.round(marketRelative), sectorRelative: Math.round(sectorRelative),
            fundamentals: Math.round(fundamentals), user,
            correlationDiscount, regimeDampen: Number(regimeDampen.toFixed(2)), breadthDampen, freshnessPenalty,
            rawScore, mechanical,
        },
    };
}
