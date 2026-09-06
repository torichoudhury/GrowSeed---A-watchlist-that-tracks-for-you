"use client";

import type { WatchlistSummary, DigestItem } from '@/types/api';

function relativeTime(iso: string, nowMs: number): string {
  const diffMs = nowMs - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

const SIGNAL_LABEL: Record<string, string> = {
  BROAD_DECLINE: 'Broad decline across your list',
  BROAD_RALLY: 'Broad rally across your list',
  HIGH_ACTIVITY: 'Unusually active list',
};

/**
 * The product's thesis, in the first screen: when you last checked, how much
 * needs you since, and everything that actually changed — named, so the
 * answer is readable before any scrolling. Every stock needing attention is
 * listed here; the 3-item digest stays a digest.
 *
 * Deliberately not a card. It sits directly on the page the way a masthead
 * does; boxing it would make it one more panel among panels instead of the
 * thing the screen is about.
 */
export function SummaryHeader({
  summary,
  attentionCount,
  items,
  onMarkSeen,
  marking,
  onJump,
}: {
  summary: WatchlistSummary['summary'];
  attentionCount: number;
  items: DigestItem[];
  onMarkSeen: () => void;
  marking: boolean;
  onJump: (instrumentId: string) => void;
}) {
  const first = !summary.lastVisitAt;
  const digest = summary.digest;
  // The server's clock is authoritative (it may be replaying a past session),
  // and reading the browser's clock during render is impure anyway. Without
  // it, show the absolute moment rather than guess a relative one.
  const nowMs = summary.serverTime ? new Date(summary.serverTime).getTime() : null;
  const sinceLabel = summary.lastVisitAt === null ? ''
    : nowMs === null
      ? new Date(summary.lastVisitAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
      : relativeTime(summary.lastVisitAt, nowMs);

  return (
    <section className="pb-5 border-b border-line">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <p className="text-[12px] text-ink-3 flex items-center gap-2">
            {summary.demo && (
              <span className="font-semibold text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded text-[10px] tracking-wide">
                DEMO REPLAY &middot; Aug 31, 2026 &middot; 10:00 AM IST
              </span>
            )}
            <span>
              {first
                ? 'First visit — your baseline is being set now'
                : `Since you last checked · ${sinceLabel}`}
              {summary.horizon !== 'DAY' && (
                <span> · judged over the {summary.horizonLabel.replace(/^Past /, 'past ')}</span>
              )}
            </span>
          </p>
          <h2 className="text-[21px] sm:text-[24px] font-semibold text-ink mt-1 leading-tight tracking-[-0.02em]">
            {attentionCount === 0
              ? 'Nothing needs your attention'
              : `${attentionCount} ${attentionCount === 1 ? 'stock needs' : 'stocks need'} your attention`}
          </h2>
        </div>
        {!first && (
          <button
            onClick={onMarkSeen}
            disabled={marking}
            className="shrink-0 text-[13px] font-medium text-ink-3 hover:text-ink disabled:opacity-50 transition-colors"
            title="Reset your baseline to right now"
          >
            {marking ? 'Marking…' : 'Mark all as seen'}
          </button>
        )}
      </div>

      {/* Everything that needs you — not a 3-item digest. */}
      {digest.quiet && <p className="mt-3 text-[13px] text-ink-2">{digest.headline}</p>}
      {items.length > 0 && (
        <ul className={`space-y-1 ${digest.quiet ? 'mt-2' : 'mt-3'}`}>
          {items.map(item => (
            <li key={item.instrumentId}>
              <button
                onClick={() => onJump(item.instrumentId)}
                className="group text-left flex items-baseline gap-2 text-[13.5px] hover:text-ink transition-colors"
              >
                <span className="font-medium text-ink w-[92px] shrink-0 group-hover:text-primary-dark transition-colors">
                  {item.symbol}
                </span>
                <span className="text-ink-2 min-w-0">{item.line}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-ink-3">
        <span className="tabular-nums">
          <span className="text-gain">{summary.gainers} up</span>
          {' · '}
          <span className="text-loss">{summary.losers} down</span>
          {' · '}
          {summary.totalStocks} tracked
        </span>
        {summary.watchlistSignals.map(s => (
          <span key={s}>· {SIGNAL_LABEL[s] ?? s}</span>
        ))}
        {summary.horizonAuto && summary.daysSinceLastVisit !== null && summary.daysSinceLastVisit >= 4 && (
          <span>· away {summary.daysSinceLastVisit} days, showing the {summary.horizonLabel.replace(/^Past /, '')} view</span>
        )}
      </div>
    </section>
  );
}
