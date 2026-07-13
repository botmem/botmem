use super::{AdapterError, SourceAdapter, SourceProbe};
use crate::state::{SourceCheckpoint, SourceId, SourceReadiness};
use crate::storage::{DeviceStore, StagedDocument, StoreError};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

const INDEX_BATCH_SIZE: usize = 512;

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
        for records in scan.records.chunks(INDEX_BATCH_SIZE) {
            let payloads = match records
                .iter()
                .map(|record| record.payload_json(source))
                .collect::<Result<Vec<_>, _>>()
            {
                Ok(payloads) => payloads,
                Err(error) => {
                    let _ = self.store.fail_rebuild(staged, "index_payload_failed");
                    return Err(IndexingError::Adapter(error));
                }
            };
            let documents = records
                .iter()
                .zip(&payloads)
                .map(|(record, payload_json)| StagedDocument {
                    source_id: &record.source_id,
                    revision: &record.revision,
                    occurred_at_ms: record.occurred_at_ms,
                    searchable_text: &record.text,
                    payload_json,
                })
                .collect::<Vec<_>>();
            if let Err(error) = self.store.stage_documents(staged, &documents) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::{SchemaDescriptor, SourceRecord, SourceScan};
    use crate::state::SourceCursor;
    use std::path::Path;

    struct LargeAdapter;

    impl SourceAdapter for LargeAdapter {
        fn source(&self) -> SourceId {
            SourceId::IMessage
        }

        fn database_path(&self) -> &Path {
            Path::new("/unused/indexer-batch-fixture")
        }

        fn probe(&self) -> SourceProbe {
            SourceProbe {
                source: SourceId::IMessage,
                readiness: SourceReadiness::Ready,
                schema: Some(schema()),
                read_only: true,
                reason_code: None,
            }
        }

        fn scan(&self, _cursor: Option<&SourceCursor>) -> Result<SourceScan, AdapterError> {
            Ok(SourceScan {
                schema: schema(),
                records: (0..=INDEX_BATCH_SIZE)
                    .map(|index| SourceRecord {
                        source_id: format!("message:{index:04}"),
                        revision: "1".to_owned(),
                        occurred_at_ms: Some(1_752_400_800_000 + index as i64),
                        text: format!("private message {index}"),
                        thread_id: None,
                        thread_title: None,
                        participant_id: None,
                        authored_by_me: false,
                    })
                    .collect(),
                next_cursor: SourceCursor::new("next"),
            })
        }
    }

    fn schema() -> SchemaDescriptor {
        SchemaDescriptor {
            family: "batch-fixture",
            version: 1,
            fingerprint: "batch-fixture-v1".to_owned(),
        }
    }

    #[test]
    fn failure_after_a_committed_batch_removes_staging_and_preserves_active_state() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let mut store = DeviceStore::open(directory.path()).expect("open store");
        let active = store
            .begin_rebuild(SourceId::IMessage)
            .expect("begin active generation");
        store
            .stage_document(
                active,
                &StagedDocument {
                    source_id: "active",
                    revision: "1",
                    occurred_at_ms: Some(1_752_400_800_000),
                    searchable_text: "last known good",
                    payload_json: "{}",
                },
            )
            .expect("stage active document");
        let checkpoint =
            SourceCheckpoint::new(SourceCursor::new("last-known-good"), 1_752_400_800_000, 1);
        store
            .activate_rebuild(active, &checkpoint)
            .expect("activate generation");
        store
            .connection
            .execute_batch(
                "CREATE TEMP TRIGGER abort_later_index_batch
                 BEFORE INSERT ON documents
                 WHEN new.source_id = 'message:0512'
                 BEGIN
                   SELECT RAISE(ABORT, 'forced later batch failure');
                 END;",
            )
            .expect("install failure trigger");

        let error = SourceIndexer::new(&mut store)
            .run(&LargeAdapter, SyncMode::Reconcile)
            .expect_err("later batch must fail");
        assert!(matches!(error, IndexingError::Store(_)));
        let status = store.status(SourceId::IMessage).expect("source status");
        assert_eq!(status.active_generation, Some(active.generation));
        assert_eq!(status.staging_generation, None);
        assert_eq!(status.checkpoint, Some(checkpoint));
        assert_eq!(status.last_error.as_deref(), Some("index_stage_failed"));
        assert_eq!(
            store
                .active_document_ids(SourceId::IMessage)
                .expect("active documents"),
            vec!["active"]
        );
        let document_count = store
            .connection
            .query_row(
                "SELECT count(*) FROM documents WHERE source = ?1",
                [SourceId::IMessage.as_str()],
                |row| row.get::<_, u64>(0),
            )
            .expect("document count");
        assert_eq!(document_count, 1);
    }
}
