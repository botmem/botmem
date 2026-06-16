//! Local FTS5 search index (PROTOCOL.md §5 `search.query` / `bridge.status`).
//!
//! Phase 3 lands here: a `rusqlite` (bundled SQLite, FTS5) store at
//! `~/.botmem/apple-bridge/index.sqlite` with column-restricted matching over
//! `{ text, sender_name, ... }`, `bm25()` ranking, per-source cursors, and the
//! `SearchItem` result mapping the server expects.
//!
//! Intentionally empty in Phase 1.
