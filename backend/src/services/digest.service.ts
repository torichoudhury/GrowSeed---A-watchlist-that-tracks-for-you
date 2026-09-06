import { SEVERITY_BANDS } from '../config/thresholds';

/**
 * The one-sentence answer to "what changed since I last looked?".
 *
 * Everything else in this product ranks a list; the digest exists so the user
 * doesn't have to read one. It names at most three stocks and why, drawn from
 * the same server-computed reasons the rows show — never a new judgement, and
 * never an LLM: if a sentence appears here, the row below it says the same
 * thing with the numbers attached.
 */

export interface DigestStock {
    instrumentId: string;
    symbol: string;
    name: string | null;
    attention: { score: number; severity: string };
    change: { todayBps: number; horizonBps?: number | null; sinceLastVisitBps?: number };
    reasons: string[];
}

export interface DigestItem {
    instrumentId: string;
    symbol: string;
    name: string | null;
    score: number;
    severity: string;
    line: string;
}

export interface Digest {
    /** Ready-to-render sentence, e.g. "TCS down 5.1% since you last checked · …" */
    headline: string;
    items: DigestItem[];
    /** True when nothing crossed the LOW band — the list is genuinely calm. */
    quiet: boolean;
}

const LOW_BAND = SEVERITY_BANDS.find(b => b.label === 'LOW')?.min ?? 21;
const MOVE_SINCE_VISIT_BPS = 300;   // 3% since your baseline is worth naming regardless of band
const QUIET_MOVER_BPS = 300;        // on a calm list, still name moves this big over the window
const MAX_ITEMS = 3;
const MAX_CLAUSE_CHARS = 76;

/** Lower-case the first word so a reason reads inside a sentence, unless it
 * is a symbol, a number or an acronym ("Q2", "₹12", "NSE"). */
function asClause(reason: string): string {
    const clause = /^[A-Z][a-z]/.test(reason) ? reason.charAt(0).toLowerCase() + reason.slice(1) : reason;
    if (clause.length <= MAX_CLAUSE_CHARS) return clause;
    const cut = clause.slice(0, MAX_CLAUSE_CHARS);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).replace(/[,;:·]$/, '')}…`;
}

function fallbackLine(s: DigestStock): string {
    const since = s.change.sinceLastVisitBps;
    const bps = since !== undefined && Math.abs(since) >= Math.abs(s.change.todayBps) ? since : s.change.todayBps;
    const dir = bps >= 0 ? 'up' : 'down';
    const suffix = bps === since ? ' since you last checked' : ' today';
    return `${dir} ${(Math.abs(bps) / 100).toFixed(2)}%${suffix}`;
}

export function buildDigest(
    stocks: DigestStock[],
    context: { gainers: number; losers: number; windowLabel: string; signals: string[] }
): Digest {
    const ranked = [...stocks]
        .filter(s => s.attention.score >= LOW_BAND || Math.abs(s.change.sinceLastVisitBps ?? 0) >= MOVE_SINCE_VISIT_BPS)
        .sort((a, b) => b.attention.score - a.attention.score)
        .slice(0, MAX_ITEMS);

    const items: DigestItem[] = ranked.map(s => ({
        instrumentId: s.instrumentId,
        symbol: s.symbol,
        name: s.name,
        score: s.attention.score,
        severity: s.attention.severity,
        line: asClause(s.reasons[0] ?? fallbackLine(s)),
    }));

    if (items.length === 0) {
        const breadth = `${context.gainers} up, ${context.losers} down`;
        const calm = `Nothing unusual — ${breadth}, every stock inside its usual ${context.windowLabel} range.`;

        // "Nothing changed" is the wrong thing to say to someone who has been
        // away a month and whose list is down 7%: statistically ordinary is
        // not the same as nothing. Name the biggest movers over their own
        // window, framed as ordinary.
        const movers = [...stocks]
            .filter(s => Math.abs(s.change.horizonBps ?? s.change.todayBps) >= QUIET_MOVER_BPS)
            .sort((a, b) => Math.abs(b.change.horizonBps ?? b.change.todayBps) - Math.abs(a.change.horizonBps ?? a.change.todayBps))
            .slice(0, 2)
            .map(s => ({
                instrumentId: s.instrumentId, symbol: s.symbol, name: s.name,
                score: s.attention.score, severity: s.attention.severity,
                line: asClause(s.reasons[0] ?? fallbackLine(s)),
            }));

        return { headline: calm, items: movers, quiet: true };
    }

    // A move the whole list made is context for all three clauses, so it is
    // stated once at the front rather than repeated per stock.
    const prefix = context.signals.includes('BROAD_DECLINE')
        ? 'Broad decline across your list. '
        : context.signals.includes('BROAD_RALLY')
            ? 'Broad rally across your list. '
            : '';

    return {
        headline: prefix + items.map(i => `${i.symbol} ${i.line}`).join(' · '),
        items,
        quiet: false,
    };
}
