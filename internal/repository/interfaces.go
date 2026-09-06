package repository

import (
    "context"
    "time"
    "github.com/your/project/internal/model"
)

type SnapshotRepository interface {
    GetLatest(ctx context.Context, instrumentID string) (model.NormalizedQuote, error)
    // Other snapshot methods can be added here
}

type RedisClient interface {
    SetNX(ctx context.Context, key string, value interface{}, expiration time.Duration) (bool, error)
    Del(ctx context.Context, keys ...string) error
}

type Cache interface {
    Get(ctx context.Context, key string) (model.NormalizedQuote, bool)
    Set(ctx context.Context, key string, value model.NormalizedQuote, expiration time.Duration)
}
