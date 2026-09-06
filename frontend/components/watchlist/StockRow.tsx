"use client";

import type { WatchlistStock } from '@/types/api';
import { formatRupees, formatPct } from '@/lib/format';

// Attention reads as intensity: a full-strength accent rule for the loudest
// band, fading into the hairline. Green and red stay reserved for direction,
// so nothing on the row competes with the numbers.
const SEVERITY_RULE: Record<string, string> = {
  CRITICAL: 'bg-primary',
  HIGH: 'bg-primary/55',
  MEDIUM: 'bg-line-strong',
};

const SEVERITY_SCORE: Record<string, string> = {
  CRITICAL: 'text-ink font-semibold',
  HIGH: 'text-ink font-medium',
  MEDIUM: 'text-ink-2',
  LOW: 'text-ink-3',
  QUIET: 'text-ink-3',
};

function Change({ bps, size = 'sm' }: { bps: number | null | undefined; size?: 'sm' | 'md' }) {
  if (bps === null || bps === undefined) return <span className="text-ink-3">—</span>;
  const cls = size === 'md' ? 'text-[13px] font-medium' : 'text-[12px]';
  // Exactly flat is not a gain. Painting "+0.00%" green on every row is the
  // fastest way to make a colour scale mean nothing.
  if (bps === 0) return <span className={`tabular-nums text-ink-3 ${cls}`}>0.00%</span>;
  const up = bps > 0;
  return (
    <span className={`tabular-nums ${up ? 'text-gain' : 'text-loss'} ${cls}`}>
      {up ? '+' : '−'}{formatPct(Math.abs(bps))}
    </span>
  );
}

/**
 * One stock row — name and the single strongest reason on the left, numbers
 * right-aligned. Clicking the row toggles the expanded reasons panel; the
 * Remove button is a separate control that DOES NOT navigate (rule 5).
 *
 * Expansion is owned by the parent (`open`/`onToggle`): the digest's
 * "jump to stock" needs to open a specific row, which internal state could
 * not honour — the parent would say `openId = HAVELLS` while the row sat
 * collapsed.
 *
 * Columns driven by `.row-grid` in globals.css so this row and the header
 * stay locked together, and collapse to name + numbers on a phone.
 */
