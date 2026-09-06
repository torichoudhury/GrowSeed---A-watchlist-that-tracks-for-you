import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    median, mad, percentile, ewmaVol, marketModel, signedStreak, dailyReturnsBps, computeStockStatistics,
    horizonReturnsBps, Candle,
} from './statistics.service';
import { calibrateScore, SCORE_CALIBRATION } from '../config/calibration';
import { toYahooTicker } from './yahoo/provider';

test('median handles odd/even lengths', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([]), 0);
});

test('MAD of a constant series is 0; of 1..5 is 1', () => {
    assert.equal(mad([5, 5, 5], 5), 0);
    assert.equal(mad([1, 2, 3, 4, 5], 3), 1);
});

test('nearest-rank percentile', () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(percentile(v, 0.95), 95);
    assert.equal(percentile(v, 0.99), 99);
    assert.equal(percentile(v, 0.5), 50);
});

test('EWMA vol of a constant-magnitude series converges to that magnitude', () => {
    const r = Array.from({ length: 300 }, (_, i) => (i % 2 ? 100 : -100));
    assert.ok(Math.abs(ewmaVol(r) - 100) < 1);
});

test('market model recovers beta and alpha from a synthetic relationship', () => {
    const m = Array.from({ length: 90 }, (_, i) => Math.round(50 * Math.sin(i)));   // market returns
    const s = m.map((x, i) => Math.round(10 + 1.5 * x + (i % 3 === 0 ? 5 : -5)));  // beta 1.5, alpha 10, noise
    const mm = marketModel(s, m)!;
    assert.ok(Math.abs(mm.beta - 1.5) < 0.05, `beta ${mm.beta}`);
    assert.ok(Math.abs(mm.alpha - 10) < 3, `alpha ${mm.alpha}`);
    assert.ok(mm.corr > 0.95);
});

test('market model needs at least 20 aligned points', () => {
    assert.equal(marketModel([1, 2, 3], [1, 2, 3]), null);
});

test('signed streak counts consecutive same-sign returns from the end', () => {
    assert.equal(signedStreak([5, -1, -2, -3]), -3);
    assert.equal(signedStreak([-5, 1, 2]), 2);
    assert.equal(signedStreak([1, 0]), 0);
});

test('daily returns are integer bps against the previous close', () => {
    const c = (date: string, close: number): Candle => ({ date, open: close, high: close, low: close, close, volume: 1000 });
    const r = dailyReturnsBps([c('2026-01-01', 10000), c('2026-01-02', 10100), c('2026-01-03', 9999)]);
    assert.deepEqual(r.map(x => x.bps), [100, -100]);
});

test('computeStockStatistics windows flags follow trading days observed', () => {
    const candles: Candle[] = Array.from({ length: 25 }, (_, i) => ({
        date: `2026-01-${String(i + 1).padStart(2, '0')}`, open: 10000, high: 10100 + i, low: 9900 - i, close: 10000 + (i % 2 ? 50 : -50), volume: 1000 + i,
    }));
    const s = computeStockStatistics('X', candles, null, null)!;
    assert.equal(s.trading_days_observed, 25);
    assert.equal(s.has_7d_window, true);
    assert.equal(s.has_30d_window, true);
    assert.equal(s.has_52w_window, false);
    assert.equal(s.high_30d_paise, 10124);
    assert.equal(s.low_30d_paise, 9876);
    assert.ok(s.mad_abs_return_bps_30d >= 1);
});

test('horizon returns are overlapping N-session moves, skipping contaminated windows', () => {
    const c = (date: string, close: number): Candle => ({ date, open: close, high: close, low: close, close, volume: 1000 });
    const candles = [
        c('2026-01-01', 10000), c('2026-01-02', 10100), c('2026-01-03', 10200),
        c('2026-01-04', 10300), c('2026-01-05', 10400), c('2026-01-06', 10500),
        c('2026-01-07', 10600),
    ];
    // 5-session returns ending at index 5 and 6.
    assert.deepEqual(horizonReturnsBps(candles, 5, new Set()), [500, 495]);
    // A re-scaling at index 3 poisons every window containing it.
    assert.deepEqual(horizonReturnsBps(candles, 5, new Set([3])), []);
    // 2-session windows ending at index 3 and 4 both contain it; the rest stay.
    assert.deepEqual(horizonReturnsBps(candles, 2, new Set([3])), [200, 194, 192]);
});

test('an unadjusted 1:1 bonus is excluded from the return distribution', () => {
    // 60 flat-ish sessions, then the price halves overnight and stays there.
    const mk = (date: string, close: number): Candle => ({
        date, open: close, high: Math.round(close * 1.004), low: Math.round(close * 0.996), close, volume: 1_000_000,
    });
    const days: Candle[] = [];
    for (let i = 0; i < 60; i++) days.push(mk(`2026-01-${String((i % 28) + 1).padStart(2, '0')}`, 20000 + (i % 2 ? 40 : -40)));
    days.push(mk('2026-03-01', 10000));
    for (let i = 0; i < 20; i++) days.push(mk(`2026-03-${String(i + 2).padStart(2, '0')}`, 10000 + (i % 2 ? 20 : -20)));

    const s = computeStockStatistics('X', days, null, null)!;
    assert.equal(s.ratio_artifacts_excluded, 1);
    // Without the guard, abs_return_max would be ~5000bps and p98/p99 would
    // follow it, making every genuine 3% day look ordinary for a year.
    assert.ok(s.abs_return_max_bps < 1000, `max ${s.abs_return_max_bps}`);
    assert.ok(s.abs_return_5d_p95_bps > 0 && s.abs_return_5d_p95_bps < 2000, `5d p95 ${s.abs_return_5d_p95_bps}`);
    assert.equal(s.close_5d_ago_paise, days[days.length - 6].close);
});

test('calibration map is monotone, hits its anchors, and clamps', () => {
    for (const [raw, cal] of SCORE_CALIBRATION.anchors) assert.equal(calibrateScore(raw), cal);
    let prev = -1;
    for (let raw = 0; raw <= 100; raw++) {
        const c = calibrateScore(raw);
        assert.ok(c >= prev, `not monotone at ${raw}`);
        assert.ok(c >= 0 && c <= 100);
        prev = c;
    }
    assert.equal(calibrateScore(999), 100);
});

test('Yahoo ticker mapping', () => {
    assert.equal(toYahooTicker('NSE:RELIANCE'), 'RELIANCE.NS');
    assert.equal(toYahooTicker('BSE:RELIANCE'), 'RELIANCE.BO');
    assert.equal(toYahooTicker('NSE:NIFTY'), '^NSEI');
    assert.equal(toYahooTicker('NSE:INDIAVIX'), '^INDIAVIX');
    assert.throws(() => toYahooTicker('NSE:NIFTYCDTY'));
});
