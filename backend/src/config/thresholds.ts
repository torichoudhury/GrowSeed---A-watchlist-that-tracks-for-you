export const THRESHOLDS = {
    LargePriceMoveBps: 500,     // 5.00% — fires LARGE_PRICE_MOVE
    VolumeRatioUnusual: 2.0,    // fires UNUSUAL_VOLUME
    VolumeRatioExtreme: 3.0,    // fires EXTREME_VOLUME
    VolumeAbsoluteFloor: 100000, // minimum shares before volume events fire
    MovementAnomalyNotable: 2.0, // modified z-score — fires VOLATILITY_SPIKE
    MovementAnomalyExtreme: 3.0, // fires EXTREME_VOLATILITY
    RelativeDivergenceBps: 200, // 2.00% — fires MARKET_OUTPERFORMANCE/UNDERPERFORMANCE
    AlertRearmBandBps: 50,      // 0.50% retreat before alert re-arms
};

// Score category caps — sum to 100. Re-budgeted (approved 2026-09-04) for the
// three-component model: time-series 50 · external 25 · fundamentals 20 · user 5.
export const SCORE_CAPS = {
    // time-series (50)
    Price: 20,
    Volume: 12,
    Volatility: 10,
    Milestone: 8,          // 52w/30d/7d crossings, streaks, drawdown — max, not sum
    // external (25) — regime and breadth act as dampeners, not categories
    MarketRelative: 15,    // beta-adjusted residual vs benchmark
    SectorRelative: 10,    // residual vs the stock's sector index
    // internal / company fundamentals (20)
    FundamentalsResults: 10,
    FundamentalsCorporateAction: 6,
    FundamentalsAnnouncement: 4,
    // user (5)
    UserSignal: 5,
};

// Empirical-percentile thresholds (approved 2026-09-04): "notable" is beyond
// the stock's OWN 95th percentile of |daily return| over the trailing year,
// "extreme" beyond the 99th. The flat constants in THRESHOLDS survive only as
// a noise floor so a 0.3% move on a dead-flat stock can never fire.
export const NOISE_FLOOR = {
    PriceMoveBps: 100,     // 1.00% — below this nothing price-based fires
    GapBps: 75,            // 0.75%
    VolumeRatio: 1.5,      // vs 30d average, on top of the absolute floor
};

export const TIME_SERIES = {
    VolRegimeShiftRatio: 1.8,   // EWMA vol / 90d realized vol
    StreakDays: 5,              // consecutive same-direction sessions
    DrawdownNotableBps: -1000,  // 10% below 30d high
    RunupNotableBps: 1000,      // 10% above 30d low
    LevelShiftZ: 2.5,           // two-window mean shift, t-like (σ90/√5); 2.5 ≈ top 1–2% under fat tails
    AccumulationVolumeZ: 2.5,   // volume spike with no price move
};

export const EXTERNAL = {
    ResidualZNotable: 2.0,      // modified z of market-model residual
    ResidualZExtreme: 3.0,
    RegimeDampenStartRatio: 1.3,  // benchmark 20d vol / 250d vol
    RegimeMaxDampen: 0.6,
    VixPctileDampen: 0.90,      // VIX above its 90th percentile of the year
    VixDampenFactor: 0.9,
    BreadthSameDirectionPct: 70,  // % of the watchlist moving the same way
    BreadthDampenFactor: 0.8,
};

/**
 * Attention horizons. "Meaningfully changed" depends entirely on how often
 * you look: for a daily checker a 2% day is news, for someone who checks
 * monthly it's noise inside a 20-session move. Each horizon compares the
 * stock's move over its own window against the empirical distribution of
 * moves over THAT window (not today's move against daily history), and
 * scales the noise floor by √sessions — the random-walk scaling, so a
 * "notable" week isn't just five notable days concatenated.
 */
