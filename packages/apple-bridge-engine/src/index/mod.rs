//! Local FTS5 search index (PROTOCOL.md §5 `search.query` / `bridge.status`).
//!
//! Phase 3: a `rusqlite` (bundled SQLite, FTS5) store with column-restricted
//! matching over `{ text, sender_name }`, `bm25()` ranking, per-source state,
//! and the `SearchItem` mapping the server expects — behavior-matched to the
//! node engine for result parity. Phase 4's source readers populate it.

pub mod store;
pub mod types;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

pub use store::IndexStore;
pub use types::{IndexRecord, SearchFilters, SearchItem, SourceName, SourceState};

use crate::rpc::{RpcDispatch, RpcError};
use crate::sources::{contacts, imessage, imessage_rpc};

const DEFAULT_LIMIT: usize = 25;
const MAX_LIMIT: usize = 200;

/// Store shared between the RPC dispatcher (reads) and the index builder
/// (writes). A Mutex (not RwLock) is fine: search is fast and the builder
/// flushes in short batched locks.
pub type SharedStore = Arc<Mutex<IndexStore>>;

/// RPC dispatcher backed by the local FTS index. Answers `search.query`,
/// `bridge.status`, `ping`, and the legacy connector-sync reads (`chats.list`,
/// `messages.history`, `contacts.list`) which read chat.db / AddressBook directly.
pub struct IndexDispatcher {
    store: SharedStore,
    imessage_db: PathBuf,
    contacts_base: PathBuf,
}

impl IndexDispatcher {
    /// Wrap an owned store with default source paths (tests).
    pub fn new(store: IndexStore) -> Self {
        Self::from_shared(Arc::new(Mutex::new(store)))
    }

    /// Share an existing store with the builder; use the default source paths.
    pub fn from_shared(store: SharedStore) -> Self {
        Self {
            store,
            imessage_db: imessage::default_db_path(),
            contacts_base: contacts::default_base(),
        }
    }
}

impl RpcDispatch for IndexDispatcher {
    fn dispatch(&self, method: &str, params: &Value) -> Result<Value, RpcError> {
        match method {
            "ping" => Ok(json!({ "pong": true, "ts": crate::status::now_ms() as u64 })),

            "bridge.status" => {
                let store = self.store.lock().map_err(|_| poisoned())?;
                let sources = store.status().map_err(db_err)?;
                Ok(json!({ "sources": sources }))
            }

            "search.query" => {
                let query = params.get("query").and_then(Value::as_str).unwrap_or("");
                if query.trim().is_empty() {
                    return Err(RpcError::invalid_params("Missing required param: query"));
                }
                // Match rpc-handler.ts: a positive limit is capped at MAX_LIMIT;
                // anything else (0, negative, absent) falls back to DEFAULT_LIMIT.
                let limit = params
                    .get("limit")
                    .and_then(Value::as_i64)
                    .filter(|&n| n > 0)
                    .map(|n| (n as usize).min(MAX_LIMIT))
                    .unwrap_or(DEFAULT_LIMIT);
                let filters: SearchFilters = params
                    .get("filters")
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|e| RpcError::invalid_params(format!("bad filters: {e}")))?
                    .unwrap_or_default();

                let store = self.store.lock().map_err(|_| poisoned())?;
                let items = store.search(query, &filters, limit).map_err(db_err)?;
                Ok(json!({ "items": items }))
            }

            // ── Legacy connector-sync reads (read chat.db / AddressBook directly,
            //    NOT the FTS index). Shapes match rpc-handler.ts / apple-client.ts. ──
            "chats.list" => {
                let limit = params.get("limit").and_then(Value::as_i64);
                let chats = imessage_rpc::chats_list(&self.imessage_db, limit).map_err(db_err)?;
                Ok(json!({ "chats": chats }))
            }

            "messages.history" => {
                let chat_id = match params.get("chat_id").and_then(Value::as_i64) {
                    Some(id) => id,
                    None => return Err(RpcError::invalid_params("Missing required param: chat_id")),
                };
                let opts = imessage_rpc::MessagesOpts {
                    limit: params.get("limit").and_then(Value::as_i64),
                    start: params.get("start").and_then(Value::as_str).map(String::from),
                    end: params.get("end").and_then(Value::as_str).map(String::from),
                };
                let messages =
                    imessage_rpc::messages_history(&self.imessage_db, chat_id, &opts).map_err(db_err)?;
                Ok(json!({ "messages": messages }))
            }

            "contacts.list" => {
                let contacts =
                    contacts::list_apple_contacts(&self.contacts_base, &crate::sources::never_cancelled())
                        .map_err(db_err)?;
                Ok(json!({ "contacts": contacts }))
            }

            other => Err(RpcError::method_not_found(other)),
        }
    }
}

fn poisoned() -> RpcError {
    RpcError::new(-32000, "index lock poisoned")
}

fn db_err(e: rusqlite::Error) -> RpcError {
    // Never include user content; rusqlite messages are about SQL/schema only.
    RpcError::new(-32000, format!("index error: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dispatcher() -> IndexDispatcher {
        let mut store = IndexStore::open_in_memory().unwrap();
        store
            .add_records(
                SourceName::Imessage,
                &[IndexRecord {
                    source_id: "1".into(),
                    text: "next installment amount is 50000".into(),
                    sender_name: "Amr".into(),
                    sender_id: "id-amr".into(),
                    ts: 1_700_000_000,
                    ..Default::default()
                }],
            )
            .unwrap();
        store.set_source_state(SourceName::Imessage, 1, None).unwrap();
        IndexDispatcher::new(store)
    }

    #[test]
    fn search_returns_items() {
        let d = dispatcher();
        let out = d
            .dispatch("search.query", &json!({ "query": "installment", "limit": 5 }))
            .unwrap();
        let items = out["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["connectorType"], "apple");
        assert_eq!(items[0]["sourceType"], "message");
    }

    #[test]
    fn empty_query_is_invalid_params() {
        let d = dispatcher();
        let err = d.dispatch("search.query", &json!({ "query": "" })).unwrap_err();
        assert_eq!(err.code, -32602);
    }

    #[test]
    fn bridge_status_has_sources() {
        let d = dispatcher();
        let out = d.dispatch("bridge.status", &Value::Null).unwrap();
        assert_eq!(out["sources"].as_array().unwrap().len(), 1);
        assert_eq!(out["sources"][0]["source"], "imessage");
        assert!(out["sources"][0]["lastIndexedAt"].is_number());
    }

    #[test]
    fn limit_is_clamped() {
        let d = dispatcher();
        // huge limit must not error
        let out = d
            .dispatch("search.query", &json!({ "query": "installment", "limit": 99999 }))
            .unwrap();
        assert!(out["items"].is_array());
    }

    #[test]
    fn unknown_method_not_found() {
        let d = dispatcher();
        let err = d.dispatch("frobnicate", &Value::Null).unwrap_err();
        assert_eq!(err.code, -32601);
    }
}
