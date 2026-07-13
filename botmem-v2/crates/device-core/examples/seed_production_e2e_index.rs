use botmem_device_core::storage::StagedDocument;
use botmem_device_core::{DeviceStore, EngineLock, SourceCheckpoint, SourceCursor, SourceId};
use std::error::Error;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const QUERY: &str = "production handoff nexus";

fn main() -> Result<(), Box<dyn Error>> {
    let mut arguments = std::env::args_os().skip(1);
    let root = PathBuf::from(arguments.next().ok_or("index root is required")?);
    if arguments.next().is_some() {
        return Err("usage: seed_production_e2e_index <root>".into());
    }

    let _lock = EngineLock::try_acquire(&root)?;
    let mut store = DeviceStore::open(&root)?;
    seed(
        &mut store,
        SourceId::IMessage,
        "imessage-e2e",
        1_700_000_004_000,
    )?;
    seed(
        &mut store,
        SourceId::Whatsapp,
        "whatsapp-e2e",
        1_700_000_005_000,
    )?;
    println!("seeded=2 query={QUERY}");
    Ok(())
}

fn seed(
    store: &mut DeviceStore,
    source: SourceId,
    source_id: &str,
    occurred_at_ms: i64,
) -> Result<(), Box<dyn Error>> {
    let generation = store.begin_rebuild(source)?;
    let payload = serde_json::json!({
        "thread": {
            "durableId": format!("{}:thread:e2e", source.as_str()),
            "title": "Production E2E"
        },
        "participants": [{
            "durableId": "+15550001111",
            "role": "participant",
            "identifiers": [{"kind": "phone", "value": "+15550001111"}]
        }],
        "media": [],
        "authoredByMe": false
    })
    .to_string();
    store.stage_document(
        generation,
        &StagedDocument {
            source_id,
            revision: "revision-e2e-1",
            occurred_at_ms: Some(occurred_at_ms),
            searchable_text: &format!("{QUERY} private {} result", source.as_str()),
            payload_json: &payload,
        },
    )?;
    let completed_at_ms = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as i64;
    store.activate_rebuild(
        generation,
        &SourceCheckpoint::new(
            SourceCursor::new("production-e2e-ready"),
            completed_at_ms,
            1,
        ),
    )?;
    Ok(())
}
