import { NormalizedQuote } from '../models/quote';
import { fetchGrowwQuote, fetchGrowwDailyCandles } from './groww/provider';
import { fetchYahooQuote, fetchYahooDailyCandles } from './yahoo/provider';
import { fetchDemoQuote, fetchDemoDailyCandles } from './demo/provider';
import { DEMO } from './clock';

/**
 * Single seam for "where do prices come from" (BUILD_SPEC §4's
 * MarketDataProvider). Everything above this — cache, single-flight,
 * circuit breaker, metrics, scoring — is provider-agnostic.
 *
 *   MARKET_DATA_PROVIDER=yahoo  (default) free, unofficial, ~15-min delayed
 *   MARKET_DATA_PROVIDER=groww  needs Groww's paid Trading API subscription
 *                               for live-data/historical roles on the key
 *
 * DEMO_AS_OF overrides the choice for live quotes, which are replayed from the
 * stored bars of that real session (services/demo/provider.ts). Historical
 * candle reads for the CHART endpoint also read the replayed dataset in demo
 * mode, so the chart and the quote agree on the same past (the demo provider
 * comment). Seeding — `npm run demo:seed` — still calls the live provider
 * directly, because that is how the demo data gets collected in the first
 * place.
 */
export type ProviderName = 'yahoo' | 'groww';

/** Unified candle shape every provider returns (and demo reads back from its seed). */
export type DailyCandle = {
    tradeDate: string; // IST date, YYYY-MM-DD
    openPaise: number;
    highPaise: number;
    lowPaise: number;
    closePaise: number;
    volume: number;
};

export function activeProvider(): ProviderName {
    const v = (process.env.MARKET_DATA_PROVIDER || 'yahoo').toLowerCase();
    if (v !== 'yahoo' && v !== 'groww') {
        throw new Error(`MARKET_DATA_PROVIDER must be "yahoo" or "groww", got "${v}"`);
    }
    return v;
}

export function fetchQuote(instrumentId: string): Promise<NormalizedQuote> {
    if (DEMO) return fetchDemoQuote(instrumentId);
    return activeProvider() === 'groww' ? fetchGrowwQuote(instrumentId) : fetchYahooQuote(instrumentId);
}

export function fetchDailyCandles(instrumentId: string, from: Date, to: Date): Promise<DailyCandle[]> {
    if (DEMO) return fetchDemoDailyCandles(instrumentId, from, to);
    return activeProvider() === 'groww'
        ? fetchGrowwDailyCandles(instrumentId, from, to)
        : fetchYahooDailyCandles(instrumentId, from, to);
}
