/**
 * Circuit breakers (BUILD_SPEC §5.3).
 *
 * This state machine already existed, hard-coded inside the quote path, which
 * meant every other upstream — the NSE endpoints, the instrument master, the
 * index-constituent files, Groww's auth — had none: a dead dependency was
 * retried at full rate on every request and every cron tick.
 *
 * Deliberately per-dependency, not per-instrument: the thing that fails is the
 * connection to a provider, so tripping per symbol would let N symbols each
 * back off independently instead of together.
 */

const DEFAULT_THRESHOLD = 5;
const DEFAULT_OPEN_MS = 30_000;

export interface Breaker {
    readonly name: string;
    /** False while the circuit is open — callers should go straight to their fallback. */
    allows(): boolean;
    recordSuccess(): void;
    recordFailure(): void;
    /** Run `fn` under the breaker; throws `CircuitOpenError` when it is open. */
    run<T>(fn: () => Promise<T>): Promise<T>;
    state(): BreakerState;
}

export interface BreakerState {
    name: string;
    open: boolean;
    consecutiveFailures: number;
    opensFor: number | null;
}

export class CircuitOpenError extends Error {
    constructor(name: string) {
        super(`Circuit "${name}" is open`);
        this.name = 'CircuitOpenError';
    }
}

const registry = new Map<string, Breaker>();

export function createBreaker(
    name: string,
    { threshold = DEFAULT_THRESHOLD, openMs = DEFAULT_OPEN_MS } = {}
): Breaker {
    const existing = registry.get(name);
    if (existing) return existing;

    let consecutiveFailures = 0;
    let openedAt: number | null = null;

    const breaker: Breaker = {
        name,
        allows() {
            if (openedAt === null) return true;
            if (Date.now() - openedAt >= openMs) {
                // Half-open: let exactly one probe through.
                openedAt = null;
                consecutiveFailures = 0;
                return true;
            }
            return false;
        },
        recordSuccess() {
            consecutiveFailures = 0;
            openedAt = null;
        },
        recordFailure() {
            consecutiveFailures++;
            if (consecutiveFailures >= threshold && openedAt === null) {
                openedAt = Date.now();
                console.warn(`Circuit breaker OPEN [${name}] — ${consecutiveFailures} consecutive failures`);
            }
        },
        async run<T>(fn: () => Promise<T>): Promise<T> {
            if (!breaker.allows()) throw new CircuitOpenError(name);
            try {
                const result = await fn();
                breaker.recordSuccess();
                return result;
            } catch (e) {
                breaker.recordFailure();
                throw e;
            }
        },
        state() {
            return {
                name,
                open: openedAt !== null,
                consecutiveFailures,
                opensFor: openedAt === null ? null : Math.max(0, openMs - (Date.now() - openedAt)),
            };
        },
    };

    registry.set(name, breaker);
    return breaker;
}

/** Every breaker's current state, for /health. */
export function breakerStates(): BreakerState[] {
    return Array.from(registry.values()).map(b => b.state());
}
