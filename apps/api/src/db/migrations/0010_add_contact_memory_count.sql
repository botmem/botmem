-- Add memory_count column to contacts for fast sorting without JOIN
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS memory_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_contacts_memory_count ON contacts (memory_count);

-- Backfill from existing memory_contacts
UPDATE contacts SET memory_count = (
  SELECT COUNT(*) FROM memory_contacts WHERE memory_contacts.contact_id = contacts.id
);
