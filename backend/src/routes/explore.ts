/**
 * GET /api/explore?category=gainers|losers|meaningful|active|volume|sector
 *
 * Rank from stored quotes/statistics — never N live-provider calls per request.
 * Every row links to /stocks/:instrumentId — no second detail UI.
 *
 * Hard rules in play:
 *   - Rule 1: "meaningful" ranking uses the SAME attention-score logic from
 *     stockIntelligence.service.ts — no separate formula here.
 *   - Rule 3: ranks from Postgres/Redis, not per-row live provider calls.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { query } from '../config/db';
import { getQuotes } from '../services/marketData.service';
import { calculateMetrics, computeRegime } from '../services/metrics.service';
import { detectEvents, EMPTY_FUNDAMENTALS } from '../services/eventDetection.service';
import { calculateScore } from '../services/attentionScore.service';
import { redact } from '../services/log';
import { BENCHMARK_INSTRUMENT_ID } from '../config/thresholds';

const router = Router();
router.use(requireAuth);

const VALID_CATEGORIES = ['gainers', 'losers', 'meaningful', 'active', 'volume', 'sector'] as const;
type Category = typeof VALID_CATEGORIES[number];
const PAGE_SIZE = 20;

router.get('/', async (req: any, res) => {
    const rawCat = String(req.query.category ?? 'meaningful').toLowerCase();
    const category: Category = VALID_CATEGORIES.includes(rawCat as Category) ? (rawCat as Category) : 'meaningful';
    const sector = req.query.sector ? String(req.query.sector).toUpperCase() : null;

    try {
        // Step 1: get candidate instruments from DB (already-stored quotes or stats)
        // We limit to instruments that have stock_statistics to ensure history exists.
        const filterSector = sector
            ? `AND ss2.sector_index_id = $2`
            : '';
        const params: any[] = [PAGE_SIZE * 3]; // fetch 3x and trim after scoring
        if (sector) params.push(sector);

        const candidateRes = await query(
            `SELECT DISTINCT i.instrument_id, i.symbol, i.name, i.status,
                    ss2.sector_index_id, si.name AS sector_name
             FROM instruments i
             JOIN stock_statistics st ON st.instrument_id = i.instrument_id
             LEFT JOIN stock_sectors ss2 ON ss2.instrument_id = i.instrument_id
             LEFT JOIN instruments si ON si.instrument_id = ss2.sector_index_id
             WHERE i.status = 'ACTIVE'
               AND st.trading_days_observed >= 20
               ${filterSector}
             LIMIT $1`,
            params,
        );

        if (candidateRes.rows.length === 0) {
            return res.json({ category, results: [], total: 0 });
        }

        const instrumentIds = candidateRes.rows.map((r: any) => r.instrument_id);
        const metaMap = new Map(candidateRes.rows.map((r: any) => [r.instrument_id, r]));

        // Step 2: fetch quotes (batch — not per-row); filter out fallback zeros
        // (source 'DATA_MISSING'/'PROVIDER_DOWN' or pricePaise=0) so instruments
        // with no demo data don't appear as ₹0.00 rows in the explore list.
        const { quotes: rawQuotes } = await getQuotes(instrumentIds);
        const quotes = rawQuotes.filter(q => {
            const src = (q as any).source ?? '';
            if (src === 'DATA_MISSING' || src === 'PROVIDER_DOWN') return false;
            if (q.lastPricePaise === 0 && q.previousClosePaise === 0) return false;
            return true;
        });
        if (quotes.length === 0) {
            return res.json({ category, results: [], total: 0 });
        }

        // Step 3: load benchmark + regime (once, not per stock)
        const indexIds = Array.from(new Set<string>([
            BENCHMARK_INSTRUMENT_ID,
            ...candidateRes.rows
                .map((r: any) => r.sector_index_id)
                .filter(Boolean),
        ]));
        const indexQuotes = new Map((await getQuotes(indexIds)).quotes.map(q => [q.instrumentId, q]));
        const benchmarkQuote = indexQuotes.get(BENCHMARK_INSTRUMENT_ID) ?? null;

        const regimeRes = await query(
            'SELECT * FROM market_regime WHERE benchmark_id = $1',
            [BENCHMARK_INSTRUMENT_ID],
        );
        const regime = computeRegime(regimeRes.rows[0] ?? null);

        const statsRes = await query(
            'SELECT * FROM stock_statistics WHERE instrument_id = ANY($1)',
            [instrumentIds],
        );
        const statsMap = new Map(statsRes.rows.map((r: any) => [r.instrument_id, r]));

        // Step 4: score each stock using the same pipeline as stockIntelligence
        const scored = quotes.map(quote => {
            const meta = metaMap.get(quote.instrumentId);
            const stats = statsMap.get(quote.instrumentId) ?? { trading_days_observed: 0 };
            const sectorIndexId = meta?.sector_index_id ?? null;
            const sectorQuote = sectorIndexId ? (indexQuotes.get(sectorIndexId) ?? null) : null;
            // No user-specific baseline for explore
            const state = { last_seen_price_paise: 0, last_seen_at: quote.retrievedAt, is_initial_state: true };

            const metrics = calculateMetrics(quote, stats, state, benchmarkQuote, sectorQuote, sectorIndexId, regime, 'DAY');
            const events = detectEvents(metrics, quote, stats, state, [], EMPTY_FUNDAMENTALS, []);
            const attention = calculateScore(metrics, events, {});

            const todayBps = metrics.todayChangeBps;
            return {
                instrumentId: quote.instrumentId,
                symbol: meta?.symbol ?? quote.instrumentId.split(':')[1],
                name: meta?.name ?? null,
                exchange: quote.instrumentId.split(':')[0],
                sectorName: meta?.sector_name ?? null,
                pricePaise: quote.lastPricePaise,
                todayChangeBps: todayBps,
                volume: quote.volume ?? 0,
                attentionScore: attention.score,
                severity: attention.severity,
                topReason: null as string | null,
            };
        });

        // Step 5: rank according to category
        let ranked = scored;
        switch (category) {
            case 'gainers':
                ranked = scored.filter(s => s.todayChangeBps > 0).sort((a, b) => b.todayChangeBps - a.todayChangeBps);
                break;
            case 'losers':
                ranked = scored.filter(s => s.todayChangeBps < 0).sort((a, b) => a.todayChangeBps - b.todayChangeBps);
                break;
            case 'meaningful':
                // Different from gainers/losers — uses attention score, not raw price change
                ranked = scored.sort((a, b) => b.attentionScore - a.attentionScore);
                break;
            case 'active':
            case 'volume':
                ranked = scored.sort((a, b) => b.volume - a.volume);
                break;
            case 'sector':
                // Group by sector, within sector sort by attention score
                ranked = scored.sort((a, b) => {
                    if (a.sectorName !== b.sectorName) return (a.sectorName ?? '').localeCompare(b.sectorName ?? '');
                    return b.attentionScore - a.attentionScore;
                });
                break;
        }

        res.json({
            category,
            results: ranked.slice(0, PAGE_SIZE),
            total: ranked.length,
        });
    } catch (e) {
        console.error('Explore failed:', redact(e));
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

export default router;
