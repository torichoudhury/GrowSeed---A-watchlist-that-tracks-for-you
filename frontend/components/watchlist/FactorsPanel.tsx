"use client";

import type { MarketContext, WatchlistStock } from '@/types/api';
import { formatPct } from '@/lib/format';
import { StockContextChips } from './StockContextChips';

type Tone = 'up' | 'down' | 'info' | 'neutral';

function signedBps(bps: number): string {
  return `${bps > 0 ? '+' : bps < 0 ? '−' : ''}${formatPct(Math.abs(bps))}`;
}

function toneClass(t: Tone): string {
  return t === 'up' ? 'text-gain' : t === 'down' ? 'text-loss' : t === 'info' ? 'text-ink-2' : 'text-ink-3';
}

/**
 * The two kinds of force behind what you're seeing, shown side by side:
 *
 *   EXTERNAL (market & macro) — the whole-market backdrop every stock shares
 *   (benchmark day, volatility regime, fear gauge, breadth). We only answer
 *   what the data actually measures; there is no fabricated "GDP up" or "war"
 *   line — if such a source existed it would slot into this block.
 *
 *   INTERNAL (company) — that stock's own story (results/dividends/corporate
 *   actions, how it behaves against its sector and the market, streaks and
 *   drawdowns). Fills from whichever row is expanded; expand a row to switch.
 */
export function FactorsPanel({ market, focused }: { market: MarketContext | null; focused: WatchlistStock | null }) {
  const external: { label: string; tone: Tone }[] = [];

  if (market) {
    external.push({
      label: `${market.name} ${signedBps(market.todayBps)} — ${market.todayBps >= 0 ? 'a tailwind on your list' : 'a headwind on your list'}`,
      tone: market.todayBps >= 0 ? 'up' : 'down',
    });
    external.push({
      label: `Regime ${market.volRatio >= 1.5 ? 'turbulent — moves are noisy' : market.volRatio >= 1.3 ? 'choppy — moderate noise' : 'calm — moves read cleanly'} (${market.volRatio.toFixed(2)}×)`,
      tone: market.volRatio >= 1.5 ? 'down' : market.volRatio >= 1.3 ? 'neutral' : 'up',
    });
    if (market.vixLevel !== null) {
      external.push({
        label: market.vixPctile !== null && market.vixPctile > 0.7
          ? `India VIX ${market.vixLevel.toFixed(2)} — dominated by fear`
          : market.vixPctile !== null && market.vixPctile <= 0.3
            ? `India VIX ${market.vixLevel.toFixed(2)} — fear unusually low`
            : `India VIX ${market.vixLevel.toFixed(2)} — normal range`,
        tone: market.vixPctile !== null && market.vixPctile > 0.7 ? 'down' : market.vixPctile !== null && market.vixPctile <= 0.3 ? 'up' : 'neutral',
      });
    }
    external.push({
      label: `Breadth ${market.breadthUp} up / ${market.breadthDown} down — ${
        market.breadthUp > market.breadthDown ? 'the move is broad, not one stock' : market.breadthUp < market.breadthDown ? 'the market fell even on you' : 'an even split'
      }`,
      tone: market.breadthUp >= market.breadthDown ? 'up' : 'down',
    });
  }

  const f = focused?.context?.fundamentals;
  const internal: { label: string; tone: Tone }[] = [];
  if (focused?.context) {
    const c = focused.context;
    if (c.sector && c.sector.residualBps != null) {
      const r = c.sector.residualBps;
      internal.push({
        label: `${signedBps(r)} vs ${c.sector.name ?? 'its sector'} — ${r >= 0 ? 'outperforming' : 'underperforming'} the sector`,
        tone: r >= 0 ? 'up' : 'down',
      });
    } else if (c.market && c.market.residualBps != null) {
      const r = c.market.residualBps;
      internal.push({
        label: `${signedBps(r)} vs ${c.market.indexId.split(':')[1] ?? 'the market'} (β ${c.market.beta?.toFixed(2) ?? '—'})`,
        tone: r >= 0 ? 'up' : 'down',
      });
    }
    if (f) {
      if (f.resultsDaysFromNow !== null && f.resultsDate) {
        internal.push({
          label: f.resultsDaysFromNow === 0 ? 'Reporting today' : f.resultsDaysFromNow > 0 ? `Reports in ${f.resultsDaysFromNow}d` : `Reported ${-f.resultsDaysFromNow}d ago`,
          tone: 'info',
        });
      }
      if (f.corporateActionToday) {
        internal.push({ label: `${f.corporateActionToday === 'BONUS' ? 'Bonus' : 'Split'} today`, tone: 'info' });
      }
      if (f.exDividendDate && f.dividendAmountPaise) {
        internal.push({ label: `Ex-dividend ₹${(f.dividendAmountPaise / 100).toFixed(2)}`, tone: 'info' });
      }
    }
    if (c.adjustmentGuard) internal.push({ label: `Adjustment guard: ${c.adjustmentGuard.label}`, tone: 'neutral' });
    if (Math.abs(c.path.streakDays) >= 3) {
      internal.push({ label: `${Math.abs(c.path.streakDays)}d ${c.path.streakDays > 0 ? 'up' : 'down'} streak`, tone: 'neutral' });
    }
    if (focused.volume.ratio >= 1.5) {
      internal.push({ label: `Volume ${focused.volume.ratio.toFixed(1)}× normal`, tone: 'info' });
    }
  }

  return (
    <section className="space-y-3">
      <h3 className="text-[11px] text-ink-3 pb-2 border-b border-line">Factors</h3>

      {focused?.context ? (
        <div className="mb-2">
          <StockContextChips stock={focused} />
        </div>
      ) : null}

      <div>
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-ink-3 mb-1.5">External — market &amp; macro</h4>
        {external.length > 0 ? (
          <ul className="space-y-1 text-[12px] leading-snug">
            {external.map((x, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-ink-3/50 select-none mt-px text-[10px]">●</span>
                <span className={toneClass(x.tone)}>{x.label}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-ink-3">Market context unavailable.</p>
        )}
      </div>

      <div>
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-ink-3 mb-1.5">Internal — company</h4>
        {focused ? (
          internal.length > 0 ? (
            <ul className="space-y-1 text-[12px] leading-snug">
              {internal.map((x, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-ink-3/50 select-none mt-px text-[10px]">●</span>
                  <span className={toneClass(x.tone)}>{x.label}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12px] text-ink-3">No company-specific factor is standing out right now.</p>
          )
        ) : (
          <p className="text-[12px] text-ink-3">Click a row to see its company factors.</p>
        )}
      </div>
    </section>
  );
}