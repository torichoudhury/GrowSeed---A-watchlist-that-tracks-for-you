package config

const (
    LargePriceMoveBps      = 500   // 5.00% — fires LARGE_PRICE_MOVE
    VolumeRatioUnusual     = 2.0   // fires UNUSUAL_VOLUME
    VolumeRatioExtreme     = 3.0   // fires EXTREME_VOLUME
    VolumeAbsoluteFloor    = 100000 // minimum shares before volume events fire
    MovementAnomalyNotable = 2.0   // modified z-score — fires VOLATILITY_SPIKE
    MovementAnomalyExtreme = 3.0   // fires EXTREME_VOLATILITY
    RelativeDivergenceBps  = 200   // 2.00% — fires MARKET_OUTPERFORMANCE/UNDERPERFORMANCE
    AlertRearmBandBps      = 50    // 0.50% retreat before alert re-arms
)

// Score category caps — these sum to 100
const (
    CapPrice      = 30
    CapVolume     = 20
    CapVolatility = 20
    CapMilestone  = 15
    CapRelative   = 10
    CapUserSignal = 5
)

// Correlation discount — applied to the price+volume+volatility sub-total
const (
    DiscountThreeCorrelated = 0.85 // all 3 fired from the same move
    DiscountTwoCorrelated   = 0.93 // 2 of 3 fired from the same move
)

// Minimum trading days required to enable each statistics window
const (
    MinDays7d  = 5
    MinDays30d = 20
    MinDays52w = 200
)

// Data freshness thresholds (seconds) — only applied when market is OPEN
const (
    FreshLiveSec    = 30
    FreshRecentSec  = 120
    FreshDelayedSec = 300
)

// Cache TTLs
const (
    QuoteTTLSec = 30
    StatsTTLSec = 900
    LockTTLMs   = 3000
)

// Severity bands — score >= Min gets that label
var SeverityBands = []struct{ Min int; Label string }{
    {81, "CRITICAL"}, {61, "HIGH"}, {41, "MEDIUM"}, {21, "LOW"}, {0, "QUIET"},
}
