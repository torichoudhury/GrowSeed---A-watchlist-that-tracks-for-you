"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '@/lib/query-keys';
import { api, ApiError, getToken, clearSession } from '@/lib/api-client';
import { useStoredValue, writeStored } from '@/lib/browser-store';
import { formatPct } from '@/lib/format';
import { useRequireAuth } from '@/lib/use-auth';
import { WSClient, type TickMessage } from '@/lib/ws-client';
import { SummaryHeader } from '@/components/watchlist/SummaryHeader';
import { WatchlistTabs } from '@/components/watchlist/WatchlistTabs';
import { StockRow } from '@/components/watchlist/StockRow';
import { HorizonSwitch } from '@/components/watchlist/HorizonSwitch';
import { MarketRail } from '@/components/watchlist/MarketRail';
import { IndicatorsPanel } from '@/components/watchlist/IndicatorsPanel';
import { FactorsPanel } from '@/components/watchlist/FactorsPanel';
import { ThemeToggle } from '@/components/watchlist/ThemeToggle';
import type { WatchlistSummary, WatchlistStock, Watchlist, InstrumentRef, Horizon, DigestItem } from '@/types/api';

// "Needs attention" = the server's MEDIUM band or above, or a large move
// since the user's own baseline. The threshold is the spec's band floor, not
// a client-side judgement about the stock (BUILD_SPEC §14 acceptance #19).
const needsAttention = (s: WatchlistStock) =>
  s.attention.score >= 41 || Math.abs(s.change.sinceLastVisitBps ?? 0) >= 500;

const HORIZON_SHORT: Record<Horizon, string> = { DAY: '1D', WEEK: '1W', MONTH: '1M' };

/** Empty disables live ticks (see the effect below). Local dev defaults to the
 * backend on :8080; a deployment must opt in by setting the variable. */
const WS_URL = process.env.NEXT_PUBLIC_WS_URL
  ?? (process.env.NODE_ENV === 'production' ? '' : 'ws://localhost:8080/ws');
type HorizonPref = Horizon | 'AUTO';

function isHorizonPref(v: string): v is HorizonPref {
  return v === 'AUTO' || v === 'DAY' || v === 'WEEK' || v === 'MONTH';
}

