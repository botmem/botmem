-- Deduplicate existing contact identifiers before adding unique constraint
DELETE FROM contact_identifiers a
USING contact_identifiers b
WHERE a.id > b.id
  AND a.contact_id = b.contact_id
  AND a.identifier_type = b.identifier_type
  AND a.identifier_value = b.identifier_value;

-- Add unique constraint to prevent duplicate identifiers per contact
CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_identifiers_unique
  ON contact_identifiers (contact_id, identifier_type, identifier_value);
