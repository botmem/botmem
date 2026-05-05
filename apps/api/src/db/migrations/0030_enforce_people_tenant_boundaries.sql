CREATE OR REPLACE FUNCTION enforce_memory_people_same_user()
RETURNS trigger AS $$
DECLARE
  person_user_id text;
  memory_user_id text;
BEGIN
  SELECT user_id INTO person_user_id
  FROM people
  WHERE id = NEW.person_id;

  SELECT a.user_id INTO memory_user_id
  FROM memories m
  JOIN accounts a ON a.id = m.account_id
  WHERE m.id = NEW.memory_id;

  IF person_user_id IS NULL OR memory_user_id IS NULL OR person_user_id IS DISTINCT FROM memory_user_id THEN
    RAISE EXCEPTION 'memory_people tenant boundary violation: person % user %, memory % user %',
      NEW.person_id, person_user_id, NEW.memory_id, memory_user_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_memory_people_same_user ON memory_people;
CREATE TRIGGER trg_memory_people_same_user
BEFORE INSERT OR UPDATE ON memory_people
FOR EACH ROW
EXECUTE FUNCTION enforce_memory_people_same_user();

CREATE OR REPLACE FUNCTION enforce_person_relationships_same_user()
RETURNS trigger AS $$
DECLARE
  source_user_id text;
  target_user_id text;
BEGIN
  SELECT user_id INTO source_user_id
  FROM people
  WHERE id = NEW.source_person_id;

  SELECT user_id INTO target_user_id
  FROM people
  WHERE id = NEW.target_person_id;

  IF NEW.user_id IS NULL
    OR source_user_id IS NULL
    OR target_user_id IS NULL
    OR NEW.user_id IS DISTINCT FROM source_user_id
    OR NEW.user_id IS DISTINCT FROM target_user_id THEN
    RAISE EXCEPTION 'person_relationships tenant boundary violation: row user %, source % user %, target % user %',
      NEW.user_id, NEW.source_person_id, source_user_id, NEW.target_person_id, target_user_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_person_relationships_same_user ON person_relationships;
CREATE TRIGGER trg_person_relationships_same_user
BEFORE INSERT OR UPDATE ON person_relationships
FOR EACH ROW
EXECUTE FUNCTION enforce_person_relationships_same_user();
