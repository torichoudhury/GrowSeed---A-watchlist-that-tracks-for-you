import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchCommonRatio, detectRatioArtifacts, artifactIndices, type RatioCandle } from './splitDetector';

/** A calm series around `start`, alternating ±0.5% so it has a real distribution. */
function calmSeries(start: number, days: number, from = 1): RatioCandle[] {
    const out: RatioCandle[] = [];
    let close = start;
    for (let i = 0; i < days; i++) {
        close = Math.round(close * (i % 2 === 0 ? 1.005 : 0.995));
        out.push({
            date: `2026-0${Math.floor((from + i) / 28) + 1}-${String(((from + i) % 28) + 1).padStart(2, '0')}`,
            high: Math.round(close * 1.008), low: Math.round(close * 0.992), close, volume: 1_000_000,
        });
    }
    return out;
}

test('matchCommonRatio ignores ordinary moves however precise', () => {
    assert.equal(matchCommonRatio(10000, 10200), null);   // +2%
    assert.equal(matchCommonRatio(10000, 8800), null);    // −12%, below the 15% floor
    assert.equal(matchCommonRatio(10000, 5000)?.factor, 0.5);
});

test('matchCommonRatio recognises clean split and bonus ratios', () => {
    assert.equal(matchCommonRatio(20000, 10000)?.factor, 0.5);           // 1:1 bonus / ₹10→₹5
    assert.equal(matchCommonRatio(30000, 10000)?.factor, 1 / 3);         // 2:1 bonus
    assert.equal(matchCommonRatio(10000, 1000)?.factor, 0.1);            // ₹10→₹1 split
    assert.equal(matchCommonRatio(10000, 20000)?.label, '1:2 reverse split');
});

test('matchCommonRatio tolerates a small same-day move on top of the ratio', () => {
    // 1:1 bonus and the stock also fell 1% that session.
    const m = matchCommonRatio(20000, 9900);
    assert.equal(m?.factor, 0.5);
    assert.ok(m!.relError > 0.005 && m!.relError <= 0.015);
});

test('matchCommonRatio rejects a ratio-adjacent move that is not clean enough', () => {
    assert.equal(matchCommonRatio(20000, 9500), null);    // −52.5%: 5% off a clean 1:1
});

test('detectRatioArtifacts finds an unadjusted 1:1 bonus and grades it HIGH', () => {
    const before = calmSeries(200000, 30);
    const last = before[before.length - 1].close;
    const split: RatioCandle = {
        date: '2026-03-02', close: Math.round(last / 2),
        // The whole session trades at the new scale — that is the tell.
        high: Math.round(last / 2 * 1.01), low: Math.round(last / 2 * 0.99),
        volume: 2_000_000,
    };
    const after = calmSeries(split.close, 10, 3).map((c, i) => ({ ...c, date: `2026-03-${String(i + 3).padStart(2, '0')}` }));
    const artifacts = detectRatioArtifacts([...before, split, ...after]);

    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].date, '2026-03-02');
    assert.equal(artifacts[0].factor, 0.5);
    assert.equal(artifacts[0].confidence, 'HIGH');
    assert.equal(artifacts[0].rangeClear, true);
    assert.equal(artifacts[0].nextDayCalm, true);
});

test('a genuine crash that gaps and keeps falling is not flagged', () => {
    const before = calmSeries(100000, 30);
    const last = before[before.length - 1].close;
    // −20% close, but the session traded back near the old level (high only
    // −2%) and the next session fell another 8%: a real shock, not a re-scaling.
    const crash: RatioCandle = {
        date: '2026-03-02', close: Math.round(last * 0.8),
        high: Math.round(last * 0.98), low: Math.round(last * 0.79), volume: 9_000_000,
    };
    const next: RatioCandle = {
        date: '2026-03-03', close: Math.round(last * 0.8 * 0.92),
        high: Math.round(last * 0.81), low: Math.round(last * 0.9 * 0.8), volume: 7_000_000,
    };
    const all = [...before, crash, next];

    // It may register as a candidate (0.8 is a clean 1:4-bonus factor), but
    // never at the confidence any caller acts on.
    for (const a of detectRatioArtifacts(all)) assert.equal(a.confidence, 'MEDIUM');
    assert.equal(artifactIndices(all).indices.size, 0);
});

test('a clean series produces no findings at all', () => {
    assert.deepEqual(detectRatioArtifacts(calmSeries(150000, 250)), []);
});
