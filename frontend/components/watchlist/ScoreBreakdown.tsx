import type { ScoreBreakdown as Breakdown } from '@/types/api';

const ROWS: { key: keyof Breakdown; label: string; cap: number; group: string }[] = [
  { key: 'price', label: 'Price move', cap: 20, group: 'Time-series' },
  { key: 'volume', label: 'Volume', cap: 12, group: 'Time-series' },
  { key: 'volatility', label: 'Volatility', cap: 10, group: 'Time-series' },
  { key: 'milestone', label: 'Milestones & path', cap: 8, group: 'Time-series' },
  { key: 'marketRelative', label: 'vs market (β-adjusted)', cap: 15, group: 'External' },
  { key: 'sectorRelative', label: 'vs sector', cap: 10, group: 'External' },
  { key: 'fundamentals', label: 'Company events', cap: 20, group: 'Internal' },
  { key: 'user', label: 'Your alerts', cap: 5, group: 'You' },
];

/** How the score was built — every number server-computed. */
export function ScoreBreakdown({ breakdown, score }: { breakdown: Breakdown; score: number }) {
  const dampeners: string[] = [];
  if (breakdown.correlationDiscount < 1) dampeners.push(`correlated signals ×${breakdown.correlationDiscount}`);
  if (breakdown.regimeDampen < 1) dampeners.push(`volatile market ×${breakdown.regimeDampen}`);
  if (breakdown.breadthDampen < 1) dampeners.push(`whole list moved ×${breakdown.breadthDampen}`);
  if (breakdown.freshnessPenalty < 1) dampeners.push(`stale data ×${breakdown.freshnessPenalty}`);

  // Group headers computed up front — deriving them by mutating a variable
  // during the map makes the render depend on the order React happens to run it.
  const rows = ROWS.map((r, i) => ({ ...r, header: i === 0 || ROWS[i - 1].group !== r.group ? r.group : null }));

  return (
    <div className="text-[12px] text-ink-2 space-y-1">
      {breakdown.mechanical && (
        <p className="text-[11px] text-ink-3 border-l-2 border-line pl-2 py-0.5 mb-2">
          A split or bonus re-scaled the price, so every price, volume and relative
          number scored zero — only the company calendar and your own alerts counted.
        </p>
      )}
      {rows.map(({ header, ...r }) => {
        const v = breakdown[r.key] as number;
        return (
          <div key={r.key}>
            {header && <div className="text-[10px] uppercase tracking-wide text-ink-3 mt-2 mb-1">{header}</div>}
            <div className="flex items-center gap-3">
              <span className="w-40 shrink-0">{r.label}</span>
              <div className="flex-1 h-px bg-line relative">
                <div
                  className={`absolute inset-y-0 left-0 h-px ${v > 0 ? 'bg-primary' : ''}`}
                  style={{ width: `${Math.min(100, (v / r.cap) * 100)}%` }}
                />
              </div>
              <span className="w-10 text-right tabular-nums text-ink-3">{v}/{r.cap}</span>
            </div>
          </div>
        );
      })}
      <div className="pt-2 mt-1 border-t border-line flex justify-between tabular-nums">
        <span className="text-ink-3">{dampeners.length ? `Dampened: ${dampeners.join(', ')}` : 'No dampeners applied'}</span>
        <span className="text-ink font-medium">raw {breakdown.rawScore ?? '–'} → {score}</span>
      </div>
    </div>
  );
}
