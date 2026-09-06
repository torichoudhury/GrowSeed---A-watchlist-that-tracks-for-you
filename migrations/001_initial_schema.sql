CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE instruments (
  instrument_id TEXT PRIMARY KEY,              -- 'NSE:RELIANCE' format
  symbol        TEXT NOT NULL,
  exchange      TEXT NOT NULL,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | SUSPENDED | DELISTED
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_instruments_symbol ON instruments(symbol);

CREATE TABLE watchlists (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_watchlists_user ON watchlists(user_id);

CREATE TABLE watchlist_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  watchlist_id  UUID NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
  instrument_id TEXT NOT NULL REFERENCES instruments(instrument_id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(watchlist_id, instrument_id)
);
CREATE INDEX idx_items_watchlist ON watchlist_items(watchlist_id);

CREATE TABLE user_stock_state (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instrument_id            TEXT NOT NULL REFERENCES instruments(instrument_id),
  last_seen_price_paise    BIGINT NOT NULL,
  last_seen_volume         BIGINT NOT NULL,
  last_seen_at             TIMESTAMPTZ NOT NULL,
  last_seen_data_timestamp TIMESTAMPTZ NOT NULL,
  is_initial_state         BOOLEAN NOT NULL DEFAULT true,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, instrument_id)
);

CREATE TABLE market_snapshots (
  id                   BIGSERIAL PRIMARY KEY,
  instrument_id        TEXT NOT NULL REFERENCES instruments(instrument_id),
  price_paise          BIGINT NOT NULL,
  open_paise           BIGINT NOT NULL,
  high_paise           BIGINT NOT NULL,
  low_paise            BIGINT NOT NULL,
  previous_close_paise BIGINT NOT NULL,
  volume               BIGINT NOT NULL,
  market_status        TEXT NOT NULL,
  data_timestamp       TIMESTAMPTZ NOT NULL,
  retrieved_at         TIMESTAMPTZ NOT NULL,
  data_source          TEXT NOT NULL
);
CREATE INDEX idx_snapshots_instr_ts ON market_snapshots(instrument_id, data_timestamp DESC);

CREATE TABLE daily_candles (
  instrument_id  TEXT NOT NULL REFERENCES instruments(instrument_id),
  trade_date     DATE NOT NULL,
  open_paise     BIGINT NOT NULL,
  high_paise     BIGINT NOT NULL,
  low_paise      BIGINT NOT NULL,
  close_paise    BIGINT NOT NULL,
  volume         BIGINT NOT NULL,
  PRIMARY KEY (instrument_id, trade_date)
);

CREATE TABLE stock_statistics (
  instrument_id             TEXT PRIMARY KEY REFERENCES instruments(instrument_id),
  avg_volume_7d             BIGINT NOT NULL DEFAULT 0,
  avg_volume_30d            BIGINT NOT NULL DEFAULT 0,
  median_abs_return_bps_30d INTEGER NOT NULL DEFAULT 0,
  mad_abs_return_bps_30d    INTEGER NOT NULL DEFAULT 0,
  median_volume_30d         BIGINT NOT NULL DEFAULT 0,
  mad_volume_30d            BIGINT NOT NULL DEFAULT 0,
  high_7d_paise             BIGINT,
  low_7d_paise              BIGINT,
  high_30d_paise            BIGINT,
  low_30d_paise             BIGINT,
  high_52w_paise            BIGINT,
  low_52w_paise             BIGINT,
  trading_days_observed     INTEGER NOT NULL DEFAULT 0,
  has_7d_window             BOOLEAN NOT NULL DEFAULT false,
  has_30d_window            BOOLEAN NOT NULL DEFAULT false,
  has_52w_window            BOOLEAN NOT NULL DEFAULT false,
  calculated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_alerts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  watchlist_id       UUID NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
  instrument_id      TEXT NOT NULL REFERENCES instruments(instrument_id),
  price_above_paise  BIGINT,
  price_below_paise  BIGINT,
  enabled            BOOLEAN NOT NULL DEFAULT true,
  armed_above        BOOLEAN NOT NULL DEFAULT true,
  armed_below        BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_alerts_user_instr ON user_alerts(user_id, instrument_id);

CREATE TABLE market_events (
  id             BIGSERIAL PRIMARY KEY,
  instrument_id  TEXT NOT NULL REFERENCES instruments(instrument_id),
  event_type     TEXT NOT NULL,
  severity       TEXT NOT NULL,
  value_bps      INTEGER,
  detected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata       JSONB
);
CREATE INDEX idx_events_instr_ts ON market_events(instrument_id, detected_at DESC);
