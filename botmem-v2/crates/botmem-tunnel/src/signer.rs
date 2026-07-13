use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use std::os::unix::fs::FileTypeExt;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

pub const SIGNING_PROTOCOL: &str = "botmem.signing.ipc.v1";
const MAX_SIGNING_FRAME_BYTES: usize = 16_384;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SigningRequest<'a> {
    protocol_version: &'static str,
    operation: &'static str,
    device_id: &'a str,
    key_id: &'a str,
    client_nonce: &'a str,
    server_nonce: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SigningResponse {
    protocol_version: String,
    ok: bool,
    signature_base64_url: Option<String>,
    error_code: Option<String>,
}

pub async fn sign_authentication(
    socket_path: &Path,
    device_id: &str,
    key_id: &str,
    client_nonce: &str,
    server_nonce: &str,
) -> Result<String, SigningError> {
    verify_socket(socket_path)?;
    let request = SigningRequest {
        protocol_version: SIGNING_PROTOCOL,
        operation: "signAuthentication",
        device_id,
        key_id,
        client_nonce,
        server_nonce,
    };
    let mut bytes = serde_json::to_vec(&request)?;
    if bytes.len() >= MAX_SIGNING_FRAME_BYTES {
        return Err(SigningError::InvalidFrame);
    }
    bytes.push(b'\n');

    let mut stream = UnixStream::connect(socket_path).await?;
    stream.write_all(&bytes).await?;
    stream.shutdown().await?;
    let mut response = Vec::new();
    BufReader::new(stream)
        .take(MAX_SIGNING_FRAME_BYTES as u64 + 1)
        .read_until(b'\n', &mut response)
        .await?;
    if response.len() > MAX_SIGNING_FRAME_BYTES {
        return Err(SigningError::InvalidFrame);
    }
    let parsed: SigningResponse = serde_json::from_slice(&response)?;
    if parsed.protocol_version != SIGNING_PROTOCOL || !parsed.ok || parsed.error_code.is_some() {
        return Err(SigningError::Rejected);
    }
    let signature = parsed
        .signature_base64_url
        .ok_or(SigningError::InvalidFrame)?;
    let decoded = URL_SAFE_NO_PAD
        .decode(&signature)
        .map_err(|_| SigningError::InvalidFrame)?;
    if decoded.len() != 64 {
        return Err(SigningError::InvalidFrame);
    }
    Ok(signature)
}

fn verify_socket(socket_path: &Path) -> Result<(), SigningError> {
    let metadata = std::fs::symlink_metadata(socket_path)?;
    if !metadata.file_type().is_socket()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(SigningError::UnsafeSocket);
    }
    Ok(())
}

#[derive(Debug, Error)]
pub enum SigningError {
    #[error("signing socket is not private to this user")]
    UnsafeSocket,
    #[error("signing request was rejected")]
    Rejected,
    #[error("signing response is invalid")]
    InvalidFrame,
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
