import { Router } from 'express';
import { query } from '../config/db';
import { redisClient } from '../config/redis';
import { getQuotes } from '../services/marketData.service';
import { calculateMetrics, computeRegime } from '../services/metrics.service';
import { detectEvents, EMPTY_FUNDAMENTALS, type AlertTransition } from '../services/eventDetection.service';
import { redact } from '../services/log';
import { loadFundamentalsContext } from '../services/fundamentals/context';
import { calculateScore } from '../services/attentionScore.service';
import { generateExplanations, deriveConclusion } from '../services/explanation.service';
import { buildDigest } from '../services/digest.service';
import { requireAuth } from '../middleware/auth';
import { getOwnedWatchlist, INSTRUMENT_ID_RE } from '../services/ownership';
import { BENCHMARK_INSTRUMENT_ID, HORIZONS, isHorizonKey, suggestHorizon } from '../config/thresholds';
import { now as clockNow, demoBadge, autoAcknowledgeEnabled, DEMO, resetDemoClock } from '../services/clock';
import { resetDemoWatchlist } from '../services/demo/reset';
import {
    parseInstrumentId, parseUuid, parseTimestamp, parseIntInRange, parseBoundedArray, parseText,
} from '../services/validate';

/** A watchlist is a screen, not a database. These bound the work one request
 * can ask for; without them `items` and `?ids=` were limited only by the JSON
 * body parser. */
const MAX_ACKNOWLEDGE_ITEMS = 200;
const MAX_STOCKS_PER_WATCHLIST = 200;
const MAX_WATCHLIST_NAME = 100;
/** ₹1 crore a share, in paise — far above any real quote, low enough to catch nonsense. */
const MAX_PAISE = 100_000_000_000;

const router = Router();
router.use(requireAuth);

/**
 * Writes the arm/disarm side of the alert hysteresis (BUILD_SPEC §8.4).
 * One statement for the whole batch; the `armed_*` columns had no writer at
 * all before this, so every alert re-fired on every poll.
 */
async function persistAlertTransitions(transitions: AlertTransition[]): Promise<void> {
    const above = transitions.filter(t => t.side === 'above');
    const below = transitions.filter(t => t.side === 'below');
    try {
        for (const [side, group] of [['armed_above', above], ['armed_below', below]] as const) {
            for (const armed of [true, false]) {
                const ids = group.filter(t => t.armed === armed).map(t => t.alertId);
                if (ids.length === 0) continue;
                await query(`UPDATE user_alerts SET ${side} = $1, updated_at = now() WHERE id = ANY($2::uuid[])`, [armed, ids]);
            }
        }
    } catch (e) {
        console.error('Alert re-arm write failed:', redact(e));
    }
}

/** The WS gateway caches each user's instrument list to survive reconnect
 * storms (ws/gateway.ts); changing the list must drop it so a newly added
 * stock starts ticking on the next connection rather than 30s later. */
const dropWsInstrumentCache = (userId: string) =>
    redisClient.del(`ws:instruments:${userId}`).catch(() => { /* cache only */ });

// ─── Watchlist CRUD (BUILD_SPEC §11, §34) ──────────────────────────────────

router.get('/', async (req: any, res) => {
    const result = await query(
        `SELECT w.id, w.name, COUNT(wi.id)::int AS "stockCount"
         FROM watchlists w
         LEFT JOIN watchlist_items wi ON wi.watchlist_id = w.id
         WHERE w.user_id = $1
         GROUP BY w.id
         ORDER BY w.created_at ASC`,
        [req.user.id]
    );
    res.json(result.rows);
});

router.post('/', async (req: any, res) => {
    const name = parseText(req.body?.name, { field: 'name', max: MAX_WATCHLIST_NAME });

    const result = await query(
        'INSERT INTO watchlists (user_id, name) VALUES ($1, $2) RETURNING id, name',
        [req.user.id, name]
    );
    res.status(201).json(result.rows[0]);
});

router.delete('/:id', async (req: any, res) => {
    const watchlist = await getOwnedWatchlist(req.user.id, req.params.id);
    if (!watchlist) return res.status(404).json({ error: 'Watchlist not found' });

    await query('DELETE FROM watchlists WHERE id = $1', [watchlist.id]);
    res.status(204).send();
});

// ─── Watchlist stocks (BUILD_SPEC §35) ─────────────────────────────────────

