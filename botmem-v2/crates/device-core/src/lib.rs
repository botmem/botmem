//! Security and durability primitives for the Botmem v2 device service.
//!
//! Protected source readers intentionally live outside this crate for now. This
//! slice owns the invariants that those adapters must use: one engine process,
//! private on-disk state, staged index generations, durable checkpoints, and a
//! bounded/versioned relay protocol.

pub mod lock;
pub mod protocol;
pub mod search;
pub mod sources;
pub mod state;
pub mod storage;

pub use lock::EngineLock;
pub use search::{CancellationToken, LocalSearchError, LocalSearchResponse, LocalSearchService};
pub use state::{SourceCheckpoint, SourceCursor, SourceId, SourceReadiness, SourceStatus};
pub use storage::{DeviceStore, StagedGeneration};
