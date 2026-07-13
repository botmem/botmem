use botmem_device_core::sources::{
    IMessageAdapter, SourceAdapter, SourceIndexer, SyncMode, WhatsAppAdapter,
};
use botmem_device_core::{DeviceStore, SourceId, SourceReadiness};
use rusqlite::{params, Connection};
use std::fs;
use std::path::Path;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

fn create_imessage_fixture(path: &Path) {
    let connection = Connection::open(path).expect("create iMessage fixture");
    connection
        .execute_batch(
            "CREATE TABLE message (
               guid TEXT NOT NULL,
               text TEXT,
               attributedBody BLOB,
               date INTEGER NOT NULL,
               date_edited INTEGER DEFAULT 0,
               date_retracted INTEGER DEFAULT 0,
               is_from_me INTEGER NOT NULL,
               handle_id INTEGER
             );
             CREATE TABLE handle (id TEXT NOT NULL);
             CREATE TABLE chat (chat_identifier TEXT NOT NULL, display_name TEXT);
             CREATE TABLE chat_message_join (message_id INTEGER NOT NULL, chat_id INTEGER NOT NULL);
             INSERT INTO handle(ROWID, id) VALUES (1, '+15550001001');
             INSERT INTO chat(ROWID, chat_identifier, display_name)
               VALUES (1, 'chat-guid-1', 'Fixture thread');
             INSERT INTO message(
               ROWID, guid, text, date, is_from_me, handle_id
             ) VALUES
               (1, 'message-guid-1', 'alpha fixture message', 100000000000000000, 0, 1),
               (2, 'message-guid-2', 'beta fixture message', 200000000000000000, 1, 1);
             INSERT INTO chat_message_join(message_id, chat_id) VALUES (1, 1), (2, 1);",
        )
        .expect("iMessage fixture schema and rows");
}

fn insert_imessage(path: &Path, row_id: i64, guid: &str, text: &str, date: i64) {
    let connection = Connection::open(path).expect("open iMessage fixture for append");
    connection
        .execute(
            "INSERT INTO message(
               ROWID, guid, text, date, is_from_me, handle_id
             ) VALUES (?1, ?2, ?3, ?4, 0, 1)",
            params![row_id, guid, text, date],
        )
        .expect("append iMessage");
    connection
        .execute(
            "INSERT INTO chat_message_join(message_id, chat_id) VALUES (?1, 1)",
            [row_id],
        )
        .expect("append iMessage chat link");
}

fn create_whatsapp_fixture(path: &Path, supported: bool) {
    let stanza_column = if supported { ", ZSTANZAID TEXT" } else { "" };
    let connection = Connection::open(path).expect("create WhatsApp fixture");
    connection
        .execute_batch(&format!(
            "CREATE TABLE ZWAMESSAGE (
               Z_PK INTEGER PRIMARY KEY,
               Z_OPT INTEGER NOT NULL,
               ZTEXT TEXT,
               ZMESSAGEDATE REAL,
               ZISFROMME INTEGER NOT NULL,
               ZFROMJID TEXT,
               ZCHATSESSION INTEGER,
               ZGROUPMEMBER INTEGER,
               ZMEDIAITEM INTEGER
               {stanza_column}
             );
             CREATE TABLE ZWACHATSESSION (
               Z_PK INTEGER PRIMARY KEY,
               ZCONTACTJID TEXT,
               ZPARTNERNAME TEXT
             );
             CREATE TABLE ZWAGROUPMEMBER (Z_PK INTEGER PRIMARY KEY, ZMEMBERJID TEXT);
             CREATE TABLE ZWAMEDIAITEM (Z_PK INTEGER PRIMARY KEY, ZTITLE TEXT);
             INSERT INTO ZWACHATSESSION(Z_PK, ZCONTACTJID, ZPARTNERNAME)
               VALUES (1, '15550002002@s.whatsapp.net', 'Fixture chat');"
        ))
        .expect("WhatsApp fixture schema");
    if supported {
        connection
            .execute(
                "INSERT INTO ZWAMESSAGE(
                   Z_PK, Z_OPT, ZSTANZAID, ZTEXT, ZMESSAGEDATE, ZISFROMME,
                   ZFROMJID, ZCHATSESSION
                 ) VALUES (1, 1, 'stanza-1', 'gamma fixture message', 800000000, 0,
                           '15550002002@s.whatsapp.net', 1)",
                [],
            )
            .expect("WhatsApp fixture message");
    }
}

