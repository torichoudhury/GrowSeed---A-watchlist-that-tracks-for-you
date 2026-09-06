import { EventType, FundamentalsContext, EMPTY_FUNDAMENTALS } from './eventDetection.service';
import { Metrics } from './metrics.service';

/** Deterministic templates, no LLM (BUILD_SPEC §10). Max 4 reasons, in
 * priority order: data problems first, then what the user asked for, then
 * the strongest statistical evidence, then context. */

export const formatRupees = (paise: number) => (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const formatPct = (bps: number) => (bps / 100).toFixed(2);
export const formatRatio = (r: number) => r.toFixed(1);

const PRIORITY: EventType[] = [
    EventType.PROVIDER_DOWN,
    EventType.CORPORATE_ACTION_ADJUSTMENT,
    EventType.SUSPECTED_PRICE_ADJUSTMENT,
    EventType.DATA_STALE,
    EventType.INSUFFICIENT_HISTORY,
    EventType.USER_PRICE_TARGET_REACHED,
    EventType.USER_PRICE_FLOOR_REACHED,
    EventType.RESULTS_JUST_OUT,
    EventType.RESULTS_UPCOMING,
    EventType.LARGE_PRICE_MOVE,
    EventType.EXTREME_VOLATILITY,
    EventType.HORIZON_MOVE,
    EventType.IDIOSYNCRATIC_MOVE,
    EventType.GAP_UP,
    EventType.GAP_DOWN,
    EventType.EXTREME_VOLUME,
    EventType.VOLATILITY_SPIKE,
    EventType.UNUSUAL_VOLUME,
    EventType.SECTOR_DIVERGENCE,
    EventType.NEW_52W_HIGH, EventType.NEW_52W_LOW,
    EventType.NEW_30D_HIGH, EventType.NEW_30D_LOW,
    EventType.NEW_7D_HIGH, EventType.NEW_7D_LOW,
    EventType.VOL_REGIME_SHIFT,
    EventType.STREAK_UP, EventType.STREAK_DOWN,
    EventType.DRAWDOWN_FROM_HIGH, EventType.RUNUP_FROM_LOW,
    EventType.LEVEL_SHIFT,
    EventType.ACCUMULATION,
    EventType.EX_DIVIDEND_TODAY, EventType.EX_DIVIDEND_UPCOMING,
    EventType.MARKET_OUTPERFORMANCE, EventType.MARKET_UNDERPERFORMANCE,
    EventType.RECENT_ANNOUNCEMENT,
];

/** "single-day" / "5-session" / "20-session" — the window a band refers to. */
const bandWindow = (m: Metrics) => (m.horizon === 'DAY' ? 'single-day' : `${m.horizonSessions}-session`);
/** "down 3.20% over the past week" — the move the band refers to. */
const move = (m: Metrics) => {
    const dir = m.rarityMoveBps >= 0 ? 'up' : 'down';
    const suffix = m.horizon === 'DAY' ? '' : ` over the ${m.horizonLabel.replace(/^Past /, 'past ')}`;
    return `${dir} ${formatPct(Math.abs(m.rarityMoveBps))}%${suffix}`;
};

export interface ExplanationContext {
    fundamentals?: FundamentalsContext;
    sectorName?: string | null;
}

export function generateExplanations(
    events: EventType[],
    metrics: Metrics,
    userState: any,
    alerts: any[],
    context: ExplanationContext = {}
): string[] {
    const f = context.fundamentals ?? EMPTY_FUNDAMENTALS;
    const reasons: string[] = [];
    const push = (s: string) => { if (reasons.length < 4 && !reasons.includes(s)) reasons.push(s); };
    const upDown = (bps: number) => (bps >= 0 ? 'up' : 'down');
    const pct = (bps: number) => formatPct(Math.abs(bps));

    const sorted = [...events].sort((a, b) => PRIORITY.indexOf(a) - PRIORITY.indexOf(b));
    // IDIOSYNCRATIC_MOVE already says it in beta-adjusted terms; the raw
    // out/underperformance line would repeat it with a worse number.
    const hasResidual = sorted.includes(EventType.IDIOSYNCRATIC_MOVE);
    // The percentile lines already quote the horizon move with its context.
    const rarityStated = sorted.includes(EventType.EXTREME_VOLATILITY) || sorted.includes(EventType.VOLATILITY_SPIKE);

    for (const event of sorted) {
        if (reasons.length >= 4) break;
        switch (event) {
            case EventType.PROVIDER_DOWN:
                push('Live data unavailable — showing last known price'); break;
            case EventType.CORPORATE_ACTION_ADJUSTMENT:
                push(`${f.corporateActionToday?.type === 'BONUS' ? 'Bonus issue' : 'Stock split'} effective today — history re-based, today's change is not comparable`); break;
            case EventType.SUSPECTED_PRICE_ADJUSTMENT:
                push(`Price moved exactly like a ${metrics.suspectedAdjustment?.label ?? 'corporate action'} (${pct(metrics.todayChangeBps)}%) — treating it as mechanical, not news, until the calendar confirms`); break;
            case EventType.DATA_STALE:
                push(`Data is delayed by ${Math.floor(metrics.dataAgeSec / 60)} minutes`); break;
            case EventType.INSUFFICIENT_HISTORY:
                push('Not enough trading history yet for full analysis'); break;
            case EventType.USER_PRICE_TARGET_REACHED: {
                const a = alerts.find(x => x.armed_above && x.price_above_paise);
                if (a) push(`Hit your price target of ₹${formatRupees(parseInt(a.price_above_paise, 10))}`);
                break;
            }
            case EventType.USER_PRICE_FLOOR_REACHED: {
                const a = alerts.find(x => x.armed_below && x.price_below_paise);
                if (a) push(`Dropped to your price floor of ₹${formatRupees(parseInt(a.price_below_paise, 10))}`);
                break;
            }
            case EventType.RESULTS_JUST_OUT: {
                const d = Math.abs(f.resultsDaysFromNow ?? 0);
                push(d <= 1 ? 'Results announced yesterday' : `Results announced ${d} days ago`); break;
            }
            case EventType.RESULTS_UPCOMING: {
                const d = f.resultsDaysFromNow ?? 0;
                push(d === 0 ? 'Results due today' : d === 1 ? 'Results due tomorrow' : `Results due in ${d} days`); break;
            }
            case EventType.LARGE_PRICE_MOVE: {
                const days = metrics.daysSinceLastVisit >= 2 ? `, ${metrics.daysSinceLastVisit} days ago` : '';
                push(`Price ${upDown(metrics.sinceLastVisitBps)} ${pct(metrics.sinceLastVisitBps)}% since your last visit${days}`); break;
            }
            case EventType.HORIZON_MOVE: {
                if (rarityStated || metrics.horizonReturnBps === null) break;
                const dir = metrics.horizonReturnBps >= 0 ? 'Up' : 'Down';
                push(`${dir} ${pct(metrics.horizonReturnBps)}% over the ${metrics.horizonLabel.replace(/^Past /, 'past ')}`);
                break;
            }
            // Percentile phrasing follows the user's horizon: a weekly checker
            // is told how this WEEK compares with its other weeks.
            case EventType.EXTREME_VOLATILITY:
                if (metrics.rarityBand === 'MAX') push(`Biggest ${bandWindow(metrics)} move of the past year (${move(metrics)})`);
                else if (metrics.rarityBand === 'P99') push(`Bigger than 99% of its ${metrics.rarityWindowLabel} moves this year (${move(metrics)})`);
                else push(`Well outside its normal daily range (${formatRatio(metrics.movementAnomaly)} on a robust z-scale)`);
                break;
            case EventType.VOLATILITY_SPIKE:
                if (metrics.rarityBand === 'P98') push(`Bigger than 98% of its ${metrics.rarityWindowLabel} moves this year (${move(metrics)})`);
                else if (metrics.rarityBand === 'P95') push(`Bigger than 95% of its ${metrics.rarityWindowLabel} moves this year (${move(metrics)})`);
                else push(`Well outside its normal daily range (${formatRatio(metrics.movementAnomaly)} on a robust z-scale)`);
                break;
            case EventType.IDIOSYNCRATIC_MOVE:
                if (metrics.residualMarketBps !== null) {
                    push(`Stock-specific: ${pct(metrics.residualMarketBps)}% ${upDown(metrics.residualMarketBps)} beyond what its usual sensitivity to Nifty explains`);
                }
                break;
            case EventType.GAP_UP:
            case EventType.GAP_DOWN:
                push(`Gapped ${upDown(metrics.gapBps)} ${pct(metrics.gapBps)}% at the open`); break;
            case EventType.EXTREME_VOLUME:
            case EventType.UNUSUAL_VOLUME:
                push(`Trading volume is ${formatRatio(metrics.volumeRatio)}× its recent average`); break;
            case EventType.SECTOR_DIVERGENCE:
                if (metrics.residualSectorBps !== null) {
                    push(`Diverging from ${context.sectorName || 'its sector'} by ${pct(metrics.residualSectorBps)}%`);
                }
                break;
            case EventType.NEW_52W_HIGH: push('Reached a new 52-week high'); break;
            case EventType.NEW_52W_LOW: push('Fell to a new 52-week low'); break;
            case EventType.NEW_30D_HIGH: push('Reached a new 30-day high'); break;
            case EventType.NEW_30D_LOW: push('Fell to a new 30-day low'); break;
            case EventType.NEW_7D_HIGH: push('Reached a new 7-day high'); break;
            case EventType.NEW_7D_LOW: push('Fell to a new 7-day low'); break;
            case EventType.VOL_REGIME_SHIFT:
                push(`Swinging ${formatRatio(metrics.volRegimeRatio)}× more than its 90-day norm lately`); break;
            case EventType.STREAK_UP:
            case EventType.STREAK_DOWN:
                push(`${Math.abs(metrics.streakDays)} straight sessions ${metrics.streakDays > 0 ? 'up' : 'down'}`); break;
            case EventType.DRAWDOWN_FROM_HIGH:
                if (metrics.drawdownFrom30dHighBps !== null) push(`${pct(metrics.drawdownFrom30dHighBps)}% below its 30-day high`); break;
            case EventType.RUNUP_FROM_LOW:
                if (metrics.runupFrom30dLowBps !== null) push(`${pct(metrics.runupFrom30dLowBps)}% above its 30-day low`); break;
            case EventType.LEVEL_SHIFT:
                push(`Its average daily move over the last week has shifted ${metrics.levelShiftZ > 0 ? 'up' : 'down'}`); break;
            case EventType.ACCUMULATION:
                push('Heavy volume without a price move'); break;
            case EventType.EX_DIVIDEND_TODAY:
                push(f.dividendAmountPaise ? `Ex-dividend today (₹${formatRupees(f.dividendAmountPaise)}/share) — the drop is mechanical` : 'Ex-dividend today — the drop is mechanical'); break;
            case EventType.EX_DIVIDEND_UPCOMING: {
                const d = f.exDividendDaysFromNow ?? 1;
                const amt = f.dividendAmountPaise ? ` (₹${formatRupees(f.dividendAmountPaise)}/share)` : '';
                push(d === 1 ? `Goes ex-dividend tomorrow${amt}` : `Goes ex-dividend in ${d} days${amt}`); break;
            }
            case EventType.MARKET_OUTPERFORMANCE:
                if (!hasResidual) push(`Outperforming the market by ${pct(metrics.relativeToBenchBps)}%`); break;
            case EventType.MARKET_UNDERPERFORMANCE:
                if (!hasResidual) push(`Underperforming the market by ${pct(metrics.relativeToBenchBps)}%`); break;
            case EventType.RECENT_ANNOUNCEMENT:
                if (f.recentAnnouncements[0]) push(`Filing: ${f.recentAnnouncements[0]}`); break;
        }
    }
    return reasons;
}

export type MovementConclusion = 
  | 'CORPORATE_ACTION'
  | 'STOCK_SPECIFIC'
  | 'SECTOR_DRIVEN'
  | 'MARKET_DRIVEN'
  | 'MIXED'
  | 'UNKNOWN';

export function deriveConclusion(events: EventType[], metrics: Metrics): string {
    if (events.includes(EventType.CORPORATE_ACTION_ADJUSTMENT) || events.includes(EventType.SUSPECTED_PRICE_ADJUSTMENT)) {
        return 'Corporate action affects the price interpretation.';
    }
    if (events.includes(EventType.IDIOSYNCRATIC_MOVE) || events.includes(EventType.RESULTS_JUST_OUT)) {
        return 'Mostly stock-specific.';
    }
    if (events.includes(EventType.SECTOR_DIVERGENCE) && metrics.residualSectorBps !== null && Math.abs(metrics.residualSectorBps) < 100) {
        // If it's not diverging much from the sector but moving a lot, it might be sector driven
        return 'Mostly sector-driven.';
    }
    if (!events.includes(EventType.IDIOSYNCRATIC_MOVE) && Math.abs(metrics.relativeToBenchBps) < 100 && Math.abs(metrics.todayChangeBps) > 100) {
        return 'Mostly market-driven.';
    }
    if (events.includes(EventType.LARGE_PRICE_MOVE) || events.includes(EventType.EXTREME_VOLATILITY)) {
        return 'Mixed drivers.';
    }
    return 'Unable to determine reliably from available data.';
}
