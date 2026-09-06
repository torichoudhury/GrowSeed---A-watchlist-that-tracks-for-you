"use client";

import { useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { qk } from '@/lib/query-keys';
import { api, ApiError } from '@/lib/api-client';
import { formatRupees, formatPct } from '@/lib/format';
import { useRequireAuth } from '@/lib/use-auth';
import type { StockIntelligenceResponse, ChartResponse, ConclusionType } from '@/types/api';

// Hard rule 5: this page NEVER calls any acknowledge/mark-seen endpoint.
// Opening the stock detail page must NOT reset the watchlist baseline.

const SEVERITY_COLOR: Record<string, string> = {
  CRITICAL: 'text-red-500',
  HIGH: 'text-orange-400',
  MEDIUM: 'text-yellow-400',
  LOW: 'text-ink-2',
  QUIET: 'text-ink-3',
};

const CONCLUSION_ACCENT: Record<ConclusionType, string> = {
  STOCK_SPECIFIC: 'bg-orange-400/10 text-orange-300 border-orange-400/20',
  MARKET_DRIVEN: 'bg-blue-400/10 text-blue-300 border-blue-400/20',
  SECTOR_DRIVEN: 'bg-purple-400/10 text-purple-300 border-purple-400/20',
  CORPORATE_ACTION: 'bg-yellow-400/10 text-yellow-300 border-yellow-400/20',
  MIXED: 'bg-ink-3/10 text-ink-2 border-ink-3/20',
  UNKNOWN: 'bg-ink-3/10 text-ink-3 border-ink-3/20',
  NO_SIGNIFICANT_CHANGE: 'bg-gain/10 text-gain border-gain/20',
};

function Change({ bps, size = 'sm' }: { bps: number | null | undefined; size?: 'sm' | 'md' | 'lg' }) {
  if (bps === null || bps === undefined) return <span className="text-ink-3">—</span>;
  const cls = size === 'lg' ? 'text-[20px] font-bold' : size === 'md' ? 'text-[14px] font-semibold' : 'text-[13px]';
  if (bps === 0) return <span className={`tabular-nums text-ink-3 ${cls}`}>0.00%</span>;
  const up = bps > 0;
  return (
    <span className={`tabular-nums ${up ? 'text-gain' : 'text-loss'} ${cls}`}>
      {up ? '+' : '−'}{formatPct(Math.abs(bps))}
    </span>
  );
}

function DataBadge({ status }: { status: string }) {
  const label: Record<string, string> = {
    LIVE: 'Live', RECENT: 'Recent', DELAYED: 'Delayed', STALE: 'Stale',
    CLOSED: 'Market closed', PROVIDER_DOWN: 'Provider down', DATA_MISSING: 'No data',
  };
  const color: Record<string, string> = {
    LIVE: 'bg-gain/15 text-gain', RECENT: 'bg-gain/10 text-gain',
    DELAYED: 'bg-yellow-400/10 text-yellow-400', STALE: 'bg-orange-400/10 text-orange-400',
    CLOSED: 'bg-ink-3/10 text-ink-3', PROVIDER_DOWN: 'bg-loss/10 text-loss', DATA_MISSING: 'bg-loss/10 text-loss',
  };
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${color[status] ?? 'bg-ink-3/10 text-ink-3'}`}>
      {label[status] ?? status}
    </span>
  );
}

/** Interactive price chart — Groww-style with area fill, crosshair, and tooltip */
function PriceChart({ candles }: { candles: ChartResponse['candles'] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const valid = candles.filter(c => c.closePaise !== null && c.closePaise > 0);
  if (valid.length < 2) return null;

  const closes = valid.map(c => c.closePaise!);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const pad = (max - min) * 0.08 || 1;
  const yMin = min - pad;
  const yMax = max + pad;
  const yRange = yMax - yMin;

  const W = 800, H = 320;
  const padL = 60, padR = 16, padT = 16, padB = 36;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const xOf = (i: number) => padL + (i / (valid.length - 1)) * plotW;
  const yOf = (v: number) => padT + plotH - ((v - yMin) / yRange) * plotH;

  const lineD = valid.map((c, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(c.closePaise!).toFixed(1)}`).join(' ');
  const areaD = lineD + ` L${xOf(valid.length - 1).toFixed(1)},${(padT + plotH).toFixed(1)} L${xOf(0).toFixed(1)},${(padT + plotH).toFixed(1)} Z`;

  const up = closes[closes.length - 1] >= closes[0];
  const lineColor = up ? 'var(--color-gain)' : 'var(--color-loss)';

  const handleMouse = (e: React.MouseEvent) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const frac = (e.clientX - rect.left) / rect.width;
    const idx = Math.round(frac * (valid.length - 1));
    setHoverIdx(Math.max(0, Math.min(valid.length - 1, idx)));
  };

  const hc = hoverIdx !== null ? valid[hoverIdx] : null;
  const hx = hoverIdx !== null ? xOf(hoverIdx) : 0;
  const hy = hc ? yOf(hc.closePaise!) : 0;

  const fmtPrice = (p: number) => `₹${(p / 100).toFixed(2)}`;
  const fmtDate = (ts: string) => {
    const d = new Date(ts);
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  };

  const yTicks = 5;
  const yTickVals = Array.from({ length: yTicks + 1 }, (_, i) => yMin + (yRange * i) / yTicks);
  const xTickCount = Math.min(6, valid.length);
  const xTickIdxs = Array.from({ length: xTickCount }, (_, i) => Math.round((i / (xTickCount - 1)) * (valid.length - 1)));

  return (
    <div className="relative w-full select-none">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full cursor-crosshair"
        preserveAspectRatio="xMidYMid meet"
        onMouseMove={handleMouse}
        onMouseLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lineColor} stopOpacity="0.25" />
            <stop offset="100%" stopColor={lineColor} stopOpacity="0" />
          </linearGradient>
          <clipPath id="plotArea">
            <rect x={padL} y={padT} width={plotW} height={plotH} />
          </clipPath>
        </defs>

        {/* Y-axis grid + labels */}
        {yTickVals.map((v, i) => (
          <g key={i}>
            <line x1={padL} y1={yOf(v)} x2={padL + plotW} y2={yOf(v)} stroke="var(--color-line)" strokeWidth="0.5" strokeDasharray={i === 0 || i === yTicks ? '0' : '4 4'} />
            <text x={padL - 8} y={yOf(v) + 3} textAnchor="end" fill="var(--color-ink-3)" fontSize="10" fontFamily="monospace">{fmtPrice(v)}</text>
          </g>
        ))}

        {/* X-axis labels */}
        {xTickIdxs.map((i) => (
          <text key={i} x={xOf(i)} y={padT + plotH + 20} textAnchor="middle" fill="var(--color-ink-3)" fontSize="10" fontFamily="monospace">
            {fmtDate(valid[i].timestamp)}
          </text>
        ))}

        <g clipPath="url(#plotArea)">
          {/* Area fill */}
          <path d={areaD} fill="url(#areaFill)" />

          {/* Line */}
          <path d={lineD} fill="none" stroke={lineColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />

          {/* Crosshair */}
          {hoverIdx !== null && (
            <line x1={hx} y1={padT} x2={hx} y2={padT + plotH} stroke="var(--color-ink-3)" strokeWidth="0.5" strokeDasharray="4 3" />
          )}

          {/* Dot */}
          {hoverIdx !== null && hc && (
            <circle cx={hx} cy={hy} r="4" fill={lineColor} stroke="var(--color-background)" strokeWidth="2" />
          )}
        </g>

        {/* Outer border */}
        <rect x={padL} y={padT} width={plotW} height={plotH} fill="none" stroke="var(--color-line)" strokeWidth="0.5" />
      </svg>

      {/* Tooltip */}
      {hoverIdx !== null && hc && (
        <div
          className="absolute pointer-events-none z-10 rounded-lg border border-line bg-surface px-3 py-2 shadow-lg"
          style={{
            left: `${(hx / W) * 100}%`,
            top: `${(hy / H) * 100 - 8}%`,
            transform: 'translate(-50%, -100%)',
          }}
        >
          <div className="text-[13px] font-semibold tabular-nums text-ink">{fmtPrice(hc.closePaise!)}</div>
          <div className="text-[11px] text-ink-3 mt-0.5">{fmtDate(hc.timestamp)}</div>
          {hc.volume !== null && (
            <div className="text-[10px] text-ink-3 mt-0.5">Vol {hc.volume.toLocaleString('en-IN')}</div>
          )}
        </div>
      )}
    </div>
  );
}

