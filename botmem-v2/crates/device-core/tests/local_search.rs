use botmem_device_core::protocol::DeviceSearchQuery;
use botmem_device_core::storage::StagedDocument;
use botmem_device_core::{
    CancellationToken, DeviceStore, LocalSearchError, LocalSearchService, SourceCheckpoint,
    SourceCursor, SourceId,
};
use std::time::{Duration, Instant};

fn checkpoint(cursor: &str, count: u64) -> SourceCheckpoint {
    SourceCheckpoint::new(SourceCursor::new(cursor), 1_752_400_800_000, count)
}

fn payload(text: &str, participant: &str, authored_by_me: bool, thread: &str) -> String {
    serde_json::json!({
        "thread": {"durableId": thread, "title": "Launch room"},
        "participants": [{
            "durableId": participant,
            "role": "participant",
            "identifiers": [{"kind": "phone", "value": participant}]
        }],
        "media": [],
        "authoredByMe": authored_by_me,
        "text": text
    })
    .to_string()
}

fn stage(
    store: &DeviceStore,
    generation: botmem_device_core::StagedGeneration,
    source_id: &str,
    text: &str,
    occurred_at_ms: i64,
    participant: &str,
    authored_by_me: bool,
) {
    let payload = payload(text, participant, authored_by_me, "thread:launch");
    store
        .stage_document(
            generation,
            &StagedDocument {
                source_id,
                revision: "revision-1",
                occurred_at_ms: Some(occurred_at_ms),
                searchable_text: text,
                payload_json: &payload,
            },
        )
        .expect("stage document");
}

fn query(text: &str) -> DeviceSearchQuery {
    DeviceSearchQuery {
        query: text.to_owned(),
        connectors: None,
        kinds: None,
        from: None,
        to: None,
        participant_id: None,
        authored_by_me: None,
        limit: 20,
        cursor: None,
    }
}

fn run(
    store: &DeviceStore,
    query: &DeviceSearchQuery,
) -> Result<botmem_device_core::LocalSearchResponse, LocalSearchError> {
    LocalSearchService::new(store).search(
        query,
        Instant::now() + Duration::from_secs(2),
        CancellationToken::default(),
    )
}

fn ready_store() -> (tempfile::TempDir, DeviceStore) {
    let directory = tempfile::tempdir().expect("temp directory");
    let mut store = DeviceStore::open(directory.path()).expect("open store");
    let imessage = store
        .begin_rebuild(SourceId::IMessage)
        .expect("begin iMessage generation");
    stage(
        &store,
        imessage,
        "message:english",
        "Launch planning with the platform team",
        1_752_400_800_000,
        "+15550001001",
        true,
    );
    stage(
        &store,
        imessage,
        "message:arabic",
        "مَرْحَبًا بالفريق وخطة الاطلاق",
        1_752_404_400_000,
        "+15550001002",
        false,
    );
    store
        .activate_rebuild(imessage, &checkpoint("imessage-ready", 2))
        .expect("activate iMessage");

    let whatsapp = store
        .begin_rebuild(SourceId::Whatsapp)
        .expect("begin WhatsApp generation");
    stage(
        &store,
        whatsapp,
        "message:whatsapp",
        "Launch details from WhatsApp",
        1_752_408_000_000,
        "15550002002@s.whatsapp.net",
        false,
    );
    store
        .activate_rebuild(whatsapp, &checkpoint("whatsapp-ready", 1))
        .expect("activate WhatsApp");
    (directory, store)
}

#[test]
fn search_exact_prefix_and_arabic_use_the_active_fts_generation() {
    let (_directory, store) = ready_store();

    let exact = run(&store, &query("launch planning")).expect("exact search");
    assert_eq!(exact.items.len(), 1);
    assert_eq!(exact.items[0].source_id, "message:english");
    assert_eq!(exact.next_cursor, None);

    let prefix = run(&store, &query("laun")).expect("prefix search");
    assert_eq!(prefix.found, 2);
    assert_eq!(
        prefix
            .items
            .iter()
            .map(|item| item.source_id.as_str())
            .collect::<Vec<_>>(),
        vec!["message:whatsapp", "message:english"]
    );

    let arabic = run(&store, &query("مرحبا")).expect("Arabic search");
    assert_eq!(arabic.items[0].source_id, "message:arabic");

    let typo = run(&store, &query("lauch")).expect("typo search");
    assert_eq!(typo.found, 2);
    assert_eq!(typo.items[0].source_id, "message:whatsapp");

    let arabic_typo = run(&store, &query("مرخبا")).expect("Arabic typo search");
    assert_eq!(arabic_typo.found, 1);
    assert_eq!(arabic_typo.items[0].source_id, "message:arabic");
}

