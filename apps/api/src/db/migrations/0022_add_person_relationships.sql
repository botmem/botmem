CREATE TABLE IF NOT EXISTS person_relationships (
  id text PRIMARY KEY,
  user_id text,
  source_person_id text NOT NULL REFERENCES people(id),
  target_person_id text NOT NULL REFERENCES people(id),
  relationship_type text NOT NULL,
  connector_type text,
  source_id text NOT NULL,
  confidence double precision NOT NULL DEFAULT 1.0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_person_relationships_user_id ON person_relationships(user_id);
CREATE INDEX IF NOT EXISTS idx_person_relationships_source ON person_relationships(source_person_id);
CREATE INDEX IF NOT EXISTS idx_person_relationships_target ON person_relationships(target_person_id);
CREATE INDEX IF NOT EXISTS idx_person_relationships_type ON person_relationships(relationship_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_person_relationships_unique
  ON person_relationships(source_person_id, target_person_id, relationship_type, connector_type, source_id);
