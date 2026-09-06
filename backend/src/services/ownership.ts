import { query } from '../config/db';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const INSTRUMENT_ID_RE = /^[A-Z]+:[A-Z0-9.]+$/;

/**
 * BUILD_SPEC §11: "All handlers verify the authenticated user owns the
 * referenced watchlist; return 404 (not 403) on ownership mismatch" — so a
 * malformed id and someone else's real id must be indistinguishable to the
 * caller.
 */
export async function getOwnedWatchlist(userId: string, watchlistId: string) {
    if (!UUID_RE.test(watchlistId)) return null;
    const res = await query('SELECT * FROM watchlists WHERE id = $1 AND user_id = $2', [watchlistId, userId]);
    return res.rows[0] || null;
}
