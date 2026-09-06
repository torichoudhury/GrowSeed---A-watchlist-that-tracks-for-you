-- 002: company-internal events, sector mapping, and the statistics needed for
-- empirical-rarity + market-model scoring. All money in paise, all
-- percentages in basis points; dimensionless ratios (beta, correlation) are
-- stored as integers scaled by 10000 so no float column exists anywhere.

-- Stock -> industry/sector, from NSE's published Nifty 500 constituents file.
CREATE TABLE IF NOT EXISTS stock_sectors (
  instrument_id    TEXT PRIMARY KEY REFERENCES instruments(instrument_id),
  industry         TEXT NOT NULL,                              -- NSE's Industry label
  sector_index_id  TEXT REFERENCES instruments(instrument_id), -- e.g. NSE:NIFTYIT; NULL = no matching index
  source           TEXT NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Company-internal events: corporate actions and the results calendar.
CREATE TABLE IF NOT EXISTS corporate_events (
  id                 BIGSERIAL PRIMARY KEY,
  instrument_id      TEXT NOT NULL REFERENCES instruments(instrument_id),
  event_type         TEXT NOT NULL,        -- SPLIT | BONUS | DIVIDEND | RESULTS | OTHER
  event_date         DATE NOT NULL,        -- ex-date for corporate actions, meeting date for results
  ratio_num          INTEGER,              -- BONUS: new shares per ratio_den old; SPLIT: new face value
  ratio_den          INTEGER,              -- BONUS: old shares;                   SPLIT: old face value
  amount_paise       BIGINT,               -- DIVIDEND per share
  subject            TEXT NOT NULL,        -- raw source text, kept for explanations/audit
  source             TEXT NOT NULL,        -- NSE_CA | NSE_EVENT_CAL | NSE_ANN | INFERRED
  applied_to_history BOOLEAN NOT NULL DEFAULT false,  -- price re-basing performed for SPLIT/BONUS
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (instrument_id, event_type, event_date, subject)
);
CREATE INDEX IF NOT EXISTS idx_corp_events_instr_date ON corporate_events(instrument_id, event_date DESC);

-- Statistics upgrade (BUILD_SPEC §6 extended).
ALTER TABLE stock_statistics
  -- Empirical distribution of |daily return| over the trailing year: the
  -- stock's own definition of "unusual" (distribution-free, fat-tail safe).
  ADD COLUMN IF NOT EXISTS abs_return_p90_bps        INTEGER,
  ADD COLUMN IF NOT EXISTS abs_return_p95_bps        INTEGER,
  ADD COLUMN IF NOT EXISTS abs_return_p98_bps        INTEGER,
  ADD COLUMN IF NOT EXISTS abs_return_p99_bps        INTEGER,
  ADD COLUMN IF NOT EXISTS abs_return_max_bps        INTEGER,
  ADD COLUMN IF NOT EXISTS volume_p90                BIGINT,
  ADD COLUMN IF NOT EXISTS volume_p95                BIGINT,
  ADD COLUMN IF NOT EXISTS volume_p99                BIGINT,
  -- Volatility at several horizons; EWMA (lambda 0.94) is the fast estimator,
  -- 90d median/MAD the slow robust one. Their ratio flags regime shifts.
  ADD COLUMN IF NOT EXISTS ewma_vol_bps              INTEGER,
  ADD COLUMN IF NOT EXISTS realized_vol_7d_bps       INTEGER,
  ADD COLUMN IF NOT EXISTS realized_vol_30d_bps      INTEGER,
  ADD COLUMN IF NOT EXISTS realized_vol_90d_bps      INTEGER,
  ADD COLUMN IF NOT EXISTS median_abs_return_bps_90d INTEGER,
  ADD COLUMN IF NOT EXISTS mad_abs_return_bps_90d    INTEGER,
  -- Market model (rolling OLS vs benchmark and vs sector index).
  ADD COLUMN IF NOT EXISTS beta_market_x10000        INTEGER,
  ADD COLUMN IF NOT EXISTS alpha_market_bps          INTEGER,
  ADD COLUMN IF NOT EXISTS resid_mad_market_bps      INTEGER,
  ADD COLUMN IF NOT EXISTS beta_sector_x10000        INTEGER,
  ADD COLUMN IF NOT EXISTS alpha_sector_bps          INTEGER,
  ADD COLUMN IF NOT EXISTS resid_mad_sector_bps      INTEGER,
  ADD COLUMN IF NOT EXISTS corr_sector_x10000        INTEGER,
  -- Path state as of the last candle.
  ADD COLUMN IF NOT EXISTS last_close_paise          BIGINT,
  ADD COLUMN IF NOT EXISTS streak_days               INTEGER,   -- signed run length: +3 = three up days
  ADD COLUMN IF NOT EXISTS drawdown_from_30d_high_bps INTEGER,
  ADD COLUMN IF NOT EXISTS runup_from_30d_low_bps    INTEGER,
  ADD COLUMN IF NOT EXISTS mean_return_5d_bps        INTEGER,   -- for the two-window level-shift test
  ADD COLUMN IF NOT EXISTS mean_return_30d_bps       INTEGER;

-- Benchmark-level regime, recomputed by the daily stats job. Elevated market
-- volatility raises the bar for stock-level alarms (a crash day must not
-- read as ten independent CRITICALs).
CREATE TABLE IF NOT EXISTS market_regime (
  benchmark_id            TEXT PRIMARY KEY REFERENCES instruments(instrument_id),
  realized_vol_20d_bps    INTEGER NOT NULL,
  realized_vol_250d_bps   INTEGER NOT NULL,
  vix_level_x100          INTEGER,           -- India VIX * 100
  vix_pctile_1y_x100      INTEGER,           -- percentile of today's VIX within trailing year, *100
  calculated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
