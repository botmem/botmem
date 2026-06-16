//! Engine lifecycle: owns the tokio runtime and the long-lived background task
//! that (in later phases) runs the tunnel client + indexer. Phase 1 wires the
//! lifecycle, config, status writer, and a graceful shutdown signal; the tunnel
//! and index are stubbed with clearly-marked TODOs.

use crate::config::EngineConfig;
use crate::status::{BridgeState, StatusWriter};
use std::sync::Arc;
use tokio::runtime::Runtime;
use tokio::sync::watch;

/// A running engine instance. Dropping it (via `stop`) tears down the runtime
/// and flushes a final `offline` status.
pub struct Engine {
    runtime: Runtime,
    status: Arc<StatusWriter>,
    shutdown_tx: watch::Sender<bool>,
}

impl Engine {
    /// Start the engine from a parsed config. Returns once the background task
    /// is spawned (non-blocking); the tunnel connects asynchronously.
    pub fn start(config: EngineConfig) -> Result<Self, EngineError> {
        crate::logging::init();
        tracing::info!(
            server = %config.server,
            token = %config.redacted_token(),
            sources = %config.sources_or_default(),
            "engine starting",
        );

        let status = Arc::new(StatusWriter::new(
            config.resolve_status_path(),
            config.server.clone(),
        ));
        status.set_state(BridgeState::Starting, "Bridge starting");

        // Ensure the data dir exists early so later phases can rely on it.
        let data_dir = config.resolve_data_dir();
        if let Err(e) = std::fs::create_dir_all(&data_dir) {
            tracing::warn!(error = %e, "could not create data dir");
        }

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("botmem-engine")
            .enable_all()
            .build()
            .map_err(EngineError::Runtime)?;

        let (shutdown_tx, shutdown_rx) = watch::channel(false);

        let task_status = Arc::clone(&status);
        let task_config = config.clone();
        runtime.spawn(async move {
            run(task_config, task_status, shutdown_rx).await;
        });

        Ok(Self { runtime, status, shutdown_tx })
    }

    /// Status writer handle (used by the FFI `status_json` mirror).
    pub fn status(&self) -> &Arc<StatusWriter> {
        &self.status
    }

    /// Signal shutdown, wait briefly for the background task to unwind, then
    /// flush a final `offline` status and drop the runtime.
    pub fn stop(self) {
        tracing::info!("engine stopping");
        let _ = self.shutdown_tx.send(true);
        // Give the background task a moment to observe the signal and exit.
        self.runtime.shutdown_timeout(std::time::Duration::from_secs(2));
        self.status.set_connected(false);
        self.status.set_state(BridgeState::Offline, "Bridge stopped");
        self.status.close();
    }
}

/// The long-lived engine loop. Phase 1: it transitions status to `connecting`
/// and idles until shutdown. Phase 2 replaces the idle wait with the tunnel
/// client; Phase 3+ adds the indexer.
async fn run(
    _config: EngineConfig,
    status: Arc<StatusWriter>,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    status.set_state(BridgeState::Connecting, "Connecting to Botmem…");
    status.push_activity("Engine started");

    // TODO(phase-2): construct and run the TunnelClient here:
    //   - X25519 keypair + auth handshake (PROTOCOL.md §2/§4)
    //   - AES-256-GCM encrypted JSON-RPC loop (§3) dispatching to the RPC handler
    //   - exponential reconnect, ws ping/pong heartbeat
    // TODO(phase-3): build/refresh the local FTS5 index and answer search.query.

    // Idle until asked to stop (cooperative shutdown).
    let _ = shutdown_rx.changed().await;
    tracing::info!("engine loop received shutdown signal");
}

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("failed to build tokio runtime: {0}")]
    Runtime(#[source] std::io::Error),
}
