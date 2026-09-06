/**
 * stockIntelligence.service.ts
 *
 * Shared pipeline that assembles everything the frontend needs to answer
 * "what happened to this stock?". Called by:
 *   - GET /api/watchlists/:id/summary (already existed — refactored to delegate here)
 *   - GET /api/stocks/:instrumentId/intelligence (new)
 *
 * Hard rules (§1 of the implementation plan):
 *   - Never write a second scoring formula — always delegates to the existing
 *     calculateMetrics / detectEvents / calculateScore / generateExplanations.
 *   - All money in integer paise; all pct in integer bps.
 *   - Uses app clock (clockNow()), never Date.now().
 *   - Degrades claims when context is missing, never fabricates attribution.
 */

import { query } from '../config/db';
import { getQuotes } from './marketData.service';
import { calculateMetrics, computeRegime, type MarketRegime } from './metrics.service';
import { detectEvents, EMPTY_FUNDAMENTALS, type AlertTransition } from './eventDetection.service';
import { calculateScore } from './attentionScore.service';
import { generateExplanations } from './explanation.service';
import { loadFundamentalsContext } from './fundamentals/context';
import { BENCHMARK_INSTRUMENT_ID, HORIZONS, isHorizonKey, suggestHorizon, type HorizonKey } from '../config/thresholds';
import { now as clockNow } from './clock';
import { NormalizedQuote } from '../models/quote';

// ─── Public types ────────────────────────────────────────────────────────────

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
        breakdown: unknown;
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
    corporateActions: CorporateActionSummary[];
    news: NewsSummary[];
    chart: { availableRanges: string[]; defaultRange: string };
    fundamentals: unknown;
    dataQuality: {
        status: string;
        dataTimestamp: string | null;
        feedDelaySeconds: number | null;
        warnings: string[];
    };
}

export interface CorporateActionSummary {
    type: string;
    date: string;
    subject: string | null;
    amountPaise: number | null;
    mechanical: boolean;
}

export interface NewsSummary {
    headline: string;
    url: string | null;
    publishedAt: string | null;
}

// ─── "Why" conclusion engine (§4, deterministic, no LLM) ─────────────────────

/**
 * Priority order from §4 of the plan:
 * 1. Corporate action / price adjustment → CORPORATE_ACTION
 * 2. Stale / missing data → UNKNOWN (never guess attribution without data)
 * 3. Strong stock-specific residual → STOCK_SPECIFIC
 * 4. Strong sector-specific residual, small stock-vs-sector residual → SECTOR_DRIVEN
 * 5. Move consistent with benchmark/beta → MARKET_DRIVEN
 * 6. Multiple factors → MIXED
 * 7. No signal → NO_SIGNIFICANT_CHANGE
 */
function buildConclusion(
    metrics: ReturnType<typeof calculateMetrics>,
    events: string[],
    dataQuality: { status: string },
): { type: ConclusionType; label: string } {
    const has = (e: string) => events.includes(e);

    // 1. Corporate action / mechanical price adjustment
    if (has('CORPORATE_ACTION_ADJUSTMENT') || has('SUSPECTED_PRICE_ADJUSTMENT')) {
        return { type: 'CORPORATE_ACTION', label: 'Corporate action may explain this move — price comparison is mechanical' };
    }

    // 2. Stale or missing data — can't safely attribute
    if (dataQuality.status === 'DATA_MISSING' || dataQuality.status === 'PROVIDER_DOWN' || has('DATA_STALE')) {
        return { type: 'UNKNOWN', label: 'Attribution unavailable — data is stale or missing' };
    }

    // Need enough price move to say anything meaningful
    const absBps = Math.abs(metrics.todayChangeBps);
    if (absBps < 100) {
        return { type: 'NO_SIGNIFICANT_CHANGE', label: 'No significant change — within normal range' };
    }

    // 3–5: Use residuals if we have benchmark context
    const hasMarket = metrics.residualMarketBps !== null && metrics.betaMarket !== null;
    const hasSector = metrics.residualSectorBps !== null;

    if (!hasMarket) {
        // No context — can at most say there was a large move
        if (has('LARGE_PRICE_MOVE') || has('IDIOSYNCRATIC_MOVE')) {
            return { type: 'UNKNOWN', label: 'Unusually large move, but market attribution cannot be determined right now' };
        }
        return { type: 'NO_SIGNIFICANT_CHANGE', label: 'No significant change detected' };
    }

    const residualMarket = Math.abs(metrics.residualMarketBps ?? 0);
    const residualSector = Math.abs(metrics.residualSectorBps ?? 0);
    // benchmarkTodayBps is not on Metrics directly, but we can derive it:
    // relativeToBenchBps = todayChangeBps - benchmarkTodayBps
    // so benchmarkTodayBps = todayChangeBps - relativeToBenchBps
    // The beta-expected move is betaMarket * benchmarkTodayBps
    const impliedBenchmarkBps = metrics.todayChangeBps - metrics.relativeToBenchBps;
    const marketBps = metrics.betaMarket !== null
        ? Math.abs(metrics.betaMarket * impliedBenchmarkBps)
        : 0;


    // "Strong" = stock-specific residual > 200bps and more than 50% of the total move
    const isStockSpecific = residualMarket > 200 && residualMarket > 0.5 * absBps;
    const isSectorDriven = hasSector && residualSector > 200 && residualSector < residualMarket;
    const isMarketDriven = marketBps > 0.5 * absBps && !isStockSpecific;

    // 6. Mixed
    if (isStockSpecific && (hasSector && residualSector > 150)) {
        return { type: 'MIXED', label: 'Move reflects a mix of stock-specific and sector factors' };
    }

    // 3. Stock-specific
    if (isStockSpecific) {
        return { type: 'STOCK_SPECIFIC', label: 'Move appears mostly stock-specific' };
    }

    // 4. Sector-driven
    if (isSectorDriven) {
        return { type: 'SECTOR_DRIVEN', label: 'Move consistent with sector trend' };
    }

    // 5. Market-driven
    if (isMarketDriven) {
        return { type: 'MARKET_DRIVEN', label: 'Move consistent with broader market direction' };
    }

    // 7. Fallback
    return { type: 'NO_SIGNIFICANT_CHANGE', label: 'Move within normal range' };
}