router.post('/:id/stocks', async (req: any, res) => {
    const watchlist = await getOwnedWatchlist(req.user.id, req.params.id);
    if (!watchlist) return res.status(404).json({ error: 'Watchlist not found' });

    const instrumentId = parseInstrumentId(req.body?.instrumentId);

    const instrument = await query('SELECT instrument_id FROM instruments WHERE instrument_id = $1', [instrumentId]);
    if (instrument.rows.length === 0) {
        return res.status(400).json({ error: 'Unknown instrument' });
    }

    // A watchlist fans out one provider fetch per stock on every summary, so
    // its size is a load bound, not just a UI preference.
    const size = await query('SELECT count(*)::int AS n FROM watchlist_items WHERE watchlist_id = $1', [watchlist.id]);
    if (size.rows[0].n >= MAX_STOCKS_PER_WATCHLIST) {
        return res.status(400).json({ error: `A watchlist can hold at most ${MAX_STOCKS_PER_WATCHLIST} stocks` });
    }

    // Idempotent per BUILD_SPEC §11: rely on the UNIQUE constraint as the
    // actual guard (architecture doc §61.C3) rather than a pre-check, so a
    // race between two requests can't both "win" a check-then-insert.
    const inserted = await query(
        `INSERT INTO watchlist_items (watchlist_id, instrument_id)
         VALUES ($1, $2)
         ON CONFLICT (watchlist_id, instrument_id) DO NOTHING
         RETURNING id`,
        [watchlist.id, instrumentId]
    );

    if (inserted.rows.length === 0) {
        return res.status(200).json({ instrumentId, alreadyPresent: true });
    }

    // A stock with no prior baseline reads as "Added just now," not a
    // fabricated percentage (architecture doc §61.A1) — seeded here so the
    // very first GET /summary already returns isInitialState: true.
    // last_seen_data_timestamp is the EPOCH, not now(): the acknowledge
    // upsert only writes when its quote timestamp is newer than the stored
    // one (§11.2), and a quote from today's 15:30 close is older than a row
    // stamped at 21:00 — the first real view would be rejected as stale.
    await query(
        `INSERT INTO user_stock_state
           (user_id, watchlist_id, instrument_id, last_seen_price_paise, last_seen_volume, last_seen_at, last_seen_data_timestamp, is_initial_state)
         VALUES ($1, $2, $3, 0, 0, now(), to_timestamp(0), true)
         ON CONFLICT (user_id, watchlist_id, instrument_id) DO NOTHING`,
        [req.user.id, watchlist.id, instrumentId]
    );

    await dropWsInstrumentCache(req.user.id);
    res.status(201).json({ instrumentId });
});

router.delete('/:id/stocks/:instrumentId', async (req: any, res) => {
    const watchlist = await getOwnedWatchlist(req.user.id, req.params.id);
    if (!watchlist) return res.status(404).json({ error: 'Watchlist not found' });

    await query(
        'DELETE FROM watchlist_items WHERE watchlist_id = $1 AND instrument_id = $2',
        [watchlist.id, parseInstrumentId(req.params.instrumentId)]
    );
    await dropWsInstrumentCache(req.user.id);
    res.status(204).send();
});

// ─── Alerts (BUILD_SPEC §40) ────────────────────────────────────────────────

router.get('/:id/alerts', async (req: any, res) => {
    const watchlist = await getOwnedWatchlist(req.user.id, req.params.id);
    if (!watchlist) return res.status(404).json({ error: 'Watchlist not found' });

    const result = await query(
        'SELECT * FROM user_alerts WHERE watchlist_id = $1 ORDER BY created_at DESC',
        [watchlist.id]
    );
    res.json(result.rows);
});

