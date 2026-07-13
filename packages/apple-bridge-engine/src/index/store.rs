//! Bridge-owned FTS5 index. This is OUR file — never a source app's DB.
//!
//! Ported from `packages/apple-bridge/src/local-index/index-store.ts` to keep
//! search behavior (schema, `{text sender_name}` MATCH, bm25 ordering, the
//! `SearchItem` mapping) identical for result parity with the node engine.

use std::collections::BTreeSet;
use std::path::Path;

use rusqlite::{params_from_iter, Connection};
use serde_json::Value;

use super::types::{
    connector_type_to_source, IndexRecord, Person, SearchFilters, SearchItem, SourceName,
    SourceState,
};
use crate::status::now_ms;

/// FTS5 index store backed by bundled SQLite.
pub struct IndexStore {
    db: Connection,
}

#[cfg(unix)]
fn create_private_dir(dir: &Path) {
    use std::os::unix::fs::DirBuilderExt;
    let _ = std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir);
}

#[cfg(not(unix))]
fn create_private_dir(dir: &Path) {
    let _ = std::fs::create_dir_all(dir);
}

#[cfg(unix)]
fn harden_index_file(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn harden_index_file(_path: &Path) {}

impl IndexStore {
    /// Open/create the index at `path` (created if missing). Never a source DB.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, rusqlite::Error> {
        let path = path.as_ref();
        if let Some(dir) = path.parent() {
            create_private_dir(dir);
        }
        let db = Connection::open(path)?;
        harden_index_file(path);
        Self::init(db)
    }

    /// In-memory store (tests).
    pub fn open_in_memory() -> Result<Self, rusqlite::Error> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(db: Connection) -> Result<Self, rusqlite::Error> {
        // WAL is safe here: this is OUR index, not a source DB.
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.execute_batch(
            r#"
            CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
                text, sender_name, thread_title,
                source UNINDEXED, source_id UNINDEXED, thread_id UNINDEXED,
                sender_id UNINDEXED, is_from_me UNINDEXED, ts UNINDEXED, media_json UNINDEXED,
                tokenize = 'unicode61 remove_diacritics 2'
            );
            CREATE TABLE IF NOT EXISTS source_state (
                source TEXT PRIMARY KEY,
                last_cursor TEXT,
                count INTEGER DEFAULT 0,
                last_indexed_at INTEGER
            );
            "#,
        )?;
        Ok(Self { db })
    }

    /// Bulk-insert normalized records inside one transaction.
    pub fn add_records(
        &mut self,
        source: SourceName,
        records: &[IndexRecord],
    ) -> Result<(), rusqlite::Error> {
        let tx = self.db.transaction()?;
        {
            let mut stmt = tx.prepare_cached(
                r#"INSERT INTO records_fts
                    (text, sender_name, thread_title, source, source_id, thread_id,
                     sender_id, is_from_me, ts, media_json)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"#,
            )?;
            for r in records {
                stmt.execute(rusqlite::params![
                    r.text,
                    r.sender_name,
                    r.thread_title,
                    source.as_str(),
                    r.source_id,
                    r.thread_id,
                    r.sender_id,
                    if r.is_from_me { 1 } else { 0 },
                    r.ts,
                    r.media_json,
                ])?;
            }
        }
        tx.commit()
    }

    /// Upsert source-state (count + lastIndexedAt now).
    pub fn set_source_state(
        &self,
        source: SourceName,
        count: i64,
        cursor: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        self.db.execute(
            r#"INSERT INTO source_state (source, last_cursor, count, last_indexed_at)
               VALUES (?1, ?2, ?3, ?4)
               ON CONFLICT(source) DO UPDATE SET
                 last_cursor = excluded.last_cursor,
                 count = excluded.count,
                 last_indexed_at = excluded.last_indexed_at"#,
            rusqlite::params![source.as_str(), cursor, count, now_ms() as i64],
        )?;
        Ok(())
    }

    /// Clear all indexed data for a full rebuild.
    pub fn reset(&self) -> Result<(), rusqlite::Error> {
        self.db
            .execute_batch("DELETE FROM records_fts; DELETE FROM source_state;")
    }

    /// Source-state rows for `bridge.status`.
    pub fn status(&self) -> Result<Vec<SourceState>, rusqlite::Error> {
        let mut stmt = self
            .db
            .prepare("SELECT source, count, last_indexed_at FROM source_state")?;
        let rows = stmt.query_map([], |row| {
            Ok(SourceState {
                source: row.get::<_, String>(0)?,
                count: row.get::<_, i64>(1)?,
                last_indexed_at: row.get::<_, Option<i64>>(2)?,
            })
        })?;
        rows.collect()
    }

    /// FTS5 search returning items in the exact shape the server expects.
    /// Ordering is by bm25 (best first); `score` is the negated rank.
    pub fn search(
        &self,
        query: &str,
        filters: &SearchFilters,
        limit: usize,
    ) -> Result<Vec<SearchItem>, rusqlite::Error> {
        // OR-of-quoted-phrases over {text sender_name} (NOT thread_title, so a
        // group title doesn't flood results). Each term quoted so punctuation is
        // literal; OR (not AND) so bm25 ranks more/rarer matches higher.
        let terms: Vec<String> = query
            .split_whitespace()
            .filter(|t| !t.is_empty())
            .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
            .collect();
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let match_expr = format!("{{text sender_name}} : ({})", terms.join(" OR "));

        // Resolve internal source filter set from source/connectorType(+plural).
        // NB: `filters.source` is added VERBATIM (matching index-store.ts), so an
        // unknown source value yields a `source IN (...)` that matches nothing —
        // rather than being silently dropped and broadening to all sources.
        let mut source_set: BTreeSet<String> = BTreeSet::new();
        if let Some(s) = filters.source.as_deref() {
            if !s.is_empty() {
                source_set.insert(s.to_string());
            }
        }
        let mut cts: Vec<&str> = Vec::new();
        if let Some(ct) = filters.connector_type.as_deref() {
            cts.push(ct);
        }
        if let Some(list) = &filters.connector_types {
            cts.extend(list.iter().map(String::as_str));
        }
        for ct in cts {
            if let Some(s) = connector_type_to_source(ct) {
                source_set.insert(s.as_str().to_string());
            }
        }

        let mut conditions = vec!["records_fts MATCH ?1".to_string()];
        // Bind values: index 1 = match_expr, then sources, then limit (last).
        let mut binds: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(match_expr)];

        if !source_set.is_empty() {
            let placeholders: Vec<String> = source_set
                .iter()
                .enumerate()
                .map(|(i, _)| format!("?{}", i + 2))
                .collect();
            conditions.push(format!("source IN ({})", placeholders.join(", ")));
            for s in &source_set {
                binds.push(Box::new(s.clone()));
            }
        }

        // sourceType: 'contact' ↔ contacts, 'message' ↔ the rest. If scoped only
        // to types the bridge can't serve, return nothing (don't broaden).
        let mut type_set: BTreeSet<&str> = BTreeSet::new();
        if let Some(t) = filters.source_type.as_deref() {
            type_set.insert(t);
        }
        if let Some(list) = &filters.source_types {
            type_set.extend(list.iter().map(String::as_str));
        }
        if !type_set.is_empty() {
            let wants_contact = type_set.contains("contact");
            let wants_message = type_set.contains("message");
            if !wants_contact && !wants_message {
                return Ok(Vec::new());
            }
            if wants_contact && !wants_message {
                conditions.push("source = 'contacts'".to_string());
            } else if wants_message && !wants_contact {
                conditions.push("source <> 'contacts'".to_string());
            }
        }

        let limit_idx = binds.len() + 1;
        binds.push(Box::new(limit as i64));

        let sql = format!(
            r#"SELECT text, sender_name, thread_title, source, source_id, thread_id, sender_id,
                      is_from_me, ts, media_json, bm25(records_fts) AS rank
               FROM records_fts
               WHERE {}
               ORDER BY rank
               LIMIT ?{}"#,
            conditions.join(" AND "),
            limit_idx,
        );

        let mut stmt = self.db.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(binds.iter().map(|b| b.as_ref())), |row| {
            let source: String = row.get(3)?;
            let source_id: String = row.get(4)?;
            let sender_name: String = row.get(1)?;
            let sender_id: String = row.get(6)?;
            let is_from_me: i64 = row.get(7)?;
            let ts: i64 = row.get(8)?;
            let media_json: Option<String> = row.get(9)?;
            let rank: f64 = row.get(10)?;
            let src = SourceName::from_str(&source);

            Ok(SearchItem {
                id: format!("{source}:{source_id}"),
                connector_type: src
                    .map(|s| s.connector_type())
                    .unwrap_or("contacts")
                    .to_string(),
                source_type: if source == "contacts" {
                    "contact"
                } else {
                    "message"
                }
                .to_string(),
                text: row.get(0)?,
                event_time: if ts != 0 {
                    Some(epoch_secs_to_iso(ts))
                } else {
                    None
                },
                people: if sender_name.is_empty() {
                    Vec::new()
                } else {
                    vec![Person {
                        name: sender_name,
                        durable_id: sender_id,
                    }]
                },
                thread_title: row.get(2)?,
                is_from_me: is_from_me != 0,
                media: media_json
                    .and_then(|j| serde_json::from_str::<Value>(&j).ok())
                    .unwrap_or_else(|| Value::Array(Vec::new())),
                score: -rank,
            })
        })?;
        rows.collect()
    }
}

