-- GeoNames offline geodecoding: cube + earthdistance extensions + geodata_places table
CREATE EXTENSION IF NOT EXISTS cube;
CREATE EXTENSION IF NOT EXISTS earthdistance;

CREATE TABLE IF NOT EXISTS geodata_places (
  id INTEGER PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  country_code CHAR(2) NOT NULL,
  admin1_code VARCHAR(20),
  admin1_name VARCHAR(200),
  admin2_code VARCHAR(80),
  admin2_name VARCHAR(200),
  alternate_names TEXT,
  modification_date DATE NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_geodata_earthcoord
  ON geodata_places USING gist (ll_to_earth(latitude, longitude));
