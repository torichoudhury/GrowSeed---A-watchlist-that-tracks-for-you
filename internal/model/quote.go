package model

import "time"

type MarketStatus string

const (
    StatusPreMarket  MarketStatus = "PRE_MARKET"
    StatusOpen       MarketStatus = "OPEN"
    StatusClosed     MarketStatus = "CLOSED"
    StatusPostMarket MarketStatus = "POST_MARKET"
    StatusUnknown    MarketStatus = "UNKNOWN"
)

type NormalizedQuote struct {
    InstrumentID       string       `json:"instrumentId"`
    LastPricePaise     int64        `json:"lastPricePaise"`
    PreviousClosePaise int64        `json:"previousClosePaise"`
    OpenPaise          int64        `json:"openPaise"`
    HighPaise          int64        `json:"highPaise"`
    LowPaise           int64        `json:"lowPaise"`
    Volume             int64        `json:"volume"`
    DataTimestamp      time.Time    `json:"dataTimestamp"`
    RetrievedAt        time.Time    `json:"retrievedAt"`
    MarketStatus       MarketStatus `json:"marketStatus"`
    Source             string       `json:"source"`
}

type Candle struct {
    TradeDate             time.Time
    OpenPaise, HighPaise, LowPaise, ClosePaise int64
    Volume                int64
}

type InstrumentRef struct {
    InstrumentID string
    Symbol       string
    Exchange     string
    Name         string
}