#[test]
fn initial_scans_create_stable_imessage_and_whatsapp_records() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let imessage_path = directory.path().join("chat.db");
    let whatsapp_path = directory.path().join("ChatStorage.sqlite");
    create_imessage_fixture(&imessage_path);
    create_whatsapp_fixture(&whatsapp_path, true);
    let mut store = DeviceStore::open(directory.path().join("index")).expect("open index");

    let imessage = IMessageAdapter::new(&imessage_path);
    let whatsapp = WhatsAppAdapter::new(&whatsapp_path);
    assert!(imessage.probe().read_only);
    assert!(whatsapp.probe().read_only);

    let imessage_report = SourceIndexer::new(&mut store)
        .run(&imessage, SyncMode::Reconcile)
        .expect("reconcile iMessage");
    let whatsapp_report = SourceIndexer::new(&mut store)
        .run(&whatsapp, SyncMode::Reconcile)
        .expect("reconcile WhatsApp");
    assert_eq!(imessage_report.indexed, 2);
    assert_eq!(whatsapp_report.indexed, 1);
    assert_eq!(imessage_report.schema_fingerprint.len(), 64);
    assert_eq!(whatsapp_report.schema_fingerprint.len(), 64);

    let imessage_records = store
        .active_documents(SourceId::IMessage)
        .expect("iMessage documents");
    assert_eq!(imessage_records[0].source_id, "message-guid-1");
    assert_eq!(imessage_records[0].revision.len(), 64);
    let whatsapp_records = store
        .active_documents(SourceId::Whatsapp)
        .expect("WhatsApp documents");
    assert_eq!(
        whatsapp_records[0].source_id,
        "15550002002@s.whatsapp.net:stanza-1"
    );
    assert_eq!(whatsapp_records[0].revision.len(), 64);
}

#[test]
fn incremental_scan_adds_only_rows_after_the_high_water_cursor() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let source_path = directory.path().join("chat.db");
    create_imessage_fixture(&source_path);
    let adapter = IMessageAdapter::new(&source_path);
    let mut store = DeviceStore::open(directory.path().join("index")).expect("open index");

    SourceIndexer::new(&mut store)
        .run(&adapter, SyncMode::Reconcile)
        .expect("initial reconciliation");
    insert_imessage(
        &source_path,
        3,
        "message-guid-3",
        "delta fixture message",
        300000000000000000,
    );
    let report = SourceIndexer::new(&mut store)
        .run(&adapter, SyncMode::Incremental)
        .expect("incremental scan");

    assert_eq!(report.scanned, 1);
    assert_eq!(report.indexed, 3);
    assert_eq!(
        store
            .active_document_ids(SourceId::IMessage)
            .expect("active ids"),
        vec!["message-guid-1", "message-guid-2", "message-guid-3"]
    );
}

#[test]
fn reconciliation_applies_edits_and_removes_deleted_source_rows() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let source_path = directory.path().join("chat.db");
    create_imessage_fixture(&source_path);
    let adapter = IMessageAdapter::new(&source_path);
    let mut store = DeviceStore::open(directory.path().join("index")).expect("open index");

    SourceIndexer::new(&mut store)
        .run(&adapter, SyncMode::Reconcile)
        .expect("initial reconciliation");
    let original_revision = store
        .active_documents(SourceId::IMessage)
        .expect("initial records")[0]
        .revision
        .clone();

    let source = Connection::open(&source_path).expect("open fixture for edit");
    source
        .execute(
            "UPDATE message
                SET text = 'alpha fixture message edited', date_edited = 400000000000000000
              WHERE guid = 'message-guid-1'",
            [],
        )
        .expect("edit fixture message");
    source
        .execute("DELETE FROM message WHERE guid = 'message-guid-2'", [])
        .expect("delete fixture message");
    drop(source);

    SourceIndexer::new(&mut store)
        .run(&adapter, SyncMode::Reconcile)
        .expect("reconcile edits");
    let records = store
        .active_documents(SourceId::IMessage)
        .expect("reconciled records");
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].source_id, "message-guid-1");
    assert_eq!(records[0].searchable_text, "alpha fixture message edited");
    assert_ne!(records[0].revision, original_revision);
}

