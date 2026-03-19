-- Add HMAC blind index columns
-- Uses renamed table names (people/person_identifiers) if rename already applied
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS identifier_hash text;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'person_identifiers') THEN
    ALTER TABLE person_identifiers ADD COLUMN IF NOT EXISTS identifier_value_hash text;
  ELSIF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'contact_identifiers') THEN
    ALTER TABLE contact_identifiers ADD COLUMN IF NOT EXISTS identifier_value_hash text;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'people') THEN
    ALTER TABLE people ADD COLUMN IF NOT EXISTS display_name_hash text;
  ELSIF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'contacts') THEN
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS display_name_hash text;
  END IF;
END $$;
ALTER TABLE memory_banks ADD COLUMN IF NOT EXISTS name_hash text;

-- Add factuality_label column (plaintext, for SQL aggregation)
ALTER TABLE memories ADD COLUMN IF NOT EXISTS factuality_label text;

-- Change factuality from jsonb to text (will hold encrypted JSON string)
ALTER TABLE memories ALTER COLUMN factuality TYPE text USING factuality::text;
ALTER TABLE memories ALTER COLUMN factuality SET DEFAULT '{"label":"UNVERIFIED","confidence":0.5,"rationale":"Pending evaluation"}';

-- Create indexes on hash columns
CREATE INDEX IF NOT EXISTS idx_accounts_identifier_hash ON accounts(identifier_hash);
CREATE INDEX IF NOT EXISTS idx_memory_banks_name_hash ON memory_banks(name_hash);
CREATE INDEX IF NOT EXISTS idx_memories_factuality_label ON memories(factuality_label);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'person_identifiers') THEN
    CREATE INDEX IF NOT EXISTS idx_person_identifiers_value_hash ON person_identifiers(identifier_value_hash);
  ELSIF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'contact_identifiers') THEN
    CREATE INDEX IF NOT EXISTS idx_contact_identifiers_value_hash ON contact_identifiers(identifier_value_hash);
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'people') THEN
    CREATE INDEX IF NOT EXISTS idx_people_display_name_hash ON people(display_name_hash);
  ELSIF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'contacts') THEN
    CREATE INDEX IF NOT EXISTS idx_contacts_display_name_hash ON contacts(display_name_hash);
  END IF;
END $$;

-- Drop old plaintext indexes (they become useless after encryption)
DROP INDEX IF EXISTS idx_contacts_display_name;
DROP INDEX IF EXISTS idx_contact_identifiers_value;
DROP INDEX IF EXISTS idx_contact_identifiers_value_hash;
DROP INDEX IF EXISTS idx_contacts_display_name_hash;
