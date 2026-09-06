/**
 * POST /api/demo/reset-baseline
 *
 * Resets every user_stock_state row for the authenticated user back to the
 * demo baseline moment (DEMO_BASELINE_AT). This re-creates the "since you last
 * checked" window exactly as if demo:reset had been run, without touching any
 * price data or statistics. Safe to call repeatedly.
 *
 * Only active in demo/replay mode (DEMO_AS_OF must be set). Returns 404 when
 * the server is running in live mode so the button cannot appear in a real
 * deployment by accident.
 */

import { Router } from 'express';
import { query } from '../config/db';
import { requireAuth } from '../middleware/auth';
import { DEMO } from '../services/clock';
import { demoBaselineSnapshot } from '../services/demo/baseline';
import { redact } from '../services/log';

const router = Router();
router.use(requireAuth);

router.post('/reset-baseline', async (req: any, res) => {
    if (!DEMO) {
        return res.status(404).json({ error: 'Demo mode is not active' });
    }

    try {
        // Get all instrument_ids this user has in any watchlist
        const instrumentRes = await query(
            `SELECT DISTINCT ws.instrument_id
             FROM watchlist_stocks ws
             JOIN watchlists w ON w.id = ws.watchlist_id
             WHERE w.user_id = $1`,
            [req.user.id],
        );

        const instrumentIds: string[] = instrumentRes.rows.map((r: any) => r.instrument_id);

        if (instrumentIds.length === 0) {
            return res.json({ reset: 0, baselineAt: DEMO.baselineAt });
        }

        // Resolve the baseline snapshot for each instrument (price at DEMO_BASELINE_AT)
        const snapshots = await Promise.all(
            instrumentIds.map(async (id) => {
                const snap = await demoBaselineSnapshot(id);
                return { id, snap };
            }),
        );

        // Upsert user_stock_state with the baseline values
        let reset = 0;
        for (const { id, snap } of snapshots) {
            const pricePaise = snap?.pricePaise ?? 0;
            const ts = snap?.dataTimestamp ?? DEMO.baselineAt;
            await query(
                `INSERT INTO user_stock_state
                    (user_id, instrument_id, last_seen_price_paise, last_seen_at, is_initial_state)
                 VALUES ($1, $2, $3, $4, false)
                 ON CONFLICT (user_id, instrument_id)
                 DO UPDATE SET
                    last_seen_price_paise = EXCLUDED.last_seen_price_paise,
                    last_seen_at = EXCLUDED.last_seen_at,
                    is_initial_state = false`,
                [req.user.id, id, pricePaise, ts],
            );
            reset++;
        }

        return res.json({ reset, baselineAt: DEMO.baselineAt });
    } catch (e) {
        console.error('Demo reset-baseline failed:', redact(e));
        return res.status(500).json({ error: 'Reset failed' });
    }
});

export default router;
