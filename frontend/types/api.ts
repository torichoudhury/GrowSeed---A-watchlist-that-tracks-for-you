export interface User {
  id: string;
  email: string;
}

export interface Watchlist {
  id: string;
  name: string;
  stockCount: number;
}

export interface StockChange {
  todayBps: number;
  /** Move over the active horizon window (equals todayBps when horizon = DAY). */
  horizonBps?: number | null;
  horizonSessions?: number;
  sinceLastVisitBps?: number;
  daysSinceLastVisit?: number;
}

export type Horizon = 'DAY' | 'WEEK' | 'MONTH';

export interface StockVolume {
  current: number;
  average: number;
  ratio: number;
}

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'QUIET';
export type RarityBand = 'NONE' | 'P90' | 'P95' | 'P98' | 'P99' | 'MAX';

export interface ScoreBreakdown {
  price: number; volume: number; volatility: number; milestone: number;
  marketRelative: number; sectorRelative: number; fundamentals: number; user: number;
  correlationDiscount: number; regimeDampen: number; breadthDampen: number; freshnessPenalty: number;
  rawScore?: number;
  /** A split/bonus (recorded or detected) made the price numbers mechanical. */
  mechanical?: boolean;
}

export interface Attention {
  score: number;
  severity: Severity;
  breakdown: ScoreBreakdown | null;
}

export interface DataQuality {
  status: 'LIVE' | 'RECENT' | 'DELAYED' | 'STALE' | 'CLOSED' | 'PROVIDER_DOWN' | 'DATA_MISSING';
  ageSeconds: number;
  feedDelaySeconds: number;
  dataTimestamp: string | null;
}

export interface StockContext {
  /** Set when the move looks like an unrecorded split/bonus. */
  adjustmentGuard?: { factor: number; label: string } | null;
  market: { indexId: string; todayBps: number; beta: number | null; residualBps: number | null } | null;
  sector: { indexId: string; name: string | null; todayBps: number | null; residualBps: number | null } | null;
  path: { streakDays: number; drawdownFrom30dHighBps: number | null; runupFrom30dLowBps: number | null };
  regime: { volRatio: number; vixPctile: number | null; dampen: number };
  fundamentals: {
    resultsDate: string | null;
    resultsDaysFromNow: number | null;
    exDividendDate: string | null;
    dividendAmountPaise: number | null;
    corporateActionToday: 'SPLIT' | 'BONUS' | null;
    announcements: string[];
  };
}

export interface WatchlistStock {
  instrumentId: string;
  symbol: string;
  name: string | null;
  instrumentStatus: 'ACTIVE' | 'SUSPENDED' | 'DELISTED';
  pricePaise: number;
  isInitialState: boolean;
  lastSeenAt: string | null;
  change: StockChange;
  volume: StockVolume;
  attention: Attention;
  rarity: RarityBand;
  /** 'daily' | 'weekly' | 'monthly' — the window `rarity` was measured over. */
  rarityWindow?: string;
  /** Horizon cutpoints were √t-scaled from daily history, not measured. */
  rarityEstimated?: boolean;
  events: string[];
  reasons: string[];
  conclusion?: string;
  context: StockContext | null;
  dataQuality: DataQuality;
}

export interface DigestItem {
  instrumentId: string;
  symbol: string;
  name: string | null;
  score: number;
  severity: Severity;
  line: string;
}

export interface Digest {
  headline: string;
  items: DigestItem[];
  quiet: boolean;
}

export interface MarketContext {
  indexId: string;
  name: string;
  todayBps: number;
  vixLevel: number | null;
  vixPctile: number | null;
  volRatio: number;
  dampen: number;
  breadthUp: number;
  breadthDown: number;
}

