import { query, pool } from './config/db';
import { DEMO } from './services/clock';
import { resetDemoWatchlist } from './services/demo/reset';

/**
 * `npm run demo:reset [minutesAgo]`
 *
 * Puts the user's baseline back so "what changed since you last checked?" has
 * something to answer again.
 */

const WATCHLIST_NAME = 'Demo Watchlist';

async function main() {
    if (!DEMO) {
        console.error('DEMO_AS_OF is not set — nothing to reset.');
        process.exitCode = 1;
        return;
    }

    const minutesArg = process.argv[2];
    const minutesIntoSession = minutesArg ? Number(minutesArg) : null;
    if (minutesArg && (!Number.isFinite(minutesIntoSession) || minutesIntoSession! < 0)) {
        console.error(`"${minutesArg}" is not a number of minutes.`);
        process.exitCode = 1;
        return;
    }

    const wl = await query(
        `SELECT w.id, w.user_id FROM watchlists w JOIN users u ON u.id = w.user_id WHERE w.name = $1 ORDER BY w.created_at LIMIT 1`,
        [WATCHLIST_NAME]
    );
    if (wl.rows.length === 0) {
        console.error(`No watchlist called "${WATCHLIST_NAME}" — run \`npm run demo:seed\` first.`);
        process.exitCode = 1;
        return;
    }
    const { id: watchlistId, user_id: userId } = wl.rows[0];

    await resetDemoWatchlist(userId, watchlistId, minutesIntoSession);

    console.log(`Baseline reset for the demo watchlist.`);
    console.log('Reload the dashboard — the summary will answer "what changed since then?" again.');
}

main()
    .catch(err => { console.error('Demo reset failed:', err); process.exitCode = 1; })
    .finally(async () => { await pool.end(); });

