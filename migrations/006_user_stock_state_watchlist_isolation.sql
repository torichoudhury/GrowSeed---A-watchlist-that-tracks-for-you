-- Truncate existing state to safely apply NOT NULL constraint
TRUNCATE TABLE user_stock_state;

-- Add watchlist_id column
ALTER TABLE user_stock_state
ADD COLUMN watchlist_id UUID REFERENCES watchlists(id) ON DELETE CASCADE;

-- Make watchlist_id NOT NULL
ALTER TABLE user_stock_state
ALTER COLUMN watchlist_id SET NOT NULL;

-- Drop the old unique constraint (user_id, instrument_id)
ALTER TABLE user_stock_state
DROP CONSTRAINT user_stock_state_user_id_instrument_id_key;

-- Add new unique constraint (user_id, watchlist_id, instrument_id)
ALTER TABLE user_stock_state
ADD CONSTRAINT user_stock_state_user_id_watchlist_id_instrument_id_key UNIQUE(user_id, watchlist_id, instrument_id);
