//! Structured status writer — the Swift UI ↔ engine contract.
//!
//! Writes `~/.botmem/bridge-status.json` atomically (tmp file + rename, mode
//! 0600) and throttled so frequent index ticks don't thrash the disk. The Swift
//! app polls this file. The shape MUST match PROTOCOL.md §6 / the legacy
//! `status-writer.ts` (`STATUS_SCHEMA = 1`).
//!
//! PRIVACY (CLAUDE.md hard rule): only states, source names, counts, and
//! durations — never message text, contact names, phone numbers, or chat ids.

use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub const STATUS_SCHEMA: u32 = 1;
pub const ACTIVITY_LIMIT: usize = 12;
const DEFAULT_THROTTLE_MS: u128 = 200;

/// Lifecycle state mirrored to the native app. Serializes to the exact strings
/// the Swift app expects.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BridgeState {
    Starting,
    Connecting,
    Indexing,
    Live,
    Error,
    Offline,
}

#[derive(Debug, Clone, Serialize)]
pub struct StatusSource {
    pub source: String, // "whatsapp" | "imessage" | "contacts"
    pub count: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct IndexingStatus {
    pub active: bool,
    pub source: Option<String>,
    pub done: u64,
    pub total: Option<u64>,
}

impl Default for IndexingStatus {
    fn default() -> Self {
        Self {
            active: false,
            source: None,
            done: 0,
            total: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ActivityEntry {
    pub ts: u64,
    pub text: String,
}

/// The exact on-disk document. Field order/names match the TS snapshot.
#[derive(Debug, Clone, Serialize)]
pub struct StatusSnapshot {
    pub schema: u32,
    pub state: BridgeState,
    pub label: String,
    pub server: String,
    pub connected: bool,
    pub sources: Vec<StatusSource>,
    pub indexing: IndexingStatus,
    pub activity: Vec<ActivityEntry>,
    #[serde(rename = "lastError")]
    pub last_error: Option<String>,
    #[serde(rename = "updatedAt")]
    pub updated_at: u64,
}

/// Mutable status state behind the writer.
struct Inner {
    state: BridgeState,
    label: String,
    server: String,
    connected: bool,
    sources: Vec<StatusSource>,
    indexing: IndexingStatus,
    activity: Vec<ActivityEntry>,
    last_error: Option<String>,
    last_flush_at: u128,
}

/// Atomic, throttled status writer. Cheap to clone the handle via `Arc`.
pub struct StatusWriter {
    path: PathBuf,
    throttle_ms: u128,
    inner: Mutex<Inner>,
}

impl StatusWriter {
    pub fn new(path: impl Into<PathBuf>, server: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            throttle_ms: DEFAULT_THROTTLE_MS,
            inner: Mutex::new(Inner {
                state: BridgeState::Starting,
                label: "Bridge starting".to_string(),
                server: server.into(),
                connected: false,
                sources: Vec::new(),
                indexing: IndexingStatus::default(),
                activity: Vec::new(),
                last_error: None,
                last_flush_at: 0,
            }),
        }
    }

    pub fn set_state(&self, state: BridgeState, label: impl Into<String>) {
        {
            let mut g = self.lock();
            g.state = state;
            g.label = label.into();
        }
        self.flush();
    }

    pub fn set_connected(&self, connected: bool) {
        self.lock().connected = connected;
        self.flush();
    }

    pub fn set_server(&self, server: impl Into<String>) {
        self.lock().server = server.into();
        self.flush();
    }

    pub fn set_sources(&self, sources: Vec<StatusSource>) {
        self.lock().sources = sources;
        self.flush();
    }

    pub fn set_indexing(&self, indexing: IndexingStatus) {
        self.lock().indexing = indexing;
        self.flush();
    }

    pub fn set_error(&self, message: Option<String>) {
        self.lock().last_error = message;
        self.flush();
    }

    /// Append a privacy-safe activity line (newest LAST, capped at ACTIVITY_LIMIT).
    pub fn push_activity(&self, text: impl Into<String>) {
        {
            let mut g = self.lock();
            g.activity.push(ActivityEntry {
                ts: now_ms() as u64,
                text: text.into(),
            });
            let len = g.activity.len();
            if len > ACTIVITY_LIMIT {
                g.activity.drain(0..len - ACTIVITY_LIMIT);
            }
        }
        self.flush();
    }

    /// Current snapshot (also what gets written on flush).
    pub fn snapshot(&self) -> StatusSnapshot {
        let g = self.lock();
        StatusSnapshot {
            schema: STATUS_SCHEMA,
            state: g.state,
            label: g.label.clone(),
            server: g.server.clone(),
            connected: g.connected,
            sources: g.sources.clone(),
            indexing: g.indexing.clone(),
            activity: g.activity.clone(),
            last_error: g.last_error.clone(),
            updated_at: now_ms() as u64,
        }
    }

    pub fn snapshot_json(&self) -> String {
        serde_json::to_string_pretty(&self.snapshot()).unwrap_or_else(|_| "{}".to_string())
    }

    /// Force a synchronous write regardless of throttle (used on shutdown).
    pub fn close(&self) {
        self.write_now();
    }

    /// Throttled write: writes immediately if enough time elapsed, else lets the
    /// next call within the window carry the latest state. (No background timer:
    /// the engine flips state frequently enough that the trailing edge lands.)
    fn flush(&self) {
        let elapsed = {
            let g = self.lock();
            now_ms().saturating_sub(g.last_flush_at)
        };
        if elapsed >= self.throttle_ms {
            self.write_now();
        }
    }

    fn write_now(&self) {
        let (snapshot, path) = {
            let mut g = self.lock();
            g.last_flush_at = now_ms();
            // build snapshot inline to reuse the locked state
            let snap = StatusSnapshot {
                schema: STATUS_SCHEMA,
                state: g.state,
                label: g.label.clone(),
                server: g.server.clone(),
                connected: g.connected,
                sources: g.sources.clone(),
                indexing: g.indexing.clone(),
                activity: g.activity.clone(),
                last_error: g.last_error.clone(),
                updated_at: now_ms() as u64,
            };
            (snap, self.path.clone())
        };
        // Status reporting is best-effort; never propagate errors.
        let _ = write_atomic(&path, &snapshot);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // Poisoning only happens if a holder panicked mid-update; the status is
        // best-effort, so recover the guard rather than crash the engine.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Write `snapshot` to `path` atomically: tmp file (mode 0600) then rename.
fn write_atomic(path: &Path, snapshot: &StatusSnapshot) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(snapshot)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    let tmp = path.with_extension(format!("{}.{}.tmp", std::process::id(), now_ms()));

    {
        let mut f = std::fs::File::create(&tmp)?;
        set_mode_600(&f);
        f.write_all(json.as_bytes())?;
        f.flush()?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(unix)]
fn set_mode_600(f: &std::fs::File) {
    use std::os::unix::fs::PermissionsExt;
    let _ = f.set_permissions(std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn set_mode_600(_f: &std::fs::File) {}

/// Current time in epoch milliseconds.
pub fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_reads_back_schema() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bridge-status.json");
        let w = StatusWriter::new(&path, "wss://api.botmem.xyz/apple-tunnel");
        w.set_state(BridgeState::Connecting, "Connecting…");
        w.close();

        let raw = std::fs::read_to_string(&path).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["schema"], 1);
        assert_eq!(v["state"], "connecting");
        assert_eq!(v["server"], "wss://api.botmem.xyz/apple-tunnel");
        assert_eq!(v["connected"], false);
        assert!(v["updatedAt"].as_u64().unwrap() > 0);
    }

    #[test]
    fn activity_capped_newest_last() {
        let dir = tempfile::tempdir().unwrap();
        let w = StatusWriter::new(dir.path().join("s.json"), "wss://x/y");
        for i in 0..(ACTIVITY_LIMIT + 5) {
            w.push_activity(format!("event {i}"));
        }
        let snap = w.snapshot();
        assert_eq!(snap.activity.len(), ACTIVITY_LIMIT);
        assert_eq!(
            snap.activity.last().unwrap().text,
            format!("event {}", ACTIVITY_LIMIT + 4)
        );
    }

    #[test]
    fn state_serializes_lowercase() {
        let dir = tempfile::tempdir().unwrap();
        let w = StatusWriter::new(dir.path().join("s.json"), "wss://x/y");
        w.set_state(BridgeState::Live, "Live");
        let json = w.snapshot_json();
        assert!(json.contains("\"state\": \"live\""));
    }
}
