package service

import (
    "context"
    "time"

    "github.com/your/project/internal/model"
    "github.com/your/project/internal/provider/groww"
    "github.com/your/project/internal/repository"
)

type MarketService struct {
    provider     groww.MarketDataProvider
    cache        repository.Cache
    redis        repository.RedisClient
    snapshotRepo repository.SnapshotRepository
    publisher    Publisher // Interface to publish to Redis Pub/Sub
}

type Publisher interface {
    PublishTick(ctx context.Context, quote model.NormalizedQuote) error
}

func NewMarketService(
    p groww.MarketDataProvider,
    c repository.Cache,
    r repository.RedisClient,
    sr repository.SnapshotRepository,
    pub Publisher,
) *MarketService {
    return &MarketService{
        provider:     p,
        cache:        c,
        redis:        r,
        snapshotRepo: sr,
        publisher:    pub,
    }
}

// GetQuote checks Redis first. On miss, it acquires a lock so only ONE
// goroutine calls Groww. All others wait and read the result that the
// winner writes. This prevents N concurrent misses → N Groww calls.
func (s *MarketService) GetQuote(ctx context.Context, id string) (model.NormalizedQuote, error) {
    cacheKey := "quote:" + id
    lockKey := "lock:quote:" + id

    // 1. Check cache
    if q, ok := s.cache.Get(ctx, cacheKey); ok {
        return q, nil
    }

    // 2. Try to acquire the single-flight lock (atomic SETNX, expires in 3s)
    acquired, _ := s.redis.SetNX(ctx, lockKey, "1", 3*time.Second)

    if acquired {
        // We won the lock — fetch from Groww, cache the result, release lock
        defer s.redis.Del(ctx, lockKey)
        q, err := s.provider.GetQuote(ctx, id)
        if err != nil {
            return s.fallback(ctx, id)
        }
        s.cache.Set(ctx, cacheKey, q, 30*time.Second)
        if s.publisher != nil {
            _ = s.publisher.PublishTick(ctx, q) // publishes to Redis Pub/Sub for WebSocket gateway
        }
        return q, nil
    }

    // 3. Lost the lock — poll every 100ms for up to 3s for the winner's result
    for i := 0; i < 30; i++ {
        time.Sleep(100 * time.Millisecond)
        if q, ok := s.cache.Get(ctx, cacheKey); ok {
            return q, nil
        }
    }

    // 4. Lock expired and still no result — use fallback
    return s.fallback(ctx, id)
}

// fallback returns the last known snapshot from PostgreSQL with status PROVIDER_DOWN.
// If no snapshot exists either, returns a stub with status DATA_MISSING.
func (s *MarketService) fallback(ctx context.Context, id string) (model.NormalizedQuote, error) {
    snap, err := s.snapshotRepo.GetLatest(ctx, id)
    if err != nil {
        return model.NormalizedQuote{InstrumentID: id, Source: "DATA_MISSING"}, nil
    }
    snap.Source = "PROVIDER_DOWN"
    return snap, nil
}
