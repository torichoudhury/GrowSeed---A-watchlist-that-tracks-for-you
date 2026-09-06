import { UUID_RE, INSTRUMENT_ID_RE } from './ownership';
import { now as clockNow } from './clock';

/**
 * Input validation at the HTTP boundary.
 *
 * Everything here throws `ValidationError`, which the error middleware turns
 * into a 400 with the message — so routes stay flat (parse, then act) instead
 * of nesting a guard per field. Deliberately hand-rolled in the same style as
 * the existing `UUID_RE` / `INSTRUMENT_ID_RE` checks rather than pulling in a
 * schema library for a dozen fields.
 */
export class ValidationError extends Error {
    readonly status = 400;
    constructor(message: string) {
        super(message);
        this.name = 'ValidationError';
    }
}

/** Clients may be a little ahead of us; they may not be a month ahead. */
const FUTURE_SKEW_MS = 60_000;
/** Anything older than this from a client is a bug or an attack, not a quote. */
const TIMESTAMP_FLOOR_MS = Date.parse('2000-01-01T00:00:00Z');

export function parseInstrumentId(value: unknown, field = 'instrumentId'): string {
    const id = String(value ?? '').trim().toUpperCase();
    if (!INSTRUMENT_ID_RE.test(id)) {
        throw new ValidationError(`${field} must look like EXCHANGE:SYMBOL`);
    }
    return id;
}

export function parseUuid(value: unknown, field: string): string {
    const id = String(value ?? '').trim();
    if (!UUID_RE.test(id)) throw new ValidationError(`${field} must be a UUID`);
    return id;
}

/**
 * A timestamp supplied by a client, bounded on both sides.
 *
 * The upper bound is the load-bearing one: `/acknowledge` writes this value as
 * the baseline's `last_seen_data_timestamp`, and the monotonic guard only
 * accepts a later one. A client that sent "2999-01-01" — accidentally or
 * otherwise — permanently froze its own baseline: every later acknowledge was
 * silently discarded and "since you last checked" never moved again.
 */
export function parseTimestamp(value: unknown, field: string): Date {
    if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) {
        throw new ValidationError(`${field} must be an ISO 8601 timestamp`);
    }
    const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
    if (Number.isNaN(ms)) throw new ValidationError(`${field} is not a valid timestamp`);
    if (ms > clockNow().getTime() + FUTURE_SKEW_MS) {
        throw new ValidationError(`${field} is in the future`);
    }
    if (ms < TIMESTAMP_FLOOR_MS) throw new ValidationError(`${field} is implausibly old`);
    return new Date(ms);
}

export function parseIntInRange(
    value: unknown,
    { field, min, max, fallback }: { field: string; min: number; max: number; fallback?: number }
): number {
    if ((value === undefined || value === null) && fallback !== undefined) return fallback;
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(n)) throw new ValidationError(`${field} must be an integer`);
    if (n < min || n > max) throw new ValidationError(`${field} must be between ${min} and ${max}`);
    return n;
}

export function parseBoundedArray(value: unknown, { field, max }: { field: string; max: number }): unknown[] {
    if (!Array.isArray(value)) throw new ValidationError(`${field} must be an array`);
    if (value.length > max) throw new ValidationError(`${field} may contain at most ${max} entries`);
    return value;
}

export function parseText(value: unknown, { field, min = 1, max }: { field: string; min?: number; max: number }): string {
    const s = String(value ?? '').trim();
    if (s.length < min) throw new ValidationError(`${field} must be at least ${min} character${min === 1 ? '' : 's'}`);
    if (s.length > max) throw new ValidationError(`${field} must be ${max} characters or fewer`);
    return s;
}