#[test]
fn search_applies_connector_time_participant_and_authorship_filters() {
    let (_directory, store) = ready_store();
    let mut filtered = query("launch");
    filtered.connectors = Some(vec![SourceId::IMessage]);
    filtered.from = Some("2025-07-13T09:00:00.000Z".to_owned());
    filtered.to = Some("2025-07-13T10:30:00.000Z".to_owned());
    filtered.participant_id = Some("+15550001001".to_owned());
    filtered.authored_by_me = Some(true);

    let response = run(&store, &filtered).expect("filtered search");
    assert_eq!(response.found, 1);
    let item = &response.items[0];
    assert_eq!(item.connector, SourceId::IMessage);
    assert_eq!(item.participants[0].durable_id, "+15550001001");
    assert_eq!(item.authored_by_me, Some(true));
    assert_eq!(item.r#ref, "imessage:message:english");
    assert!(item.occurred_at.is_some());
}

#[test]
fn staged_and_failed_generations_never_leak_into_search() {
    let (_directory, mut store) = ready_store();
    let staged = store
        .begin_rebuild(SourceId::IMessage)
        .expect("begin replacement");
    stage(
        &store,
        staged,
        "message:hidden",
        "hiddenneedle",
        1_752_500_000_000,
        "+15550001003",
        false,
    );
    assert_eq!(
        run(&store, &query("hiddenneedle"))
            .expect("hidden search")
            .found,
        0
    );
    assert_eq!(
        run(&store, &query("launch"))
            .expect("last good search")
            .found,
        2
    );

    store
        .fail_rebuild(staged, "permission_revoked")
        .expect("fail rebuild");
    assert_eq!(
        run(&store, &query("hiddenneedle"))
            .expect("failed search")
            .found,
        0
    );
    assert_eq!(
        run(&store, &query("launch"))
            .expect("preserved search")
            .found,
        2
    );
}

#[test]
fn deadline_and_cancellation_stop_search_without_returning_partial_rows() {
    let (_directory, store) = ready_store();
    let deadline = LocalSearchService::new(&store).search(
        &query("launch"),
        Instant::now(),
        CancellationToken::default(),
    );
    assert!(matches!(deadline, Err(LocalSearchError::DeadlineExceeded)));

    let cancellation = CancellationToken::default();
    cancellation.cancel();
    let cancelled = LocalSearchService::new(&store).search(
        &query("launch"),
        Instant::now() + Duration::from_secs(1),
        cancellation,
    );
    assert!(matches!(cancelled, Err(LocalSearchError::Cancelled)));

    let mut cursor_request = query("launch");
    cursor_request.cursor = Some("must-never-contain-device-results".to_owned());
    let cursor = run(&store, &cursor_request);
    assert!(matches!(cursor, Err(LocalSearchError::UnsupportedCursor)));
}

#[test]
fn readonly_helper_store_can_search_but_cannot_mutate_source_state() {
    let (directory, writer) = ready_store();
    drop(writer);

    let reader = DeviceStore::open_readonly(directory.path()).expect("open readonly store");
    let response = run(&reader, &query("launch")).expect("readonly search");
    assert_eq!(response.found, 2);
    assert!(reader
        .status(SourceId::IMessage)
        .expect("status")
        .searchable());

    let mutation = reader.set_readiness(
        SourceId::IMessage,
        botmem_device_core::SourceReadiness::Disabled,
        Some("user_disabled"),
    );
    assert!(mutation.is_err(), "readonly connection accepted a mutation");
}

#[test]
fn query_plan_uses_the_fts5_virtual_table_and_order_is_repeatable() {
    let (_directory, store) = ready_store();
    let service = LocalSearchService::new(&store);
    let plan = service
        .explain_query_plan(&query("launch"))
        .expect("query plan");
    assert!(
        plan.iter()
            .any(|detail| detail.contains("VIRTUAL TABLE INDEX")),
        "query plan did not use FTS5: {plan:?}"
    );

    let first = run(&store, &query("launch")).expect("first search");
    let second = run(&store, &query("launch")).expect("second search");
    assert_eq!(first.items, second.items);
}

#[test]
#[ignore = "manual 100k scale harness; reports evidence but enforces no unmeasured SLA"]
fn search_100k_scale_harness_reports_plan_and_elapsed_time() {
    let directory = tempfile::tempdir().expect("temp directory");
    let mut store = DeviceStore::open(directory.path()).expect("open store");
    let generation = store
        .begin_rebuild(SourceId::IMessage)
        .expect("begin generation");
    for index in 0..100_000u64 {
        let source_id = format!("message:{index:06}");
        let text = if index % 1_000 == 0 {
            format!("launch sentinel {index}")
        } else {
            format!("ordinary device message {index}")
        };
        stage(
            &store,
            generation,
            &source_id,
            &text,
            1_700_000_000_000 + index as i64,
            "+15550001001",
            false,
        );
    }
    store
        .activate_rebuild(generation, &checkpoint("100k", 100_000))
        .expect("activate 100k generation");
    // Warm both the FTS and typo candidate indexes before collecting a fixed
    // exact/selective, exact/common, typo/selective, and typo/common workload.
    run(&store, &query("launch")).expect("100k warmup");
    run(&store, &query("lauch")).expect("100k typo warmup");
    let mut samples_us = Vec::with_capacity(100);
    for index in 0..100 {
        let (term, expected) = match index % 4 {
            0 => ("launch", 100),
            1 => ("ordinary device", 99_900),
            2 => ("lauch", 100),
            _ => ("ordnary device", 99_900),
        };
        let started = Instant::now();
        let response = run(&store, &query(term)).expect("100k measured search");
        samples_us.push(started.elapsed().as_micros());
        assert_eq!(response.found, expected, "unexpected count for {term}");
    }
    samples_us.sort_unstable();
    let p50_us = samples_us[49];
    let p95_us = samples_us[94];
    let max_us = samples_us[99];
    let plan = LocalSearchService::new(&store)
        .explain_query_plan(&query("launch"))
        .expect("100k plan");
    assert!(plan
        .iter()
        .any(|detail| detail.contains("VIRTUAL TABLE INDEX")));
    eprintln!(
        "botmem local FTS+typo 100k mixed/100 queries: p50={p50_us}us p95={p95_us}us max={max_us}us; plan={plan:?}"
    );
}
