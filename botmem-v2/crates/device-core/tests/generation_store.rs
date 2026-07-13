use botmem_device_core::storage::StagedDocument;
use botmem_device_core::{DeviceStore, SourceCheckpoint, SourceCursor, SourceId, SourceReadiness};

fn checkpoint(cursor: &str, count: u64) -> SourceCheckpoint {
    SourceCheckpoint::new(SourceCursor::new(cursor), 1_752_400_800_000, count)
}

fn document<'a>(source_id: &'a str, text: &'a str) -> StagedDocument<'a> {
    StagedDocument {
        source_id,
        revision: "1",
        occurred_at_ms: Some(1_752_400_800_000),
        searchable_text: text,
        payload_json: "{}",
    }
}

#[test]
fn successful_rebuild_atomically_flips_the_active_generation() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let mut store = DeviceStore::open(directory.path()).expect("open store");

    let first = store
        .begin_rebuild(SourceId::IMessage)
        .expect("begin first");
    store
        .stage_document(first, &document("message:1", "first"))
        .expect("stage first document");
    store
        .activate_rebuild(first, &checkpoint("cursor-1", 1))
        .expect("activate first");

    let second = store
        .begin_rebuild(SourceId::IMessage)
        .expect("begin second");
    store
        .stage_document(second, &document("message:2", "second"))
        .expect("stage second document");

    assert_eq!(
        store
            .active_document_ids(SourceId::IMessage)
            .expect("active docs"),
        vec!["message:1"]
    );
    store
        .activate_rebuild(second, &checkpoint("cursor-2", 1))
        .expect("activate second");

    let status = store.status(SourceId::IMessage).expect("status");
    assert_eq!(status.readiness, SourceReadiness::Ready);
    assert_eq!(status.active_generation, Some(second.generation));
    assert_eq!(status.checkpoint, Some(checkpoint("cursor-2", 1)));
    assert_eq!(
        store
            .active_document_ids(SourceId::IMessage)
            .expect("active docs"),
        vec!["message:2"]
    );
}

#[test]
fn failed_rebuild_preserves_the_last_good_generation_and_checkpoint() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let mut store = DeviceStore::open(directory.path()).expect("open store");

    let good = store.begin_rebuild(SourceId::Whatsapp).expect("begin good");
    store
        .stage_document(good, &document("chat:1", "kept"))
        .expect("stage good document");
    store
        .activate_rebuild(good, &checkpoint("good-cursor", 1))
        .expect("activate good");

    let failed = store
        .begin_rebuild(SourceId::Whatsapp)
        .expect("begin failed");
    store
        .stage_document(failed, &document("chat:2", "must not leak"))
        .expect("stage failed document");
    store
        .fail_rebuild(failed, "permission_revoked")
        .expect("fail rebuild");

    let status = store.status(SourceId::Whatsapp).expect("status");
    assert_eq!(status.readiness, SourceReadiness::Ready);
    assert_eq!(status.active_generation, Some(good.generation));
    assert_eq!(status.staging_generation, None);
    assert_eq!(status.checkpoint, Some(checkpoint("good-cursor", 1)));
    assert_eq!(status.last_error.as_deref(), Some("permission_revoked"));
    assert_eq!(
        store
            .active_document_ids(SourceId::Whatsapp)
            .expect("active docs"),
        vec!["chat:1"]
    );
}

#[test]
fn source_state_transitions_do_not_claim_readiness_early() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let mut store = DeviceStore::open(directory.path()).expect("open store");

    let initial = store.status(SourceId::IMessage).expect("initial status");
    assert_eq!(initial.readiness, SourceReadiness::Disabled);
    assert!(!initial.searchable());

    store
        .set_readiness(
            SourceId::IMessage,
            SourceReadiness::PermissionRequired,
            Some("full_disk_access_required"),
        )
        .expect("permission state");
    let waiting = store.status(SourceId::IMessage).expect("waiting status");
    assert_eq!(waiting.readiness, SourceReadiness::PermissionRequired);
    assert!(!waiting.searchable());

    let staged = store
        .begin_rebuild(SourceId::IMessage)
        .expect("begin rebuild");
    let indexing = store.status(SourceId::IMessage).expect("indexing status");
    assert_eq!(indexing.readiness, SourceReadiness::Indexing);
    assert!(!indexing.searchable());

    store
        .activate_rebuild(staged, &checkpoint("ready", 0))
        .expect("activate");
    assert!(store
        .status(SourceId::IMessage)
        .expect("ready")
        .searchable());
}

#[cfg(unix)]
#[test]
fn storage_permissions_are_private_even_when_preexisting_modes_are_open() {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    let directory = tempfile::tempdir().expect("temporary directory");
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o755))
        .expect("open directory permissions");
    let store = DeviceStore::open(directory.path()).expect("open store");
    store.enforce_permissions().expect("enforce permissions");

    let directory_mode = fs::metadata(directory.path())
        .expect("directory metadata")
        .permissions()
        .mode()
        & 0o777;
    let database_mode = fs::metadata(directory.path().join("index.sqlite3"))
        .expect("database metadata")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(directory_mode, 0o700);
    assert_eq!(database_mode, 0o600);
}

#[test]
fn readonly_open_never_creates_a_missing_index() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let index_root = directory.path().join("missing");

    assert!(DeviceStore::open_readonly(&index_root).is_err());
    assert!(!index_root.exists());
}

#[cfg(unix)]
#[test]
fn readonly_open_rejects_non_private_index_permissions() {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    let directory = tempfile::tempdir().expect("temporary directory");
    let store = DeviceStore::open(directory.path()).expect("open store");
    drop(store);
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o755))
        .expect("make directory non-private");

    assert!(DeviceStore::open_readonly(directory.path()).is_err());
}
