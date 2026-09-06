"use client";

import Link from 'next/link';
import type { Watchlist } from '@/types/api';

/** Groww-style pill tabs across the user's watchlists, plus a "+" to create.
 * Border-free so it can sit inside the list panel's own header. */
export function WatchlistTabs({ watchlists, activeId, onCreate }: { watchlists: Watchlist[]; activeId: string; onCreate: () => void }) {
  return (
    <div className="flex items-center gap-4 overflow-x-auto no-scrollbar -mb-2.5">
      {watchlists.map(w => {
        const active = w.id === activeId;
        return (
          <Link
            key={w.id}
            href={`/watchlists/${w.id}`}
            className={`shrink-0 text-[13px] pb-2.5 border-b-2 transition-colors ${
              active ? 'text-ink font-medium border-primary' : 'text-ink-3 border-transparent hover:text-ink-2'
            }`}
          >
            {w.name}
            <span className="ml-1.5 tabular-nums text-ink-3">{w.stockCount}</span>
          </Link>
        );
      })}
      <button
        onClick={onCreate}
        className="shrink-0 pb-2.5 text-[13px] text-ink-3 hover:text-ink transition-colors"
        aria-label="New watchlist"
        title="New watchlist"
      >
        +
      </button>
    </div>
  );
}