export interface WatchlistSummary {
  watchlist: { id: string; name: string };
  summary: {
    totalStocks: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    quiet: number;
    gainers: number;
    losers: number;
    watchlistSignals: string[];
    lastVisitAt: string | null;
    daysSinceLastVisit: number | null;
    horizon: Horizon;
    /** True when the server chose the horizon from the user's visit cadence. */
    horizonAuto: boolean;
    suggestedHorizon: Horizon;
    horizonLabel: string;
    market: MarketContext | null;
    digest: Digest;
    /** The app's own clock — relative times are computed against this, not the
     * browser's, so a replayed session doesn't read as a month stale. */
    serverTime?: string;
    /** Present only when the backend is replaying a past session. */
    demo?: { asOf: string; speed: number } | null;
    /** False when the server has disabled the 3s auto-acknowledge. */
    autoAcknowledge?: boolean;
  };
  stocks: WatchlistStock[];
}

export interface InstrumentRef {
  instrumentId: string;
  symbol: string;
  exchange: string;
  name: string;
}

export interface Alert {
  id: string;
  instrument_id: string;
  price_above_paise: string | null;
  price_below_paise: string | null;
  enabled: boolean;
}

// ─── Stock Intelligence (new) ────────────────────────────────────────────────

export type ConclusionType =
  | 'STOCK_SPECIFIC'
  | 'MARKET_DRIVEN'
  | 'SECTOR_DRIVEN'
  | 'CORPORATE_ACTION'
  | 'MIXED'
  | 'UNKNOWN'
  | 'NO_SIGNIFICANT_CHANGE';

export interface StockIntelligenceResponse {
  stock: {
    instrumentId: string;
    symbol: string;
    name: string | null;
    exchange: string;
    status: string;
  };
  quote: {
    pricePaise: number;
    previousClosePaise: number;
    openPaise: number | null;
    highPaise: number | null;
    lowPaise: number | null;
    volume: number | null;
    todayChangeBps: number | null;
    retrievedAt: string | null;
  };
  sinceLastCheck: {
    hasBaseline: boolean;
    checkedAt: string | null;
    previousPricePaise: number | null;
    currentPricePaise: number | null;
    changeBps: number | null;
    daysSinceLastVisit: number | null;
  };
  attention: {
    score: number;
    severity: string;
    breakdown: ScoreBreakdown | null;
  };
  why: {
    headline: string;
    conclusion: { type: ConclusionType; label: string };
    reasons: string[];
    reasonCodes: string[];
  };
  rarity: { band: string | null; window: string | null; estimated: boolean };
  volume: { current: number | null; average: number | null; ratio: number | null; percentile: number | null };
  marketContext: {
    benchmarkId: string;
    benchmarkName: string | null;
    todayBps: number | null;
    vix: number | null;
    vixPercentile: number | null;
    regime: string | null;
  };
  sectorContext: {
    sectorIndexId: string | null;
    sectorName: string | null;
    todayBps: number | null;
    stockVsSectorBps: number | null;
  };
  events: string[];
  corporateActions: {
    type: string;
    date: string;
    subject: string | null;
    amountPaise: number | null;
    mechanical: boolean;
  }[];
  news: { headline: string; url: string | null; publishedAt: string | null }[];
  chart: { availableRanges: string[]; defaultRange: string };
  fundamentals: {
    resultsDate: string | null;
    resultsDaysFromNow: number | null;
    exDividendDate: string | null;
    dividendAmountPaise: number | null;
    corporateActionToday: string | null;
    announcements: string[];
  } | null;
  dataQuality: {
    status: string;
    dataTimestamp: string | null;
    feedDelaySeconds: number | null;
    warnings: string[];
  };
}

export interface ChartCandle {
  timestamp: string;
  openPaise: number | null;
  highPaise: number | null;
  lowPaise: number | null;
  closePaise: number | null;
  volume: number | null;
}

export interface ChartResponse {
  range: string;
  interval: string;
  actualInterval: string;
  candles: ChartCandle[];
}

export interface ExploreResult {
  instrumentId: string;
  symbol: string;
  name: string | null;
  exchange: string;
  sectorName: string | null;
  pricePaise: number;
  todayChangeBps: number;
  volume: number;
  attentionScore: number;
  severity: string;
}

export interface ExploreResponse {
  category: string;
  results: ExploreResult[];
  total: number;
}
