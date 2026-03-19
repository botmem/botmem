-- Rename tables (skip if already renamed)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='contacts') THEN
    ALTER TABLE contacts RENAME TO people;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='contact_identifiers') THEN
    ALTER TABLE contact_identifiers RENAME TO person_identifiers;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='memory_contacts') THEN
    ALTER TABLE memory_contacts RENAME TO memory_people;
  END IF;
END $$;

-- Rename columns (skip if already renamed)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='merge_dismissals' AND column_name='contact_id_1') THEN
    ALTER TABLE merge_dismissals RENAME COLUMN contact_id_1 TO person_id_1;
    ALTER TABLE merge_dismissals RENAME COLUMN contact_id_2 TO person_id_2;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='person_identifiers' AND column_name='contact_id') THEN
    ALTER TABLE person_identifiers RENAME COLUMN contact_id TO person_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='memory_people' AND column_name='contact_id') THEN
    ALTER TABLE memory_people RENAME COLUMN contact_id TO person_id;
  END IF;
END $$;

-- Rename indexes
ALTER INDEX IF EXISTS idx_contacts_display_name_hash RENAME TO idx_people_display_name_hash;
ALTER INDEX IF EXISTS idx_contacts_user_id RENAME TO idx_people_user_id;
ALTER INDEX IF EXISTS idx_contacts_memory_count RENAME TO idx_people_memory_count;
ALTER INDEX IF EXISTS idx_contact_identifiers_contact_id RENAME TO idx_person_identifiers_person_id;
ALTER INDEX IF EXISTS idx_contact_identifiers_value_hash RENAME TO idx_person_identifiers_value_hash;
ALTER INDEX IF EXISTS idx_contact_identifiers_unique RENAME TO idx_person_identifiers_unique;
ALTER INDEX IF EXISTS idx_memory_contacts_contact_id RENAME TO idx_memory_people_person_id;
ALTER INDEX IF EXISTS idx_memory_contacts_memory_id RENAME TO idx_memory_people_memory_id;