export const HORIZONS = {
    DAY: { sessions: 1, label: 'Today', short: '1D', windowLabel: 'daily' },
    WEEK: { sessions: 5, label: 'Past week', short: '1W', windowLabel: 'weekly' },
    MONTH: { sessions: 20, label: 'Past month', short: '1M', windowLabel: 'monthly' },
} as const;

export type HorizonKey = keyof typeof HORIZONS;

export function isHorizonKey(v: string): v is HorizonKey {
    return v === 'DAY' || v === 'WEEK' || v === 'MONTH';
}

/**
 * Which horizon a user who has been away this long should land on. Their own
 * visit cadence is the only honest default: it makes "what changed since you
 * last checked" and "is that unusual?" answer over the same window.
 */
export function suggestHorizon(daysSinceLastVisit: number | null): HorizonKey {
    if (daysSinceLastVisit === null) return 'DAY';
    if (daysSinceLastVisit >= 12) return 'MONTH';
    if (daysSinceLastVisit >= 4) return 'WEEK';
    return 'DAY';
}

// Statistical corporate-action guard (services/fundamentals/splitDetector.ts).
export const ADJUSTMENT_GUARD = {
    MinAbsReturnBps: 1500,        // 15% — NSE price bands make a real one-day move this size very rare
    RatioTolerance: 0.015,        // implied factor within 1.5% of a clean ratio → candidate
    HighConfidenceTolerance: 0.004, // within 0.4% → clean enough to act on
    RangeClearanceFrac: 0.08,     // the whole session traded clear of the pre-event level
    NextDayCalmBps: 500,          // a re-scaling settles immediately; a shock does not
    KnownEventWindowDays: 3,      // a calendar entry this close means it is already handled
};

// Fundamentals windows (approved defaults 2026-09-04), in calendar days.
export const FUNDAMENTALS = {
    ResultsDaysBefore: 3,
    ResultsDaysAfter: 2,
    ExDividendDaysBefore: 1,
    AnnouncementDays: 2,
};

// Correlation discount — applied to the price+volume+volatility sub-total
export const CORRELATION_DISCOUNT = {
    ThreeCorrelated: 0.85, // all 3 fired from the same move
    TwoCorrelated: 0.93,   // 2 of 3 fired from the same move
};

// Minimum trading days required to enable each statistics window
export const MIN_DAYS = {
    Days7: 5,
    Days30: 20,
    Days52w: 200,
};

// Data freshness thresholds (seconds) — only applied when market is OPEN
export const FRESHNESS_SEC = {
    Live: 30,
    Recent: 120,
    Delayed: 300,
};

// Cache TTLs
export const CACHE_TTL = {
    QuoteSec: 30,
    // Outside the session the price cannot change, so re-fetching every 30s
    // buys nothing and is what gets an unofficial feed to throttle us. A
    // cached CLOSED quote is discarded the moment the session state changes
    // (marketData.service), so this can never bleed into a live session.
    QuoteClosedSec: 600,
    StatsSec: 900,
    LockMs: 3000,
};

// Never open more than this many provider connections at once. A cold summary
// wants ~23 quotes; firing them all in parallel is both rude to a free feed
// and the fastest way to be rate-limited into tarpit territory.
export const PROVIDER_MAX_CONCURRENCY = 4;

// Severity bands — score >= Min gets that label
export const SEVERITY_BANDS = [
    { min: 81, label: "CRITICAL" },
    { min: 61, label: "HIGH" },
    { min: 41, label: "MEDIUM" },
    { min: 21, label: "LOW" },
    { min: 0, label: "QUIET" },
];

// Market-relative comparisons (BUILD_SPEC §11.1 step 5) use the Nifty 50 as
// the benchmark. Groww's own trading_symbol for it is bare "NIFTY" (its
// instrument name is "NIFTY 50", but the symbol itself has no "50") — see
// instrument.csv row: NSE,NIFTY,NIFTY,NSE-NIFTY,NIFTY 50,IDX,CASH,...
export const BENCHMARK_INSTRUMENT_ID = 'NSE:NIFTY';
