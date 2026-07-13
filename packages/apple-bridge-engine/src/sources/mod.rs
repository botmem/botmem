//! Read-only source readers over local Apple/WhatsApp databases, plus the index
//! build driver that streams their records into the FTS index.
//!
//! All reads happen IN THIS PROCESS (the FDA-granted one), read-only. Phase 4a:
//! Contacts, WhatsApp (text + captions), iMessage (incl. attributedBody decode).
//! Phase 4b adds PDF/DOCX attachment text extraction.

pub mod attachments;
pub mod attributed_body;
pub mod contacts;
pub mod imessage;
pub mod imessage_rpc;
pub mod whatsapp;

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

use crate::index::{IndexRecord, SharedStore, SourceName};
use crate::status::{BridgeState, IndexingStatus, StatusSource, StatusWriter};

/// Streaming sink for normalized records.
pub type RecordSink<'a> = &'a mut dyn FnMut(IndexRecord);

/// Cooperative-cancellation probe: readers call this at the top of each row loop
/// (and before expensive attachment extraction) and stop promptly when it's true,
/// so `Engine::stop` never waits for a full DB scan.
pub type Cancelled<'a> = &'a dyn Fn() -> bool;

/// A cancellation probe that never cancels (tests / unconditional reads).
pub fn never_cancelled() -> impl Fn() -> bool {
    || false
}

/// Format epoch MILLISECONDS as `YYYY-MM-DDTHH:MM:SS.mmmZ` (matches JS
/// `new Date(ms).toISOString()`). Used by the legacy chats.list/messages.history
/// RPCs to mirror `db.ts` `coreDataToISO`.
pub(crate) fn epoch_ms_to_iso(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    // civil_from_days: days since 1970-01-01 → (year, month, day)
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };

    format!("{year:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{millis:03}Z")
}

/// Records buffered before each batched insert under the index lock.
const BATCH: usize = 1000;

/// Open a source DB strictly read-only (defense-in-depth: never write a source
/// app's DB). Sets a busy timeout so a concurrent writer doesn't fail the read.
pub(crate) fn open_ro(path: &Path) -> Result<Connection, rusqlite::Error> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(Duration::from_secs(5))?;
    // query_only is belt-and-suspenders on top of the read-only open flag.
    let _ = conn.pragma_update(None, "query_only", "ON");
    Ok(conn)
}

/// Which sources to index, parsed from the auth `sources` CSV (server semantics:
/// `contacts`, `imessages`|`messages`, `whatsapp`). WhatsApp is also auto-indexed
/// whenever present, so it's enabled if listed OR detected.
#[derive(Debug, Clone, Copy)]
pub struct EnabledSources {
    pub contacts: bool,
    pub imessages: bool,
    pub whatsapp: bool,
}

impl EnabledSources {
    pub fn parse(csv: &str) -> Self {
        let parts: Vec<String> = csv
            .split(',')
            .map(|p| p.trim().to_lowercase())
            .filter(|p| !p.is_empty())
            .collect();
        if parts.is_empty() {
            return Self {
                contacts: true,
                imessages: true,
                whatsapp: true,
            };
        }
        Self {
            contacts: parts.iter().any(|p| p == "contacts"),
            imessages: parts.iter().any(|p| p == "imessages" || p == "messages"),
            whatsapp: parts.iter().any(|p| p == "whatsapp"),
        }
    }
}

