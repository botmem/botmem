//! WebSocket tunnel client (PROTOCOL.md §1–§5).
//!
//! Connects to the Botmem API, performs the X25519 auth handshake, then runs an
//! encrypted JSON-RPC loop: decrypt server request → dispatch → encrypt
//! response. Handles ws ping/pong heartbeat and exponential reconnect. Auth
//! failure is permanent (no reconnect), matching `tunnel.ts`.

use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

use super::crypto::KeyPair;
use crate::rpc::{handle_payload, RpcDispatch};
use crate::status::{BridgeState, StatusWriter};

const MAX_BACKOFF_MS: u64 = 30_000;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);

/// Inputs for a tunnel session.
pub struct TunnelClient {
    pub server: String,
    pub token: String,
    pub sources: String,
    pub status: Arc<StatusWriter>,
    pub dispatch: Arc<dyn RpcDispatch>,
}

#[derive(Deserialize)]
struct AuthResponse {
    event: String,
    data: AuthResponseData,
}

#[derive(Deserialize)]
struct AuthResponseData {
    ok: bool,
    #[serde(default)]
    #[serde(rename = "publicKey")]
    public_key: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

/// Outcome of a single connection attempt.
enum ConnOutcome {
    /// Was connected, then the socket dropped — reconnect.
    Disconnected,
    /// Could not establish/authenticate at transport level — reconnect w/ backoff.
    ConnectError(String),
    /// Server rejected auth — permanent, do not reconnect.
    Fatal(String),
    /// Asked to shut down — stop cleanly.
    Shutdown,
}

impl TunnelClient {
    /// Run until shutdown or a fatal auth failure.
    pub async fn run(self, mut shutdown: watch::Receiver<bool>) {
        let mut attempt: u32 = 0;
        loop {
            if *shutdown.borrow() {
                break;
            }
            self.status.set_state(BridgeState::Connecting, "Connecting to Botmem…");

            match self.connect_once(&mut shutdown).await {
                ConnOutcome::Shutdown => break,
                ConnOutcome::Fatal(reason) => {
                    self.status.set_connected(false);
                    self.status.set_error(Some(format!("Authentication failed: {reason}")));
                    self.status.set_state(BridgeState::Error, "Authentication failed");
                    self.status.push_activity("Authentication failed");
                    tracing::error!("tunnel auth failed (permanent): {reason}");
                    break;
                }
                ConnOutcome::Disconnected => {
                    // We had a good connection; reset backoff.
                    attempt = 0;
                    self.status.set_connected(false);
                    self.status.set_state(BridgeState::Connecting, "Reconnecting to Botmem…");
                    self.status.push_activity("Disconnected");
                    if self.backoff(attempt, &mut shutdown).await {
                        break;
                    }
                }
                ConnOutcome::ConnectError(msg) => {
                    self.status.set_connected(false);
                    self.status.set_state(BridgeState::Connecting, "Reconnecting to Botmem…");
                    tracing::warn!("tunnel connect error: {msg}");
                    let did_shutdown = self.backoff(attempt, &mut shutdown).await;
                    attempt = attempt.saturating_add(1);
                    if did_shutdown {
                        break;
                    }
                }
            }
        }
        tracing::info!("tunnel client stopped");
    }