router.post('/:id/alerts', async (req: any, res) => {
    const watchlist = await getOwnedWatchlist(req.user.id, req.params.id);
    if (!watchlist) return res.status(404).json({ error: 'Watchlist not found' });

    const instrumentId = parseInstrumentId(req.body?.instrumentId);

    const hasAbove = req.body?.priceAbovePaise !== undefined && req.body?.priceAbovePaise !== null;
    const hasBelow = req.body?.priceBelowPaise !== undefined && req.body?.priceBelowPaise !== null;
    if (!hasAbove && !hasBelow) {
        return res.status(400).json({ error: 'Provide priceAbovePaise and/or priceBelowPaise as a positive integer' });
    }
    const priceAbove = hasAbove ? parseIntInRange(req.body.priceAbovePaise, { field: 'priceAbovePaise', min: 1, max: MAX_PAISE }) : null;
    const priceBelow = hasBelow ? parseIntInRange(req.body.priceBelowPaise, { field: 'priceBelowPaise', min: 1, max: MAX_PAISE }) : null;
    // A floor above the target can never disarm — both alerts would fire forever.
    if (priceAbove !== null && priceBelow !== null && priceBelow >= priceAbove) {
        return res.status(400).json({ error: 'priceBelowPaise must be below priceAbovePaise' });
    }

    const instrument = await query('SELECT instrument_id FROM instruments WHERE instrument_id = $1', [instrumentId]);
    if (instrument.rows.length === 0) {
        return res.status(400).json({ error: 'Unknown instrument' });
    }

    const result = await query(
        `INSERT INTO user_alerts (user_id, watchlist_id, instrument_id, price_above_paise, price_below_paise)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [req.user.id, watchlist.id, instrumentId, priceAbove, priceBelow]
    );
    res.status(201).json(result.rows[0]);
});

router.delete('/:id/alerts/:alertId', async (req: any, res) => {
    const watchlist = await getOwnedWatchlist(req.user.id, req.params.id);
    if (!watchlist) return res.status(404).json({ error: 'Watchlist not found' });

    // Unvalidated, this string reached a UUID column and Postgres answered
    // with 22P02 — a 500 for what is a malformed request.
    await query(
        'DELETE FROM user_alerts WHERE id = $1 AND watchlist_id = $2',
        [parseUuid(req.params.alertId, 'alertId'), watchlist.id]
    );
    res.status(204).send();
});

// ─── Summary (BUILD_SPEC §11.1) ────────────────────────────────────────────

router.get('/:id/summary', async (req: any, res) => {
    const watchlist = await getOwnedWatchlist(req.user.id, req.params.id);
    if (!watchlist) return res.status(404).json({ error: 'Watchlist not found' });

    try {
        const itemsRes = await query(
            `SELECT wi.instrument_id, i.symbol, i.name, i.status
             FROM watchlist_items wi
             JOIN instruments i ON i.instrument_id = wi.instrument_id
             WHERE wi.watchlist_id = $1`,
            [watchlist.id]
        );
        const instrumentIds: string[] = itemsRes.rows.map(r => r.instrument_id);
        const instrumentMeta = new Map(itemsRes.rows.map(r => [r.instrument_id, r]));

        // The lens: how far back "changed" reaches. Defaults to the user's own
        // visit cadence (?horizon=DAY|WEEK|MONTH overrides it explicitly).
        const requestedHorizon = String(req.query.horizon ?? 'AUTO').toUpperCase();
        const explicitHorizon = isHorizonKey(requestedHorizon) ? requestedHorizon : null;

        if (instrumentIds.length === 0) {
            return res.json({
                watchlist: { id: watchlist.id, name: watchlist.name },
                summary: {
                    totalStocks: 0, critical: 0, high: 0, medium: 0, low: 0, quiet: 0, gainers: 0, losers: 0,
                    watchlistSignals: [], lastVisitAt: null, daysSinceLastVisit: null,
                    horizon: explicitHorizon ?? 'DAY', horizonAuto: !explicitHorizon, suggestedHorizon: 'DAY',
                    horizonLabel: HORIZONS[explicitHorizon ?? 'DAY'].label,
                    market: null, serverTime: clockNow().toISOString(), demo: demoBadge(),
                    autoAcknowledge: autoAcknowledgeEnabled(),
                    digest: { headline: 'Your watchlist is empty — add a stock to start tracking what changes.', items: [], quiet: true },
                },
                stocks: [],
            });
        }

        // Partial-failure tolerant (BUILD_SPEC §5.2, §11.1 step 3) — one bad
        // instrument must not 500 the rest of the dashboard.
        const { quotes, errors } = await getQuotes(instrumentIds);

        // External context: each stock's sector index (if mapped), the market
        // benchmark, and the current volatility regime. Index quotes are
        // fetched once for the whole watchlist, not per stock.
        const sectorRes = await query(
            `SELECT ss.instrument_id, ss.sector_index_id, i.name AS sector_name
             FROM stock_sectors ss LEFT JOIN instruments i ON i.instrument_id = ss.sector_index_id
             WHERE ss.instrument_id = ANY($1)`,
            [instrumentIds]
        );
        const sectorOf = new Map<string, { id: string | null; name: string | null }>(
            sectorRes.rows.map(r => [r.instrument_id, { id: r.sector_index_id, name: r.sector_name }])
        );
        const indexIds = Array.from(new Set<string>([BENCHMARK_INSTRUMENT_ID, ...sectorRes.rows.map(r => r.sector_index_id).filter(Boolean)]));
        const indexQuotes = new Map((await getQuotes(indexIds)).quotes.map(q => [q.instrumentId, q]));
        const benchmarkQuote = indexQuotes.get(BENCHMARK_INSTRUMENT_ID) ?? null;

        const [stateRes, statsRes, alertsRes, regimeRes, fundamentalsMap] = await Promise.all([
            query('SELECT * FROM user_stock_state WHERE user_id = $1 AND watchlist_id = $2 AND instrument_id = ANY($3)', [req.user.id, watchlist.id, instrumentIds]),
            query('SELECT * FROM stock_statistics WHERE instrument_id = ANY($1)', [instrumentIds]),
            query('SELECT * FROM user_alerts WHERE user_id = $1 AND watchlist_id = $2 AND enabled = true', [req.user.id, watchlist.id]),
            query('SELECT * FROM market_regime WHERE benchmark_id = $1', [BENCHMARK_INSTRUMENT_ID]),
            loadFundamentalsContext(instrumentIds),
        ]);
        const regime = computeRegime(regimeRes.rows[0] ?? null);

        // How long the user has actually been away decides the default horizon:
        // "what changed since you last checked" and "is that unusual?" then
        // answer over the same window (config/thresholds.ts suggestHorizon).
        const seenTimes = stateRes.rows
            .filter((r: any) => !r.is_initial_state && r.last_seen_at)
            .map((r: any) => new Date(r.last_seen_at).getTime());
        const lastVisitMs = seenTimes.length ? Math.max(...seenTimes) : null;
        // App clock, not wall clock: in replay mode "how long were you away"
        // is measured from the replayed session, not from real today.
        const daysSinceLastVisit = lastVisitMs === null ? null : Math.floor((clockNow().getTime() - lastVisitMs) / 86_400_000);
        const suggestedHorizon = suggestHorizon(daysSinceLastVisit);
        const horizon = explicitHorizon ?? suggestedHorizon;

        const stateMap = new Map(stateRes.rows.map(r => [r.instrument_id, r]));
        const statsMap = new Map(statsRes.rows.map(r => [r.instrument_id, r]));
        const alertsByInstrument = alertsRes.rows.reduce((acc: Record<string, any[]>, curr: any) => {
            (acc[curr.instrument_id] ??= []).push(curr);
            return acc;
        }, {});

        // Breadth: what share of the list moved the same way as this stock.
        // A move the whole watchlist made is expected, not this stock's news
        // (architecture doc §54); only meaningful with enough names.
        const signs = quotes.map(q => Math.sign(q.lastPricePaise - q.previousClosePaise));
        const upCount = signs.filter(s => s > 0).length;
        const downCount = signs.filter(s => s < 0).length;
        const breadthFor = (sign: number) =>
            quotes.length >= 5 ? (sign > 0 ? upCount : sign < 0 ? downCount : 0) / quotes.length : 0;

        // §8.4 hysteresis: an alert that fired disarms, and re-arms only once
        // the price retreats past the band. Collected across the whole list and
        // written once, after the response is computed.
        const alertTransitions: AlertTransition[] = [];

        const stocks: any[] = quotes.map(quote => {
            const meta = instrumentMeta.get(quote.instrumentId);
            const state = stateMap.get(quote.instrumentId) || { last_seen_price_paise: 0, last_seen_at: quote.retrievedAt, is_initial_state: true };
            const stats = statsMap.get(quote.instrumentId) || { trading_days_observed: 0 };
            const alerts = alertsByInstrument[quote.instrumentId] || [];
            const sector = sectorOf.get(quote.instrumentId) ?? { id: null, name: null };
            const sectorQuote = sector.id ? indexQuotes.get(sector.id) ?? null : null;
            const fundamentals = fundamentalsMap.get(quote.instrumentId) ?? EMPTY_FUNDAMENTALS;

            const metrics = calculateMetrics(quote, stats, state, benchmarkQuote, sectorQuote, sector.id, regime, horizon);
            const events = detectEvents(metrics, quote, stats, state, alerts, fundamentals, alertTransitions);
            const attention = calculateScore(metrics, events, {
                fundamentals,
                breadthSameDirection: breadthFor(Math.sign(metrics.todayChangeBps)),
            });
            const reasons = generateExplanations(events, metrics, state, alerts, { fundamentals, sectorName: sector.name });
            const conclusion = deriveConclusion(events, metrics);
            const isInitialState = !!state.is_initial_state;

            return {
                instrumentId: quote.instrumentId,
                symbol: meta?.symbol || quote.instrumentId.split(':')[1],
                name: meta?.name || null,
                instrumentStatus: meta?.status || 'ACTIVE',
                pricePaise: quote.lastPricePaise,
                isInitialState,
                lastSeenAt: isInitialState ? null : (state as any).last_seen_at ?? null,
                change: {
                    todayBps: metrics.todayChangeBps,
                    horizonBps: metrics.horizonReturnBps,
                    horizonSessions: metrics.horizonSessions,
                    ...(isInitialState ? {} : {
                        sinceLastVisitBps: metrics.sinceLastVisitBps,
                        daysSinceLastVisit: metrics.daysSinceLastVisit,
                    }),
                },
                volume: {
                    current: quote.volume,
                    average: parseInt((stats as any).avg_volume_30d, 10) || 0,
                    ratio: Number(metrics.volumeRatio.toFixed(2)),
                },
                attention,
                rarity: metrics.rarityBand,
                rarityWindow: metrics.rarityWindowLabel,
                rarityEstimated: metrics.rarityFallback,
                events,
                reasons,
                conclusion,
                context: {
                    adjustmentGuard: metrics.suspectedAdjustment,
                    market: benchmarkQuote ? {
                        indexId: BENCHMARK_INSTRUMENT_ID,
                        todayBps: benchmarkQuote.previousClosePaise > 0
                            ? Math.floor(((benchmarkQuote.lastPricePaise - benchmarkQuote.previousClosePaise) * 10000) / benchmarkQuote.previousClosePaise) : 0,
                        beta: metrics.betaMarket,
                        residualBps: metrics.residualMarketBps,
                    } : null,
                    sector: sector.id ? {
                        indexId: sector.id, name: sector.name,
                        todayBps: metrics.sectorTodayBps, residualBps: metrics.residualSectorBps,
                    } : null,
                    path: {
                        streakDays: metrics.streakDays,
                        drawdownFrom30dHighBps: metrics.drawdownFrom30dHighBps,
                        runupFrom30dLowBps: metrics.runupFrom30dLowBps,
                    },
                    regime: {
                        volRatio: Number(regime.volRatio.toFixed(2)),
                        vixPctile: regime.vixPctile === null ? null : Number(regime.vixPctile.toFixed(2)),
                        dampen: Number(regime.dampen.toFixed(2)),
                    },
                    fundamentals: {
                        resultsDate: fundamentals.resultsDate,
                        resultsDaysFromNow: fundamentals.resultsDaysFromNow,
                        exDividendDate: fundamentals.exDividendDate,
                        dividendAmountPaise: fundamentals.dividendAmountPaise,
                        corporateActionToday: fundamentals.corporateActionToday?.type ?? null,
                        announcements: fundamentals.recentAnnouncements,
                    },
                },
                dataQuality: {
                    status: metrics.dataStatus,
                    ageSeconds: metrics.dataAgeSec,
                    feedDelaySeconds: quote.feedDelaySec ?? 0,
                    dataTimestamp: quote.dataTimestamp,
                },
            };
        });

        // Instruments the provider truly couldn't return anything for at all.
        for (const [instrumentId, message] of Object.entries(errors)) {
            const meta = instrumentMeta.get(instrumentId);
            stocks.push({
                instrumentId,
                symbol: meta?.symbol || instrumentId.split(':')[1],
                name: meta?.name || null,
                instrumentStatus: meta?.status || 'ACTIVE',
                pricePaise: 0,
                isInitialState: false,
                change: { todayBps: 0 },
                volume: { current: 0, average: 0, ratio: 0 },
                attention: { score: 0, severity: 'QUIET', breakdown: null },
                rarity: 'NONE',
                events: ['DATA_MISSING'],
                reasons: ['Live data unavailable — showing last known price'],
                context: null,
                dataQuality: { status: 'DATA_MISSING', ageSeconds: 0, feedDelaySeconds: 0, dataTimestamp: null },
            });
            console.error(`Quote unavailable for ${instrumentId}: ${message}`);
        }

        stocks.sort((a, b) => {
            if (b.attention.score !== a.attention.score) return b.attention.score - a.attention.score;
            const aSev = a.attention.severity === b.attention.severity ? 0 : 1;
            if (aSev) {
                const order = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'QUIET'];
                return order.indexOf(a.attention.severity) - order.indexOf(b.attention.severity);
            }
            return Math.abs(b.change.todayBps) - Math.abs(a.change.todayBps);
        });

        let critical = 0, high = 0, medium = 0, low = 0, quiet = 0;
        let gainers = 0, losers = 0;
        for (const s of stocks) {
            if (s.attention.severity === 'CRITICAL') critical++;
            else if (s.attention.severity === 'HIGH') high++;
            else if (s.attention.severity === 'MEDIUM') medium++;
            else if (s.attention.severity === 'LOW') low++;
            else quiet++;

            if (s.change.todayBps > 0) gainers++;
            else if (s.change.todayBps < 0) losers++;
        }

        const totalStocks = stocks.length;
        const watchlistSignals: string[] = [];
        if (totalStocks >= 5) {
            if (losers >= 0.7 * totalStocks) watchlistSignals.push('BROAD_DECLINE');
            if (gainers >= 0.7 * totalStocks) watchlistSignals.push('BROAD_RALLY');
        }
        if (high + critical >= 3) watchlistSignals.push('HIGH_ACTIVITY');

        // "Since you last checked" = the most recent acknowledged view of any
        // stock in this list; null on a first visit.
        const lastVisitAt = stocks.reduce<string | null>((acc, s) => {
            if (!s.lastSeenAt) return acc;
            const t = new Date(s.lastSeenAt).toISOString();
            return !acc || t > acc ? t : acc;
        }, null);

        // Persist the alert arm/disarm changes. Fire-and-forget: a failure here
        // means an alert repeats, which must never cost the user their summary.
        if (alertTransitions.length > 0) {
            void persistAlertTransitions(alertTransitions);
        }

        // One sentence that answers the product's question without scrolling.
        const digest = buildDigest(stocks, {
            gainers, losers, signals: watchlistSignals, windowLabel: HORIZONS[horizon].windowLabel,
        });

        const regimeRow = regimeRes.rows[0] ?? null;
        const market = benchmarkQuote ? {
            indexId: BENCHMARK_INSTRUMENT_ID,
            name: 'NIFTY 50',
            todayBps: benchmarkQuote.previousClosePaise > 0
                ? Math.floor(((benchmarkQuote.lastPricePaise - benchmarkQuote.previousClosePaise) * 10000) / benchmarkQuote.previousClosePaise) : 0,
            vixLevel: regimeRow?.vix_level_x100 != null ? Number(regimeRow.vix_level_x100) / 100 : null,
            vixPctile: regime.vixPctile === null ? null : Number(regime.vixPctile.toFixed(2)),
            volRatio: Number(regime.volRatio.toFixed(2)),
            dampen: Number(regime.dampen.toFixed(2)),
            breadthUp: gainers,
            breadthDown: losers,
        } : null;

        res.json({
            watchlist: { id: watchlist.id, name: watchlist.name },
            summary: {
                totalStocks, critical, high, medium, low, quiet, gainers, losers, watchlistSignals, lastVisitAt,
                daysSinceLastVisit,
                horizon, horizonAuto: !explicitHorizon, suggestedHorizon, horizonLabel: HORIZONS[horizon].label,
                market, digest,
                // Relative times ("3 days ago") must be computed against the
                // app's clock, not the browser's, or a replayed session reads
                // as a month stale.
                serverTime: clockNow().toISOString(),
                demo: demoBadge(),
                autoAcknowledge: autoAcknowledgeEnabled(),
            },
            stocks,
        });
    } catch (e) {
        console.error('Summary failed:', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ─── Acknowledge (BUILD_SPEC §11.2) ────────────────────────────────────────

router.post('/:id/acknowledge', async (req: any, res) => {
    const watchlist = await getOwnedWatchlist(req.user.id, req.params.id);
    if (!watchlist) return res.status(404).json({ error: 'Watchlist not found' });

    const items = parseBoundedArray(req.body?.items, { field: 'items', max: MAX_ACKNOWLEDGE_ITEMS });

    // "When you looked" is a moment on the app's clock — stamping it with the
    // database's wall clock would put a replayed session's visit a month in
    // the future and break every "since you last checked" comparison.
    const seenAt = clockNow().toISOString();

    // Validate every field. `dataTimestamp` in particular becomes the baseline
    // the monotonic guard compares against forever after, so an unchecked
    // future date freezes the user's "since you last checked" permanently.
    // One bad item used to abort the whole multi-row upsert (500, nothing
    // written); now the batch is rejected up front with a reason.
    const seen = new Map<string, { instrumentId: string; ltpPaise: number; qty: number; at: Date }>();
    for (const raw of items) {
        const item = (raw ?? {}) as Record<string, unknown>;
        const instrumentId = parseInstrumentId(item.instrumentId);
        const at = parseTimestamp(item.dataTimestamp, `dataTimestamp for ${instrumentId}`);
        const entry = {
            instrumentId,
            ltpPaise: parseIntInRange(item.pricePaise, { field: 'pricePaise', min: 0, max: MAX_PAISE, fallback: 0 }),
            qty: parseIntInRange(item.volume, { field: 'volume', min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 }),
            at,
        };
        // Postgres refuses to touch the same row twice in one statement, so a
        // duplicated instrument would fail the batch. Keep the newest.
        const prior = seen.get(instrumentId);
        if (!prior || at > prior.at) seen.set(instrumentId, entry);
    }

    const valid = Array.from(seen.values());
    if (valid.length === 0) return res.status(204).send();

    try {
        // One statement, not one per stock: a sequential loop left the
        // baseline half-updated for seconds, and a summary refetch landing in
        // that window showed some rows re-based and others not.
        const params: any[] = [req.user.id, watchlist.id, seenAt];
        const tuples = valid.map(item => {
            const b = params.length;
            params.push(item.instrumentId, item.ltpPaise, item.qty, item.at.toISOString());
            return `($1, $2, $${b + 1}, $${b + 2}, $${b + 3}, $3::timestamptz, $${b + 4}::timestamptz, false)`;
        });
        await query(
            `INSERT INTO user_stock_state
               (user_id, watchlist_id, instrument_id, last_seen_price_paise, last_seen_volume, last_seen_at, last_seen_data_timestamp, is_initial_state)
             VALUES ${tuples.join(',')}
             ON CONFLICT (user_id, watchlist_id, instrument_id) DO UPDATE SET
               last_seen_at             = EXCLUDED.last_seen_at,
               last_seen_price_paise    = CASE 
                                            WHEN EXCLUDED.last_seen_data_timestamp > user_stock_state.last_seen_data_timestamp 
                                            THEN EXCLUDED.last_seen_price_paise 
                                            ELSE user_stock_state.last_seen_price_paise 
                                          END,
               last_seen_volume         = CASE 
                                            WHEN EXCLUDED.last_seen_data_timestamp > user_stock_state.last_seen_data_timestamp 
                                            THEN EXCLUDED.last_seen_volume 
                                            ELSE user_stock_state.last_seen_volume 
                                          END,
               last_seen_data_timestamp = GREATEST(user_stock_state.last_seen_data_timestamp, EXCLUDED.last_seen_data_timestamp),
               is_initial_state         = false,
               updated_at               = now()`,
            params
        );
        res.status(204).send();
    } catch (e) {
        console.error('Acknowledge failed:', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ─── Demo Replay (BUILD_SPEC §14.5) ────────────────────────────────────────

router.post('/:id/demo/replay', async (req: any, res) => {
    if (!DEMO) {
        return res.status(400).json({ error: 'Cannot replay demo in live mode.' });
    }

    const watchlist = await getOwnedWatchlist(req.user.id, req.params.id);
    if (!watchlist) return res.status(404).json({ error: 'Watchlist not found' });

    try {
        // 1. Reset the global demo clock to exactly the baseline time
        resetDemoClock(DEMO.baselineAt);

        // 2. Reset the user's specific watchlist to its baseline snapshot
        await resetDemoWatchlist(req.user.id, watchlist.id, null);

        res.status(200).json({ message: 'Replay started' });
    } catch (e) {
        console.error('Demo Replay failed:', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

export default router;
