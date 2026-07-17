-- Quest points on players row (synced from RuneLite VarPlayer.QUEST_POINTS)

ALTER TABLE players
    ADD COLUMN IF NOT EXISTS quest_points integer;
