//! JSON-RPC 2.0 layer (PROTOCOL.md §3/§5). The server is the caller; the bridge
//! answers. Requests arrive decrypted; responses are serialized then encrypted
//! by the tunnel client.

use serde::Deserialize;
use serde_json::{json, Value};

/// A decoded JSON-RPC request from the server.
#[derive(Debug, Deserialize)]
pub struct RpcRequest {
    #[allow(dead_code)]
    pub jsonrpc: Option<String>,
    /// Echoed verbatim on the response. Numeric per the server, but kept as a
    /// `Value` so we round-trip whatever we're given.
    #[serde(default)]
    pub id: Value,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

/// A JSON-RPC error (maps to the `error` member of the response).
#[derive(Debug, Clone)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    pub fn method_not_found(method: &str) -> Self {
        Self::new(-32601, format!("Method not found: {method}"))
    }
    pub fn invalid_params(msg: impl Into<String>) -> Self {
        Self::new(-32602, msg)
    }
}

/// Dispatches a single RPC method to a result or an error. Phase 3 implements
/// this over the local FTS index; later phases add the legacy read methods.
pub trait RpcDispatch: Send + Sync {
    fn dispatch(&self, method: &str, params: &Value) -> Result<Value, RpcError>;
}

/// Build the encrypted-channel response JSON for a request + handler outcome,
/// echoing the request `id` (PROTOCOL.md §3).
pub fn response_json(id: &Value, outcome: Result<Value, RpcError>) -> Value {
    match outcome {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(e) => {
            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": e.code, "message": e.message } })
        }
    }
}

/// Handle a raw decrypted request payload, returning the serialized response
/// bytes. A request with a null/absent id still gets a response (the server
/// drops null-id responses, but echoing keeps the code uniform).
pub fn handle_payload(dispatch: &dyn RpcDispatch, payload: &[u8]) -> Vec<u8> {
    let req: RpcRequest = match serde_json::from_slice(payload) {
        Ok(r) => r,
        Err(e) => {
            // Parse error — no id to echo; respond with a JSON-RPC parse error.
            let resp = json!({ "jsonrpc": "2.0", "id": Value::Null,
                "error": { "code": -32700, "message": format!("Parse error: {e}") } });
            return serde_json::to_vec(&resp).unwrap_or_default();
        }
    };
    let outcome = dispatch.dispatch(&req.method, &req.params);
    let resp = response_json(&req.id, outcome);
    serde_json::to_vec(&resp).unwrap_or_default()
}

/// Phase 2 dispatcher: answers `ping` and `bridge.status` (empty until the index
/// lands), and reports the index as unavailable for `search.query`. Matches the
/// legacy `rpc-handler.ts` behavior when no local index is present.
pub struct StubDispatcher;

impl RpcDispatch for StubDispatcher {
    fn dispatch(&self, method: &str, _params: &Value) -> Result<Value, RpcError> {
        match method {
            "ping" => Ok(json!({ "pong": true, "ts": crate::status::now_ms() as u64 })),
            // No index yet → empty sources (TS returns { sources: [] } in this case).
            "bridge.status" => Ok(json!({ "sources": [] })),
            // Index not available yet (Phase 3). Matches TS -32601 in this state.
            "search.query" => Err(RpcError::new(-32601, "Local search index not available")),
            other => Err(RpcError::method_not_found(other)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_roundtrips_id() {
        let req = br#"{"jsonrpc":"2.0","id":7,"method":"ping"}"#;
        let out = handle_payload(&StubDispatcher, req);
        let v: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["id"], 7);
        assert_eq!(v["result"]["pong"], true);
        assert!(v["result"]["ts"].as_u64().unwrap() > 0);
    }

    #[test]
    fn search_without_index_is_minus_32601() {
        let req = br#"{"jsonrpc":"2.0","id":1,"method":"search.query","params":{"query":"x"}}"#;
        let out = handle_payload(&StubDispatcher, req);
        let v: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["error"]["code"], -32601);
    }

    #[test]
    fn bridge_status_empty_sources() {
        let req = br#"{"jsonrpc":"2.0","id":2,"method":"bridge.status"}"#;
        let out = handle_payload(&StubDispatcher, req);
        let v: Value = serde_json::from_slice(&out).unwrap();
        assert!(v["result"]["sources"].as_array().unwrap().is_empty());
    }

    #[test]
    fn unknown_method_not_found() {
        let req = br#"{"jsonrpc":"2.0","id":3,"method":"frobnicate"}"#;
        let out = handle_payload(&StubDispatcher, req);
        let v: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["error"]["code"], -32601);
    }

    #[test]
    fn parse_error_yields_minus_32700() {
        let out = handle_payload(&StubDispatcher, b"not json");
        let v: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["error"]["code"], -32700);
        assert_eq!(v["id"], Value::Null);
    }
}
