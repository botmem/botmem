//! Engine configuration, parsed from the JSON blob handed across the FFI by the
//! Swift host (or read from `~/.botmem/apple-bridge/config.json`).

use serde::Deserialize;
use std::path::PathBuf;

/// Configuration required to start the engine.
///
/// Matches the onboarding inputs (`--token` / `--server`) plus optional path
/// overrides. Unknown fields are ignored so the Swift side can add metadata
/// without breaking the engine.
#[derive(Debug, Clone, Deserialize)]
pub struct EngineConfig {
    /// Bridge token, prefix `apple_bt_` (see PROTOCOL.md §2).
    pub token: String,
    /// Tunnel server URL, e.g. `wss://api.botmem.xyz/apple-tunnel`.
    pub server: String,
    /// Comma-separated source list advertised to the server during auth.
    /// Defaults to `contacts,imessages,whatsapp` when absent.
    #[serde(default)]
    pub sources: Option<String>,
    /// Override for the status file path (else `BRIDGE_STATUS_PATH` env, else
    /// `~/.botmem/bridge-status.json`).
    #[serde(default)]
    pub status_path: Option<String>,
    /// Override for the engine data dir (index, config). Defaults to
    /// `~/.botmem/apple-bridge`.
    #[serde(default)]
    pub data_dir: Option<String>,
}

impl EngineConfig {
    /// Parse and validate a config JSON string.
    pub fn from_json(s: &str) -> Result<Self, ConfigError> {
        let cfg: EngineConfig = serde_json::from_str(s).map_err(ConfigError::Parse)?;
        cfg.validate()?;
        Ok(cfg)
    }

    fn validate(&self) -> Result<(), ConfigError> {
        if self.token.trim().is_empty() {
            return Err(ConfigError::Missing("token"));
        }
        if self.server.trim().is_empty() {
            return Err(ConfigError::Missing("server"));
        }
        if !(self.server.starts_with("ws://") || self.server.starts_with("wss://")) {
            return Err(ConfigError::BadServer);
        }
        Ok(())
    }

    /// Effective `sources` string sent in the auth handshake.
    pub fn sources_or_default(&self) -> String {
        self.sources
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("contacts,imessages,whatsapp")
            .to_string()
    }

    /// Resolve the engine data directory (`~/.botmem/apple-bridge` by default).
    pub fn resolve_data_dir(&self) -> PathBuf {
        if let Some(d) = &self.data_dir {
            return PathBuf::from(d);
        }
        home_dir().join(".botmem").join("apple-bridge")
    }

    /// Resolve the status file path (explicit → `BRIDGE_STATUS_PATH` → default).
    pub fn resolve_status_path(&self) -> PathBuf {
        if let Some(p) = &self.status_path {
            return PathBuf::from(p);
        }
        if let Ok(env) = std::env::var("BRIDGE_STATUS_PATH") {
            if !env.is_empty() {
                return PathBuf::from(env);
            }
        }
        home_dir().join(".botmem").join("bridge-status.json")
    }

    /// Token with the random part redacted for logging — NEVER log the full
    /// token. Keeps the human-meaningful prefix (`apple_bt_`/`imsg_bt_`): the
    /// random suffix has no underscores, so everything up to the final `_` is
    /// the prefix.
    pub fn redacted_token(&self) -> String {
        match self.token.rsplit_once('_') {
            Some((prefix, _)) => format!("{prefix}_…"),
            None => "…".to_string(),
        }
    }
}

/// Best-effort home directory (`$HOME`, else `/tmp`). Avoids pulling a crate in
/// just for this; macOS always sets `$HOME`.
pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("invalid config json: {0}")]
    Parse(#[source] serde_json::Error),
    #[error("missing required config field: {0}")]
    Missing(&'static str),
    #[error("server must be a ws:// or wss:// url")]
    BadServer,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_config() {
        let cfg = EngineConfig::from_json(
            r#"{"token":"apple_bt_abc","server":"wss://api.botmem.xyz/apple-tunnel"}"#,
        )
        .unwrap();
        assert_eq!(cfg.token, "apple_bt_abc");
        assert_eq!(cfg.sources_or_default(), "contacts,imessages,whatsapp");
        assert_eq!(cfg.redacted_token(), "apple_bt_…");
    }

    #[test]
    fn ignores_unknown_fields() {
        let cfg = EngineConfig::from_json(
            r#"{"token":"apple_bt_x","server":"wss://x/y","deviceName":"Amr's Mac","extra":1}"#,
        );
        assert!(cfg.is_ok());
    }

    #[test]
    fn rejects_missing_token() {
        let err = EngineConfig::from_json(r#"{"token":"","server":"wss://x/y"}"#).unwrap_err();
        assert!(matches!(err, ConfigError::Missing("token")));
    }

    #[test]
    fn rejects_non_ws_server() {
        let err =
            EngineConfig::from_json(r#"{"token":"apple_bt_x","server":"https://x/y"}"#).unwrap_err();
        assert!(matches!(err, ConfigError::BadServer));
    }

    #[test]
    fn custom_sources_passthrough() {
        let cfg = EngineConfig::from_json(
            r#"{"token":"apple_bt_x","server":"wss://x/y","sources":"contacts,imessages"}"#,
        )
        .unwrap();
        assert_eq!(cfg.sources_or_default(), "contacts,imessages");
    }
}
