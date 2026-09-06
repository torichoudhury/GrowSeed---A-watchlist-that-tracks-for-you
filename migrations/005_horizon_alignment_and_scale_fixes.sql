-- 005: fixes for three measurement bugs found auditing the model.
--
-- 1. HORIZON WINDOW OFF BY ONE. `close_5d_ago_paise` is the close five
--    sessions before the LAST STORED CANDLE. During a live session the last
--    candle is yesterday, so pairing it with the live quote measured SIX
--    sessions and compared the result against a distribution of FIVE-session
--    moves — a systematic ~9.5% inflation of every weekly and monthly return
--    for the whole trading day (√(6/5) under random-walk scaling). Storing the
--    N-1 close as well lets the metric pick the right base depending on
--    whether the stats row already contains today.
--
-- 2. STREAK DOUBLE COUNT. `streak_days` includes the last stored candle. After
--    the 15:45 rollup and 16:00 recalc that candle IS today, but the live
--    quote's previous close is still yesterday's — so today's direction was
--    added twice and a four-day run reported as five. `last_candle_date` is
--    what tells the two situations apart.
--
-- 3. WRONG SCALE IN A COLUMN NAME. `vix_pctile_1y_x100` holds the percentile
--    scaled by 10000, not 100 (writer: round(fraction * 10000)). The pipeline
--    is self-consistent, so nothing is visibly wrong today, but the name is a
--    trap for the next reader. Renamed to match reality.

ALTER TABLE stock_statistics
  ADD COLUMN IF NOT EXISTS close_4d_ago_paise  BIGINT,
  ADD COLUMN IF NOT EXISTS close_19d_ago_paise BIGINT,
  ADD COLUMN IF NOT EXISTS last_candle_date    DATE;

ALTER TABLE market_regime
  RENAME COLUMN vix_pctile_1y_x100 TO vix_pctile_1y_x10000;

COMMENT ON COLUMN market_regime.vix_pctile_1y_x10000 IS
  'Percentile of today''s VIX within the trailing year, scaled by 10000 (9438 = 94.38th).';
