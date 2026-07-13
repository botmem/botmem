use super::{AdapterError, SourceAdapter, SourceProbe};
use crate::state::{SourceCheckpoint, SourceId, SourceReadiness};
use crate::storage::{DeviceStore, StagedDocument, StoreError};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncMode {
    Incremental,
    Reconcile,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexReport {
    pub source: SourceId,
    pub mode: SyncMode,
    pub scanned: u64,
    pub indexed: u64,
    pub schema_fingerprint: String,
}

pub struct SourceIndexer<'a> {
    store: &'a mut DeviceStore,
}

impl<'a> SourceIndexer<'a> {
    pub fn new(store: &'a mut DeviceStore) -> Self {
        Self { store }
    }

    pub fn run(
        &mut self,
        adapter: &dyn SourceAdapter,
        mode: SyncMode,
    ) -> Result<IndexReport, IndexingError> {
        let source = adapter.source();
        let probe = adapter.probe();
        if probe.readiness != SourceReadiness::Ready || !probe.read_only {
            self.apply_probe_failure(&probe)?;
            return Err(IndexingError::Unavailable {
                connector: source,
                readiness: probe.readiness,
                reason_code: probe.reason_code.unwrap_or("source_unavailable"),
            });
        }

        let previous = self.store.status(source)?;
        let cursor = match mode {
            SyncMode::Incremental => previous.checkpoint.as_ref().map(|value| &value.cursor),
            SyncMode::Reconcile => None,
        };
        let scan = match adapter.scan(cursor) {
            Ok(scan) => scan,
            Err(error) => {
                self.apply_adapter_error(source, &error)?;
                return Err(IndexingError::Adapter(error));
            }
        };
        let staged = match mode {
            SyncMode::Incremental if previous.active_generation.is_some() => {
                self.store.begin_incremental(source)?
            }
            SyncMode::Incremental | SyncMode::Reconcile => self.store.begin_rebuild(source)?,
        };

        let scanned = scan.records.len() as u64;
        for record in &scan.records {
            let payload_json = record.payload_json(source)?;
            if let Err(error) = self.store.stage_document(
                staged,
                &StagedDocument {
                    source_id: &record.source_id,
                    revision: &record.revision,
                    occurred_at_ms: record.occurred_at_ms,
                    searchable_text: &record.text,
                    payload_json: &payload_json,
                },
            ) {
                let _ = self.store.fail_rebuild(staged, "index_stage_failed");
                return Err(IndexingError::Store(error));
            }
        }
        let indexed = self.store.staged_document_count(staged)?;
        let checkpoint = SourceCheckpoint::new(scan.next_cursor, now_ms()?, indexed);
        self.store.activate_rebuild(staged, &checkpoint)?;
        Ok(IndexReport {
            source,
            mode,
            scanned,
            indexed,
            schema_fingerprint: scan.schema.fingerprint,
        })
    }

    fn apply_probe_failure(&mut self, probe: &SourceProbe) -> Result<(), StoreError> {
        self.store
            .set_readiness(probe.source, probe.readiness, probe.reason_code)
    }

    fn apply_adapter_error(
        &mut self,
        source: SourceId,
        error: &AdapterError,
    ) -> Result<(), StoreError> {
        let (readiness, reason) = match error {
            AdapterError::Unavailable {
                readiness,
                reason_code,
                ..
            } => (*readiness, *reason_code),
            AdapterError::UnsupportedSchema { .. } => (
                SourceReadiness::SchemaUnsupported,
                "source_schema_unsupported",
            ),
            _ => (SourceReadiness::Error, "source_scan_failed"),
        };
        self.store.set_readiness(source, readiness, Some(reason))
    }
}

fn now_ms() -> Result<i64, IndexingError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| IndexingError::Clock)?
        .as_millis()
        .try_into()
        .map_err(|_| IndexingError::Clock)
}

#[derive(Debug, Error)]
pub enum IndexingError {
    #[error("source {connector} is unavailable in state {readiness:?}: {reason_code}")]
    Unavailable {
        connector: SourceId,
        readiness: SourceReadiness,
        reason_code: &'static str,
    },
    #[error(transparent)]
    Adapter(#[from] AdapterError),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("system clock cannot produce a checkpoint timestamp")]
    Clock,
}
