export enum MarketStatus {
    PRE_MARKET = 'PRE_MARKET',
    OPEN = 'OPEN',
    CLOSED = 'CLOSED',
    POST_MARKET = 'POST_MARKET',
    UNKNOWN = 'UNKNOWN'
}

export interface NormalizedQuote {
    instrumentId: string;
    lastPricePaise: number;
    previousClosePaise: number;
    openPaise: number;
    highPaise: number;
    lowPaise: number;
    volume: number;
    dataTimestamp: Date;
    retrievedAt: Date;
    marketStatus: MarketStatus;
    source: string;
    /** Nominal delay of the feed itself (e.g. 900 for Yahoo's 15-min NSE
     * delay). Freshness bands are judged net of this; absent means real-time. */
    feedDelaySec?: number;
}

export interface Candle {
    tradeDate: Date;
    openPaise: number;
    highPaise: number;
    lowPaise: number;
    closePaise: number;
    volume: number;
}

export interface InstrumentRef {
    instrumentId: string;
    symbol: string;
    exchange: string;
    name: string;
}
