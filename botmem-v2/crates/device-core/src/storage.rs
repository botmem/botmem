use crate::state::{SourceCheckpoint, SourceId, SourceReadiness, SourceStatus, StateError};
use rusqlite::{
    functions::FunctionFlags, params, Connection, OpenFlags, OptionalExtension, Transaction,
};
use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

const DATABASE_FILE: &str = "index.sqlite3";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StagedGeneration {
    pub source: SourceId,
    pub generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveDocument {
    pub source_id: String,
    pub revision: String,
    pub occurred_at_ms: Option<i64>,
    pub searchable_text: String,
    pub payload_json: String,
}

/// SQLite-backed local state. Mutable callers must hold [`crate::EngineLock`]
/// while an instance is open. The outbound helper uses [`Self::open_readonly`]
/// and can never become a second writer or generation owner.
pub struct DeviceStore {
    root: PathBuf,
    read_only: bool,
    pub(crate) connection: Connection,
}

impl DeviceStore {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, StoreError> {
        let root = root.as_ref();
        ensure_private_directory(root)?;
        let database_path = root.join(DATABASE_FILE);
        ensure_private_file(&database_path)?;

        let connection = Connection::open(&database_path)?;
        connection.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             PRAGMA busy_timeout = 5000;",
        )?;
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS source_state (
               source TEXT PRIMARY KEY,
               readiness TEXT NOT NULL,
               active_generation INTEGER,
               staging_generation INTEGER,
               checkpoint_json TEXT,
               last_error TEXT,
               updated_at_ms INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS generations (
               source TEXT NOT NULL,
               generation INTEGER NOT NULL,
               state TEXT NOT NULL CHECK(state IN ('staging', 'active', 'retired', 'failed')),
               started_at_ms INTEGER NOT NULL,
               completed_at_ms INTEGER,
               failure_code TEXT,
               PRIMARY KEY (source, generation)
             );
             CREATE TABLE IF NOT EXISTS documents (
               source TEXT NOT NULL,
               generation INTEGER NOT NULL,
               source_id TEXT NOT NULL,
               revision TEXT NOT NULL,
               occurred_at_ms INTEGER,
               searchable_text TEXT NOT NULL,
               payload_json TEXT NOT NULL,
               PRIMARY KEY (source, generation, source_id),
               FOREIGN KEY (source, generation)
                 REFERENCES generations(source, generation) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS documents_generation_idx
               ON documents(source, generation);
             CREATE TABLE IF NOT EXISTS local_schema_metadata (
               name TEXT PRIMARY KEY,
               value TEXT NOT NULL
             );",
        )?;
        connection.create_scalar_function(
            "botmem_normalize_search_text",
            1,
            FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_UTF8,
            |context| {
                let value = context.get::<String>(0)?;
                Ok(crate::search::normalize_search_text(&value))
            },
        )?;
        register_search_functions(&connection)?;
        ensure_fts_schema(&connection)?;

        let store = Self {
            root: root.to_owned(),
            read_only: false,
            connection,
        };
        store.enforce_permissions()?;
        for source in SourceId::ALL {
            store.ensure_source(source)?;
        }
        Ok(store)
    }

    /// Opens the active index for the outbound search helper without any
    /// schema, state, journal, or permission mutation. The signed app remains
    /// the sole writer and generation owner.
    pub fn open_readonly(root: impl AsRef<Path>) -> Result<Self, StoreError> {
        let root = root.as_ref();
        require_private_directory(root)?;
        let database_path = root.join(DATABASE_FILE);
        require_private_file(&database_path)?;
        let connection = Connection::open_with_flags(
            &database_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA query_only = ON;
             PRAGMA busy_timeout = 5000;",
        )?;
        connection.create_scalar_function(
            "botmem_normalize_search_text",
            1,
            FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_UTF8,
            |context| {
                let value = context.get::<String>(0)?;
                Ok(crate::search::normalize_search_text(&value))
            },
        )?;
        register_search_functions(&connection)?;
        require_fts_schema(&connection)?;
        Ok(Self {
            root: root.to_owned(),
            read_only: true,
            connection,
        })
    }

    pub fn status(&self, source: SourceId) -> Result<SourceStatus, StoreError> {
        if !self.read_only {
            self.ensure_source(source)?;
        }
        let row = self.connection.query_row(
            "SELECT readiness, active_generation, staging_generation,
                    checkpoint_json, last_error
               FROM source_state WHERE source = ?1",
            [source.as_str()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<u64>>(1)?,
                    row.get::<_, Option<u64>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )?;
        let checkpoint = row.3.map(|json| serde_json::from_str(&json)).transpose()?;
        Ok(SourceStatus {
            source,
            readiness: SourceReadiness::parse(&row.0)?,
            active_generation: row.1,
            staging_generation: row.2,
            checkpoint,
            last_error: row.4,
        })
    }

    pub fn set_readiness(
        &self,
        source: SourceId,
        next: SourceReadiness,
        reason_code: Option<&str>,
    ) -> Result<(), StoreError> {
        if matches!(next, SourceReadiness::Indexing | SourceReadiness::Ready) {
            return Err(StoreError::Invariant(
                "indexing and ready transitions are controlled by generation operations".to_owned(),
            ));
        }
        validate_reason(reason_code)?;
        let current = self.status(source)?;
        if !current.readiness.can_transition_to(next) {
            return Err(StoreError::InvalidTransition {
                connector: source,
                from: current.readiness,
                to: next,
            });
        }
        if current.staging_generation.is_some() {
            return Err(StoreError::Invariant(
                "cannot change readiness while a generation is staging".to_owned(),
            ));
        }
        self.connection.execute(
            "UPDATE source_state
                SET readiness = ?2, last_error = ?3, updated_at_ms = ?4
              WHERE source = ?1",
            params![source.as_str(), next.as_str(), reason_code, now_ms()?],
        )?;
        Ok(())
    }

    pub fn begin_rebuild(&mut self, source: SourceId) -> Result<StagedGeneration, StoreError> {
        self.begin_generation(source, false)
    }

    /// Starts an incremental generation by copying the current active snapshot.
    /// New or edited rows can then be upserted without exposing a partial view.
    pub fn begin_incremental(&mut self, source: SourceId) -> Result<StagedGeneration, StoreError> {
        if self.status(source)?.active_generation.is_none() {
            return self.begin_rebuild(source);
        }
        self.begin_generation(source, true)
    }

    fn begin_generation(
        &mut self,
        source: SourceId,
        copy_active: bool,
    ) -> Result<StagedGeneration, StoreError> {
        let transaction = self.connection.transaction()?;
        let (readiness, staging): (String, Option<u64>) = transaction.query_row(
            "SELECT readiness, staging_generation FROM source_state WHERE source = ?1",
            [source.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let readiness = SourceReadiness::parse(&readiness)?;
        if staging.is_some() {
            return Err(StoreError::RebuildAlreadyRunning(source));
        }
        if !readiness.can_transition_to(SourceReadiness::Indexing) {
            return Err(StoreError::InvalidTransition {
                connector: source,
                from: readiness,
                to: SourceReadiness::Indexing,
            });
        }
        let generation = transaction.query_row(
            "SELECT COALESCE(MAX(generation), 0) + 1
               FROM generations WHERE source = ?1",
            [source.as_str()],
            |row| row.get::<_, u64>(0),
        )?;
        let timestamp = now_ms()?;
        transaction.execute(
            "INSERT INTO generations(source, generation, state, started_at_ms)
             VALUES (?1, ?2, 'staging', ?3)",
            params![source.as_str(), generation, timestamp],
        )?;
        transaction.execute(
            "UPDATE source_state
                SET readiness = 'indexing', staging_generation = ?2,
                    last_error = NULL, updated_at_ms = ?3
              WHERE source = ?1",
            params![source.as_str(), generation, timestamp],
        )?;
        if copy_active {
            transaction.execute(
                "INSERT INTO documents(
                   source, generation, source_id, revision, occurred_at_ms,
                   searchable_text, payload_json
                 )
                 SELECT d.source, ?2, d.source_id, d.revision, d.occurred_at_ms,
                        d.searchable_text, d.payload_json
                   FROM documents d
                   JOIN source_state s
                     ON s.source = d.source AND s.active_generation = d.generation
                  WHERE d.source = ?1",
                params![source.as_str(), generation],
            )?;
            transaction.execute(
                "INSERT OR IGNORE INTO document_tokens(document_rowid, token)
                 SELECT fresh.rowid, token.token
                   FROM documents fresh
                   JOIN documents previous
                     ON previous.source = fresh.source
                    AND previous.source_id = fresh.source_id
                   JOIN source_state state
                     ON state.source = previous.source
                    AND state.active_generation = previous.generation
                   JOIN document_tokens token
                     ON token.document_rowid = previous.rowid
                  WHERE fresh.source = ?1 AND fresh.generation = ?2",
                params![source.as_str(), generation],
            )?;
        }
        transaction.commit()?;
        Ok(StagedGeneration { source, generation })
    }

    pub fn stage_document(
        &self,
        staged: StagedGeneration,
        document: &StagedDocument<'_>,
    ) -> Result<(), StoreError> {
        document.validate()?;
        let is_staging = self.connection.query_row(
            "SELECT EXISTS(
               SELECT 1 FROM generations
                WHERE source = ?1 AND generation = ?2 AND state = 'staging'
             )",
            params![staged.source.as_str(), staged.generation],
            |row| row.get::<_, bool>(0),
        )?;
        if !is_staging {
            return Err(StoreError::GenerationNotStaging(staged));
        }
        self.connection.execute(
            "INSERT INTO documents(
               source, generation, source_id, revision, occurred_at_ms,
               searchable_text, payload_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(source, generation, source_id) DO UPDATE SET
               revision = excluded.revision,
               occurred_at_ms = excluded.occurred_at_ms,
               searchable_text = excluded.searchable_text,
               payload_json = excluded.payload_json",
            params![
                staged.source.as_str(),
                staged.generation,
                document.source_id,
                document.revision,
                document.occurred_at_ms,
                document.searchable_text,
                document.payload_json,
            ],
        )?;
        let rowid = self.connection.query_row(
            "SELECT rowid FROM documents
              WHERE source = ?1 AND generation = ?2 AND source_id = ?3",
            params![
                staged.source.as_str(),
                staged.generation,
                document.source_id
            ],
            |row| row.get::<_, i64>(0),
        )?;
        let tokens = crate::search::search_tokens_json(document.searchable_text)?;
        self.connection.execute(
            "DELETE FROM document_tokens WHERE document_rowid = ?1",
            [rowid],
        )?;
        self.connection.execute(
            "INSERT OR IGNORE INTO document_tokens(document_rowid, token)
             SELECT ?1, value FROM json_each(?2)",
            params![rowid, tokens],
        )?;
        self.connection.execute(
            "INSERT OR IGNORE INTO token_bigrams(token, bigram)
             SELECT token.token, bigram.value
               FROM document_tokens token,
                    json_each(botmem_search_bigrams(token.token)) bigram
              WHERE token.document_rowid = ?1",
            [rowid],
        )?;
        Ok(())
    }

    pub fn activate_rebuild(
        &mut self,
        staged: StagedGeneration,
        checkpoint: &SourceCheckpoint,
    ) -> Result<(), StoreError> {
        checkpoint.validate()?;
        let checkpoint_json = serde_json::to_string(checkpoint)?;
        let transaction = self.connection.transaction()?;
        require_staging(&transaction, staged)?;
        let timestamp = now_ms()?;

        transaction.execute(
            "UPDATE generations SET state = 'retired'
              WHERE source = ?1 AND state = 'active'",
            [staged.source.as_str()],
        )?;
        transaction.execute(
            "UPDATE generations
                SET state = 'active', completed_at_ms = ?3
              WHERE source = ?1 AND generation = ?2 AND state = 'staging'",
            params![staged.source.as_str(), staged.generation, timestamp],
        )?;
        transaction.execute(
            "UPDATE source_state
                SET readiness = 'ready', active_generation = ?2,
                    staging_generation = NULL, checkpoint_json = ?3,
                    last_error = NULL, updated_at_ms = ?4
              WHERE source = ?1 AND staging_generation = ?2",
            params![
                staged.source.as_str(),
                staged.generation,
                checkpoint_json,
                timestamp
            ],
        )?;
        // Retired snapshots are no longer needed once the new active pointer
        // is durable. Removing only their documents keeps generation numbers
        // monotonic while preventing stale text from bloating FTS queries.
        transaction.execute(
            "DELETE FROM documents
              WHERE source = ?1 AND generation IN (
                    SELECT generation FROM generations
                     WHERE source = ?1 AND state = 'retired'
              )",
            [staged.source.as_str()],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn fail_rebuild(
        &mut self,
        staged: StagedGeneration,
        reason_code: &str,
    ) -> Result<(), StoreError> {
        validate_reason(Some(reason_code))?;
        let transaction = self.connection.transaction()?;
        require_staging(&transaction, staged)?;
        let timestamp = now_ms()?;
        transaction.execute(
            "UPDATE generations
                SET state = 'failed', completed_at_ms = ?3, failure_code = ?4
              WHERE source = ?1 AND generation = ?2",
            params![
                staged.source.as_str(),
                staged.generation,
                timestamp,
                reason_code
            ],
        )?;
        transaction.execute(
            "UPDATE source_state
                SET readiness = CASE
                      WHEN active_generation IS NULL THEN 'error' ELSE 'ready' END,
                    staging_generation = NULL, last_error = ?3, updated_at_ms = ?4
              WHERE source = ?1 AND staging_generation = ?2",
            params![
                staged.source.as_str(),
                staged.generation,
                reason_code,
                timestamp
            ],
        )?;
        transaction.execute(
            "DELETE FROM documents WHERE source = ?1 AND generation = ?2",
            params![staged.source.as_str(), staged.generation],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn active_document_ids(&self, source: SourceId) -> Result<Vec<String>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT d.source_id
               FROM documents d
               JOIN source_state s
                 ON s.source = d.source AND s.active_generation = d.generation
              WHERE d.source = ?1
              ORDER BY d.source_id",
        )?;
        let rows = statement.query_map([source.as_str()], |row| row.get(0))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn active_documents(&self, source: SourceId) -> Result<Vec<ActiveDocument>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT d.source_id, d.revision, d.occurred_at_ms,
                    d.searchable_text, d.payload_json
               FROM documents d
               JOIN source_state s
                 ON s.source = d.source AND s.active_generation = d.generation
              WHERE d.source = ?1
              ORDER BY d.source_id",
        )?;
        let rows = statement.query_map([source.as_str()], |row| {
            Ok(ActiveDocument {
                source_id: row.get(0)?,
                revision: row.get(1)?,
                occurred_at_ms: row.get(2)?,
                searchable_text: row.get(3)?,
                payload_json: row.get(4)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn staged_document_count(&self, staged: StagedGeneration) -> Result<u64, StoreError> {
        self.connection
            .query_row(
                "SELECT COUNT(*) FROM documents
                  WHERE source = ?1 AND generation = ?2",
                params![staged.source.as_str(), staged.generation],
                |row| row.get(0),
            )
            .map_err(StoreError::from)
    }

    pub fn enforce_permissions(&self) -> Result<(), StoreError> {
        ensure_private_directory(&self.root)?;
        for name in [
            DATABASE_FILE,
            "index.sqlite3-wal",
            "index.sqlite3-shm",
            "engine.lock",
        ] {
            let path = self.root.join(name);
            if path.exists() {
                set_file_private(&path)?;
            }
        }
        Ok(())
    }

    fn ensure_source(&self, source: SourceId) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO source_state(source, readiness, updated_at_ms)
             VALUES (?1, 'disabled', ?2)
             ON CONFLICT(source) DO NOTHING",
            params![source.as_str(), now_ms()?],
        )?;
        Ok(())
    }
}

fn ensure_fts_schema(connection: &Connection) -> Result<(), StoreError> {
    let version = connection
        .query_row(
            "SELECT value FROM local_schema_metadata WHERE name = 'document_fts_schema'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if version.as_deref() == Some("4") {
        return Ok(());
    }
    // Contentless FTS keeps normalized terms without duplicating retrievable
    // message bodies. The documents table remains the sole source of content.
    connection.execute_batch(
        "BEGIN IMMEDIATE;
         DROP TRIGGER IF EXISTS documents_fts_insert;
         DROP TRIGGER IF EXISTS documents_fts_delete;
         DROP TRIGGER IF EXISTS documents_fts_update;
         DROP TRIGGER IF EXISTS documents_tokens_delete;
         DROP TABLE IF EXISTS document_fts;
         DROP TABLE IF EXISTS document_bigrams;
         DROP TABLE IF EXISTS document_tokens;
         DROP TABLE IF EXISTS token_bigrams;
         CREATE VIRTUAL TABLE document_fts USING fts5(
           searchable_text,
           content='',
           tokenize='unicode61 remove_diacritics 2'
         );
         CREATE TABLE document_tokens (
           document_rowid INTEGER NOT NULL,
           token TEXT NOT NULL,
           PRIMARY KEY(document_rowid, token)
         ) WITHOUT ROWID;
         CREATE INDEX document_tokens_lookup
           ON document_tokens(token, document_rowid);
         CREATE TABLE token_bigrams (
           token TEXT NOT NULL,
           bigram TEXT NOT NULL,
           PRIMARY KEY(token, bigram)
         ) WITHOUT ROWID;
         CREATE INDEX token_bigrams_lookup
           ON token_bigrams(bigram, token);
         CREATE TRIGGER documents_fts_insert
         AFTER INSERT ON documents BEGIN
           INSERT INTO document_fts(rowid, searchable_text)
           VALUES (new.rowid, botmem_normalize_search_text(new.searchable_text));
         END;
         CREATE TRIGGER documents_fts_delete
         AFTER DELETE ON documents BEGIN
           INSERT INTO document_fts(document_fts, rowid, searchable_text)
           VALUES (
             'delete', old.rowid,
             botmem_normalize_search_text(old.searchable_text)
           );
           DELETE FROM document_tokens WHERE document_rowid = old.rowid;
         END;
         CREATE TRIGGER documents_fts_update
         AFTER UPDATE OF searchable_text ON documents BEGIN
           INSERT INTO document_fts(document_fts, rowid, searchable_text)
           VALUES (
             'delete', old.rowid,
             botmem_normalize_search_text(old.searchable_text)
           );
           INSERT INTO document_fts(rowid, searchable_text)
           VALUES (new.rowid, botmem_normalize_search_text(new.searchable_text));
         END;
         INSERT INTO document_fts(rowid, searchable_text)
         SELECT rowid, botmem_normalize_search_text(searchable_text) FROM documents;
         INSERT OR IGNORE INTO document_tokens(document_rowid, token)
         SELECT d.rowid, token.value
           FROM documents d, json_each(botmem_search_tokens(d.searchable_text)) token;
         INSERT OR IGNORE INTO token_bigrams(token, bigram)
         SELECT token.token, bigram.value
           FROM (SELECT DISTINCT token FROM document_tokens) token,
                json_each(botmem_search_bigrams(token.token)) bigram;
         INSERT INTO local_schema_metadata(name, value)
         VALUES ('document_fts_schema', '4')
         ON CONFLICT(name) DO UPDATE SET value = excluded.value;
         COMMIT;",
    )?;
    Ok(())
}

fn require_fts_schema(connection: &Connection) -> Result<(), StoreError> {
    let version = connection
        .query_row(
            "SELECT value FROM local_schema_metadata WHERE name = 'document_fts_schema'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if version.as_deref() != Some("4") {
        return Err(StoreError::Invariant(
            "local search schema is not ready".to_owned(),
        ));
    }
    Ok(())
}

fn register_search_functions(connection: &Connection) -> Result<(), StoreError> {
    connection.create_scalar_function(
        "botmem_search_bigrams",
        1,
        FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_UTF8,
        |context| {
            let value = context.get::<String>(0)?;
            crate::search::search_bigrams_json(&value)
                .map_err(|error| rusqlite::Error::UserFunctionError(Box::new(error)))
        },
    )?;
    connection.create_scalar_function(
        "botmem_search_tokens",
        1,
        FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_UTF8,
        |context| {
            let value = context.get::<String>(0)?;
            crate::search::search_tokens_json(&value)
                .map_err(|error| rusqlite::Error::UserFunctionError(Box::new(error)))
        },
    )?;
    connection.create_scalar_function(
        "botmem_token_within",
        3,
        FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_UTF8,
        |context| {
            let query = context.get::<String>(0)?;
            let token = context.get::<String>(1)?;
            let maximum = context.get::<i64>(2)?;
            Ok(maximum >= 0
                && crate::search::within_edit_distance(&query, &token, maximum as usize))
        },
    )?;
    Ok(())
}

pub struct StagedDocument<'a> {
    pub source_id: &'a str,
    pub revision: &'a str,
    pub occurred_at_ms: Option<i64>,
    pub searchable_text: &'a str,
    pub payload_json: &'a str,
}

impl StagedDocument<'_> {
    fn validate(&self) -> Result<(), StoreError> {
        if self.source_id.is_empty() || self.source_id.len() > 2_048 {
            return Err(StoreError::Invariant(
                "source_id must contain 1..=2048 bytes".to_owned(),
            ));
        }
        if self.revision.is_empty() || self.revision.len() > 512 {
            return Err(StoreError::Invariant(
                "revision must contain 1..=512 bytes".to_owned(),
            ));
        }
        if self.searchable_text.len() > 20_000 {
            return Err(StoreError::Invariant(
                "searchable_text exceeds 20000 bytes".to_owned(),
            ));
        }
        serde_json::from_str::<serde_json::Value>(self.payload_json)?;
        Ok(())
    }
}

fn require_staging(
    transaction: &Transaction<'_>,
    staged: StagedGeneration,
) -> Result<(), StoreError> {
    let found = transaction
        .query_row(
            "SELECT state FROM generations
              WHERE source = ?1 AND generation = ?2",
            params![staged.source.as_str(), staged.generation],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if found.as_deref() != Some("staging") {
        return Err(StoreError::GenerationNotStaging(staged));
    }
    let current = transaction.query_row(
        "SELECT staging_generation FROM source_state WHERE source = ?1",
        [staged.source.as_str()],
        |row| row.get::<_, Option<u64>>(0),
    )?;
    if current != Some(staged.generation) {
        return Err(StoreError::GenerationNotStaging(staged));
    }
    Ok(())
}

fn now_ms() -> Result<i64, StoreError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| StoreError::ClockBeforeEpoch)?
        .as_millis()
        .try_into()
        .map_err(|_| StoreError::ClockOverflow)
}

fn validate_reason(reason: Option<&str>) -> Result<(), StoreError> {
    if reason.is_some_and(|value| value.is_empty() || value.len() > 128) {
        return Err(StoreError::Invariant(
            "reason code must contain 1..=128 bytes".to_owned(),
        ));
    }
    Ok(())
}

fn ensure_private_directory(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn require_private_directory(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "index root is not a directory",
        ));
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "index root is not private",
        ));
    }
    Ok(())
}

fn require_private_file(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "index database is not a regular file",
        ));
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "index database is not private",
        ));
    }
    Ok(())
}

fn ensure_private_file(path: &Path) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options.create(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    options.open(path)?;
    set_file_private(path)
}

fn set_file_private(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[derive(Debug, Error)]
pub enum StoreError {
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    State(#[from] StateError),
    #[error("source {connector} cannot transition from {from:?} to {to:?}")]
    InvalidTransition {
        connector: SourceId,
        from: SourceReadiness,
        to: SourceReadiness,
    },
    #[error("source {0} already has a staged generation")]
    RebuildAlreadyRunning(SourceId),
    #[error("generation {0:?} is not the current staged generation")]
    GenerationNotStaging(StagedGeneration),
    #[error("state invariant failed: {0}")]
    Invariant(String),
    #[error("system clock is before the Unix epoch")]
    ClockBeforeEpoch,
    #[error("system clock value exceeds SQLite integer range")]
    ClockOverflow,
}
