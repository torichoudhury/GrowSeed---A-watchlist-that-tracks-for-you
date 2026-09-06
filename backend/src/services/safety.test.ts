import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstrumentId, parseUuid, parseTimestamp, parseIntInRange, parseBoundedArray, parseText, ValidationError } from './validate';
import { redact, redactString, describeShape, MASK } from './log';
import { createBreaker } from './circuitBreaker';
import { calculateMetrics } from './metrics.service';
import { now as clockNow } from './clock';
import { MarketStatus, NormalizedQuote } from '../models/quote';

// ─── Input validation ───────────────────────────────────────────────────────

test('parseInstrumentId uppercases and rejects anything else', () => {
    assert.equal(parseInstrumentId('nse:reliance'), 'NSE:RELIANCE');
    assert.throws(() => parseInstrumentId('reliance'), ValidationError);
    assert.throws(() => parseInstrumentId(''), ValidationError);
    assert.throws(() => parseInstrumentId(null), ValidationError);
});

test('parseUuid accepts a UUID and rejects a bare string', () => {
    const id = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    assert.equal(parseUuid(id, 'alertId'), id);
    // This is the value that used to reach a UUID column and 500 the request.
    assert.throws(() => parseUuid('not-a-uuid', 'alertId'), ValidationError);
});

test('parseTimestamp refuses a future date — the frozen-baseline bug', () => {
    // "2999-01-01" is a valid timestamptz, so it was accepted, satisfied the
    // monotonic guard forever after, and silently froze the user's baseline.
    assert.throws(() => parseTimestamp('2999-01-01', 'dataTimestamp'), /in the future/);
    assert.throws(() => parseTimestamp('not-a-date', 'dataTimestamp'), /not a valid timestamp/);
    assert.throws(() => parseTimestamp('1970-01-02', 'dataTimestamp'), /implausibly old/);
    assert.throws(() => parseTimestamp(null, 'dataTimestamp'), ValidationError);

    // Against the APP clock, not the wall clock: in replay mode "now" is the
    // replayed session, and a real wall-clock timestamp is genuinely ahead of it.
    const recent = new Date(clockNow().getTime() - 60_000).toISOString();
    assert.equal(parseTimestamp(recent, 'dataTimestamp').toISOString(), recent);
});

test('parseIntInRange and parseBoundedArray enforce their bounds', () => {
    assert.equal(parseIntInRange(5, { field: 'x', min: 0, max: 10 }), 5);
    assert.equal(parseIntInRange(undefined, { field: 'x', min: 0, max: 10, fallback: 0 }), 0);
    assert.throws(() => parseIntInRange(1.5, { field: 'x', min: 0, max: 10 }), /must be an integer/);
    assert.throws(() => parseIntInRange(-1, { field: 'x', min: 0, max: 10 }), /between/);
    assert.throws(() => parseBoundedArray([1, 2, 3], { field: 'items', max: 2 }), /at most 2/);
    assert.throws(() => parseBoundedArray('nope', { field: 'items', max: 2 }), /must be an array/);
    assert.throws(() => parseText('   ', { field: 'name', max: 10 }), /at least 1/);
});

// ─── Log redaction ──────────────────────────────────────────────────────────

test('redact masks tokens, bearers, credentials and query secrets', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMifQ.c2lnbmF0dXJl';
    assert.ok(!redactString(`token=${jwt}`).includes(jwt));
    assert.ok(!redactString(`Authorization: Bearer ${jwt}`).includes(jwt));
    assert.ok(!redactString('postgresql://user:hunter2@db.example.com:5432/app').includes('hunter2'));
    assert.ok(!redactString('wss://x/ws?ticket=abc123def456').includes('abc123def456'));
    assert.ok(!redactString('{"access_token":"s3cr3t-value"}').includes('s3cr3t-value'));
});

test('redact masks secret-looking object keys but keeps the error readable', () => {
    const out = redact({ apiKey: 'abc', nested: { password: 'p' }, symbol: 'NSE:ITC' }) as any;
    assert.equal(out.apiKey, MASK);
    assert.equal(out.nested.password, MASK);
    assert.equal(out.symbol, 'NSE:ITC');

    const err = redact(new Error('login failed for token=eyJhbGciOiJIUzI1NiJ9.aaaaaaaa.bbbb')) as any;
    assert.equal(err.name, 'Error');
    assert.ok(!err.message.includes('eyJhbGciOiJIUzI1NiJ9'));
    assert.ok(err.stack);
});

test('describeShape reports keys and types, never values', () => {
    const shape = describeShape({ token: 'super-secret', expiry: 3600, scopes: ['a', 'b'] });
    assert.ok(!shape.includes('super-secret'));
    assert.equal(shape, '{ token: string, expiry: number, scopes: array(2) }');
});

// ─── Circuit breaker ────────────────────────────────────────────────────────

