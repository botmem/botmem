use botmem_device_core::SourceId;
use serde::Deserialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use thiserror::Error;
use url::Url;
use uuid::Uuid;

pub const TUNNEL_CONFIG_PROTOCOL: &str = "botmem.tunnel.config.v1";
const MAX_CONFIG_BYTES: usize = 65_536;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TunnelConfig {
    pub protocol_version: String,
    pub api_base_url: String,
    pub workspace_id: String,
    pub device_id: String,
    pub key_id: String,
    pub client_version: String,
    pub connectors: Vec<SourceId>,
    pub index_root: PathBuf,
    pub signing_socket: PathBuf,
    #[serde(default)]
    pub trust_anchor_pem: Option<String>,
}

impl TunnelConfig {
    pub fn read_stdin() -> Result<Self, ConfigError> {
        Self::read(std::io::stdin().lock())
    }

    pub fn read(reader: impl Read) -> Result<Self, ConfigError> {
        let mut bytes = Vec::new();
        reader
            .take((MAX_CONFIG_BYTES + 1) as u64)
            .read_to_end(&mut bytes)?;
        if bytes.len() > MAX_CONFIG_BYTES {
            return Err(ConfigError::TooLarge);
        }
        let config: Self = serde_json::from_slice(&bytes)?;
        config.validate()?;
        Ok(config)
    }

    pub fn tunnel_url(&self) -> Result<Url, ConfigError> {
        let mut url = Url::parse(&self.api_base_url).map_err(|_| ConfigError::InvalidUrl)?;
        url.set_scheme("wss").map_err(|_| ConfigError::InvalidUrl)?;
        url.set_path(&format!(
            "/v2/workspaces/{}/device-tunnel",
            self.workspace_id
        ));
        url.set_query(None);
        url.set_fragment(None);
        Ok(url)
    }

    fn validate(&self) -> Result<(), ConfigError> {
        if self.protocol_version != TUNNEL_CONFIG_PROTOCOL {
            return Err(ConfigError::InvalidField("protocolVersion"));
        }
        let api = Url::parse(&self.api_base_url).map_err(|_| ConfigError::InvalidUrl)?;
        if api.scheme() != "https"
            || api.host_str().is_none()
            || !api.username().is_empty()
            || api.password().is_some()
            || api.path() != "/"
            || api.query().is_some()
            || api.fragment().is_some()
        {
            return Err(ConfigError::InvalidUrl);
        }
        Uuid::parse_str(&self.workspace_id)
            .map_err(|_| ConfigError::InvalidField("workspaceId"))?;
        Uuid::parse_str(&self.device_id).map_err(|_| ConfigError::InvalidField("deviceId"))?;
        bounded(&self.key_id, 1, 128, "keyId")?;
        bounded(&self.client_version, 1, 64, "clientVersion")?;
        if self.connectors.is_empty() || self.connectors.len() > 2 {
            return Err(ConfigError::InvalidField("connectors"));
        }
        let mut connectors = self.connectors.clone();
        connectors.sort_by_key(|source| source.as_str());
        connectors.dedup();
        if connectors.len() != self.connectors.len() {
            return Err(ConfigError::InvalidField("connectors"));
        }
        absolute_private_path(&self.index_root, "indexRoot")?;
        absolute_private_path(&self.signing_socket, "signingSocket")?;
        if let Some(anchor) = &self.trust_anchor_pem {
            if anchor.is_empty() || anchor.len() > 32_768 {
                return Err(ConfigError::InvalidField("trustAnchorPem"));
            }
        }
        Ok(())
    }
}

fn bounded(
    value: &str,
    minimum: usize,
    maximum: usize,
    field: &'static str,
) -> Result<(), ConfigError> {
    if value.trim() != value || value.len() < minimum || value.len() > maximum {
        return Err(ConfigError::InvalidField(field));
    }
    Ok(())
}

fn absolute_private_path(path: &Path, field: &'static str) -> Result<(), ConfigError> {
    if !path.is_absolute() || path.as_os_str().len() > 4_096 {
        return Err(ConfigError::InvalidField(field));
    }
    Ok(())
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("tunnel configuration exceeds the maximum size")]
    TooLarge,
    #[error("tunnel configuration URL is invalid")]
    InvalidUrl,
    #[error("tunnel configuration field is invalid: {0}")]
    InvalidField(&'static str),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> serde_json::Value {
        serde_json::json!({
            "protocolVersion": TUNNEL_CONFIG_PROTOCOL,
            "apiBaseUrl": "https://relay.example.test/",
            "workspaceId": "10000000-0000-4000-8000-000000000001",
            "deviceId": "20000000-0000-4000-8000-000000000002",
            "keyId": "key-1",
            "clientVersion": "botmem-tunnel/0.1.0",
            "connectors": ["imessage"],
            "indexRoot": "/tmp/botmem-index",
            "signingSocket": "/tmp/botmem-sign.sock"
        })
    }

    #[test]
    fn reads_bounded_non_secret_stdin_and_derives_wss_route() {
        let config = TunnelConfig::read(fixture().to_string().as_bytes()).expect("config");
        assert_eq!(
            config.tunnel_url().expect("tunnel URL").as_str(),
            "wss://relay.example.test/v2/workspaces/10000000-0000-4000-8000-000000000001/device-tunnel"
        );
    }

    #[test]
    fn rejects_plaintext_credentials_unknown_fields_and_oversize() {
        for mutation in [
            (
                "apiBaseUrl",
                serde_json::json!("http://relay.example.test/"),
            ),
            (
                "apiBaseUrl",
                serde_json::json!("https://user:secret@relay.example.test/"),
            ),
        ] {
            let mut value = fixture();
            value[mutation.0] = mutation.1;
            assert!(TunnelConfig::read(value.to_string().as_bytes()).is_err());
        }
        let mut value = fixture();
        value["secret"] = serde_json::json!("must-not-exist");
        assert!(TunnelConfig::read(value.to_string().as_bytes()).is_err());
        assert!(matches!(
            TunnelConfig::read(vec![b'x'; MAX_CONFIG_BYTES + 1].as_slice()),
            Err(ConfigError::TooLarge)
        ));
    }
}
