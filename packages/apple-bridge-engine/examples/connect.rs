//! Live handshake smoke: connect to the real tunnel, prove the Rust crypto
//! interops with the Node server (auth succeeds → session key derived → status
//! flips to connected), then stop. Run with:
//!   BRIDGE_TOKEN=apple_bt_… BRIDGE_SERVER=wss://api.botmem.xyz/apple-tunnel \
//!     cargo run --example connect
use botmem_engine::Engine;
use botmem_engine::EngineConfig;

fn main() {
    let token = std::env::var("BRIDGE_TOKEN").expect("set BRIDGE_TOKEN");
    let server = std::env::var("BRIDGE_SERVER")
        .unwrap_or_else(|_| "wss://api.botmem.xyz/apple-tunnel".to_string());
    let dir = std::env::temp_dir().join("botmem-connect-example");
    let cfg = serde_json::json!({
        "token": token,
        "server": server,
        "sources": "contacts,imessages,whatsapp",
        "status_path": dir.join("status.json").to_string_lossy(),
        "data_dir": dir.to_string_lossy(),
    });
    let config = EngineConfig::from_json(&cfg.to_string()).expect("config");
    let engine = Engine::start(config).expect("start");

    // Poll status for up to ~12s waiting for the tunnel to connect.
    let mut connected = false;
    for _ in 0..24 {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let snap = engine.status().snapshot();
        if snap.connected {
            connected = true;
            println!("CONNECTED: state={:?} label={:?}", snap.state, snap.label);
            break;
        }
        if matches!(snap.state, botmem_engine::BridgeState::Error) {
            println!("ERROR: {:?}", snap.last_error);
            break;
        }
    }
    engine.stop();
    if connected {
        println!("OK: live handshake succeeded — Rust↔Node crypto interop verified");
        std::process::exit(0);
    } else {
        eprintln!("FAIL: did not reach connected state");
        std::process::exit(1);
    }
}