/// Build (rebuild) the whole index from the enabled, detected sources. Runs
/// synchronously on a dedicated thread; checks `stop` between batches so a
/// shutdown aborts promptly. Never logs user content — counts/sources only.
pub fn build_index(
    store: &SharedStore,
    status: &StatusWriter,
    sources_csv: &str,
    stop: &Arc<AtomicBool>,
) {
    let enabled = EnabledSources::parse(sources_csv);
    status.set_state(BridgeState::Indexing, "Indexing local data…");

    // Fresh rebuild — simplest correct baseline; incremental refresh is a later
    // optimization. Best-effort: if reset fails we still try to add.
    if let Ok(s) = store.lock() {
        let _ = s.reset();
    }

    let cancelled = || stop.load(Ordering::Relaxed);

    // Contacts first — it feeds name resolution for later sources (and is cheap).
    if enabled.contacts && !cancelled() {
        let base = contacts::default_base();
        if contacts::detect(&base) {
            index_source(store, status, SourceName::Contacts, |sink| {
                contacts::read(&base, &cancelled, sink)
            });
        }
    }

    if enabled.whatsapp && !cancelled() {
        let db = whatsapp::default_db_path();
        if whatsapp::detect(&db) {
            index_source(store, status, SourceName::Whatsapp, |sink| {
                whatsapp::read(&db, &cancelled, sink)
            });
        }
    }

    if enabled.imessages && !cancelled() {
        let db = imessage::default_db_path();
        if imessage::detect(&db) {
            index_source(store, status, SourceName::Imessage, |sink| {
                imessage::read(&db, &cancelled, sink)
            });
        }
    }

    // Finalize: publish per-source counts to the status file and go idle/live.
    if let Ok(s) = store.lock() {
        if let Ok(states) = s.status() {
            let sources: Vec<StatusSource> = states
                .into_iter()
                .map(|st| StatusSource {
                    source: st.source,
                    count: st.count as u64,
                })
                .collect();
            status.set_sources(sources);
        }
    }
    status.set_indexing(IndexingStatus::default());
    status.push_activity("Indexing complete");
    // Leave the lifecycle to the tunnel (it owns connected/live); if we're still
    // offline, reflect that indexing finished.
    tracing::info!("index build finished");
}

/// Stream one source's records into the index in batches, updating progress.
/// Cancellation is the reader's responsibility (it stops calling `sink` and
/// returns early when its `Cancelled` probe fires), so this just buffers/flushes.
fn index_source<F>(store: &SharedStore, status: &StatusWriter, source: SourceName, read_fn: F)
where
    F: FnOnce(RecordSink<'_>) -> Result<usize, rusqlite::Error>,
{
    status.set_indexing(IndexingStatus {
        active: true,
        source: Some(source.as_str().to_string()),
        done: 0,
        total: None,
    });

    let mut buf: Vec<IndexRecord> = Vec::with_capacity(BATCH);
    let mut done: u64 = 0;

    let flush = |store: &SharedStore, buf: &mut Vec<IndexRecord>| {
        if buf.is_empty() {
            return;
        }
        if let Ok(mut s) = store.lock() {
            let _ = s.add_records(source, buf);
        }
        buf.clear();
    };

    let mut sink = |rec: IndexRecord| {
        buf.push(rec);
        done += 1;
        if buf.len() >= BATCH {
            flush(store, &mut buf);
            status.set_indexing(IndexingStatus {
                active: true,
                source: Some(source.as_str().to_string()),
                done,
                total: None,
            });
        }
    };

    match read_fn(&mut sink) {
        Ok(_) => {}
        Err(e) => {
            tracing::warn!(source = source.as_str(), error = %e, "source read error");
            status.push_activity(format!("{} read error", source.as_str()));
        }
    }
    flush(store, &mut buf);

    if let Ok(s) = store.lock() {
        let _ = s.set_source_state(source, done as i64, None);
    }
    status.push_activity(format!("Indexed {} {}", done, source.as_str()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enabled_sources_parsing() {
        let all = EnabledSources::parse("contacts,imessages,whatsapp");
        assert!(all.contacts && all.imessages && all.whatsapp);

        let msgs = EnabledSources::parse("messages");
        assert!(msgs.imessages && !msgs.contacts && !msgs.whatsapp);

        let empty = EnabledSources::parse("");
        assert!(empty.contacts && empty.imessages && empty.whatsapp);
    }
}
