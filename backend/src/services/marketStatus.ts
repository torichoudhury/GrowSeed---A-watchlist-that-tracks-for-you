import { MarketStatus } from '../models/quote';
import { now as clockNow } from './clock';

/**
 * NSE regular session in IST, Monday-Friday. No holiday calendar — a known
 * simplification for local/demo use; a real deployment would need NSE's
 * published holiday list.
 *
 * "Now" comes from the app clock, so in replay mode the session opens and
 * closes on the replayed day rather than the real one (services/clock.ts).
 */
export function getMarketStatus(now: Date = clockNow()): MarketStatus {
    const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const day = ist.getDay(); // 0 Sun .. 6 Sat
    if (day === 0 || day === 6) return MarketStatus.CLOSED;

    const minutesSinceMidnight = ist.getHours() * 60 + ist.getMinutes();
    const preOpen = 9 * 60; // 09:00
    const open = 9 * 60 + 15; // 09:15
    const close = 15 * 60 + 30; // 15:30
    const postClose = 16 * 60; // 16:00

    if (minutesSinceMidnight < preOpen) return MarketStatus.CLOSED;
    if (minutesSinceMidnight < open) return MarketStatus.PRE_MARKET;
    if (minutesSinceMidnight < close) return MarketStatus.OPEN;
    if (minutesSinceMidnight < postClose) return MarketStatus.POST_MARKET;
    return MarketStatus.CLOSED;
}