    /// Sleep for the backoff delay, returning true if shutdown fired meanwhile.
    async fn backoff(&self, attempt: u32, shutdown: &mut watch::Receiver<bool>) -> bool {
        let delay = (1000u64).saturating_mul(1u64 << attempt.min(5)).min(MAX_BACKOFF_MS);
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(delay)) => false,
            _ = wait_shutdown(shutdown) => true,
        }
    }

    async fn connect_once(&self, shutdown: &mut watch::Receiver<bool>) -> ConnOutcome {
        // Build the request with the bridge User-Agent (PROTOCOL.md §1).
        let mut request = match self.server.as_str().into_client_request() {
            Ok(r) => r,
            Err(e) => return ConnOutcome::ConnectError(format!("bad server url: {e}")),
        };
        let ua = concat!("botmem-apple-bridge/", env!("CARGO_PKG_VERSION"));
        request
            .headers_mut()
            .insert("User-Agent", HeaderValue::from_static(ua));

        let ws = tokio::select! {
            res = tokio_tungstenite::connect_async(request) => res,
            _ = wait_shutdown(shutdown) => return ConnOutcome::Shutdown,
        };
        let (ws_stream, _resp) = match ws {
            Ok(v) => v,
            Err(e) => return ConnOutcome::ConnectError(e.to_string()),
        };
        let (mut write, mut read) = ws_stream.split();

        // ── Handshake ────────────────────────────────────────────────────────
        self.status.set_state(BridgeState::Connecting, "Authenticating…");
        let keypair = match KeyPair::generate() {
            Ok(k) => k,
            Err(e) => return ConnOutcome::ConnectError(e.to_string()),
        };
        let auth = json!({
            "event": "auth",
            "data": {
                "token": self.token,
                "publicKey": B64.encode(keypair.public_raw),
                "sources": self.sources,
            }
        });
        if let Err(e) = write.send(Message::Text(auth.to_string())).await {
            return ConnOutcome::ConnectError(format!("send auth: {e}"));
        }

        // Await the auth response (JSON text frame).
        let session_key = loop {
            let msg = tokio::select! {
                m = read.next() => m,
                _ = wait_shutdown(shutdown) => return ConnOutcome::Shutdown,
            };
            match msg {
                Some(Ok(Message::Text(txt))) => {
                    let resp: AuthResponse = match serde_json::from_str(&txt) {
                        Ok(r) => r,
                        Err(e) => return ConnOutcome::ConnectError(format!("bad auth resp: {e}")),
                    };
                    if resp.event != "auth" {
                        continue;
                    }
                    if !resp.data.ok {
                        return ConnOutcome::Fatal(
                            resp.data.reason.unwrap_or_else(|| "unknown".to_string()),
                        );
                    }
                    let pk_b64 = match resp.data.public_key {
                        Some(p) => p,
                        None => return ConnOutcome::ConnectError("auth resp missing publicKey".into()),
                    };
                    let pk = match B64.decode(pk_b64.as_bytes()) {
                        Ok(p) => p,
                        Err(e) => return ConnOutcome::ConnectError(format!("bad server pubkey: {e}")),
                    };
                    match keypair.derive_session_key(&pk) {
                        Ok(k) => break k,
                        Err(e) => return ConnOutcome::ConnectError(e.to_string()),
                    }
                }
                Some(Ok(Message::Ping(p))) => {
                    let _ = write.send(Message::Pong(p)).await;
                }
                Some(Ok(Message::Close(_))) | None => return ConnOutcome::Disconnected,
                Some(Ok(_)) => continue, // ignore other frames pre-auth
                Some(Err(e)) => return ConnOutcome::ConnectError(e.to_string()),
            }
        };

        // ── Connected: encrypted JSON-RPC loop ────────────────────────────────
        self.status.set_connected(true);
        self.status.set_error(None);
        self.status.set_state(BridgeState::Live, "Live · connected");
        self.status.push_activity("Tunnel connected");
        tracing::info!("tunnel connected — encrypted session established");

        let mut hb = tokio::time::interval(HEARTBEAT_INTERVAL);
        hb.tick().await; // consume the immediate first tick
        // True once we've pinged and are awaiting a pong; if still true at the
        // next tick, the peer is unresponsive (~detection within one interval;
        // well under the server's 90s stale window).
        let mut awaiting_pong = false;

        loop {
            tokio::select! {
                incoming = read.next() => {
                    match incoming {
                        Some(Ok(Message::Binary(buf))) => {
                            match super::crypto::decrypt(&session_key, &buf) {
                                Ok(plain) => {
                                    let resp = handle_payload(self.dispatch.as_ref(), &plain);
                                    match super::crypto::encrypt(&session_key, &resp) {
                                        Ok(frame) => {
                                            if write.send(Message::Binary(frame)).await.is_err() {
                                                return ConnOutcome::Disconnected;
                                            }
                                        }
                                        Err(e) => tracing::warn!("encrypt response failed: {e}"),
                                    }
                                }
                                Err(e) => tracing::warn!("decrypt failed: {e}"),
                            }
                        }
                        Some(Ok(Message::Ping(p))) => {
                            let _ = write.send(Message::Pong(p)).await;
                        }
                        Some(Ok(Message::Pong(_))) => { awaiting_pong = false; }
                        Some(Ok(Message::Close(_))) | None => return ConnOutcome::Disconnected,
                        Some(Ok(_)) => {} // ignore stray text/frames post-auth
                        Some(Err(e)) => {
                            tracing::warn!("tunnel read error: {e}");
                            return ConnOutcome::Disconnected;
                        }
                    }
                }
                _ = hb.tick() => {
                    if awaiting_pong {
                        tracing::warn!("heartbeat: no pong — reconnecting");
                        return ConnOutcome::Disconnected;
                    }
                    if write.send(Message::Ping(Vec::new())).await.is_err() {
                        return ConnOutcome::Disconnected;
                    }
                    awaiting_pong = true;
                }
                _ = wait_shutdown(shutdown) => {
                    let _ = write.send(Message::Close(None)).await;
                    return ConnOutcome::Shutdown;
                }
            }
        }
    }
}

/// Resolve when shutdown is (or becomes) true. Returns immediately if already set.
async fn wait_shutdown(rx: &mut watch::Receiver<bool>) {
    if *rx.borrow() {
        return;
    }
    let _ = rx.changed().await;
}
