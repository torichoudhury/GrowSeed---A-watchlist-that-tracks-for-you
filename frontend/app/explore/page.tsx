"use client";

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { qk } from '@/lib/query-keys';
import { api } from '@/lib/api-client';
import { formatRupees, formatPct } from '@/lib/format';
import { useRequireAuth } from '@/lib/use-auth';
import type { ExploreResponse, ExploreResult } from '@/types/api';

// Explore categories — description is shown to the user
const CATEGORIES: { key: string; label: string; description: string }[] = [
  { key: 'meaningful', label: 'Meaningful', description: 'Ranked by attention score — what actually changed, not just raw price' },
  { key: 'gainers',   label: 'Gainers',    description: 'Highest price gains today' },
  { key: 'losers',    label: 'Losers',     description: 'Largest price declines today' },
  { key: 'volume',    label: 'Volume',     description: 'Highest trading volume today' },
  { key: 'sector',    label: 'By sector',  description: 'Grouped by sector, sorted by attention within each sector' },
];

const SEVERITY_DOT: Record<string, string> = {
  CRITICAL: 'bg-red-500',
  HIGH: 'bg-orange-400',
  MEDIUM: 'bg-yellow-400',
  LOW: 'bg-ink-3/40',
  QUIET: 'bg-ink-3/20',
};

function Change({ bps }: { bps: number }) {
  if (bps === 0) return <span className="text-ink-3 tabular-nums text-[13px]">0.00%</span>;
  const up = bps > 0;
  return (
    <span className={`tabular-nums text-[13px] font-medium ${up ? 'text-gain' : 'text-loss'}`}>
      {up ? '+' : '−'}{formatPct(Math.abs(bps))}
    </span>
  );
}

function ExploreRow({ result, onClick }: { result: ExploreResult; onClick: () => void }) {
  return (
    <li
      className="flex items-center gap-3 px-4 py-3 border-b border-line last:border-b-0 hover:bg-surface-2/50 cursor-pointer transition-colors"
      onClick={onClick}
    >
      <span className={`shrink-0 h-2 w-2 rounded-full ${SEVERITY_DOT[result.severity] ?? 'bg-ink-3/20'}`} title={result.severity.toLowerCase()} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5 min-w-0">
          <span className="text-[13.5px] font-medium text-ink">{result.name ?? result.symbol}</span>
          <span className="text-[11px] text-ink-3 shrink-0">{result.symbol}</span>
        </span>
        {result.sectorName && (
          <span className="block text-[11px] text-ink-3">{result.sectorName}</span>
        )}
      </span>
      <span className="shrink-0 text-right">
        <span className="block text-[13px] font-semibold tabular-nums text-ink">{formatRupees(result.pricePaise)}</span>
        <Change bps={result.todayChangeBps} />
      </span>
      <span
        className="shrink-0 text-right hidden sm:block"
        title="Attention score — meaningful-ness of the change"
      >
        <span className={`text-[13px] tabular-nums ${result.attentionScore >= 41 ? 'text-ink font-medium' : 'text-ink-3'}`}>
          {result.attentionScore}
        </span>
      </span>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-ink-3 shrink-0">
        <path d="m9 18 6-6-6-6"/>
      </svg>
    </li>
  );
}

export default function ExplorePage() {
  const { ready, isAuthenticated } = useRequireAuth();
  const router = useRouter();
  const [category, setCategory] = useState('meaningful');

  const { data, isLoading } = useQuery<ExploreResponse>({
    queryKey: qk.explore(category),
    queryFn: () => api.get(`/api/explore?category=${category}`),
    enabled: isAuthenticated,
    staleTime: 30_000,
  });

  if (!ready || !isAuthenticated) {
    return <div className="min-h-screen flex items-center justify-center text-ink-3 text-sm">Loading…</div>;
  }

  const activeCat = CATEGORIES.find(c => c.key === category)!;

  // Group by sector for the 'sector' category
  const grouped = category === 'sector' && data
    ? data.results.reduce((acc: Record<string, ExploreResult[]>, r) => {
        const k = r.sectorName ?? 'Other';
        (acc[k] ??= []).push(r);
        return acc;
      }, {})
    : null;

  return (
    <div className="min-h-screen bg-background">
      {/* Nav */}
      <nav className="sticky top-0 z-30 border-b border-line bg-background/90 backdrop-blur h-14 flex items-center px-4 lg:px-6 gap-4">
        <button
          onClick={() => router.back()}
          className="text-ink-3 hover:text-ink text-sm flex items-center gap-1 shrink-0"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6"/></svg>
          Back
        </button>
        <h1 className="text-[15px] font-semibold text-ink">Explore</h1>
      </nav>

      <main className="mx-auto max-w-3xl px-4 lg:px-6 py-6 space-y-5">
        {/* Category tabs */}
        <div className="flex gap-1 overflow-x-auto pb-0.5">
          {CATEGORIES.map(cat => (
            <button
              key={cat.key}
              onClick={() => setCategory(cat.key)}
              className={`shrink-0 text-[12px] px-3 py-1.5 rounded-full transition-colors font-medium ${
                category === cat.key
                  ? 'bg-primary text-white'
                  : 'text-ink-3 hover:text-ink hover:bg-surface-2'
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>

        {/* Description */}
        <p className="text-[12px] text-ink-3">{activeCat.description}</p>

        {/* Results */}
        <section className="rounded-xl border border-line bg-surface overflow-hidden">
          {/* Column header */}
          <div className="hidden sm:grid px-4 py-2 border-b border-line text-[11px] text-ink-3"
            style={{ gridTemplateColumns: '16px 1fr auto auto auto' }}
          >
            <span />
            <span>Stock</span>
            <span className="text-right">Price · Today</span>
            <span className="text-right">Attention</span>
            <span />
          </div>

          {isLoading && (
            <ul>
              {Array.from({ length: 10 }).map((_, i) => (
                <li key={i} className="px-4 py-3 border-b border-line flex justify-between animate-pulse">
                  <div className="space-y-2">
                    <div className="h-3.5 w-36 bg-surface-2 rounded" />
                    <div className="h-3 w-20 bg-surface-2 rounded" />
                  </div>
                  <div className="space-y-2">
                    <div className="h-3.5 w-16 bg-surface-2 rounded ml-auto" />
                    <div className="h-3 w-12 bg-surface-2 rounded ml-auto" />
                  </div>
                </li>
              ))}
            </ul>
          )}

          {!isLoading && grouped && Object.entries(grouped).map(([sector, rows]) => (
            <div key={sector}>
              <div className="px-4 pt-3 pb-1.5">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">{sector}</span>
              </div>
              <ul>
                {rows.map(r => (
                  <ExploreRow
                    key={r.instrumentId}
                    result={r}
                    onClick={() => router.push(`/stocks/${encodeURIComponent(r.instrumentId)}`)}
                  />
                ))}
              </ul>
            </div>
          ))}

          {!isLoading && !grouped && data && (
            <ul>
              {data.results.map(r => (
                <ExploreRow
                  key={r.instrumentId}
                  result={r}
                  onClick={() => router.push(`/stocks/${encodeURIComponent(r.instrumentId)}`)}
                />
              ))}
              {data.results.length === 0 && (
                <li className="px-4 py-12 text-center text-[13px] text-ink-3">No results.</li>
              )}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