function SearchAdd({ watchlistId, onAdded }: { watchlistId: string; onAdded: () => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ query: string; items: InstrumentRef[] }>({ query: '', items: [] });

  const trimmed = q.trim();
  const canSearch = trimmed.length >= 2;

  // The effect only fetches; whether the dropdown is open is DERIVED from the
  // query and the results, so nothing has to be reset synchronously here.
  useEffect(() => {
    if (!canSearch) return;
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const items = await api.get(`/api/instruments/search?q=${encodeURIComponent(trimmed)}`);
        if (!cancelled) setResults({ query: trimmed, items });
      } catch {
        if (!cancelled) setResults({ query: trimmed, items: [] });
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [trimmed, canSearch]);

  // Results from an older keystroke are never shown as if they matched this one.
  const open = canSearch && results.query === trimmed && results.items.length > 0;

  async function add(instrumentId: string) {
    await api.post(`/api/watchlists/${watchlistId}/stocks`, { instrumentId });
    setQ('');
    onAdded();
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-2.5 border-b border-line pb-2 focus-within:border-ink-3 transition-colors">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-ink-3 shrink-0"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Add a stock"
          className="flex-1 min-w-0 bg-transparent text-[13px] text-ink placeholder:text-ink-3 focus:outline-none"
        />
      </div>
      {open && (
        <ul className="absolute z-20 left-0 right-0 mt-1 bg-surface border border-line rounded-lg shadow-lg max-h-72 overflow-y-auto thin-scroll">
          {results.items.map(r => (
            <li key={r.instrumentId}>
              <button onClick={() => add(r.instrumentId)} className="w-full text-left px-3 py-2.5 hover:bg-surface-2 flex items-center justify-between gap-3">
                <span className="min-w-0">
                  <span className="block text-[13px] text-ink font-medium">{r.name}</span>
                  <span className="block text-[11px] text-ink-3">{r.symbol} · {r.exchange}</span>
                </span>
                <span className="text-primary-dark text-[12px] font-semibold shrink-0">Add</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function WatchlistDashboard() {
  const { ready, isAuthenticated } = useRequireAuth();
  const params = useParams();
  const router = useRouter();
  const watchlistId = params.id as string;
  const queryClient = useQueryClient();
  const acknowledged = useRef(false);
  const [marking, setMarking] = useState(false);
  const [resetting, setResetting] = useState(false);
  // Feed health is now internal only — the header no longer sings "Live".
  const live = useRef(false);
  const [filter, setFilter] = useState<'attention' | 'all'>('all');
  const [highlightId, setHighlightId] = useState<string | null>(null);
  // Parent-owned expansion state: the digest's jumpTo() must be able to open
  // a specific row, which row-local state could not honour (§33-34 of the plan).
  const [openId, setOpenId] = useState<string | null>(null);
  // 'AUTO' lets the server pick from the user's visit cadence; an explicit
  // choice sticks per browser (read as an external store, not copied into
  // state inside an effect — lib/browser-store.ts).
  const horizonPref = useStoredValue<HorizonPref>('horizon', 'AUTO', isHorizonPref);
  const setHorizon = useCallback((h: HorizonPref) => writeStored('horizon', h), []);

  const { data: watchlists } = useQuery<Watchlist[]>({
    queryKey: qk.watchlists,
    queryFn: () => api.get('/api/watchlists'),
    enabled: isAuthenticated,
  });

  // Memoised: `qk.summary()` builds a new array every call, and this key is
  // read by the tick effect below. An unmemoised key there re-ran the effect
  // on EVERY render, tearing down and rebuilding the WebSocket each time —
  // which is why the header sat on "Polling" and the server saw a storm of
  // connection setups.
  const summaryKey = useMemo(() => qk.summary(watchlistId, horizonPref), [watchlistId, horizonPref]);
  const summaryKeyRef = useRef(summaryKey);
  useEffect(() => { summaryKeyRef.current = summaryKey; }, [summaryKey]);

  const { data, isLoading, isError, error } = useQuery<WatchlistSummary>({
    queryKey: summaryKey,
    queryFn: () => api.get(`/api/watchlists/${watchlistId}/summary?horizon=${horizonPref}`),
    enabled: isAuthenticated && !!watchlistId,
    staleTime: 25_000,
    // Outside the session the price cannot change: polling every 30s only
    // burns the provider's goodwill (and its rate limit).
    refetchInterval: q => (q.state.data?.stocks?.[0]?.dataQuality.status === 'CLOSED' ? 300_000 : 30_000),
    refetchOnWindowFocus: true,
  });

  const ackItems = (stocks: WatchlistStock[]) =>
    stocks.filter(s => s.dataQuality.dataTimestamp).map(s => ({
      instrumentId: s.instrumentId, pricePaise: s.pricePaise, volume: s.volume.current, dataTimestamp: s.dataQuality.dataTimestamp,
    }));

  async function markAllSeen() {
    if (!data) return;
    setMarking(true);
    try {
      await api.post(`/api/watchlists/${watchlistId}/acknowledge`, { items: ackItems(data.stocks) });
      acknowledged.current = true;
      queryClient.invalidateQueries({ queryKey: ['watchlist', watchlistId, 'summary'] });
    } catch (e) {
      // One bad item (e.g. a timestamp the server rejects) used to crash the
      // page via an unhandled rejection; surface it quietly instead.
      console.error('Mark all as seen failed:', e);
    } finally {
      setMarking(false);
    }
  }



  // BUILD_SPEC §14.4 — live ticks patch price in place; scores stay server-side.
  // Skipped entirely when no socket URL is configured: on a host that scales to
  // zero nothing publishes ticks, so opening a socket would show "Live" while
  // the prices actually came from the 30s poll. Better to say "Polling".
  useEffect(() => {
    if (!isAuthenticated || !WS_URL) return;
    const client = new WSClient(WS_URL, getToken);
    client.onStatus = (v) => { live.current = v; };
    client.onTick = (t: TickMessage) => {
      // Read through the ref: one socket serves whichever list/horizon is on
      // screen, so switching either must not reconnect.
      queryClient.setQueryData<WatchlistSummary>(summaryKeyRef.current, old => {
        if (!old) return old;
        return {
          ...old,
          stocks: old.stocks.map(s => s.instrumentId === t.quote.instrumentId
            ? {
                ...s,
                pricePaise: t.quote.lastPricePaise,
                change: {
                  ...s.change,
                  todayBps: t.quote.previousClosePaise > 0
                    ? Math.floor(((t.quote.lastPricePaise - t.quote.previousClosePaise) * 10000) / t.quote.previousClosePaise)
                    : s.change.todayBps,
                },
                volume: { ...s.volume, current: t.quote.volume },
              }
            : s),
        };
      });
    };
    client.connect();
    return () => client.disconnect();
  }, [isAuthenticated, queryClient]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['watchlist', watchlistId, 'summary'] });
    queryClient.invalidateQueries({ queryKey: qk.watchlists });
  };

  async function createWatchlist() {
    const name = window.prompt('Name your new watchlist');
    if (!name?.trim()) return;
    const created = await api.post('/api/watchlists', { name: name.trim() });
    queryClient.invalidateQueries({ queryKey: qk.watchlists });
    router.push(`/watchlists/${created.id}`);
  }

  // One toggle for every row shares a single `openId`: clicking a second row
  // collapses the first, exactly like an accordion.
  const toggleRow = useCallback((instrumentId: string) => {
    setOpenId(prev => (prev === instrumentId ? null : instrumentId));
  }, []);

  // Digest → row: open it, scroll to it and flash it. Navigation happens on click.
  const jumpTo = useCallback((instrumentId: string) => {
    setFilter('all');
    setOpenId(instrumentId);
    setHighlightId(instrumentId);
    requestAnimationFrame(() => {
      document.getElementById(`row-${instrumentId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    setTimeout(() => setHighlightId(prev => (prev === instrumentId ? null : prev)), 2000);
  }, []);

  const { attention, rest } = useMemo(() => {
    const stocks = data?.stocks ?? [];
    return { attention: stocks.filter(needsAttention), rest: stocks.filter(s => !needsAttention(s)) };
  }, [data]);

  // The header lists EVERY stock that needs attention — a digest of the top 3
  // would read "7 need you" and then only name 3, which is a lie by omission.
  const headerItems: DigestItem[] = useMemo(
    () =>
      attention.map(s => ({
        instrumentId: s.instrumentId,
        symbol: s.symbol,
        name: s.name,
        score: s.attention.score,
        severity: s.attention.severity,
        line:
          s.reasons[0]
          ?? (s.isInitialState ? 'Added — tracking from now'
            : s.dataQuality.status === 'DATA_MISSING' || s.dataQuality.status === 'PROVIDER_DOWN'
              ? 'Live data unavailable — check back later'
              : 'No reason generated'),
      })),
    [attention]
  );

  if (!ready || !isAuthenticated) {
    return <div className="min-h-screen flex items-center justify-center text-ink-3 text-sm">Loading…</div>;
  }

  const remove = (s: WatchlistStock) => async () => {
    await api.delete(`/api/watchlists/${watchlistId}/stocks/${s.instrumentId}`);
    refresh();
  };

  const horizon: Horizon = data?.summary.horizon ?? 'DAY';
  const showHorizon = horizon !== 'DAY';
  const firstVisit = !data?.summary.lastVisitAt;
  const feedDelayMin = data?.stocks[0]?.dataQuality.feedDelaySeconds
    ? Math.round(data.stocks[0].dataQuality.feedDelaySeconds / 60)
    : 0;

  const renderList = (stocks: WatchlistStock[]) => (
    <ul>
      {stocks.map(s => (
        <StockRow
          key={s.instrumentId}
          stock={s}
          onRemove={remove(s)}
          firstVisit={firstVisit}
          showHorizon={showHorizon}
          horizonShort={HORIZON_SHORT[horizon]}
          highlighted={highlightId === s.instrumentId}
          open={openId === s.instrumentId}
          onToggle={() => toggleRow(s.instrumentId)}
        />
      ))}
    </ul>
  );

  const sectionLabel = (text: string, count: number) => (
    <div className="px-4 pt-3 pb-1.5 flex items-center gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">{text}</h3>
      <span className="text-[11px] text-ink-3 tabular-nums">{count}</span>
    </div>
  );

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b border-line bg-background/90 backdrop-blur">
        <div className="mx-auto max-w-[1400px] px-4 lg:px-6 h-14 flex items-center gap-4">
          <h1 className="text-[15px] font-semibold text-ink whitespace-nowrap tracking-[-0.01em]">
            Watchlist
          </h1>
          {/* Index levels belong in the chrome, the way every broker puts them
              there — not in a bordered "Market today" card in the sidebar. */}
          {data?.summary.market && (
            <div className="hidden md:flex items-center gap-4 text-[12px] border-l border-line pl-4">
              <span className="flex items-baseline gap-1.5">
                <span className="text-ink-3">NIFTY</span>
                <span className={`tabular-nums font-medium ${data.summary.market.todayBps >= 0 ? 'text-gain' : 'text-loss'}`}>
                  {data.summary.market.todayBps >= 0 ? '+' : '−'}{formatPct(Math.abs(data.summary.market.todayBps))}
                </span>
              </span>
              {data.summary.market.vixLevel !== null && (
                <span className="flex items-baseline gap-1.5">
                  <span className="text-ink-3">VIX</span>
                  <span className="tabular-nums text-ink-2">{data.summary.market.vixLevel.toFixed(2)}</span>
                </span>
              )}
            </div>
          )}
          <button
            onClick={() => router.push('/explore')}
            className="hidden sm:inline text-[12px] text-ink-3 hover:text-ink border border-line rounded px-2.5 py-1 transition-colors"
          >
            Explore
          </button>
          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            {data && (
              <HorizonSwitch
                value={horizon}
                onChange={setHorizon}
              />
            )}
            {/* Demo reset — rewinds every stock's "since you last checked"
                baseline back to 2026-08-31 10:00 IST so the demo tells a
                consistent story after acknowledge/mark-seen gestures. Only
                shown when the server is in demo mode. */}
            {data?.summary.demo && (
              <button
                id="demo-reset-btn"
                disabled={resetting}
                onClick={async () => {
                  setResetting(true);
                  try {
                    await api.post(`/api/watchlists/${watchlistId}/demo/replay`, {});
                    // Invalidate summary + intelligence caches so every row
                    // re-renders with the fresh "since you last checked" window.
                    await queryClient.invalidateQueries();
                  } catch {
                    // Swallow — the button is a convenience; errors are silent.
                  } finally {
                    setResetting(false);
                  }
                }}
                title="Reset demo baseline and clock to 31 Aug 2026, 10:00 IST"
                className={
                  `flex items-center gap-1.5 font-medium text-[12px] px-3 py-1.5 rounded-full border transition-all ` +
                  (resetting
                    ? 'border-ink-3/30 text-ink-3 cursor-not-allowed opacity-50'
                    : 'border-amber-500 text-amber-500 hover:bg-amber-500 hover:text-white shadow-sm hover:shadow-amber-500/20')
                }
              >
                {resetting ? (
                  <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                    <polygon points="5 3 19 12 5 21 5 3" />
                  </svg>
                )}
                Replay Demo
              </button>
            )}
            {/* Demo-mode chrome is hidden (was "Replay · …"): the demo is for
                showing the product, and a header full of footnotes gets in the
                way. The asOf/speed claim still rides in the page metadata. */}
            <ThemeToggle />
            {/* Clears the session only: theme and horizon are the browser's
                preferences, not the session's. */}
            <button
              onClick={() => { clearSession(); router.replace('/login'); }}
              className="text-[12px] text-ink-3 hover:text-ink whitespace-nowrap"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-4 lg:px-6 py-4 lg:py-6 space-y-4 lg:space-y-5">
        {data && (
          <SummaryHeader
            summary={data.summary}
            attentionCount={attention.length}
            items={headerItems}
            onMarkSeen={markAllSeen}
            marking={marking}
            onJump={jumpTo}
          />
        )}

        <div className="grid gap-4 lg:gap-5 items-start lg:grid-cols-[minmax(0,1fr)_336px]">
          {/* ── The list ─────────────────────────────────────────────── */}
          <section className="rounded-lg border border-line bg-surface overflow-hidden">
            <div className="px-4 py-2.5 border-b border-line flex flex-wrap items-center gap-3 justify-between">
              {watchlists && <WatchlistTabs watchlists={watchlists} activeId={watchlistId} onCreate={createWatchlist} />}
              {data && data.stocks.length > 0 && (
                <div className="ml-auto flex items-center gap-3 text-[12px]">
                  {(['all', 'attention'] as const).map(f => (
                    <button
                      key={f}
                      onClick={() => setFilter(f)}
                      className={`transition-colors ${filter === f ? 'text-ink font-medium' : 'text-ink-3 hover:text-ink-2'}`}
                    >
                      {f === 'all' ? `All ${data.stocks.length}` : `Needs attention ${attention.length}`}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Column header — desktop only, shares .row-grid with the rows */}
            {data && data.stocks.length > 0 && (
              <div className="hidden lg:block border-b border-line">
                <div className={`row-grid px-4 py-2 text-[11px] text-ink-3 ${showHorizon ? 'with-horizon' : ''}`}>
                  <span />
                  <span className="text-right">Price</span>
                  <span className="text-right">Today</span>
                  {showHorizon && <span className="text-right">{HORIZON_SHORT[horizon]}</span>}
                  <span className="text-right">Since visit</span>
                  <span
                    className="text-right cursor-help"
                    title={'Attention 0–100, calibrated on real history so ~2% of stock-days reach critical.\n'
                      + 'Time-series 50 · market and sector 25 · company events 20 · your alerts 5.\n'
                      + 'Open a row to see the arithmetic.'}
                  >
                    Attention
                  </span>
                </div>
              </div>
            )}

            {isLoading && (
              <ul>
                {Array.from({ length: 8 }).map((_, i) => (
                  <li key={i} className="px-4 py-3 border-b border-line flex justify-between animate-pulse">
                    <div className="space-y-2"><div className="h-3.5 w-40 bg-surface-2 rounded" /><div className="h-3 w-56 bg-surface-2 rounded" /></div>
                    <div className="space-y-2 text-right"><div className="h-3.5 w-20 bg-surface-2 rounded ml-auto" /><div className="h-3 w-24 bg-surface-2 rounded ml-auto" /></div>
                  </li>
                ))}
              </ul>
            )}

            {isError && (
              <div className="m-4 text-[13px] text-loss bg-loss/10 rounded-lg px-3 py-2">
                {error instanceof ApiError ? error.message : 'Could not load this watchlist'}
              </div>
            )}

            {data && filter === 'attention' && (
              attention.length ? renderList(attention) : (
                <p className="px-4 py-12 text-center text-[13px] text-ink-3">Nothing needs your attention right now.</p>
              )
            )}

            {data && filter === 'all' && (
              <>
                {attention.length > 0 && (
                  <>
                    {sectionLabel('Needs attention', attention.length)}
                    {renderList(attention)}
                  </>
                )}
                {rest.length > 0 && (
                  <>
                    {attention.length > 0 && sectionLabel('Everything else', rest.length)}
                    {renderList(rest)}
                  </>
                )}
              </>
            )}

            {data && data.stocks.length === 0 && (
              <p className="px-4 py-14 text-center text-[13px] text-ink-3">
                Your watchlist is empty — search on the right to add stocks.
              </p>
            )}

            {data && data.stocks.length > 0 && feedDelayMin > 0 && (
              <div className="px-4 py-2.5 border-t border-line text-[11px] text-ink-3 text-right">
                Prices ~{feedDelayMin} min delayed
              </div>
            )}
          </section>

          {/* ── Context rail ─────────────────────────────────────────── */}
          <aside className="space-y-5 lg:sticky lg:top-[72px]">
            <SearchAdd watchlistId={watchlistId} onAdded={refresh} />
            <MarketRail market={data?.summary.market ?? null} dampenedBy={data?.summary.market?.dampen ?? null} />
            <IndicatorsPanel market={data?.summary.market ?? null} />
            <FactorsPanel
              market={data?.summary.market ?? null}
              focused={data?.stocks.find(s => s.instrumentId === openId) ?? null}
            />
          </aside>
        </div>
      </main>
    </div>
  );
}
