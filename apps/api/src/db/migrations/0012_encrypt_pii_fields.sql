-- Add HMAC blind index columns
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS identifier_hash text;
ALTER TABLE contact_identifiers ADD COLUMN IF NOT EXISTS identifier_value_hash text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS display_name_hash text;
ALTER TABLE memory_banks ADD COLUMN IF NOT EXISTS name_hash text;

-- Add factuality_label column (plaintext, for SQL aggregation)
ALTER TABLE memories ADD COLUMN IF NOT EXISTS factuality_label text;

-- Change factuality from jsonb to text (will hold encrypted JSON string)
ALTER TABLE memories ALTER COLUMN factuality TYPE text USING factuality::text;
ALTER TABLE memories ALTER COLUMN factuality SET DEFAULT '{"label":"UNVERIFIED","confidence":0.5,"rationale":"Pending evaluation"}';

-- Create indexes on hash columns
CREATE INDEX IF NOT EXISTS idx_accounts_identifier_hash ON accounts(identifier_hash);
CREATE INDEX IF NOT EXISTS idx_contact_identifiers_value_hash ON contact_identifiers(identifier_value_hash);
CREATE INDEX IF NOT EXISTS idx_contacts_display_name_hash ON contacts(display_name_hash);
CREATE INDEX IF NOT EXISTS idx_memory_banks_name_hash ON memory_banks(name_hash);
CREATE INDEX IF NOT EXISTS idx_memories_factuality_label ON memories(factuality_label);

-- Drop old plaintext indexes (they become useless after encryption)
DROP INDEX IF EXISTS idx_contacts_display_name;
DROP INDEX IF EXISTS idx_contact_identifiers_value;
