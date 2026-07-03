//! Index record + search result types. Mirrors
//! `packages/apple-bridge/src/local-index/types.ts` and PROTOCOL.md §5.

use serde::Serialize;

/// Internal source identifier (NOT the wire connectorType).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceName {
    Imessage,
    Whatsapp,
    Contacts,
}

impl SourceName {
    pub fn as_str(self) -> &'static str {
        match self {
            SourceName::Imessage => "imessage",
            SourceName::Whatsapp => "whatsapp",
            SourceName::Contacts => "contacts",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "imessage" => Some(SourceName::Imessage),
            "whatsapp" => Some(SourceName::Whatsapp),
            "contacts" => Some(SourceName::Contacts),
            _ => None,
        }
    }

    /// Wire connectorType: imessage→apple, whatsapp→whatsapp, contacts→contacts.
    pub fn connector_type(self) -> &'static str {
        match self {
            SourceName::Imessage => "apple",
            SourceName::Whatsapp => "whatsapp",
            SourceName::Contacts => "contacts",
        }
    }
}

/// Map a wire connectorType back to the internal source name (for filtering).
pub fn connector_type_to_source(connector_type: &str) -> Option<SourceName> {
    match connector_type {
        "apple" | "imessage" => Some(SourceName::Imessage),
        "whatsapp" => Some(SourceName::Whatsapp),
        "contacts" => Some(SourceName::Contacts),
        _ => None,
    }
}

/// A normalized record produced by a source adapter, ready to index.
#[derive(Debug, Clone, Default)]
pub struct IndexRecord {
    pub source_id: String,
    pub thread_id: String,
    pub thread_title: String,
    pub sender_name: String,
    pub sender_id: String,
    pub is_from_me: bool,
    /// Event time in unix SECONDS (0 when unknown, e.g. contacts).
    pub ts: i64,
    pub text: String,
    /// Opaque media descriptors serialized to JSON; never message bodies.
    pub media_json: Option<String>,
}

/// Source-state row for `bridge.status` (lastIndexedAt in epoch MS).
#[derive(Debug, Clone, Serialize)]
pub struct SourceState {
    pub source: String,
    pub count: i64,
    #[serde(rename = "lastIndexedAt")]
    pub last_indexed_at: Option<i64>,
}

/// A person attached to a search item.
#[derive(Debug, Clone, Serialize)]
pub struct Person {
    pub name: String,
    #[serde(rename = "durableId")]
    pub durable_id: String,
}

/// A search result item — serializes to the exact shape the server expects.
#[derive(Debug, Clone, Serialize)]
pub struct SearchItem {
    pub id: String,
    #[serde(rename = "connectorType")]
    pub connector_type: String,
    #[serde(rename = "sourceType")]
    pub source_type: String,
    pub text: String,
    #[serde(rename = "eventTime")]
    pub event_time: Option<String>,
    pub people: Vec<Person>,
    #[serde(rename = "threadTitle")]
    pub thread_title: String,
    #[serde(rename = "isFromMe")]
    pub is_from_me: bool,
    pub media: serde_json::Value,
    pub score: f64,
}

/// Filters accepted by `search.query` (PROTOCOL.md §5).
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct SearchFilters {
    pub source: Option<String>,
    #[serde(rename = "sourceType")]
    pub source_type: Option<String>,
    #[serde(rename = "connectorType")]
    pub connector_type: Option<String>,
    #[serde(rename = "connectorTypes")]
    pub connector_types: Option<Vec<String>>,
    #[serde(rename = "sourceTypes")]
    pub source_types: Option<Vec<String>>,
}