/** Machine-readable reason codes alongside the human strings */
function buildReasonCodes(events: string[]): string[] {
    const codeMap: Record<string, string> = {
        LARGE_PRICE_MOVE: 'LARGE_MOVE',
        IDIOSYNCRATIC_MOVE: 'STOCK_SPECIFIC',
        EXTREME_VOLUME: 'HIGH_VOLUME',
        UNUSUAL_VOLUME: 'HIGH_VOLUME',
        MARKET_OUTPERFORMANCE: 'STOCK_SPECIFIC',
        MARKET_UNDERPERFORMANCE: 'STOCK_SPECIFIC',
        SECTOR_DIVERGENCE: 'SECTOR_DIVERGENCE',
        VOLATILITY_SPIKE: 'VOLATILITY_SPIKE',
        EXTREME_VOLATILITY: 'VOLATILITY_SPIKE',
        GAP_UP: 'GAP_UP',
        GAP_DOWN: 'GAP_DOWN',
        NEW_52W_HIGH: 'NEW_52W_HIGH',
        NEW_52W_LOW: 'NEW_52W_LOW',
        CORPORATE_ACTION_ADJUSTMENT: 'CORPORATE_ACTION',
        SUSPECTED_PRICE_ADJUSTMENT: 'PRICE_ADJUSTMENT',
        RESULTS_JUST_OUT: 'RESULTS_EVENT',
        RESULTS_UPCOMING: 'RESULTS_EVENT',
        RECENT_ANNOUNCEMENT: 'NEWS_EVENT',
        DATA_STALE: 'STALE_DATA',
        PROVIDER_DOWN: 'PROVIDER_DOWN',
        INSUFFICIENT_HISTORY: 'INSUFFICIENT_HISTORY',
    };
    const codes = new Set<string>();
    for (const e of events) {
        const code = codeMap[e];
        if (code) codes.add(code);
    }
    if (codes.size === 0) codes.add('NO_SIGNIFICANT_CHANGE');
    return Array.from(codes);
}

// ─── Options ─────────────────────────────────────────────────────────────────

export interface BuildOptions {
    /** Explicit horizon override; null = auto from visit cadence. */
    horizonKey?: HorizonKey | null;
    /** Watchlist ID — used to load user_stock_state. Omit for public/explore. */
    watchlistId?: string;
    userId?: string;
}

// ─── Main orchestrator ───────────────────────────────────────────────────────

