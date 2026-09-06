import { NormalizedQuote, MarketStatus, Candle, InstrumentRef } from '../../models/quote';

export interface MarketDataProvider {
    getQuote(instrumentId: string): Promise<NormalizedQuote>;
    getQuotes(instrumentIds: string[]): Promise<{ quotes: NormalizedQuote[], errors: Record<string, Error> }>;
    getHistoricalCandles(instrumentId: string, from: Date, to: Date): Promise<Candle[]>;
    searchInstrument(query: string): Promise<InstrumentRef[]>;
}

export function normalizeRupeesToPaise(rupees: number): number {
    return Math.round(rupees * 100);
}

export function buildInstrumentId(exchange: string, symbol: string): string {
    return `${exchange}:${symbol}`.toUpperCase();
}

export function normalizeQuote(raw: any): NormalizedQuote {
    const retrievedAt = new Date();
    let dataTimestamp = new Date(raw.timestamp);
    
    if (dataTimestamp.getTime() > retrievedAt.getTime()) {
        dataTimestamp = retrievedAt; // Fix clock skew
    }
    
    return {
        instrumentId: buildInstrumentId(raw.exchange, raw.symbol),
        lastPricePaise: normalizeRupeesToPaise(raw.lastPrice),
        previousClosePaise: normalizeRupeesToPaise(raw.previousClose),
        openPaise: normalizeRupeesToPaise(raw.open),
        highPaise: normalizeRupeesToPaise(raw.high),
        lowPaise: normalizeRupeesToPaise(raw.low),
        volume: raw.volume,
        dataTimestamp,
        retrievedAt,
        marketStatus: raw.marketStatus as MarketStatus || MarketStatus.UNKNOWN,
        source: 'groww'
    };
}