export function StockRow({
  stock,
  onRemove,
  firstVisit = false,
  showHorizon = false,
  horizonShort = '1D',
  highlighted = false,
  open = false,
  onToggle,
}: {
  stock: WatchlistStock;
  onRemove: () => void;
  firstVisit?: boolean;
  showHorizon?: boolean;
  horizonShort?: string;
  highlighted?: boolean;
  /** Whether this row's detail panel is expanded (parent-owned state). */
  open?: boolean;
  /** Called when the row header is clicked — the parent flips its `open` id. */
  onToggle?: () => void;
}) {
  const missing = stock.dataQuality.status === 'DATA_MISSING' || stock.dataQuality.status === 'PROVIDER_DOWN';
  const sinceVisit = stock.change.sinceLastVisitBps;
  const hasBaseline = !stock.isInitialState && sinceVisit !== undefined;
  const accent = SEVERITY_RULE[stock.attention.severity];
  const topReason = stock.reasons[0];
  const primaryBps = hasBaseline ? sinceVisit! : (showHorizon ? stock.change.horizonBps ?? stock.change.todayBps : stock.change.todayBps);

  function handleRowClick() {
    onToggle?.();
  }

  return (
    <li
      id={`row-${stock.instrumentId}`}
      className={`relative border-b border-line last:border-b-0 scroll-mt-24 transition-colors ${
        highlighted ? 'bg-primary/5' : ''
      }`}
    >
      {accent && <span className={`absolute left-0 top-0 bottom-0 w-[2px] ${accent}`} aria-hidden />}
      {/* Row is now a div (not a button) — navigation happens on click, Remove is its own button */}
      <div
        onClick={handleRowClick}
        className={`row-grid w-full text-left px-4 py-2.5 hover:bg-surface-2/60 transition-colors cursor-pointer ${showHorizon ? 'with-horizon' : ''}`}
        role="button"
        aria-expanded={open}
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !(e.target as HTMLElement).closest('[data-remove-btn]')) {
            e.preventDefault();
            handleRowClick();
          }
        }}
        aria-label={`${stock.name ?? stock.symbol} — ${open ? 'collapse' : 'expand'} details`}
      >
        {/* Name + why */}
        <span className="min-w-0 block">
          <span className="flex items-baseline gap-2 min-w-0">
            <span className="text-[13.5px] font-medium text-ink">{stock.name ?? stock.symbol}</span>
            <span className="text-[11px] text-ink-3 shrink-0 tracking-wide">{stock.symbol}</span>
            {stock.instrumentStatus !== 'ACTIVE' && (
              <span className="text-[10px] uppercase tracking-wide text-ink-3 border border-line rounded px-1 shrink-0">Not trading</span>
            )}
          </span>
          {/* The row headline shows the single strongest reason, but a full filing
              is noise on a collapsed row — it belongs to the expanded "Why it
              matters" panel below (and the stock page). So filing rows fall
              back to the same idle state as every other quiet row. */}
          <span className="block text-[12px] text-ink-3 mt-px truncate">
            {topReason && !missing && !topReason.startsWith('Filing:')
              ? topReason
              : stock.isInitialState && !missing && !firstVisit
                ? 'Added — tracking from now'
                : stock.instrumentId.split(':')[0]}
          </span>
        </span>

        {/* Phone: price stacked with the change that matters */}
        <span className="lg:hidden text-right shrink-0">
          {missing ? (
            <span className="text-[13px] text-ink-3">No data</span>
          ) : (
            <>
              <span className="block text-[14px] font-semibold tabular-nums text-ink">{formatRupees(stock.pricePaise)}</span>
              <span className="block">
                <Change bps={primaryBps} size="md" />
                <span className="text-[11px] text-ink-3"> {hasBaseline ? 'since visit' : showHorizon ? horizonShort : 'today'}</span>
              </span>
              {/* With a baseline the headline is "since you looked", but the
                  day's own move is still the number people scan for. */}
              {hasBaseline && (
                <span className="block">
                  <Change bps={showHorizon ? stock.change.horizonBps : stock.change.todayBps} />
                  <span className="text-[11px] text-ink-3"> {showHorizon ? horizonShort : 'today'}</span>
                </span>
              )}
            </>
          )}
        </span>

        {/* Desktop columns */}
        <span className="hidden lg:block text-right text-[14px] font-semibold tabular-nums text-ink">
          {missing ? <span className="text-ink-3 font-normal text-[13px]">No data</span> : formatRupees(stock.pricePaise)}
        </span>
        <span className="hidden lg:block text-right">
          {missing ? <span className="text-ink-3">—</span> : <Change bps={stock.change.todayBps} size="md" />}
        </span>
        {showHorizon && (
          <span className="hidden lg:block text-right">
            {missing ? <span className="text-ink-3">—</span> : <Change bps={stock.change.horizonBps} size="md" />}
          </span>
        )}
        <span
          className="hidden lg:block text-right"
          title={hasBaseline && stock.change.daysSinceLastVisit ? `over ${stock.change.daysSinceLastVisit} days` : undefined}
        >
          {hasBaseline ? (
            <>
              <Change bps={sinceVisit!} size="md" />
            </>
          ) : (
            <span className="text-[11px] text-ink-3">baseline set</span>
          )}
        </span>
        <span className="hidden lg:flex items-center justify-end gap-2">
          <span
            className={`text-[13px] tabular-nums ${SEVERITY_SCORE[stock.attention.severity] ?? 'text-ink-3'}`}
            title={`${stock.attention.severity.toLowerCase()} — attention score ${stock.attention.score}/100`}
          >
            {stock.attention.score}
          </span>
          {/* Remove is a separate control — never triggers navigation (rule 5) */}
          <button
            data-remove-btn
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            className="text-[11px] text-loss hover:underline shrink-0 px-1"
            title="Remove from watchlist"
          >
            ✕
          </button>
          <svg
            width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            className="text-ink-3 shrink-0"
          >
            <path d="m9 18 6-6-6-6" />
          </svg>
        </span>
      </div>

      {open && !missing && (
        <div className="px-4 py-4 bg-surface-2/40 border-t border-line text-[13px] flex flex-col gap-4">
          <div className="flex flex-col sm:flex-row justify-between items-start gap-4">
            <div className="space-y-1">
              <span className={`text-[11px] font-bold tracking-wider uppercase ${SEVERITY_SCORE[stock.attention.severity] || 'text-ink-3'}`}>
                {stock.attention.severity === 'QUIET' ? 'NO UNUSUAL ACTIVITY' : `${stock.attention.severity} ATTENTION`}
              </span>
              <div className="text-ink-2 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium text-ink"><Change bps={stock.change.todayBps} /> today</span>
                {hasBaseline && (
                  <>
                    <span className="text-ink-3 hidden sm:inline">·</span>
                    <span className="font-medium text-ink"><Change bps={sinceVisit} /> since you last checked</span>
                  </>
                )}
              </div>
            </div>
            
            <a
              href={`/stocks/${encodeURIComponent(stock.instrumentId)}`}
              target="_blank"
              rel="noopener noreferrer"
              data-link-btn
              onClick={(event) => event.stopPropagation()}
              className="shrink-0 inline-flex items-center gap-1.5 text-[12px] font-medium text-primary-dark hover:text-primary hover:underline border border-line bg-surface rounded-full px-3 py-1.5 transition-colors shadow-sm"
            >
              View full details
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </a>
          </div>
          
          <div className="space-y-1.5">
            <h4 className="text-[10px] font-bold uppercase tracking-wider text-ink-3">Why it matters</h4>
            <ul className="space-y-1.5 text-ink-2">
              {stock.reasons.slice(0, 4).map((r, i) => (
                <li key={i} className="flex gap-2.5 items-start">
                  <span className="text-ink-3/50 select-none mt-[2px] text-[10px]">●</span>
                  <span className="leading-snug">{r}</span>
                </li>
              ))}
            </ul>
          </div>

          {stock.conclusion && (
            <div className="pt-2 border-t border-line/50 text-[12px] font-medium text-ink">
              {stock.conclusion}
            </div>
          )}
        </div>
      )}

      {/* Data quality footer — visible on mobile, collapsed on desktop since those details move to stock page */}
      {missing && (
        <div className="px-4 pb-2 text-[11px] text-ink-3">
          Live data unavailable — check back later
        </div>
      )}
    </li>
  );
}
