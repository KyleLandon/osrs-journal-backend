-- Public profiles by default (Wise Old Man style); users can opt into private

ALTER TABLE user_characters
    ALTER COLUMN is_public SET DEFAULT true;

-- Existing linked characters: default to public unless already set
UPDATE user_characters SET is_public = true WHERE is_public IS NULL;
