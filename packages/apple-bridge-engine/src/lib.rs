//! Botmem Apple Bridge engine.
//!
//! In-process Rust engine linked into the Swift menu-bar app (the FDA-granted
//! process). It reads local Apple data, maintains a local FTS index, and serves
//! encrypted JSON-RPC over the tunnel to the Botmem API. See `ARCHITECTURE.md`
//! and `PROTOCOL.md`.
//!
//! Phase 1 (current) wires the lifecycle, config, status writer, logging, and
//! C ABI. The tunnel (Phase 2), index (Phase 3), and source readers (Phase 4)
//! land behind the module stubs below.

pub mod config;
pub mod engine;
pub mod ffi;
pub mod logging;
pub mod rpc;
pub mod status;

// Phase 2+ module stubs — kept here so the public module layout is stable as
// each phase lands.
pub mod tunnel;
pub mod index;
pub mod sources;

// Re-export the most useful types for the rlib consumers (tests, tooling).
pub use config::EngineConfig;
pub use engine::Engine;
pub use status::{BridgeState, StatusWriter};
