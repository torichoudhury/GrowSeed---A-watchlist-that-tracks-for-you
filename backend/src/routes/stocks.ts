/**
 * GET /api/stocks/:instrumentId/intelligence
 * GET /api/stocks/:instrumentId/chart
 *
 * Stock-level intelligence endpoint. Auth-required. Delegates all analytics
 * to stockIntelligence.service.ts — never duplicates the scoring formula.
 *
 * Hard rules in play:
 *   - Rule 1: no second copy of calculateMetrics/calculateScore logic
 *   - Rule 2: frontend receives the backend's `conclusion.label` verbatim
 *   - Rule 4: dataQuality.warnings surfaces missing data; never silently omit
 *   - Rule 5: this route never calls acknowledge/baseline-update endpoints
 *   - Rule 6: uses clockNow(), never Date.now()
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { buildStockIntelligence, NotFoundError } from '../services/stockIntelligence.service';
import { fetchDailyCandles } from '../services/marketProvider';
import { redact } from '../services/log';
import { parseInstrumentId } from '../services/validate';
import { isHorizonKey } from '../config/thresholds';
import { now as clockNow } from '../services/clock';

const router = Router();
router.use(requireAuth);

// ─── Intelligence endpoint ───────────────────────────────────────────────────

router.get('/:instrumentId/intelligence', async (req: any, res) => {
    const instrumentId = parseInstrumentId(req.params.instrumentId);

    const requestedHorizon = req.query.horizon ? String(req.query.horizon).toUpperCase() : null;
    const horizonKey = requestedHorizon && isHorizonKey(requestedHorizon) ? requestedHorizon : null;

    try {
        const result = await buildStockIntelligence(instrumentId, {
            userId: req.user.id,
            horizonKey,
        });
        res.json(result);
    } catch (e) {
        if (e instanceof NotFoundError) {
            return res.status(404).json({ error: e.message });
        }
        console.error(`Intelligence failed for ${instrumentId}:`, redact(e));
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ─── Chart endpoint (§5 of plan) ─────────────────────────────────────────────
// Backend picks interval per range. Never leaks provider strings ('yahoo','5m').
// Reports `actualInterval` honestly when intraday isn't available.

const RANGE_DAYS: Record<string, number> = {
    '1D': 1,
    '1W': 7,
    '1M': 30,
    '6M': 180,
    '1Y': 365,
};

router.get('/:instrumentId/chart', async (req: any, res) => {
    const instrumentId = parseInstrumentId(req.params.instrumentId);
    const rangeParam = String(req.query.range ?? '1M').toUpperCase();
    const range = RANGE_DAYS[rangeParam] ? rangeParam : '1M';
    const days = RANGE_DAYS[range];

    // The window is measured against the app clock, never the wall clock:
    // in demo/replay mode the quote is a replay of DEMO_AS_OF, so a chart
    // queried around "real today" would ask for dates the replay does not
    // live in and return an empty panel (rule 6 of this route).
    const to = clockNow();
    const from = new Date(to.getTime() - days * 86_400_000);

    try {
        const rawCandles = await fetchDailyCandles(instrumentId, from, to);

        // Map to contract shape — never expose provider-specific fields.
        // Providers (and the demo's seeded candles) carry an IST trade date;
        // expose it as a timestamp on that IST day (00:00) plus the date itself.
        const candles = rawCandles.map((c: any) => ({
            timestamp: typeof c.tradeDate === 'string'
                ? `${c.tradeDate}T00:00:00+05:30`
                : (typeof c.timestamp === 'string' ? c.timestamp : new Date(c.timestamp).toISOString()),
            tradeDate: typeof c.tradeDate === 'string' ? c.tradeDate : null,
            openPaise: typeof c.openPaise === 'number' ? c.openPaise : (typeof c.open === 'number' ? Math.round(c.open * 100) : null),
            highPaise: typeof c.highPaise === 'number' ? c.highPaise : (typeof c.high === 'number' ? Math.round(c.high * 100) : null),
            lowPaise: typeof c.lowPaise === 'number' ? c.lowPaise : (typeof c.low === 'number' ? Math.round(c.low * 100) : null),
            closePaise: typeof c.closePaise === 'number' ? c.closePaise : (typeof c.close === 'number' ? Math.round(c.close * 100) : null),
            volume: c.volume ?? null,
        }));

        res.json({
            range,
            // Daily candles — honest interval label regardless of provider internals
            interval: 'DAILY',
            actualInterval: 'DAILY',
            candles,
        });
    } catch (e) {
        console.error(`Chart failed for ${instrumentId}:`, redact(e));
        // Degrade cleanly — the stock page must still load without a chart
        res.status(502).json({
            error: 'Historical chart unavailable right now',
            range,
            interval: 'DAILY',
            candles: [],
        });
    }
});

export default router;
