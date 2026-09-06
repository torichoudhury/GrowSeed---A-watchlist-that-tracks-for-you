/**
 * Score calibration (approved 2026-09-04): the raw attention score is
 * mapped onto the spec's 0–100 scale so that the spec's severity bands
 * (QUIET <21, LOW ≥21, MEDIUM ≥41, HIGH ≥61, CRITICAL ≥81) hit the target
 * base rates below on real history — instead of CRITICAL never firing
 * because multiplicative dampeners compress the raw range (observed raw
 * max 68 over 1,310 stock-days).
 *
 * Anchors are [rawScore, calibratedScore] pairs, interpolated linearly and
 * clamped. Regenerate with `npm run calibrate` after any change to signals,
 * caps or thresholds, and paste the printed anchors here.
 */
export const SCORE_CALIBRATION = {
    calibratedAt: '2026-09-05',
    dataset: '23 NSE stocks × 243 trading days = 5,451 stock-days (2025-09 → 2026-08), daily-checker persona, Yahoo daily candles',
    targetBaseRates: { LOW: 0.35, MEDIUM: 0.15, HIGH: 0.06, CRITICAL: 0.015 },
    // Re-fitted 2026-09-05 after correcting four measurement bugs that all
    // inflated scores: the volume p98 slot receiving p95 (0.8 of the cap where
    // 0.6 was earned), the horizon window spanning N+1 sessions, the streak
    // counting today twice, and percentile bands firing on six days of
    // history. On the previous anchors the corrected model ran hot —
    // CRITICAL 2.04% against a 1.5% target — because the anchors had absorbed
    // those biases. Regenerate with `npm run calibrate` after any change to
    // signals, caps or thresholds, and paste the printed anchors here.
    anchors: [
        [0, 0],
        [13, 21],   // raw p65   → LOW floor
        [21, 41],   // raw p85   → MEDIUM floor
        [32, 61],   // raw p94   → HIGH floor
        [48, 81],   // raw p98.5 → CRITICAL floor
        [70, 100],  // raw max observed
    ] as [number, number][],
};

/** Monotone piecewise-linear map from raw to calibrated score, clamped to 0–100. */
export function calibrateScore(raw: number): number {
    const a = SCORE_CALIBRATION.anchors;
    if (raw <= a[0][0]) return a[0][1];
    for (let i = 1; i < a.length; i++) {
        const [x0, y0] = a[i - 1];
        const [x1, y1] = a[i];
        if (raw <= x1) {
            return Math.round(y0 + ((raw - x0) * (y1 - y0)) / (x1 - x0));
        }
    }
    return 100;
}
