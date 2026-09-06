import type { WatchlistStock } from '@/types/api';
import { formatPct } from '@/lib/format';

/**
 * The "why" behind a score, as compact chips: where the stock sits vs market
 * and sector, what's on the company calendar, and its path state. Purely
 * presentational — every number here comes from the server.
 */
export function StockContextChips({ stock }: { stock: WatchlistStock }) {
  const ctx = stock.context;
  if (!ctx) return null;
  const chips: { label: string; tone: 'neutral' | 'up' | 'down' | 'info' }[] = [];

  if (ctx.sector && ctx.sector.residualBps !== null && Math.abs(ctx.sector.residualBps) >= 100) {
    chips.push({
      label: `${ctx.sector.residualBps > 0 ? '+' : '−'}${formatPct(Math.abs(ctx.sector.residualBps))} vs ${ctx.sector.name ?? 'sector'}`,
      tone: ctx.sector.residualBps > 0 ? 'up' : 'down',
    });
  } else if (ctx.market && ctx.market.residualBps !== null && Math.abs(ctx.market.residualBps) >= 100) {
    chips.push({
      label: `${ctx.market.residualBps > 0 ? '+' : '−'}${formatPct(Math.abs(ctx.market.residualBps))} vs Nifty (β ${ctx.market.beta?.toFixed(2)})`,
      tone: ctx.market.residualBps > 0 ? 'up' : 'down',
    });
  }

  const f = ctx.fundamentals;
  if (f.resultsDaysFromNow !== null) {
    const d = f.resultsDaysFromNow;
    chips.push({ label: d === 0 ? 'Results today' : d > 0 ? `Results in ${d}d` : `Results ${-d}d ago`, tone: 'info' });
  }
  if (f.exDividendDate) chips.push({ label: 'Ex-dividend', tone: 'info' });
  if (f.corporateActionToday) chips.push({ label: f.corporateActionToday === 'BONUS' ? 'Bonus today' : 'Split today', tone: 'info' });
  if (ctx.adjustmentGuard) chips.push({ label: `Looks like a ${ctx.adjustmentGuard.label}`, tone: 'neutral' });

  if (Math.abs(ctx.path.streakDays) >= 3) {
    chips.push({ label: `${Math.abs(ctx.path.streakDays)}d ${ctx.path.streakDays > 0 ? 'up' : 'down'} streak`, tone: 'neutral' });
  }
  if (ctx.path.drawdownFrom30dHighBps !== null && ctx.path.drawdownFrom30dHighBps <= -500) {
    chips.push({ label: `${formatPct(Math.abs(ctx.path.drawdownFrom30dHighBps))} off 30d high`, tone: 'neutral' });
  }

  if (chips.length === 0) return null;
  // Text separated by hairline dividers, not a row of coloured pills: only
  // direction earns colour, and only where it means gain or loss.
  const toneClass: Record<string, string> = {
    up: 'text-gain',
    down: 'text-loss',
    info: 'text-ink-2',
    neutral: 'text-ink-3',
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] tabular-nums">
      {chips.map((c, i) => (
        <span key={c.label} className={`flex items-center gap-3 ${toneClass[c.tone]}`}>
          {i > 0 && <span className="text-line-strong" aria-hidden>·</span>}
          {c.label}
        </span>
      ))}
    </div>
  );
}
