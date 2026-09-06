"use client";

import type { MarketContext } from '@/types/api';
import { formatPct } from '@/lib/format';

type State = 'positive' | 'neutral' | 'negative';

const DOT: Record<State, string> = {
  positive: 'bg-gain',
  neutral: 'bg-ink-3/60',
  negative: 'bg-loss',
};

const WORD: Record<State, string> = {
  positive: 'Positive',
  neutral: 'Neutral',
  negative: 'Negative',
};

const WORD_CLASS: Record<State, string> = {
  positive: 'text-gain',
  neutral: 'text-ink-2',
  negative: 'text-loss',
};

function classify(thresholdBps: number) {
  return (bps: number): State => (bps >= thresholdBps ? 'positive' : bps <= -thresholdBps ? 'negative' : 'neutral');
}

/**
 * The market's day, read as a small dashboard: each indicator classified into
 * a positive / neutral / negative state. Pure judgement on the server's own
 * numbers (never fabricated) and deliberately coarse — the point is the quick
 * scan, the MarketRail above keeps the exact values.
 */
export function IndicatorsPanel({ market }: { market: MarketContext | null }) {
  if (!market) return null;
  const bench = classify(25)(market.todayBps);
  const breadth: State = market.breadthUp > market.breadthDown ? 'positive' : market.breadthUp < market.breadthDown ? 'negative' : 'neutral';
  const volRatio = market.volRatio;
  const regime: State = !Number.isFinite(volRatio) ? 'neutral' : volRatio >= 1.5 ? 'negative' : volRatio >= 1.3 ? 'neutral' : 'positive';
  const vixState: State | null = market.vixPctile === null ? null
    : market.vixPctile >= 0.7 ? 'negative' : market.vixPctile <= 0.3 ? 'positive' : 'neutral';

  return (
    <section>
      <h3 className="text-[11px] text-ink-3 pb-2 border-b border-line">Indicators</h3>
      <ul className="text-[12px]">
        <Indicator label="Benchmark" value={market.name} state={bench} detail={signed(market.todayBps)} />
        <Indicator label="Breadth" value={`${market.breadthUp} up · ${market.breadthDown} down`} state={breadth} />
        <Indicator
          label="Volatility"
          value={regimeLabel(volRatio)}
          state={regime}
          detail={`${volRatio.toFixed(2)}×`}
        />
        {market.vixLevel !== null && vixState !== null && (
          <Indicator
            label="India VIX"
            value={market.vixLevel.toFixed(2)}
            state={vixState}
            detail={market.vixPctile !== null ? `${Math.round(market.vixPctile * 100)}th pct` : undefined}
          />
        )}
      </ul>
    </section>
  );
}

function signed(bps: number): string {
  return `${bps > 0 ? '+' : bps < 0 ? '−' : ''}${formatPct(Math.abs(bps))}`;
}

function regimeLabel(r: number): string {
  return r >= 1.5 ? 'Turbulent' : r >= 1.3 ? 'Choppy' : 'Calm';
}

function Indicator({
  label,
  value,
  state,
  detail,
}: {
  label: string;
  value: string | number;
  state: State;
  detail?: string;
}) {
  return (
    <li className="flex items-center justify-between gap-3 py-2 border-b border-line last:border-b-0">
      <span className="flex items-center gap-2 text-ink-2 min-w-0">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${DOT[state]} shrink-0`} aria-hidden />
        <span className="shrink-0">{label}</span>
      </span>
      <span className="flex items-baseline gap-1.5 text-right min-w-0">
        <span className="tabular-nums text-ink">{value}</span>
        {detail && <span className="tabular-nums text-ink-3 text-[11px]">{detail}</span>}
        <span className={`w-[52px] shrink-0 text-right text-[11px] font-medium ${WORD_CLASS[state]}`}>{WORD[state]}</span>
      </span>
    </li>
  );
}