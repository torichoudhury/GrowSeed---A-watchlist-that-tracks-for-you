import { Router } from 'express';
import { getQuotes } from '../services/marketData.service';
import { fetchDailyCandles } from '../services/marketProvider';
import { requireAuth } from '../middleware/auth';
import { INSTRUMENT_ID_RE } from '../services/ownership';

const router = Router();
router.use(requireAuth);

router.get('/quotes', async (req: any, res) => {
    const idsParam = String(req.query.ids || '');
    const instrumentIds = idsParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    if (instrumentIds.length === 0) {
        return res.status(400).json({ error: 'ids query param is required, e.g. ?ids=NSE:A,NSE:B' });
    }
    if (instrumentIds.some(id => !INSTRUMENT_ID_RE.test(id))) {
        return res.status(400).json({ error: 'Every id must look like EXCHANGE:SYMBOL' });
    }

    const { quotes } = await getQuotes(instrumentIds);
    res.json(quotes);
});

router.get('/:instrumentId/history', async (req: any, res) => {
    const instrumentId = req.params.instrumentId.toUpperCase();
    if (!INSTRUMENT_ID_RE.test(instrumentId)) {
        return res.status(400).json({ error: 'instrumentId must look like EXCHANGE:SYMBOL' });
    }

    const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 90 * 86_400_000);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date();
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
        return res.status(400).json({ error: 'from/to must be valid dates with from before to' });
    }

    try {
        const candles = await fetchDailyCandles(instrumentId, from, to);
        res.json(candles);
    } catch (e) {
        console.error(`History fetch failed for ${instrumentId}:`, (e as Error).message);
        res.status(502).json({ error: 'Could not fetch historical data right now' });
    }
});

export default router;
