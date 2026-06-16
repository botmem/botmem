//! Tracing/log initialization. Idempotent — safe to call on every engine start.
//!
//! PRIVACY: log MESSAGES must never contain user content (message text, contact
//! names, phone numbers, chat ids). This module only configures the subscriber;
//! call sites are responsible for keeping content out of the logs.

use once_cell::sync::OnceCell;
use tracing_subscriber::{fmt, EnvFilter};

static INIT: OnceCell<()> = OnceCell::new();

/// Initialize the global tracing subscriber once.
///
/// Level controlled by `BOTMEM_BRIDGE_LOG` (e.g. `info`, `debug`,
/// `botmem_engine=debug`), defaulting to `info`.
pub fn init() {
    INIT.get_or_init(|| {
        let filter = EnvFilter::try_from_env("BOTMEM_BRIDGE_LOG")
            .unwrap_or_else(|_| EnvFilter::new("info"));
        // Writes to stderr; the Swift host captures it. No ANSI (log files).
        let _ = fmt()
            .with_env_filter(filter)
            .with_ansi(false)
            .with_target(true)
            .try_init();
    });
}
