//! End-to-end RPC-over-crypto roundtrip (no network): simulate exactly what the
//! server does on the wire — encrypt a JSON-RPC request with the shared session
//! key, then run it through the bridge's decrypt → dispatch (index) → encrypt
//! response path, and decrypt the response as the server would. Proves the
//! crypto framing + RPC layer + index integrate correctly.

use botmem_engine::index::{IndexDispatcher, IndexRecord, IndexStore, SourceName};
use botmem_engine::rpc::{handle_payload, RpcDispatch};
use botmem_engine::tunnel::crypto::{decrypt, encrypt, KeyPair};
use serde_json::{json, Value};

fn shared_key() -> [u8; 32] {
    // Two ephemeral keypairs (server + bridge) → same derived key, like the wire.
    let server = KeyPair::generate().unwrap();
    let bridge = KeyPair::generate().unwrap();
    let ks = server.derive_session_key(&bridge.public_raw).unwrap();
    let kb = bridge.derive_session_key(&server.public_raw).unwrap();
    assert_eq!(ks, kb);
    ks
}

fn dispatcher() -> IndexDispatcher {
    let mut store = IndexStore::open_in_memory().unwrap();
    store
        .add_records(
            SourceName::Whatsapp,
            &[IndexRecord {
                source_id: "42".into(),
                text: "the next installment amount is 50,000 due Friday".into(),
                sender_name: "Mostafa".into(),
                sender_id: "lid-123".into(),
                thread_title: "Parkwoods".into(),
                thread_id: "chat-pw".into(),
                ts: 1_700_000_000,
                ..Default::default()
            }],
        )
        .unwrap();
    store.set_source_state(SourceName::Whatsapp, 1, None).unwrap();
    IndexDispatcher::new(store)
}

/// Drive one request through the full wire path; return the decrypted response.
fn wire_call(key: &[u8; 32], dispatch: &dyn RpcDispatch, request: &Value) -> Value {
    // Server side: encrypt the request frame.
    let req_bytes = serde_json::to_vec(request).unwrap();
    let frame = encrypt(key, &req_bytes).unwrap();

    // Bridge side: decrypt → dispatch → encrypt response.
    let plain = decrypt(key, &frame).unwrap();
    let resp_bytes = handle_payload(dispatch, &plain);
    let resp_frame = encrypt(key, &resp_bytes).unwrap();

    // Server side: decrypt the response.
    let resp_plain = decrypt(key, &resp_frame).unwrap();
    serde_json::from_slice(&resp_plain).unwrap()
}

#[test]
fn search_query_over_the_wire() {
    let key = shared_key();
    let d = dispatcher();

    let resp = wire_call(
        &key,
        &d,
        &json!({ "jsonrpc": "2.0", "id": 7, "method": "search.query",
                 "params": { "query": "installment", "limit": 10 } }),
    );

    assert_eq!(resp["jsonrpc"], "2.0");
    assert_eq!(resp["id"], 7);
    let items = resp["result"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["connectorType"], "whatsapp");
    assert_eq!(items[0]["sourceType"], "message");
    assert_eq!(items[0]["id"], "whatsapp:42");
    assert_eq!(items[0]["people"][0]["name"], "Mostafa");
    assert!(items[0]["eventTime"].as_str().unwrap().ends_with('Z'));
    assert!(items[0]["score"].as_f64().is_some());
}

#[test]
fn bridge_status_over_the_wire() {
    let key = shared_key();
    let d = dispatcher();
    let resp = wire_call(
        &key,
        &d,
        &json!({ "jsonrpc": "2.0", "id": 1, "method": "bridge.status" }),
    );
    let sources = resp["result"]["sources"].as_array().unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0]["source"], "whatsapp");
    assert_eq!(sources[0]["count"], 1);
    assert!(sources[0]["lastIndexedAt"].is_number());
}

#[test]
fn ping_over_the_wire() {
    let key = shared_key();
    let d = dispatcher();
    let resp = wire_call(
        &key,
        &d,
        &json!({ "jsonrpc": "2.0", "id": 99, "method": "ping" }),
    );
    assert_eq!(resp["id"], 99);
    assert_eq!(resp["result"]["pong"], true);
}
