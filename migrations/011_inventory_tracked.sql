-- Inventory snapshot from the plugin (Sync Bank & Inventory). Stored as JSON
-- on players; the site counts these together with player_bank for ownership,
-- gear, banked XP, Graceful marks, etc.
ALTER TABLE players
    ADD COLUMN IF NOT EXISTS inventory_tracked jsonb NOT NULL DEFAULT '[]'::jsonb;
