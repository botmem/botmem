//! Read-only adapters for device-local message databases.

mod imessage;
mod indexer;
mod whatsapp;

pub use imessage::IMessageAdapter;
pub use indexer::{IndexReport, IndexingError, SourceIndexer, SyncMode};
pub use whatsapp::WhatsAppAdapter;

use crate::state::{SourceCursor, SourceId, SourceReadiness};
use rusqlite::{Connection, DatabaseName, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use thiserror::Error;

const MAX_RECORD_TEXT_BYTES: usize = 20_000;

pub trait SourceAdapter {
    fn source(&self) -> SourceId;
    fn database_path(&self) -> &Path;
    fn probe(&self) -> SourceProbe;
    fn scan(&self, cursor: Option<&SourceCursor>) -> Result<SourceScan, AdapterError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceProbe {
    pub source: SourceId,
    pub readiness: SourceReadiness,
    pub schema: Option<SchemaDescriptor>,
    pub read_only: bool,
    pub reason_code: Option<&'static str>,
}

impl SourceProbe {
    fn unavailable(
        source: SourceId,
        readiness: SourceReadiness,
        reason_code: &'static str,
    ) -> Self {
        Self {
            source,
            readiness,
            schema: None,
            read_only: false,
            reason_code: Some(reason_code),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaDescriptor {
    pub family: &'static str,
    pub version: u16,
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceScan {
    pub schema: SchemaDescriptor,
    pub records: Vec<SourceRecord>,
    pub next_cursor: SourceCursor,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceRecord {
    pub source_id: String,
    pub revision: String,
    pub occurred_at_ms: Option<i64>,
    pub text: String,
    pub thread_id: Option<String>,
    pub thread_title: Option<String>,
    pub participant_id: Option<String>,
    pub authored_by_me: bool,
}

impl SourceRecord {
    pub fn validate(&self) -> Result<(), AdapterError> {
        validate_bounded("sourceId", &self.source_id, 1, 2_048)?;
        validate_bounded("revision", &self.revision, 1, 512)?;
        if self.text.len() > MAX_RECORD_TEXT_BYTES {
            return Err(AdapterError::InvalidData(
                "message text exceeds 20000 bytes".to_owned(),
            ));
        }
        if let Some(value) = &self.thread_id {
            validate_bounded("threadId", value, 1, 1_024)?;
        }
        if let Some(value) = &self.participant_id {
            validate_bounded("participantId", value, 1, 512)?;
        }
        Ok(())
    }

    pub fn payload_json(&self, source: SourceId) -> Result<String, AdapterError> {
        let connector = source.as_str();
        let identifier_kind = match source {
            SourceId::Whatsapp => "provider_user_id",
            SourceId::IMessage
                if self
                    .participant_id
                    .as_deref()
                    .is_some_and(|id| id.contains('@')) =>
            {
                "email"
            }
            SourceId::IMessage => "phone",
        };
        let participants = self
            .participant_id
            .as_ref()
            .map(|durable_id| {
                serde_json::json!([{
                    "durableId": durable_id,
                    "identifiers": [{
                        "kind": identifier_kind,
                        "value": durable_id
                    }]
                }])
            })
            .unwrap_or_else(|| serde_json::json!([]));
        let thread = self.thread_id.as_ref().map(|durable_id| {
            serde_json::json!({
                "durableId": durable_id,
                "title": self.thread_title,
            })
        });
        Ok(serde_json::to_string(&serde_json::json!({
            "ref": format!("{connector}:{}", self.source_id),
            "sourceId": self.source_id,
            "revision": self.revision,
            "connector": connector,
            "occurredAtMs": self.occurred_at_ms,
            "text": self.text,
            "thread": thread,
            "participants": participants,
            "media": [],
            "authoredByMe": self.authored_by_me,
        }))?)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AdapterCursor {
    source: SourceId,
    sort_value: i64,
    row_id: i64,
}

impl AdapterCursor {
    fn initial(source: SourceId) -> Self {
        Self {
            source,
            sort_value: i64::MIN,
            row_id: 0,
        }
    }

    fn parse(source: SourceId, cursor: Option<&SourceCursor>) -> Result<Self, AdapterError> {
        let Some(cursor) = cursor else {
            return Ok(Self::initial(source));
        };
        cursor.validate()?;
        let decoded: Self = serde_json::from_str(&cursor.opaque)
            .map_err(|_| AdapterError::InvalidCursor("cursor payload is invalid".to_owned()))?;
        if decoded.source != source {
            return Err(AdapterError::InvalidCursor(
                "cursor belongs to a different source".to_owned(),
            ));
        }
        Ok(decoded)
    }

    fn encode(self, high_watermark_ms: Option<i64>) -> Result<SourceCursor, AdapterError> {
        Ok(SourceCursor {
            format_version: 1,
            opaque: serde_json::to_string(&self)?,
            high_watermark_ms,
            tie_breaker: Some(self.row_id.to_string()),
        })
    }
}

fn default_path(relative: &str) -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(relative)
}

fn open_source_database(source: SourceId, path: &Path) -> Result<Connection, AdapterError> {
    if !path.exists() {
        return Err(AdapterError::Unavailable {
            connector: source,
            readiness: SourceReadiness::NotInstalled,
            reason_code: "source_not_installed",
        });
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| AdapterError::Unavailable {
        connector: source,
        readiness: SourceReadiness::PermissionRequired,
        reason_code: "source_permission_required",
    })?;
    connection.pragma_update(None, "query_only", true)?;
    if !connection.is_readonly(DatabaseName::Main)? {
        return Err(AdapterError::Invariant(
            "source database was not opened read-only".to_owned(),
        ));
    }
    Ok(connection)
}

fn columns(connection: &Connection, table: &'static str) -> Result<BTreeSet<String>, AdapterError> {
    let mut statement = connection.prepare("SELECT name FROM pragma_table_info(?1)")?;
    let rows = statement.query_map([table], |row| row.get::<_, String>(0))?;
    rows.collect::<Result<BTreeSet<_>, _>>()
        .map_err(AdapterError::from)
}

fn schema_fingerprint(
    connection: &Connection,
    tables: &[&'static str],
) -> Result<String, AdapterError> {
    let mut schema = BTreeMap::new();
    for table in tables {
        schema.insert(*table, columns(connection, table)?);
    }
    let canonical = serde_json::to_vec(&schema)?;
    Ok(hex_digest(&Sha256::digest(&canonical)))
}

fn contains_all(columns: &BTreeSet<String>, required: &[&str]) -> bool {
    required.iter().all(|column| columns.contains(*column))
}

fn stable_revision(parts: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part);
    }
    hex_digest(&hasher.finalize())
}

fn hex_digest(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(&mut output, "{byte:02x}");
    }
    output
}

fn probe_error(source: SourceId, error: AdapterError) -> SourceProbe {
    match error {
        AdapterError::Unavailable {
            readiness,
            reason_code,
            ..
        } => SourceProbe::unavailable(source, readiness, reason_code),
        AdapterError::UnsupportedSchema { .. } => SourceProbe::unavailable(
            source,
            SourceReadiness::SchemaUnsupported,
            "source_schema_unsupported",
        ),
        _ => SourceProbe::unavailable(source, SourceReadiness::Error, "source_probe_failed"),
    }
}

fn validate_bounded(
    field: &str,
    value: &str,
    minimum: usize,
    maximum: usize,
) -> Result<(), AdapterError> {
    let length = value.chars().count();
    if length < minimum || length > maximum {
        return Err(AdapterError::InvalidData(format!(
            "{field} must contain {minimum}..={maximum} characters"
        )));
    }
    Ok(())
}

#[derive(Debug, Error)]
pub enum AdapterError {
    #[error("source {connector} is unavailable: {reason_code}")]
    Unavailable {
        connector: SourceId,
        readiness: SourceReadiness,
        reason_code: &'static str,
    },
    #[error("source {connector} has unsupported schema fingerprint {fingerprint}")]
    UnsupportedSchema {
        connector: SourceId,
        fingerprint: String,
    },
    #[error("invalid source cursor: {0}")]
    InvalidCursor(String),
    #[error("invalid source data: {0}")]
    InvalidData(String),
    #[error("source adapter invariant failed: {0}")]
    Invariant(String),
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    State(#[from] crate::state::StateError),
}