test('breaker opens after the threshold and half-opens after the window', () => {
    const b = createBreaker('test-breaker-a', { threshold: 3, openMs: 20 });
    assert.equal(b.allows(), true);
    b.recordFailure(); b.recordFailure();
    assert.equal(b.allows(), true, 'below the threshold it stays closed');
    b.recordFailure();
    assert.equal(b.allows(), false, 'threshold reached — open');
    assert.equal(b.state().open, true);

    return new Promise<void>(resolve => setTimeout(() => {
        assert.equal(b.allows(), true, 'half-open probe allowed after the window');
        b.recordSuccess();
        assert.equal(b.state().consecutiveFailures, 0);
        resolve();
    }, 30));
});

test('breaker.run surfaces the failure and counts it', async () => {
    const b = createBreaker('test-breaker-b', { threshold: 1, openMs: 1000 });
    await assert.rejects(b.run(async () => { throw new Error('upstream down'); }), /upstream down/);
    await assert.rejects(b.run(async () => 'never runs'), /is open/);
});

// ─── Metrics fixes ──────────────────────────────────────────────────────────

const IST_NOON = (date: string) => new Date(`${date}T06:30:00Z`);   // 12:00 IST

function quoteOf(over: Partial<NormalizedQuote> = {}): NormalizedQuote {
    const ts = IST_NOON('2026-08-03');
    return {
        instrumentId: 'NSE:TEST',
        lastPricePaise: 10500, previousClosePaise: 10000,
        openPaise: 10100, highPaise: 10600, lowPaise: 10050, volume: 2_000_000,
        dataTimestamp: ts, retrievedAt: ts,
        marketStatus: MarketStatus.OPEN, source: 'test', feedDelaySec: 0,
        ...over,
    };
}

const baseStats = {
    trading_days_observed: 300, has_7d_window: true, has_30d_window: true, has_52w_window: true,
    avg_volume_30d: 1_000_000, median_volume_30d: 1_000_000, mad_volume_30d: 250_000,
    median_abs_return_bps_30d: 70, mad_abs_return_bps_30d: 40,
    abs_return_p90_bps: 170, abs_return_p95_bps: 240, abs_return_p98_bps: 330,
    abs_return_p99_bps: 400, abs_return_max_bps: 900,
    volume_p90: 1_200_000, volume_p95: 1_600_000, volume_p99: 3_000_000,
    realized_vol_90d_bps: 150, ewma_vol_bps: 150,
    mean_return_5d_bps: 0, mean_return_30d_bps: 0,
    streak_days: 4,
    high_30d_paise: 11000, low_30d_paise: 9000,
    close_5d_ago_paise: 10000, close_4d_ago_paise: 10200,
    close_20d_ago_paise: 9500, close_19d_ago_paise: 9600,
    last_candle_date: '2026-07-31',
};
const state = { last_seen_price_paise: 10000, last_seen_at: IST_NOON('2026-07-31'), is_initial_state: false };
const regime = { volRatio: 1, vixPctile: 0.5, dampen: 1 };

test('volume between p95 and p99 grades P95, not P98', () => {
    // The p98 slot used to be handed volume_p95, and the ladder tests p98
    // first — so everything above p95 scored 0.8 of the cap instead of 0.6.
    const m = calculateMetrics(quoteOf({ volume: 2_000_000 }), baseStats, state, null, null, null, regime);
    assert.equal(m.volumeRarityBand, 'P95');
    assert.equal(m.volumeRarityFraction, 0.6);
});

test('a streak is not extended when the stats row already contains today', () => {
    const live = calculateMetrics(quoteOf(), baseStats, state, null, null, null, regime);
    assert.equal(live.streakDays, 5, 'stats end 31 Jul, quote is 3 Aug — today extends the run');

    const afterRecalc = calculateMetrics(
        quoteOf(), { ...baseStats, last_candle_date: '2026-08-03' }, state, null, null, null, regime
    );
    assert.equal(afterRecalc.streakDays, 4, 'stats already include today — counting it again reported 5 for a 4-day run');
});

test('the horizon base steps back one session while the stats row lags', () => {
    // Stats end 31 Jul, the quote is 3 Aug: the quote itself supplies the
    // newest session, so a 5-session window must start from close_4d_ago.
    const live = calculateMetrics(quoteOf(), baseStats, state, null, null, null, regime, 'WEEK');
    assert.equal(live.horizonReturnBps, Math.round(((10500 - 10200) * 10000) / 10200));

    const afterRecalc = calculateMetrics(
        quoteOf(), { ...baseStats, last_candle_date: '2026-08-03' }, state, null, null, null, regime, 'WEEK'
    );
    assert.equal(afterRecalc.horizonReturnBps, Math.round(((10500 - 10000) * 10000) / 10000));
});
