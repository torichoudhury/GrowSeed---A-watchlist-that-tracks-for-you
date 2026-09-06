import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { query } from '../config/db';
import { requireAuth } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

// BUILD_SPEC §11 + architecture doc §61.G2: an unrated search endpoint is a
// scraping vector over the whole instrument table. Keyed on user id only —
// requireAuth above already guarantees req.user is set by the time this
// runs, so there's no IP-fallback branch to get IPv6-normalization wrong.
const searchLimiter = rateLimit({
    windowMs: 60_000,
    limit: 20,
    keyGenerator: (req: any) => req.user.id,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many searches — try again in a minute' },
});

router.get('/search', searchLimiter, async (req: any, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) {
        return res.status(400).json({ error: 'q must be at least 2 characters' });
    }

    const result = await query(
        `SELECT instrument_id, symbol, exchange, name FROM instruments
         WHERE status = 'ACTIVE' AND (symbol ILIKE $1 OR name ILIKE $1)
         ORDER BY symbol ASC LIMIT 20`,
        [`%${q}%`]
    );
    res.json(result.rows.map(r => ({
        instrumentId: r.instrument_id,
        symbol: r.symbol,
        exchange: r.exchange,
        name: r.name,
    })));
});

export default router;
