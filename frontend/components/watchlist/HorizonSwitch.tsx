"use client";

import type { Horizon } from '@/types/api';

const OPTIONS: { key: Horizon; short: string; title: string }[] = [
  { key: 'DAY', short: '1D', title: 'Compare today against this stock’s other days' },
  { key: 'WEEK', short: '1W', title: 'Compare the last 5 sessions against its other weeks' },
  { key: 'MONTH', short: '1M', title: 'Compare the last 20 sessions against its other months' },
];

/**
 * The lens. "Unusual" is meaningless without a window, and the right window is
 * how often you actually look — so the server defaults this to the user's own
 * visit cadence and this control overrides it. Changing it re-measures rarity
 * against the matching multi-session distribution, not just the displayed number.
 */
export function HorizonSwitch({
  value,
  onChange,
}: {
  value: Horizon;
  onChange: (h: Horizon) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1 rounded-md border border-line p-0.5">
        {OPTIONS.map(o => {
          const active = value === o.key;
          return (
            <button
              key={o.key}
              onClick={() => onChange(o.key)}
              title={o.title}
              className={`px-2 py-0.5 rounded text-[12px] transition-colors ${
                active ? 'bg-surface-2 text-ink font-medium' : 'text-ink-3 hover:text-ink-2'
              }`}
            >
              {o.short}
            </button>
          );
        })}
      </div>
    </div>
  );
}
