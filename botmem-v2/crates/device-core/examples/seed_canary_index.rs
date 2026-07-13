use botmem_device_core::storage::StagedDocument;
use botmem_device_core::{DeviceStore, EngineLock, SourceCheckpoint, SourceCursor, SourceId};
use std::error::Error;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const SENTINEL: &str = "botmemlocalonlysentinel";
const BATCH_SIZE: usize = 1_000;

fn main() -> Result<(), Box<dyn Error>> {
    let mut arguments = std::env::args_os().skip(1);
    let root = PathBuf::from(arguments.next().ok_or("index root is required")?);
    let count = arguments
        .next()
        .ok_or("document count is required")?
        .into_string()
        .map_err(|_| "document count is not UTF-8")?
        .parse::<u64>()?;
    if arguments.next().is_some() || !(1..=1_000_000).contains(&count) {
        return Err("usage: seed_canary_index <root> <count <= 1000000>".into());
    }

    let _lock = EngineLock::try_acquire(&root)?;
    let mut store = DeviceStore::open(&root)?;
    let generation = store.begin_rebuild(SourceId::IMessage)?;
    let payload = serde_json::json!({
        "thread": {"durableId": "thread:canary", "title": "Canary"},
        "participants": [{
            "durableId": "+15550001001",
            "role": "participant",
            "identifiers": [{"kind": "phone", "value": "+15550001001"}]
        }],
        "media": [],
        "authoredByMe": false
    })
    .to_string();
    for batch_start in (0..count).step_by(BATCH_SIZE) {
        let batch_end = (batch_start + BATCH_SIZE as u64).min(count);
        let owned = (batch_start..batch_end)
            .map(|index| {
                let source_id = format!("canary:{index:08}");
                let text = if index % 1_000 == 0 {
                    format!("{SENTINEL} production relay result {index}")
                } else {
                    format!("ordinary private device message {index}")
                };
                (index, source_id, text)
            })
            .collect::<Vec<_>>();
        let documents = owned
            .iter()
            .map(|(index, source_id, text)| StagedDocument {
                source_id,
                revision: "revision-1",
                occurred_at_ms: Some(1_700_000_000_000 + *index as i64),
                searchable_text: text,
                payload_json: &payload,
            })
            .collect::<Vec<_>>();
        store.stage_documents(generation, &documents)?;
    }
    let completed_at_ms = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as i64;
    store.activate_rebuild(
        generation,
        &SourceCheckpoint::new(SourceCursor::new("canary-ready"), completed_at_ms, count),
    )?;
    println!("seeded={count} sentinel={SENTINEL}");
    Ok(())
}