/// Format unix SECONDS as `YYYY-MM-DDTHH:MM:SS.000Z` (matches JS toISOString()
/// for whole-second timestamps). Uses Howard Hinnant's civil-from-days.
fn epoch_secs_to_iso(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    // civil_from_days: days since 1970-01-01 → (year, month, day)
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if m <= 2 { y + 1 } else { y };

    format!("{year:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.000Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(source_id: &str, text: &str, sender: &str, ts: i64) -> IndexRecord {
        IndexRecord {
            source_id: source_id.to_string(),
            text: text.to_string(),
            sender_name: sender.to_string(),
            sender_id: format!("id-{sender}"),
            thread_title: "Parkwoods".to_string(),
            thread_id: "chat1".to_string(),
            ts,
            ..Default::default()
        }
    }

    fn store_with_data() -> IndexStore {
        let mut s = IndexStore::open_in_memory().unwrap();
        s.add_records(
            SourceName::Imessage,
            &[
                rec(
                    "1",
                    "next installment amount is 50000 due Friday",
                    "Amr",
                    1_700_000_000,
                ),
                rec("2", "lunch plans tomorrow", "Sara", 1_700_001_000),
            ],
        )
        .unwrap();
        s.add_records(
            SourceName::Whatsapp,
            &[rec(
                "9",
                "the installment receipt is attached",
                "Mostafa",
                1_700_002_000,
            )],
        )
        .unwrap();
        let mut c = rec("c1", "Amr Essam", "Amr Essam", 0);
        c.thread_title = String::new();
        s.add_records(SourceName::Contacts, &[c]).unwrap();
        s.set_source_state(SourceName::Imessage, 2, None).unwrap();
        s.set_source_state(SourceName::Whatsapp, 1, None).unwrap();
        s.set_source_state(SourceName::Contacts, 1, None).unwrap();
        s
    }

    #[test]
    fn finds_term_across_sources_ranked() {
        let s = store_with_data();
        let items = s
            .search("installment", &SearchFilters::default(), 25)
            .unwrap();
        assert_eq!(items.len(), 2, "both installment messages match");
        // each has a higher (less-negative) score for better bm25
        assert!(items[0].score >= items[1].score);
        assert!(items.iter().all(|i| i.text.contains("installment")));
    }

    #[test]
    fn search_item_shape_matches_contract() {
        let s = store_with_data();
        let items = s
            .search("installment", &SearchFilters::default(), 1)
            .unwrap();
        let it = &items[0];
        assert!(it.id.contains(':'));
        assert!(matches!(it.connector_type.as_str(), "apple" | "whatsapp"));
        assert_eq!(it.source_type, "message");
        assert!(it.event_time.as_ref().unwrap().ends_with("Z"));
        assert_eq!(it.people.len(), 1);
        assert!(it.media.is_array());
    }

    #[test]
    fn connector_type_filter_scopes_source() {
        let s = store_with_data();
        let f = SearchFilters {
            connector_types: Some(vec!["whatsapp".into()]),
            ..Default::default()
        };
        let items = s.search("installment", &f, 25).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].connector_type, "whatsapp");
    }

    #[test]
    fn sender_name_is_searchable_but_thread_title_is_not() {
        let s = store_with_data();
        // sender_name matches
        assert!(!s
            .search("Sara", &SearchFilters::default(), 25)
            .unwrap()
            .is_empty());
        // thread_title ("Parkwoods") must NOT match (excluded from MATCH columns)
        assert!(s
            .search("Parkwoods", &SearchFilters::default(), 25)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn source_type_contact_only_returns_contacts() {
        let s = store_with_data();
        let f = SearchFilters {
            source_types: Some(vec!["contact".into()]),
            ..Default::default()
        };
        let items = s.search("Amr", &f, 25).unwrap();
        assert!(items.iter().all(|i| i.source_type == "contact"));
        assert!(!items.is_empty());
    }

    #[test]
    fn unservable_source_type_returns_empty() {
        let s = store_with_data();
        let f = SearchFilters {
            source_types: Some(vec!["email".into()]),
            ..Default::default()
        };
        assert!(s.search("installment", &f, 25).unwrap().is_empty());
    }

    #[test]
    fn status_reports_counts() {
        let s = store_with_data();
        let st = s.status().unwrap();
        let total: i64 = st.iter().map(|r| r.count).sum();
        assert_eq!(total, 4);
        assert!(st.iter().all(|r| r.last_indexed_at.is_some()));
    }

    #[test]
    fn iso_format_matches_js() {
        // 1700000000 = 2023-11-14T22:13:20Z
        assert_eq!(epoch_secs_to_iso(1_700_000_000), "2023-11-14T22:13:20.000Z");
        assert_eq!(epoch_secs_to_iso(0), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn empty_query_returns_empty() {
        let s = store_with_data();
        assert!(s
            .search("   ", &SearchFilters::default(), 25)
            .unwrap()
            .is_empty());
    }
}
