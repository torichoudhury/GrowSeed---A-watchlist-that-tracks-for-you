-- 004: intraday bars, for replaying a real past session as if it were today.
--
-- The demo mode (DEMO_AS_OF) needs the market to MOVE while someone is
-- watching, and the only honest way to do that with month-old data is to
-- store the real intra-session bars of that day and serve them against a
-- shifted clock. These are real Yahoo 5-minute bars: nothing here is
-- synthesised, only replayed.
CREATE TABLE IF NOT EXISTS intraday_bars (
  instrument_id TEXT NOT NULL REFERENCES instruments(instrument_id),
  bar_ts        TIMESTAMPTZ NOT NULL,   -- bar START, exchange time
  open_paise    BIGINT NOT NULL,
  high_paise    BIGINT NOT NULL,
  low_paise     BIGINT NOT NULL,
  close_paise   BIGINT NOT NULL,
  volume        BIGINT NOT NULL,        -- volume IN this bar, not cumulative
  PRIMARY KEY (instrument_id, bar_ts)
);
CREATE INDEX IF NOT EXISTS idx_intraday_instr_ts ON intraday_bars(instrument_id, bar_ts);