#[cfg(unix)]
#[test]
fn permission_failure_preserves_the_last_good_index() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let source_path = directory.path().join("chat.db");
    create_imessage_fixture(&source_path);
    let adapter = IMessageAdapter::new(&source_path);
    let mut store = DeviceStore::open(directory.path().join("index")).expect("open index");
    SourceIndexer::new(&mut store)
        .run(&adapter, SyncMode::Reconcile)
        .expect("initial reconciliation");
    let original_ids = store
        .active_document_ids(SourceId::IMessage)
        .expect("original active ids");

    fs::set_permissions(&source_path, fs::Permissions::from_mode(0o000))
        .expect("remove fixture permission");
    let result = SourceIndexer::new(&mut store).run(&adapter, SyncMode::Reconcile);
    fs::set_permissions(&source_path, fs::Permissions::from_mode(0o600))
        .expect("restore fixture permission");

    assert!(result.is_err());
    let status = store.status(SourceId::IMessage).expect("permission status");
    assert_eq!(status.readiness, SourceReadiness::PermissionRequired);
    assert_eq!(
        store
            .active_document_ids(SourceId::IMessage)
            .expect("preserved ids"),
        original_ids
    );
}

#[test]
fn unsupported_whatsapp_schema_is_reported_without_staging_data() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let source_path = directory.path().join("ChatStorage.sqlite");
    create_whatsapp_fixture(&source_path, false);
    let adapter = WhatsAppAdapter::new(&source_path);
    let mut store = DeviceStore::open(directory.path().join("index")).expect("open index");

    let result = SourceIndexer::new(&mut store).run(&adapter, SyncMode::Reconcile);
    assert!(result.is_err());
    let status = store.status(SourceId::Whatsapp).expect("WhatsApp status");
    assert_eq!(status.readiness, SourceReadiness::SchemaUnsupported);
    assert_eq!(status.active_generation, None);
}

#[test]
fn missing_source_databases_report_not_installed_for_each_adapter() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let mut store = DeviceStore::open(directory.path().join("index")).expect("open index");
    let imessage = IMessageAdapter::new(directory.path().join("missing-chat.db"));
    let whatsapp = WhatsAppAdapter::new(directory.path().join("missing-whatsapp.sqlite"));

    assert!(SourceIndexer::new(&mut store)
        .run(&imessage, SyncMode::Reconcile)
        .is_err());
    assert!(SourceIndexer::new(&mut store)
        .run(&whatsapp, SyncMode::Reconcile)
        .is_err());
    assert_eq!(
        store
            .status(SourceId::IMessage)
            .expect("iMessage status")
            .readiness,
        SourceReadiness::NotInstalled
    );
    assert_eq!(
        store
            .status(SourceId::Whatsapp)
            .expect("WhatsApp status")
            .readiness,
        SourceReadiness::NotInstalled
    );
}

#[cfg(unix)]
#[test]
fn adapters_leave_source_databases_byte_identical_and_create_no_sidecars() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let imessage_path = directory.path().join("chat.db");
    let whatsapp_path = directory.path().join("ChatStorage.sqlite");
    create_imessage_fixture(&imessage_path);
    create_whatsapp_fixture(&whatsapp_path, true);
    let before_imessage = fs::read(&imessage_path).expect("read iMessage fixture");
    let before_whatsapp = fs::read(&whatsapp_path).expect("read WhatsApp fixture");
    fs::set_permissions(&imessage_path, fs::Permissions::from_mode(0o444))
        .expect("make iMessage fixture read-only");
    fs::set_permissions(&whatsapp_path, fs::Permissions::from_mode(0o444))
        .expect("make WhatsApp fixture read-only");

    let imessage = IMessageAdapter::new(&imessage_path);
    let whatsapp = WhatsAppAdapter::new(&whatsapp_path);
    assert!(imessage.probe().read_only);
    assert!(whatsapp.probe().read_only);
    imessage.scan(None).expect("read-only iMessage scan");
    whatsapp.scan(None).expect("read-only WhatsApp scan");

    assert_eq!(
        fs::read(&imessage_path).expect("read iMessage after"),
        before_imessage
    );
    assert_eq!(
        fs::read(&whatsapp_path).expect("read WhatsApp after"),
        before_whatsapp
    );
    for path in [&imessage_path, &whatsapp_path] {
        assert!(!path.with_extension("db-journal").exists());
        assert!(!Path::new(&format!("{}-journal", path.display())).exists());
        assert!(!Path::new(&format!("{}-wal", path.display())).exists());
    }
}
