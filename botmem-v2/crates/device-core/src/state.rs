use serde::{Deserialize, Serialize};
use std::fmt;
use thiserror::Error;

pub const CHECKPOINT_SCHEMA_VERSION: u16 = 1;
const MAX_CURSOR_BYTES: usize = 4_096;
const MAX_TIE_BREAKER_BYTES: usize = 1_024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceId {
    IMessage,
    Whatsapp,
}

impl SourceId {
    pub const ALL: [Self; 2] = [Self::IMessage, Self::Whatsapp];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::IMessage => "imessage",
            Self::Whatsapp => "whatsapp",
        }
    }
}

impl fmt::Display for SourceId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl TryFrom<&str> for SourceId {
    type Error = StateError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "imessage" => Ok(Self::IMessage),
            "whatsapp" => Ok(Self::Whatsapp),
            other => Err(StateError::UnknownSource(other.to_owned())),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceReadiness {
    Disabled,
    NotInstalled,
    PermissionRequired,
    SchemaUnsupported,
    Indexing,
    Ready,
    Error,
}

impl SourceReadiness {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::NotInstalled => "not_installed",
            Self::PermissionRequired => "permission_required",
            Self::SchemaUnsupported => "schema_unsupported",
            Self::Indexing => "indexing",
            Self::Ready => "ready",
            Self::Error => "error",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self, StateError> {
        match value {
            "disabled" => Ok(Self::Disabled),
            "not_installed" => Ok(Self::NotInstalled),
            "permission_required" => Ok(Self::PermissionRequired),
            "schema_unsupported" => Ok(Self::SchemaUnsupported),
            "indexing" => Ok(Self::Indexing),
            "ready" => Ok(Self::Ready),
            "error" => Ok(Self::Error),
            other => Err(StateError::UnknownReadiness(other.to_owned())),
        }
    }

    pub(crate) const fn can_transition_to(self, next: Self) -> bool {
        if self as u8 == next as u8 {
            return true;
        }

        match self {
            Self::Disabled => matches!(
                next,
                Self::NotInstalled
                    | Self::PermissionRequired
                    | Self::SchemaUnsupported
                    | Self::Indexing
                    | Self::Error
            ),
            Self::NotInstalled | Self::PermissionRequired | Self::SchemaUnsupported => matches!(
                next,
                Self::Disabled
                    | Self::NotInstalled
                    | Self::PermissionRequired
                    | Self::SchemaUnsupported
                    | Self::Indexing
                    | Self::Error
            ),
            Self::Indexing => matches!(
                next,
                Self::Disabled
                    | Self::PermissionRequired
                    | Self::SchemaUnsupported
                    | Self::Ready
                    | Self::Error
            ),
            Self::Ready => matches!(
                next,
                Self::Disabled
                    | Self::NotInstalled
                    | Self::PermissionRequired
                    | Self::SchemaUnsupported
                    | Self::Indexing
                    | Self::Error
            ),
            Self::Error => matches!(
                next,
                Self::Disabled
                    | Self::NotInstalled
                    | Self::PermissionRequired
                    | Self::SchemaUnsupported
                    | Self::Indexing
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceCursor {
    pub format_version: u16,
    pub opaque: String,
    pub high_watermark_ms: Option<i64>,
    pub tie_breaker: Option<String>,
}

impl SourceCursor {
    pub fn new(opaque: impl Into<String>) -> Self {
        Self {
            format_version: 1,
            opaque: opaque.into(),
            high_watermark_ms: None,
            tie_breaker: None,
        }
    }

    pub fn validate(&self) -> Result<(), StateError> {
        if self.format_version == 0 {
            return Err(StateError::InvalidCheckpoint(
                "cursor formatVersion must be positive".to_owned(),
            ));
        }
        if self.opaque.len() > MAX_CURSOR_BYTES {
            return Err(StateError::InvalidCheckpoint(
                "cursor opaque value exceeds 4096 bytes".to_owned(),
            ));
        }
        if self
            .tie_breaker
            .as_ref()
            .is_some_and(|value| value.len() > MAX_TIE_BREAKER_BYTES)
        {
            return Err(StateError::InvalidCheckpoint(
                "cursor tieBreaker exceeds 1024 bytes".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceCheckpoint {
    pub schema_version: u16,
    pub cursor: SourceCursor,
    pub completed_at_ms: i64,
    pub items_indexed: u64,
}

impl SourceCheckpoint {
    pub fn new(cursor: SourceCursor, completed_at_ms: i64, items_indexed: u64) -> Self {
        Self {
            schema_version: CHECKPOINT_SCHEMA_VERSION,
            cursor,
            completed_at_ms,
            items_indexed,
        }
    }

    pub fn validate(&self) -> Result<(), StateError> {
        if self.schema_version != CHECKPOINT_SCHEMA_VERSION {
            return Err(StateError::InvalidCheckpoint(format!(
                "unsupported checkpoint schema version {}",
                self.schema_version
            )));
        }
        if self.completed_at_ms <= 0 {
            return Err(StateError::InvalidCheckpoint(
                "completedAtMs must be positive".to_owned(),
            ));
        }
        self.cursor.validate()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceStatus {
    pub source: SourceId,
    pub readiness: SourceReadiness,
    pub active_generation: Option<u64>,
    pub staging_generation: Option<u64>,
    pub checkpoint: Option<SourceCheckpoint>,
    pub last_error: Option<String>,
}

impl SourceStatus {
    pub fn searchable(&self) -> bool {
        self.readiness == SourceReadiness::Ready && self.active_generation.is_some()
    }
}

#[derive(Debug, Error)]
pub enum StateError {
    #[error("unknown source: {0}")]
    UnknownSource(String),
    #[error("unknown source readiness: {0}")]
    UnknownReadiness(String),
    #[error("invalid source checkpoint: {0}")]
    InvalidCheckpoint(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_bounds_are_enforced() {
        let cursor = SourceCursor::new("x".repeat(MAX_CURSOR_BYTES + 1));
        assert!(cursor.validate().is_err());
    }

    #[test]
    fn readiness_transition_table_is_explicit() {
        assert!(SourceReadiness::Ready.can_transition_to(SourceReadiness::Indexing));
        assert!(SourceReadiness::Indexing.can_transition_to(SourceReadiness::Ready));
        assert!(!SourceReadiness::NotInstalled.can_transition_to(SourceReadiness::Ready));
    }
}
