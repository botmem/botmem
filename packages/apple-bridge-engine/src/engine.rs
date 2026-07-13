//! Engine lifecycle: owns the tokio runtime (tunnel client) and a dedicated
//! indexer thread that streams local sources into the FTS index. Phase 1 wired
//! the lifecycle/status/config; Phase 2 the tunnel; Phase 3 the index; Phase 4
//! the source readers that populate it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use tokio::runtime::Runtime;
use tokio::sync::watch;

use crate::config::EngineConfig;
use crate::index::{IndexDispatcher, IndexStore, SharedStore};
use crate::rpc::{RpcDispatch, StubDispatcher};
use crate::status::{BridgeState, StatusWriter};
use crate::tunnel::TunnelClient;

/// A running engine instance. `stop` tears down the runtime, signals the indexer
/// to abort, and flushes a final `offline` status.
pub struct Engine {
    runtime: Runtime,
    status: Arc<StatusWriter>,
    shutdown_tx: watch::Sender<bool>,
    stop_flag: Arc<AtomicBool>,
    index_thread: Option<JoinHandle<()>>,
}

impl Engine {
    /// Start the engine from a parsed config. Non-blocking: the tunnel connects
    /// and the index builds asynchronously.
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

        let data_dir = config.resolve_data_dir();
        if let Err(e) = std::fs::create_dir_all(&data_dir) {
            tracing::warn!(error = %e, "could not create data dir");
        }

        // Shared FTS index: the indexer thread writes it, the tunnel dispatcher
        // reads it. Fall back to a stub dispatcher (tunnel still runs) if it
        // can't open, so a disk hiccup doesn't take the bridge down.
        let index_path = data_dir.join("index.sqlite");
        let (dispatch, shared): (Arc<dyn RpcDispatch>, Option<SharedStore>) = match IndexStore::open(
            &index_path,
        ) {
            Ok(store) => {
                let shared: SharedStore = Arc::new(Mutex::new(store));
                (
                    Arc::new(IndexDispatcher::from_shared(Arc::clone(&shared))),
                    Some(shared),
                )
            }
            Err(e) => {
                tracing::warn!(error = %e, "could not open local index; serving stub dispatcher");
                status.push_activity("Index unavailable");
                (Arc::new(StubDispatcher), None)
            }
        };

        let stop_flag = Arc::new(AtomicBool::new(false));

        // Indexer thread (blocking SQLite + file IO) — populate the shared index.
        let index_thread = shared.map(|store| {
            let status = Arc::clone(&status);
            let stop = Arc::clone(&stop_flag);
            let sources = config.sources_or_default();
            std::thread::Builder::new()
                .name("botmem-indexer".into())
                .spawn(move || {
                    crate::sources::build_index(&store, &status, &sources, &stop);
                })
                .expect("spawn indexer thread")
        });

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
            run(task_config, task_status, shutdown_rx, dispatch).await;
        });

        Ok(Self {
            runtime,
            status,
            shutdown_tx,
            stop_flag,
            index_thread,
        })
    }

    /// Status writer handle (used by the FFI `status_json` mirror).
    pub fn status(&self) -> &Arc<StatusWriter> {
        &self.status
    }

    /// Signal shutdown, stop the indexer + tunnel, flush a final `offline` status.
    pub fn stop(mut self) {
        tracing::info!("engine stopping");
        self.stop_flag.store(true, Ordering::Relaxed);
        let _ = self.shutdown_tx.send(true);
        self.runtime
            .shutdown_timeout(std::time::Duration::from_secs(2));
        // The indexer aborts at its next batch boundary once stop_flag is set.
        if let Some(handle) = self.index_thread.take() {
            let _ = handle.join();
        }
        self.status.set_connected(false);
        self.status
            .set_state(BridgeState::Offline, "Bridge stopped");
        self.status.close();
    }
}

/// The long-lived engine loop: run the encrypted tunnel until shutdown (it
/// reconnects internally and answers RPCs from the shared index dispatcher).
async fn run(
    config: EngineConfig,
    status: Arc<StatusWriter>,
    shutdown_rx: watch::Receiver<bool>,
    dispatch: Arc<dyn RpcDispatch>,
) {
    status.set_state(BridgeState::Connecting, "Connecting to Botmem…");
    status.push_activity("Engine started");

    let client = TunnelClient {
        server: config.server.clone(),
        token: config.token.clone(),
        sources: config.sources_or_default(),
        status: Arc::clone(&status),
        dispatch,
    };
    client.run(shutdown_rx).await;
    tracing::info!("engine loop exited");
}

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("failed to build tokio runtime: {0}")]
    Runtime(#[source] std::io::Error),
}
