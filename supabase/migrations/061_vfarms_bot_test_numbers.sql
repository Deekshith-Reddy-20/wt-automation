-- ============================================================
-- 061: V-Farms bot test allowlist
--
-- While property_settings.test_mode is on, the WhatsApp bot records its
-- replies in the inbox without sending them, except to the staff phone
-- numbers listed here (E.164), so the owner can try the bot end-to-end
-- from their own phone without messaging real guests.
-- ============================================================

ALTER TABLE property_settings
  ADD COLUMN IF NOT EXISTS test_phone_numbers TEXT[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'property_settings_test_numbers_e164') THEN
    ALTER TABLE property_settings ADD CONSTRAINT property_settings_test_numbers_e164
      CHECK (array_to_string(test_phone_numbers, ',') ~ '^(\+[1-9][0-9]{7,14}(,\+[1-9][0-9]{7,14})*)?$');
  END IF;
END $$;
