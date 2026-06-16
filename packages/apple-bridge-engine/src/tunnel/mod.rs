//! Encrypted WebSocket tunnel client (PROTOCOL.md §2–§5).
//!
//! Phase 2 lands here:
//!   - X25519 ephemeral keypair, raw-32-byte public key on the wire
//!   - HKDF-SHA256 (salt "botmem-apple-tunnel-v1", info "aes-256-gcm-session-key")
//!   - AES-256-GCM frames: [IV(12) | ciphertext | tag(16)]
//!   - JSON-RPC 2.0 responder (server is the caller, bridge answers)
//!   - exponential reconnect (min(1000*2^n, 30_000) ms), ws ping/pong heartbeat
//!
//! Crypto constants are pinned here so a regression is caught at compile sites.

pub mod client;
pub mod crypto;

pub use client::TunnelClient;

/// HKDF salt — MUST match `crypto.ts` / the server.
pub const HKDF_SALT: &[u8] = b"botmem-apple-tunnel-v1";
/// HKDF info — MUST match `crypto.ts` / the server.
pub const HKDF_INFO: &[u8] = b"aes-256-gcm-session-key";
/// AES-GCM IV length (bytes).
pub const IV_LEN: usize = 12;
/// AES-GCM tag length (bytes).
pub const TAG_LEN: usize = 16;
/// X25519 SPKI DER header prepended to a raw 32-byte public key.
pub const X25519_SPKI_HEADER: [u8; 12] =
    [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00];