export async function buildStockIntelligence(
    instrumentId: string,
    options: BuildOptions = {},
): Promise<StockIntelligenceResponse> {
    const { userId, horizonKey: explicitHorizon } = options;

    // 1. Instrument metadata
    const metaRes = await query(
        'SELECT instrument_id, symbol, name, status FROM instruments WHERE instrument_id = $1',
        [instrumentId],
    );
    if (metaRes.rows.length === 0) {
        throw new NotFoundError(`Instrument ${instrumentId} not found`);
    }
    const meta = metaRes.rows[0];
    const exchange = instrumentId.split(':')[0] ?? 'NSE';

    // 2. Quote
    const { quotes, errors } = await getQuotes([instrumentId]);
    const quoteOrNull = quotes[0] ?? null;
    const quoteError = errors[instrumentId] ?? null;

    // 3. Benchmark + sector context (loaded even if quote is missing, to provide market info)
    const sectorRes = await query(
        `SELECT ss.instrument_id, ss.sector_index_id, i.name AS sector_name
         FROM stock_sectors ss LEFT JOIN instruments i ON i.instrument_id = ss.sector_index_id
         WHERE ss.instrument_id = $1`,
        [instrumentId],
    );
    const sectorRow = sectorRes.rows[0] ?? null;
    const sectorIndexId: string | null = sectorRow?.sector_index_id ?? null;
    const sectorName: string | null = sectorRow?.sector_name ?? null;

    const indexIds = Array.from(new Set<string>([
        BENCHMARK_INSTRUMENT_ID,
        ...(sectorIndexId ? [sectorIndexId] : []),
    ]));
    const indexQuotes = new Map((await getQuotes(indexIds)).quotes.map(q => [q.instrumentId, q]));
    const benchmarkQuote = indexQuotes.get(BENCHMARK_INSTRUMENT_ID) ?? null;
    const sectorQuote = sectorIndexId ? (indexQuotes.get(sectorIndexId) ?? null) : null;

    // 4. User baseline + statistics + regime + fundamentals
    const statsRes = await query(
        'SELECT * FROM stock_statistics WHERE instrument_id = $1',
        [instrumentId],
    );
    const stats = statsRes.rows[0] ?? { trading_days_observed: 0 };

    const regimeRes = await query(
        'SELECT * FROM market_regime WHERE benchmark_id = $1',
        [BENCHMARK_INSTRUMENT_ID],
    );
    const regime = computeRegime(regimeRes.rows[0] ?? null);

    // User state (only if authenticated)
    let userState: any = null;
    if (userId) {
        const stateRes = options.watchlistId
            ? await query(
                'SELECT * FROM user_stock_state WHERE user_id = $1 AND watchlist_id = $2 AND instrument_id = $3',
                [userId, options.watchlistId, instrumentId],
            )
            : await query(
                'SELECT * FROM user_stock_state WHERE user_id = $1 AND instrument_id = $2 ORDER BY last_seen_at DESC LIMIT 1',
                [userId, instrumentId],
            );
        userState = stateRes.rows[0] ?? null;
    }
    const state = userState ?? { last_seen_price_paise: 0, last_seen_at: quoteOrNull?.retrievedAt, is_initial_state: true };

    const fundamentalsMap = await loadFundamentalsContext([instrumentId]);
    const fundamentals = fundamentalsMap.get(instrumentId) ?? EMPTY_FUNDAMENTALS;

    // 5. Horizon selection (visits cadence)
    const daysSinceLastVisit = userState && !userState.is_initial_state && userState.last_seen_at
        ? Math.floor((clockNow().getTime() - new Date(userState.last_seen_at).getTime()) / 86_400_000)
        : null;
    const suggestedHorizon = suggestHorizon(daysSinceLastVisit);
    const horizon = explicitHorizon ?? suggestedHorizon;

    // 6. If quote is missing OR is a zero fallback from the provider-down / data-missing
    //    fallback chain, build a degraded response rather than computing metrics on
    //    pricePaise=0 data (which produces zeroed OHLV, attention=0, change=0, etc.)
    const quoteSource = (quoteOrNull as any)?.source ?? '';
    const isFallbackZero =
        !quoteOrNull ||
        quoteSource === 'DATA_MISSING' ||
        quoteSource === 'PROVIDER_DOWN' ||
        (quoteOrNull.lastPricePaise === 0 && quoteOrNull.previousClosePaise === 0);

    if (isFallbackZero) {
        const warnings = quoteError
            ? [`Data unavailable: ${quoteError}`]
            : quoteSource === 'DATA_MISSING'
            ? ['No data for this instrument on the demo date — re-run demo:seed to populate it']
            : ['Quote not available'];
        return buildDegradedResponse(instrumentId, meta, exchange, userState, regime, benchmarkQuote, sectorIndexId, sectorName, sectorQuote, warnings);
    }

    const quote = quoteOrNull;

    // 7. Core pipeline — identical to watchlist summary (rule 1: never duplicate)
    const alertTransitions: AlertTransition[] = [];
    const metrics = calculateMetrics(quote, stats, state, benchmarkQuote, sectorQuote, sectorIndexId, regime, horizon);
    const events = detectEvents(metrics, quote, stats, state, [] /* no per-stock alerts here */, fundamentals, alertTransitions);
    const attention = calculateScore(metrics, events, { fundamentals });
    const reasons = generateExplanations(events, metrics, state, [], { fundamentals, sectorName });

    // 8. Why-it-moved conclusion
    const dqStatus = metrics.dataStatus;
    const conclusion = buildConclusion(metrics, events, { status: dqStatus });
    const reasonCodes = buildReasonCodes(events);

    const headline = reasons[0] ?? (conclusion.type === 'NO_SIGNIFICANT_CHANGE'
        ? 'No significant change — within normal range'
        : conclusion.label);

    // 9. Since-last-check
    const isInitial = !!(state as any).is_initial_state;
    const sinceLastCheck = {
        hasBaseline: !isInitial,
        checkedAt: isInitial ? null : ((state as any).last_seen_at ?? null),
        previousPricePaise: isInitial ? null : ((state as any).last_seen_price_paise ?? null),
        currentPricePaise: quote.lastPricePaise,
        changeBps: isInitial ? null : (metrics.sinceLastVisitBps ?? null),
        daysSinceLastVisit: isInitial ? null : daysSinceLastVisit,
    };

    // 10. Market context
    const regimeRow = regimeRes.rows[0] ?? null;
    const benchmarkTodayBps = benchmarkQuote && benchmarkQuote.previousClosePaise > 0
        ? Math.floor(((benchmarkQuote.lastPricePaise - benchmarkQuote.previousClosePaise) * 10000) / benchmarkQuote.previousClosePaise)
        : null;
    const marketContext = {
        benchmarkId: BENCHMARK_INSTRUMENT_ID,
        benchmarkName: 'NIFTY 50',
        todayBps: benchmarkTodayBps,
        vix: regimeRow?.vix_level_x100 != null ? Number(regimeRow.vix_level_x100) / 100 : null,
        vixPercentile: regime.vixPctile === null ? null : Number(regime.vixPctile.toFixed(2)),
        regime: describeRegime(regime),
    };

    // 11. Sector context
    const sectorTodayBps = sectorQuote && sectorQuote.previousClosePaise > 0
        ? Math.floor(((sectorQuote.lastPricePaise - sectorQuote.previousClosePaise) * 10000) / sectorQuote.previousClosePaise)
        : null;
    const sectorContext = {
        sectorIndexId,
        sectorName,
        todayBps: sectorTodayBps,
        stockVsSectorBps: metrics.residualSectorBps ?? null,
    };

    // 12. Corporate actions (from fundamentals context already loaded)
    const corporateActions = buildCorporateActions(fundamentals);

    // 13. Data quality
    const warnings: string[] = [];
    if (dqStatus === 'STALE') warnings.push('Data may be stale — showing cached quote');
    if (dqStatus === 'CLOSED') warnings.push('Market is closed — showing last session close');
    if (quote.feedDelaySec && quote.feedDelaySec > 900) warnings.push(`Feed is approximately ${Math.round(quote.feedDelaySec / 60)} minutes delayed`);

    return {
        stock: { instrumentId, symbol: meta.symbol, name: meta.name ?? null, exchange, status: meta.status ?? 'ACTIVE' },
        quote: {
            pricePaise: quote.lastPricePaise,
            previousClosePaise: quote.previousClosePaise,
            openPaise: quote.openPaise ?? null,
            highPaise: quote.highPaise ?? null,
            lowPaise: quote.lowPaise ?? null,
            volume: quote.volume ?? null,
            todayChangeBps: metrics.todayChangeBps,
            retrievedAt: quote.retrievedAt?.toISOString() ?? null,
        },
        sinceLastCheck,
        attention,
        why: { headline, conclusion, reasons, reasonCodes },
        rarity: {
            band: metrics.rarityBand ?? null,
            window: metrics.rarityWindowLabel ?? null,
            estimated: metrics.rarityFallback,
        },
        volume: {
            current: quote.volume ?? null,
            average: stats.avg_volume_30d ? parseInt(stats.avg_volume_30d, 10) : null,
            ratio: Number(metrics.volumeRatio.toFixed(2)),
            percentile: metrics.volumeRarityFraction !== undefined ? Number((metrics.volumeRarityFraction * 100).toFixed(1)) : null,
        },
        marketContext,
        sectorContext,
        events: events as unknown as string[],
        corporateActions,
        news: [],   // filled by news layer (step 10 of plan) — never blocks the response
        chart: { availableRanges: ['1D', '1W', '1M', '6M', '1Y'], defaultRange: '1D' },
        fundamentals: {
            resultsDate: fundamentals.resultsDate,
            resultsDaysFromNow: fundamentals.resultsDaysFromNow,
            exDividendDate: fundamentals.exDividendDate,
            dividendAmountPaise: fundamentals.dividendAmountPaise,
            corporateActionToday: fundamentals.corporateActionToday?.type ?? null,
            announcements: fundamentals.recentAnnouncements,
        },
        dataQuality: {
            status: dqStatus,
            dataTimestamp: quote.dataTimestamp?.toISOString() ?? null,
            feedDelaySeconds: quote.feedDelaySec ?? null,
            warnings,
        },
    };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function describeRegime(regime: MarketRegime): string {
    if (regime.volRatio > 1.5) return 'HIGH_VOLATILITY';
    if (regime.volRatio > 1.2) return 'ELEVATED_VOLATILITY';
    return 'NORMAL';
}

function buildCorporateActions(fundamentals: typeof EMPTY_FUNDAMENTALS): CorporateActionSummary[] {
    const out: CorporateActionSummary[] = [];
    if (fundamentals.corporateActionToday) {
        out.push({
            type: fundamentals.corporateActionToday.type,
            date: 'today',
            subject: fundamentals.corporateActionToday.subject ?? null,
            amountPaise: null,
            mechanical: true,
        });
    }
    if (fundamentals.exDividendDate) {
        out.push({
            type: 'DIVIDEND',
            date: fundamentals.exDividendDate,
            subject: null,
            amountPaise: fundamentals.dividendAmountPaise,
            mechanical: false,
        });
    }
    return out;
}

function buildDegradedResponse(
    instrumentId: string,
    meta: any,
    exchange: string,
    userState: any,
    regime: MarketRegime,
    benchmarkQuote: NormalizedQuote | null,
    sectorIndexId: string | null,
    sectorName: string | null,
    sectorQuote: NormalizedQuote | null,
    warnings: string[],
): StockIntelligenceResponse {
    const benchmarkTodayBps = benchmarkQuote && benchmarkQuote.previousClosePaise > 0
        ? Math.floor(((benchmarkQuote.lastPricePaise - benchmarkQuote.previousClosePaise) * 10000) / benchmarkQuote.previousClosePaise)
        : null;

    return {
        stock: { instrumentId, symbol: meta.symbol, name: meta.name ?? null, exchange, status: meta.status ?? 'ACTIVE' },
        quote: {
            pricePaise: 0,
            previousClosePaise: 0,
            openPaise: null,
            highPaise: null,
            lowPaise: null,
            volume: null,
            todayChangeBps: null,
            retrievedAt: null,
        },
        sinceLastCheck: {
            hasBaseline: false,
            checkedAt: null,
            previousPricePaise: null,
            currentPricePaise: null,
            changeBps: null,
            daysSinceLastVisit: null,
        },
        attention: { score: 0, severity: 'QUIET', breakdown: null },
        why: {
            headline: 'Live data unavailable — showing last known state',
            conclusion: { type: 'UNKNOWN', label: 'Attribution unavailable — provider is down' },
            reasons: ['Live data unavailable — showing last known price'],
            reasonCodes: ['PROVIDER_DOWN'],
        },
        rarity: { band: null, window: null, estimated: false },
        volume: { current: null, average: null, ratio: null, percentile: null },
        marketContext: {
            benchmarkId: BENCHMARK_INSTRUMENT_ID,
            benchmarkName: 'NIFTY 50',
            todayBps: benchmarkTodayBps,
            vix: null,
            vixPercentile: null,
            regime: describeRegime(regime),
        },
        sectorContext: {
            sectorIndexId,
            sectorName,
            todayBps: null,
            stockVsSectorBps: null,
        },
        events: ['PROVIDER_DOWN'],
        corporateActions: [],
        news: [],
        chart: { availableRanges: ['1D', '1W', '1M', '6M', '1Y'], defaultRange: '1D' },
        fundamentals: null,
        dataQuality: {
            status: 'PROVIDER_DOWN',
            dataTimestamp: null,
            feedDelaySeconds: null,
            warnings,
        },
    };
}

// Exported so routes can surface a clean 404 instead of a 500
export class NotFoundError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'NotFoundError';
    }
}
