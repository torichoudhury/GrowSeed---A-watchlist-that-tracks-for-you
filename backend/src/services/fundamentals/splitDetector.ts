import { ADJUSTMENT_GUARD } from '../../config/thresholds';

/**
 * Statistical safety net for corporate actions our calendar missed.
 *
 * The NSE feeds we parse (corporate actions + announcements) describe splits
 * and bonuses in free text, and free text eventually wins: a wording we don't
 * match means the price series keeps an un-adjusted jump in it. One 1:1 bonus
 * looks like a -50% day, which is catastrophic twice over — it fires a
 * CRITICAL alert about nothing, and it poisons the stock's own return
 * distribution (abs_return_max = 5000bps) for a whole year, dulling every
 * genuine signal after it.
 *
 * So we also detect them from the numbers alone. The evidence is strong:
 *   1. The overnight factor lands on a *clean* ratio (1/2, 1/3, 2/5, 10→1 …)
 *      to within a fraction of a percent. Real moves don't do that.
 *   2. NSE applies price bands (typically 20%, tighter for many names), so a
 *      genuine single-session -50% close is close to impossible.
 *   3. The whole session trades at the new scale — the day's high never comes
 *      near the old level — whereas a crash gaps and then trades through it.
 *   4. The next session is calm. A real shock keeps moving; a re-scaling is
 *      over the moment it happens.
 *
 * Nothing here rewrites history on its own: this module only reports. The
 * `detect:splits` script records HIGH-confidence findings as
 * SUSPECTED_ADJUSTMENT rows for review, and only a human `--apply` promotes
 * one to a SPLIT/BONUS that the existing re-basing path acts on.
 */

/** Structurally compatible with statistics.service's Candle (kept local so
 * statistics.service can import this module without a cycle). */
export interface RatioCandle {
    date: string;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export interface RatioMatch {
    /** after / before, as the clean ratio it matched (0.5 for a 1:1 bonus). */
    factor: number;
    label: string;
    /** |implied/clean − 1| — how far the observed factor sits off the clean one. */
    relError: number;
}

export interface RatioArtifact extends RatioMatch {
    date: string;
    index: number;
    returnBps: number;
    impliedFactor: number;
    /** The session never traded near the pre-event level. */
    rangeClear: boolean;
    /** The following session was calm — consistent with a re-scaling, not a shock. */
    nextDayCalm: boolean;
    /** Share count changes with the price, so volume usually scales ~1/factor. */
    volumeRatio: number | null;
    confidence: 'HIGH' | 'MEDIUM';
}

/** Clean ratios a corporate action can produce, as after/before price factors. */
function candidateRatios(): RatioMatch[] {
    const out: { factor: number; label: string }[] = [];
    // Bonus a:b — a new shares for every b held → price × b/(a+b).
    for (const [a, b] of [[1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [9, 1], [1, 2], [1, 3], [1, 4], [1, 5], [2, 3], [3, 2], [2, 5], [3, 5]]) {
        out.push({ factor: b / (a + b), label: `${a}:${b} bonus` });
    }
    // Split, quoted as old→new face value → price × new/old.
    for (const [o, n] of [[10, 1], [10, 2], [10, 5], [5, 1], [5, 2], [2, 1], [100, 1], [100, 2], [100, 5], [100, 10]]) {
        out.push({ factor: n / o, label: `₹${o}→₹${n} split` });
    }
    // Consolidation / reverse split.
    for (const f of [2, 3, 5, 10]) out.push({ factor: f, label: `1:${f} reverse split` });

    // A 1:1 bonus and a ₹10→₹5 split move the price identically, and from
    // price alone they are indistinguishable — so the label has to say both.
    // Deduplicating by factor kept whichever was pushed first (always the
    // bonus), which meant every split ratio an Indian company actually
    // performs was reported as a bonus, in the explanation shown to the user
    // and in the row a human reviews before re-basing history.
    const byFactor = new Map<string, string[]>();
    for (const r of out) {
        const key = r.factor.toFixed(6);
        const labels = byFactor.get(key) ?? [];
        if (!labels.includes(r.label)) labels.push(r.label);
        byFactor.set(key, labels);
    }
    const seen = new Set<string>();
    return out
        .filter(r => { const k = r.factor.toFixed(6); if (seen.has(k)) return false; seen.add(k); return true; })
        .map(r => ({ ...r, label: (byFactor.get(r.factor.toFixed(6)) ?? [r.label]).join(' or '), relError: 0 }));
}

const RATIOS = candidateRatios();

/**
 * Does the move from `before` to `after` look like a clean corporate-action
 * ratio rather than a market move? Returns null unless the move is large
 * (a 2% day is never a split) AND lands within tolerance of a clean ratio.
 */
export function matchCommonRatio(
    before: number,
    after: number,
    tolerance: number = ADJUSTMENT_GUARD.RatioTolerance
): RatioMatch | null {
    if (!(before > 0) || !(after > 0)) return null;
    const implied = after / before;
    if (Math.abs(implied - 1) * 10000 < ADJUSTMENT_GUARD.MinAbsReturnBps) return null;

    let best: RatioMatch | null = null;
    for (const r of RATIOS) {
        const relError = Math.abs(implied / r.factor - 1);
        if (relError <= tolerance && (best === null || relError < best.relError)) {
            best = { factor: r.factor, label: r.label, relError };
        }
    }
    return best;
}

/**
 * Every day in the series whose overnight move looks mechanical rather than
 * real. HIGH confidence requires the tight ratio match *and* both
 * corroborating tests; that's the only grade any caller acts on.
 */
export function detectRatioArtifacts(candles: RatioCandle[]): RatioArtifact[] {
    const out: RatioArtifact[] = [];
    for (let i = 1; i < candles.length; i++) {
        const prev = candles[i - 1], cur = candles[i];
        const match = matchCommonRatio(prev.close, cur.close);
        if (!match) continue;

        const clearance = ADJUSTMENT_GUARD.RangeClearanceFrac;
        const rangeClear = match.factor < 1
            ? cur.high <= prev.close * (1 - clearance)
            : cur.low >= prev.close * (1 + clearance);

        const next = candles[i + 1];
        const nextDayCalm = !next || Math.abs(((next.close - cur.close) * 10000) / cur.close) < ADJUSTMENT_GUARD.NextDayCalmBps;

        const tight = match.relError <= ADJUSTMENT_GUARD.HighConfidenceTolerance;
        out.push({
            ...match,
            date: cur.date,
            index: i,
            returnBps: Math.round(((cur.close - prev.close) * 10000) / prev.close),
            impliedFactor: cur.close / prev.close,
            rangeClear,
            nextDayCalm,
            volumeRatio: prev.volume > 0 ? cur.volume / prev.volume : null,
            confidence: tight && rangeClear && nextDayCalm ? 'HIGH' : 'MEDIUM',
        });
    }
    return out;
}

/** Candle indices whose return should be treated as mechanical. */
export function artifactIndices(candles: RatioCandle[]): { indices: Set<number>; artifacts: RatioArtifact[] } {
    const artifacts = detectRatioArtifacts(candles).filter(a => a.confidence === 'HIGH');
    return { indices: new Set(artifacts.map(a => a.index)), artifacts };
}
