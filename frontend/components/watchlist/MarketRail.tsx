"use client";

import type { MarketContext } from '@/types/api';
import { formatPct } from '@/lib/format';

function Signed({ bps }: { bps: number }) {
  const up = bps >= 0;
  return (
    <span className={`tabular-nums ${up ? 'text-gain' : 'text-loss'}`}>
      {up ? '+' : '−'}{formatPct(Math.abs(bps))}
    </span>
  );
}

/**
 * Why a stock's move may not be the stock's own story: the market's day, the
 * volatility regime, and how hard that regime is currently damping scores.
 * A plain labelled list rather than a bordered card — the header already
 * carries the index levels, this is the detail behind them.
 */
export function MarketRail({ market, dampenedBy }: { market: MarketContext | null; dampenedBy: number | null }) {
  if (!market) return null;
  const regimeLabel = market.volRatio >= 1.5 ? 'turbulent'
    : market.volRatio >= 1.3 ? 'choppy'
      : market.volRatio <= 0.8 ? 'very calm' : 'calm';

  return (
    <section>
      <h3 className="text-[11px] text-ink-3 pb-2 border-b border-line">Market</h3>
      <dl className="text-[13px]">
        <Row label={market.name}><Signed bps={market.todayBps} /></Row>
        {market.vixLevel !== null && (
          <Row label="India VIX">
            <span className="tabular-nums text-ink">{market.vixLevel.toFixed(2)}</span>
            {market.vixPctile !== null && (
              <span className="text-ink-3 tabular-nums"> · {Math.round(market.vixPctile * 100)}th</span>
            )}
          </Row>
        )}
        <Row label="Volatility">
          <span className="text-ink">{regimeLabel}</span>
          <span className="text-ink-3 tabular-nums"> {market.volRatio.toFixed(2)}×</span>
        </Row>
        <Row label="Your list">
          <span className="tabular-nums text-gain">{market.breadthUp}↑</span>{' '}
          <span className="tabular-nums text-loss">{market.breadthDown}↓</span>
        </Row>
      </dl>
      {dampenedBy !== null && dampenedBy < 1 && (
        <p className="mt-3 text-[11px] text-ink-3 leading-relaxed">
          Scores damped ×{dampenedBy.toFixed(2)}: in a market this noisy, one stock moving is weaker
          evidence that something happened to that stock.
        </p>
      )}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2 border-b border-line last:border-b-0">
      <dt className="text-ink-2">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
