package groww

import (
    "context"
    "math"
    "strings"
    "time"
    "github.com/your/project/internal/model"
)

// GrowwQuoteResponse represents the expected JSON shape from Groww.
// TODO: Update these fields to match the real API response.
type GrowwQuoteResponse struct {
    Symbol        string  `json:"symbol"`
    Exchange      string  `json:"exchange"`
    LastPrice     float64 `json:"lastPrice"`
    PreviousClose float64 `json:"previousClose"`
    Open          float64 `json:"open"`
    High          float64 `json:"high"`
    Low           float64 `json:"low"`
    Volume        int64   `json:"volume"`
    Timestamp     time.Time `json:"timestamp"`
    MarketStatus  string  `json:"marketStatus"`
}

// MarketDataProvider is the interface all code below the adapter layer uses.
type MarketDataProvider interface {
    GetQuote(ctx context.Context, instrumentID string) (model.NormalizedQuote, error)
    GetQuotes(ctx context.Context, instrumentIDs []string) ([]model.NormalizedQuote, map[string]error)
    GetHistoricalCandles(ctx context.Context, instrumentID string, from, to time.Time) ([]model.Candle, error)
    SearchInstrument(ctx context.Context, query string) ([]model.InstrumentRef, error)
}

// normalizeRupeesToPaise converts Groww's float rupee value to integer paise.
func normalizeRupeesToPaise(rupees float64) int64 {
    return int64(math.Round(rupees * 100))
}

// buildInstrumentID constructs the canonical instrument_id from symbol and exchange.
func buildInstrumentID(exchange, symbol string) string {
    return strings.ToUpper(exchange + ":" + symbol)
}

func mapMarketStatus(raw string) model.MarketStatus {
    switch strings.ToUpper(raw) {
    case "OPEN":
        return model.StatusOpen
    case "PRE_MARKET":
        return model.StatusPreMarket
    case "POST_MARKET":
        return model.StatusPostMarket
    case "CLOSED":
        return model.StatusClosed
    default:
        return model.StatusUnknown
    }
}

// normalizeQuote converts Groww's raw response into a NormalizedQuote.
func normalizeQuote(raw GrowwQuoteResponse) model.NormalizedQuote {
    retrievedAt := time.Now().UTC()
    dataTimestamp := raw.Timestamp.UTC()
    if dataTimestamp.After(retrievedAt) {
        dataTimestamp = retrievedAt
    }
    return model.NormalizedQuote{
        InstrumentID:       buildInstrumentID(raw.Exchange, raw.Symbol),
        LastPricePaise:     normalizeRupeesToPaise(raw.LastPrice),
        PreviousClosePaise: normalizeRupeesToPaise(raw.PreviousClose),
        OpenPaise:          normalizeRupeesToPaise(raw.Open),
        HighPaise:          normalizeRupeesToPaise(raw.High),
        LowPaise:           normalizeRupeesToPaise(raw.Low),
        Volume:             raw.Volume,
        DataTimestamp:      dataTimestamp,
        RetrievedAt:        retrievedAt,
        MarketStatus:       mapMarketStatus(raw.MarketStatus),
        Source:             "groww",
    }
}
