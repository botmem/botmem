-- Tighten the people hot path used by memory ingestion.
--
-- Older encrypted rows used randomized ciphertext in identifier_value, so the
-- historical unique index on (person_id, identifier_type, identifier_value)
-- does not protect against duplicate logical identifiers. Deduplicate first,
-- then enforce uniqueness on the HMAC blind index used for lookups.

DELETE FROM person_identifiers pi
USING person_identifiers newer
WHERE pi.ctid < newer.ctid
  AND pi.person_id = newer.person_id
  AND pi.identifier_type = newer.identifier_type
  AND pi.identifier_value_hash IS NOT NULL
  AND newer.identifier_value_hash IS NOT NULL
  AND pi.identifier_value_hash = newer.identifier_value_hash;

CREATE INDEX IF NOT EXISTS idx_person_identifiers_lookup
  ON person_identifiers(identifier_type, identifier_value_hash, person_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_person_identifiers_unique_hash
  ON person_identifiers(person_id, identifier_type, identifier_value_hash)
  WHERE identifier_value_hash IS NOT NULL;

DELETE FROM memory_people mp
USING memory_people newer
WHERE mp.ctid < newer.ctid
  AND mp.memory_id = newer.memory_id
  AND mp.person_id = newer.person_id
  AND mp.role = newer.role;

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_people_unique
  ON memory_people(memory_id, person_id, role);