const RANGES = ['1D', '1W', '1M', '6M', '1Y'] as const;

export default function StockDetailPage() {
  const { ready, isAuthenticated } = useRequireAuth();
  const params = useParams();
  const router = useRouter();
  const rawId = params.instrumentId as string;
  // Next.js encodes brackets in the URL param; decode here.
  const instrumentId = decodeURIComponent(rawId).toUpperCase();
  const [chartRange, setChartRange] = useState<string>('1M');

  // router.back() is a no-op when this page is the first history entry
  // (direct link, fresh tab, Vercel preview, etc). Fall back to /watchlists.
  function goBack() {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back();
    } else {
      router.replace('/watchlists');
    }
  }

  const {
    data,
    isLoading,
    isError,
    error,
  } = useQuery<StockIntelligenceResponse>({
    queryKey: qk.intelligence(instrumentId),
    queryFn: () => api.get(`/api/stocks/${encodeURIComponent(instrumentId)}/intelligence`),
    enabled: isAuthenticated && !!instrumentId,
    staleTime: 25_000,
    refetchInterval: q => (q.state.data?.dataQuality.status === 'CLOSED' ? 300_000 : 30_000),
  });

  const { data: chart } = useQuery<ChartResponse>({
    queryKey: qk.chart(instrumentId, chartRange),
    queryFn: () => api.get(`/api/stocks/${encodeURIComponent(instrumentId)}/chart?range=${chartRange}`),
    enabled: isAuthenticated && !!instrumentId,
    staleTime: 60_000,
  });

  if (!ready || !isAuthenticated) {
    return <div className="min-h-screen flex items-center justify-center text-ink-3 text-sm">Loading…</div>;
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <nav className="sticky top-0 z-30 border-b border-line bg-background/90 backdrop-blur h-14 flex items-center px-4 gap-3">
          <button onClick={goBack} className="text-ink-3 hover:text-ink text-sm flex items-center gap-1">
            <span>←</span> Back
          </button>
        </nav>
        <div className="mx-auto max-w-3xl px-4 py-8 space-y-4 animate-pulse">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-16 bg-surface-2 rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (isError) {
    const msg = error instanceof ApiError && error.status === 404
      ? 'Stock not found.'
      : 'Could not load stock data. Please try again.';
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4 text-center px-4">
        <p className="text-loss text-sm">{msg}</p>
        <button onClick={goBack} className="text-primary text-sm hover:underline">← Go back</button>
      </div>
    );
  }

  if (!data) return null;

  const { stock, quote, sinceLastCheck, attention, why, rarity, volume, marketContext, sectorContext, corporateActions, news, fundamentals, dataQuality } = data;
  const isNoData = dataQuality.status === 'PROVIDER_DOWN' || dataQuality.status === 'DATA_MISSING';

  return (
    <div className="min-h-screen bg-background">
      {/* ── Nav bar ── */}
      <nav className="sticky top-0 z-30 border-b border-line bg-background/90 backdrop-blur h-14 flex items-center px-4 lg:px-6 gap-4">
        <button
          onClick={goBack}
          className="text-ink-3 hover:text-ink text-sm flex items-center gap-1 shrink-0"
          aria-label="Back"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6"/></svg>
          Back
        </button>
        <span className="text-[15px] font-semibold text-ink">
          {stock.name ?? stock.symbol}
        </span>
        <span className="text-[12px] text-ink-3 shrink-0">{stock.symbol}</span>
        <DataBadge status={dataQuality.status} />
        {dataQuality.feedDelaySeconds && dataQuality.feedDelaySeconds > 300 && (
          <span className="hidden sm:inline text-[11px] text-ink-3 shrink-0">
            ~{Math.round(dataQuality.feedDelaySeconds / 60)} min delayed
          </span>
        )}
      </nav>

      <main className="mx-auto max-w-3xl px-4 lg:px-6 py-6 space-y-5">

        {/* ── Price header ── */}
        <section aria-label="Current price">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="text-[28px] font-bold tabular-nums text-ink leading-none">
                {isNoData ? <span className="text-ink-3 text-[18px]">No data</span> : formatRupees(quote.pricePaise)}
              </div>
              {!isNoData && (
                <div className="flex items-center gap-3 mt-1">
                  <Change bps={quote.todayChangeBps} size="md" />
                  <span className="text-[12px] text-ink-3">today</span>
                </div>
              )}
            </div>
            {rarity.band && rarity.band !== 'NONE' && !isNoData && (
              <div className="text-right">
                <span className={`text-[11px] px-2 py-1 rounded-full border ${
                  rarity.band === 'MAX' || rarity.band === 'P99' ? 'bg-red-500/10 text-red-400 border-red-500/20' :
                  rarity.band === 'P98' ? 'bg-orange-400/10 text-orange-400 border-orange-400/20' :
                  'bg-yellow-400/10 text-yellow-400 border-yellow-400/20'
                }`}>
                  {rarity.band} move{rarity.window && rarity.window !== 'daily' ? ` · ${rarity.window}` : ''}
                  {rarity.estimated ? ' (est.)' : ''}
                </span>
              </div>
            )}
          </div>

          {/* OHLV summary */}
          {!isNoData && (
            <div className="mt-3 grid grid-cols-4 gap-2">
              {[
                { label: 'Open', val: quote.openPaise },
                { label: 'High', val: quote.highPaise },
                { label: 'Low', val: quote.lowPaise },
                { label: 'Prev close', val: quote.previousClosePaise },
              ].map(({ label, val }) => (
                <div key={label} className="text-center">
                  <div className="text-[10px] text-ink-3 uppercase tracking-wide">{label}</div>
                  <div className="text-[12px] tabular-nums text-ink-2 mt-0.5">
                    {val ? formatRupees(val) : '—'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── Why it moved (above the fold, per spec §4) ── */}
        {/* Rule 2: render conclusion.label exactly as sent. Do NOT re-word into causal claims. */}
        <section
          aria-label="Why it moved"
          className="rounded-xl border border-line bg-surface p-4 space-y-3"
        >
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Why it moved</h2>

          {/* Conclusion badge */}
          <div className={`inline-flex items-center gap-2 text-[12px] px-3 py-1.5 rounded-lg border ${
            CONCLUSION_ACCENT[why.conclusion.type]
          }`}>
            {why.conclusion.label}
          </div>

          {/* Headline reason */}
          <p className="text-[14px] text-ink leading-snug">{why.headline}</p>

          {/* Full reason list */}
          {why.reasons.length > 1 && (
            <ul className="space-y-1.5">
              {why.reasons.slice(1).map((r, i) => (
                <li key={i} className="text-[13px] text-ink-2 flex gap-2">
                  <span className="text-primary-dark mt-[3px] shrink-0">•</span>
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          )}

          {/* Data quality warnings */}
          {dataQuality.warnings.length > 0 && (
            <div className="pt-1 border-t border-line space-y-1">
              {dataQuality.warnings.map((w, i) => (
                <p key={i} className="text-[11px] text-ink-3 flex gap-1.5">
                  <span>⚠</span>{w}
                </p>
              ))}
            </div>
          )}
        </section>

        {/* ── Since last check ── */}
        <section aria-label="Since last check" className="rounded-xl border border-line bg-surface p-4">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-ink-3 mb-3">Since your last visit</h2>
          {sinceLastCheck.hasBaseline ? (
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <Change bps={sinceLastCheck.changeBps} size="lg" />
                {sinceLastCheck.daysSinceLastVisit !== null && (
                  <div className="text-[12px] text-ink-3 mt-1">
                    over {sinceLastCheck.daysSinceLastVisit === 0 ? 'today' : `${sinceLastCheck.daysSinceLastVisit} day${sinceLastCheck.daysSinceLastVisit !== 1 ? 's' : ''}`}
                  </div>
                )}
              </div>
              {sinceLastCheck.previousPricePaise !== null && sinceLastCheck.currentPricePaise !== null && (
                <div className="text-right text-[12px] text-ink-3">
                  <div>{formatRupees(sinceLastCheck.previousPricePaise)} → {formatRupees(sinceLastCheck.currentPricePaise)}</div>
                  {sinceLastCheck.checkedAt && (
                    <div className="mt-0.5">
                      Checked: {new Date(sinceLastCheck.checkedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <p className="text-[13px] text-ink-3">First visit — tracking from now.</p>
          )}
        </section>

        {/* ── Chart ── */}
        <section aria-label="Price chart" className="rounded-xl border border-line bg-surface p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Price chart</h2>
            <div className="flex gap-1">
              {RANGES.map(r => (
                <button
                  key={r}
                  onClick={() => setChartRange(r)}
                  className={`text-[11px] px-2 py-0.5 rounded transition-colors ${
                    chartRange === r ? 'bg-primary/20 text-primary-dark font-medium' : 'text-ink-3 hover:text-ink'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
          {chart && chart.candles.length > 0 ? (
            <PriceChart candles={chart.candles} />
          ) : (
            <p className="text-[12px] text-ink-3 py-6 text-center">Historical chart unavailable right now.</p>
          )}
        </section>

        {/* ── Market & Sector context ── */}
        <section aria-label="Market and sector context" className="rounded-xl border border-line bg-surface p-4 space-y-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Market context</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <ContextCell
              label={marketContext.benchmarkName ?? 'NIFTY 50'}
              value={<Change bps={marketContext.todayBps} />}
              sub="benchmark today"
            />
            {marketContext.vix !== null && (
              <ContextCell
                label="VIX"
                value={<span className="text-ink tabular-nums text-[13px]">{marketContext.vix.toFixed(2)}</span>}
                sub={marketContext.vixPercentile !== null ? `${(marketContext.vixPercentile * 100).toFixed(0)}th pct` : undefined}
              />
            )}
            {marketContext.regime && (
              <ContextCell label="Regime" value={<span className="text-ink-2 text-[12px]">{marketContext.regime.replace(/_/g, ' ')}</span>} />
            )}
            {sectorContext.sectorName && (
              <ContextCell
                label={sectorContext.sectorName}
                value={<Change bps={sectorContext.todayBps} />}
                sub="sector today"
              />
            )}
            {sectorContext.stockVsSectorBps !== null && (
              <ContextCell
                label="vs sector"
                value={<Change bps={sectorContext.stockVsSectorBps} />}
                sub="stock residual"
              />
            )}
          </div>
          {/* Interpretive sentence — states market/sector/stock-specific/mixed/undetermined
              exactly as the backend computed it; never asserts a cause the numbers don't support */}
          <p className="text-[12px] text-ink-3 border-t border-line pt-2">
            {why.conclusion.label}
          </p>
        </section>

        {/* ── Volume ── */}
        {!isNoData && (
          <section aria-label="Volume" className="rounded-xl border border-line bg-surface p-4">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-ink-3 mb-3">Volume</h2>
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <span className="text-[18px] font-semibold tabular-nums text-ink">
                  {volume.current !== null ? volume.current.toLocaleString('en-IN') : '—'}
                </span>
                <span className="text-[12px] text-ink-3 ml-2">shares</span>
              </div>
              {volume.ratio !== null && (
                <div className="text-right text-[12px] text-ink-3">
                  <span className={`text-[14px] font-semibold ${volume.ratio >= 2 ? 'text-ink' : 'text-ink-2'}`}>
                    {volume.ratio.toFixed(1)}×
                  </span>
                  {' '}avg
                  {volume.percentile !== null && <> · {volume.percentile.toFixed(0)}th pct</>}
                </div>
              )}
            </div>
            {volume.average !== null && (
              <div className="mt-2 text-[11px] text-ink-3">
                30-day avg: {volume.average.toLocaleString('en-IN')} shares
              </div>
            )}
            {/* Volume bar */}
            {volume.ratio !== null && (
              <div className="mt-3 h-1.5 bg-surface-2 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${volume.ratio >= 2 ? 'bg-primary' : 'bg-ink-3/40'}`}
                  style={{ width: `${Math.min(100, (volume.ratio / 3) * 100).toFixed(0)}%` }}
                />
              </div>
            )}
          </section>
        )}

        {/* ── Attention score ── */}
        <section aria-label="Attention score" className="rounded-xl border border-line bg-surface p-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Attention score</h2>
              <div className="flex items-center gap-2 mt-1">
                <span className={`text-[24px] font-bold tabular-nums ${SEVERITY_COLOR[attention.severity] ?? 'text-ink'}`}>
                  {attention.score}
                </span>
                <span className="text-[12px] text-ink-3">/ 100 · {attention.severity.toLowerCase()}</span>
              </div>
            </div>
            <div className="text-right">
              <div className="h-2 w-32 bg-surface-2 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${
                    attention.score >= 70 ? 'bg-red-500' :
                    attention.score >= 41 ? 'bg-orange-400' :
                    attention.score >= 20 ? 'bg-yellow-400' : 'bg-ink-3/40'
                  }`}
                  style={{ width: `${attention.score}%` }}
                />
              </div>
            </div>
          </div>
        </section>

        {/* ── Corporate actions ── */}
        {corporateActions.length > 0 && (
          <section aria-label="Corporate actions" className="rounded-xl border border-line bg-surface p-4 space-y-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Corporate actions</h2>
            {corporateActions.map((ca, i) => (
              <div key={i} className="flex items-start justify-between gap-3">
                <div>
                  <span className="text-[13px] font-medium text-ink">{ca.type}</span>
                  {ca.subject && <p className="text-[12px] text-ink-2 mt-0.5">{ca.subject}</p>}
                  {/* Split/bonus distinction: labeled as mechanical, not presented as a real gain */}
                  {ca.mechanical && (
                    <p className="text-[11px] text-ink-3 mt-0.5">
                      Mechanical price adjustment — not a real gain or loss
                    </p>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <span className="text-[12px] text-ink-3">{ca.date}</span>
                  {ca.amountPaise !== null && (
                    <div className="text-[12px] text-ink-2">₹{(ca.amountPaise / 100).toFixed(2)}</div>
                  )}
                </div>
              </div>
            ))}
          </section>
        )}

        {/* ── News ── */}
        {news && news.length > 0 && (
          <section aria-label="Recent news" className="rounded-xl border border-line bg-surface p-4 space-y-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Recent news</h2>
            {news.map((n, i) => (
              <a
                key={i}
                href={n.url ?? '#'}
                target="_blank"
                rel="noopener noreferrer"
                className="block group"
              >
                <p className="text-[13px] text-ink leading-snug group-hover:text-primary-dark transition-colors">{n.headline}</p>
                {n.publishedAt && (
                  <p className="text-[11px] text-ink-3 mt-0.5">
                    {new Date(n.publishedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                  </p>
                )}
              </a>
            ))}
          </section>
        )}

        {/* ── Fundamentals ── */}
        {fundamentals && (fundamentals.resultsDate || fundamentals.exDividendDate || fundamentals.announcements.length > 0) && (
          <section aria-label="Upcoming events" className="rounded-xl border border-line bg-surface p-4 space-y-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Company events</h2>
            {fundamentals.resultsDate && (
              <div className="flex justify-between text-[13px]">
                <span className="text-ink-2">Results date</span>
                <span className="text-ink tabular-nums">
                  {fundamentals.resultsDate}
                  {fundamentals.resultsDaysFromNow !== null && (
                    <span className="text-[11px] text-ink-3 ml-1">
                      ({fundamentals.resultsDaysFromNow >= 0 ? `in ${fundamentals.resultsDaysFromNow}d` : `${Math.abs(fundamentals.resultsDaysFromNow)}d ago`})
                    </span>
                  )}
                </span>
              </div>
            )}
            {fundamentals.exDividendDate && (
              <div className="flex justify-between text-[13px]">
                <span className="text-ink-2">Ex-dividend</span>
                <span className="text-ink tabular-nums">
                  {fundamentals.exDividendDate}
                  {fundamentals.dividendAmountPaise !== null && (
                    <span className="text-[11px] text-ink-3 ml-1">₹{(fundamentals.dividendAmountPaise / 100).toFixed(2)}</span>
                  )}
                </span>
              </div>
            )}
            {fundamentals.announcements.length > 0 && (
              <div className="pt-1 border-t border-line">
                <p className="text-[11px] text-ink-3 mb-1">Recent announcements</p>
                {fundamentals.announcements.map((a, i) => (
                  <p key={i} className="text-[12px] text-ink-2 leading-snug">{a}</p>
                ))}
              </div>
            )}
          </section>
        )}

        {/* ── Data quality footer ── */}
        <footer className="text-[11px] text-ink-3 text-center pb-6">
          {dataQuality.dataTimestamp && (
            <span>Data as of {new Date(dataQuality.dataTimestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} · </span>
          )}
          <span>{stock.exchange}</span>
        </footer>
      </main>
    </div>
  );
}

function ContextCell({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
}) {
  return (
    <div className="bg-surface-2/50 rounded-lg p-2.5">
      <div className="text-[10px] text-ink-3 uppercase tracking-wide mb-1">{label}</div>
      <div>{value}</div>
      {sub && <div className="text-[10px] text-ink-3 mt-0.5">{sub}</div>}
    </div>
  );
}
