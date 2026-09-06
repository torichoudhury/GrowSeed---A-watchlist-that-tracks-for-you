/**
 * The application clock.
 *
 * Normally this is just `new Date()`. In demo mode (`DEMO_AS_OF=YYYY-MM-DD`)
 * every part of the backend that asks "what time is it?" is answered with a
 * point inside that past trading session instead, so a month-old day of real
 * market data behaves exactly like today: the session opens, prices move,
 * freshness is measured against the session, and "since you last checked"
 * spans the real weekend before it.
 *
 * The data is never rewritten to pretend it is recent — candles keep their
 * true dates, and statistics simply stop at the demo date so nothing from the
 * future leaks into them. Unset the env var and the app is live again.
 *
 *   DEMO_AS_OF=2026-09-04        the session to replay (a real trading day)
 *   DEMO_SPEED=6                 demo seconds per real second (6 ⇒ the 6h15m
 *                                session takes ~62 real minutes)
 *   DEMO_SESSION_START=09:15     demo time at the moment the server starts
 *   DEMO_LABEL=off               hide the "replay" badge in the UI
 */

const IST_OFFSET = '+05:30';
const SESSION_END_CLAMP = '16:05';   // past POST_MARKET, so the day ends CLOSED

export interface DemoClock {
    asOf: string;
    speed: number;
    sessionStart: string;
    label: boolean;
    /** Whether viewing the dashboard re-bases the baseline after 3s. */
    autoAcknowledge: boolean;
    /**
     * The demo baseline — "since you last checked" is measured from this fixed
     * moment (demo fixture: Monday 31 Aug 2026, 10:00 IST). Controls the
     * `last_seen_at` the seed/reset scripts write to user_stock_state, so the
     * demo opens on a real multi-day window instead of "just now".
     */
    baselineAt: string;
    /**
     * Derive the replay position from the wall clock instead of from process
     * start, wrapping when the session ends.
     *
     * Anchoring to process start is nicer locally — every `npm run dev` opens
     * the market — but it cannot survive a host that scales to zero: each cold
     * start would rewind the replay to 09:15, so the demo would silently jump
     * backwards whenever traffic paused. In loop mode every instance computes
     * the same demo time from the same wall clock, so there is no per-process
     * state to lose. Defaults on wherever VERCEL is set.
     */
    loop: boolean;
}

function parseDemo(): DemoClock | null {
    const raw = (process.env.DEMO_AS_OF ?? '2026-08-31').trim();
    if (!raw || raw.toLowerCase() === 'off' || raw.toLowerCase() === 'live') return null;
    const asOf = raw;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
        console.warn(`DEMO_AS_OF="${asOf}" is not YYYY-MM-DD — demo mode is OFF`);
        return null;
    }
    const speed = Number(process.env.DEMO_SPEED || 6);
    return {
        asOf,
        speed: Number.isFinite(speed) && speed > 0 ? speed : 6,
        sessionStart: (process.env.DEMO_SESSION_START || '09:15').trim(),
        label: (process.env.DEMO_LABEL || 'on').trim().toLowerCase() !== 'off',
        autoAcknowledge: (process.env.DEMO_AUTO_ACK || 'off').trim().toLowerCase() !== 'off',
        baselineAt: (process.env.DEMO_BASELINE_AT || '2026-08-31T10:00:00+05:30'),
        loop: (process.env.DEMO_LOOP || 'on').trim().toLowerCase() === 'on',
    };
}

/** Auto-acknowledge is the real product behaviour (BUILD_SPEC §14.5), but it
 * re-bases the baseline three seconds after the dashboard opens — which
 * during a demo erases the opening "here is what changed while you were away"
 * before anyone has read it. It therefore defaults off for both live and
 * demo; set DEMO_AUTO_ACK=on to re-enable it, leaving "Mark all as seen" to
 * demonstrate the same mechanism deliberately. */
export function autoAcknowledgeEnabled(): boolean {
    return DEMO ? DEMO.autoAcknowledge : false;
}

export const DEMO: DemoClock | null = parseDemo();

// Fixed at module load, but can be reset by a demo replay:
let bootedAt = Date.now();
let loopShiftMs = 0;

export function resetDemoClock(targetIso: string) {
    if (!DEMO) return;
    const start = Date.parse(`${DEMO.asOf}T${DEMO.sessionStart}:00${IST_OFFSET}`);
    const target = Date.parse(targetIso);
    const elapsed = target - start;

    if (DEMO.loop) {
        loopShiftMs = Date.now() - elapsed / DEMO.speed;
    } else {
        bootedAt = Date.now() - elapsed / DEMO.speed;
    }
}

/** "Now" — real, or the corresponding point in the replayed session. */
export function now(): Date {
    if (!DEMO) return new Date();
    const start = Date.parse(`${DEMO.asOf}T${DEMO.sessionStart}:00${IST_OFFSET}`);
    const end = Date.parse(`${DEMO.asOf}T${SESSION_END_CLAMP}:00${IST_OFFSET}`);

    if (DEMO.loop) {
        // Stateless: a pure function of the wall clock, so every instance —
        // and every cold start — agrees on where the replay is, and the
        // session cycles rather than freezing at the close.
        const cycleMs = Math.max(1, Math.round((end - start) / DEMO.speed));
        const offset = (((Date.now() - loopShiftMs) % cycleMs) + cycleMs) % cycleMs;
        return new Date(start + offset * DEMO.speed);
    }

    const elapsed = (Date.now() - bootedAt) * DEMO.speed;
    return new Date(Math.min(start + elapsed, end));
}

export function nowMs(): number {
    return now().getTime();
}

/** The IST calendar date the app considers "today" (YYYY-MM-DD). */
export function istToday(): string {
    return now().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/** In demo mode, history after this date does not exist yet. */
export function historyCutoff(): string | null {
    return DEMO ? DEMO.asOf : null;
}

/** What the UI is told, so a replay can never be mistaken for a live market. */
export function demoBadge(): { asOf: string; speed: number } | null {
    return DEMO && DEMO.label ? { asOf: DEMO.asOf, speed: DEMO.speed } : null;
}
