-- 003: horizon-aware statistics + the statistical corporate-action guard.
--
-- Two additions, both in service of "meaningfully changed *since you last
-- checked*":
--
--   1. Multi-session return distributions. "Unusual" only means something
--      relative to a window, and the right window is the user's own checking
--      cadence. A weekly checker's 5-session move is compared with this
--      stock's other 5-session moves — not with daily history, and not with
--      a √t guess (that is the fallback, see metrics.service horizonCutpoints).
--      Windows overlap, so the samples are autocorrelated; they are used only
--      as quantiles of the marginal distribution.
--
--   2. Bookkeeping for the split/bonus guard: how many sessions the estimator
--      threw out as mechanical re-scalings, so a distribution that looks odd
--      can be traced. corporate_events.event_type additionally carries
--      'SUSPECTED_ADJUSTMENT' rows written by `npm run detect:splits`
--      (source = 'STATISTICAL'); they are deliberately NOT in the
--      ('SPLIT','BONUS') set that re-bases stored history, so an inference
--      can never silently rewrite prices — a human promotes it first.

ALTER TABLE stock_statistics
  ADD COLUMN IF NOT EXISTS abs_return_5d_p90_bps     INTEGER,
  ADD COLUMN IF NOT EXISTS abs_return_5d_p95_bps     INTEGER,
  ADD COLUMN IF NOT EXISTS abs_return_5d_p98_bps     INTEGER,
  ADD COLUMN IF NOT EXISTS abs_return_5d_max_bps     INTEGER,
  ADD COLUMN IF NOT EXISTS median_abs_return_5d_bps  INTEGER,
  ADD COLUMN IF NOT EXISTS abs_return_20d_p90_bps    INTEGER,
  ADD COLUMN IF NOT EXISTS abs_return_20d_p95_bps    INTEGER,
  ADD COLUMN IF NOT EXISTS abs_return_20d_p98_bps    INTEGER,
  ADD COLUMN IF NOT EXISTS abs_return_20d_max_bps    INTEGER,
  ADD COLUMN IF NOT EXISTS median_abs_return_20d_bps INTEGER,
  -- Close N sessions before the last stored candle: the baseline a horizon
  -- return is measured from (kept here so a summary request needs no candle read).
  ADD COLUMN IF NOT EXISTS close_5d_ago_paise        BIGINT,
  ADD COLUMN IF NOT EXISTS close_20d_ago_paise       BIGINT,
  ADD COLUMN IF NOT EXISTS ratio_artifacts_excluded  INTEGER NOT NULL DEFAULT 0;
