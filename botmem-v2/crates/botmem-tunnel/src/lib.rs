pub mod config;
mod signer;

use botmem_device_core::protocol::{
    encode_device_frame, parse_device_frame, AuthenticatePayload, AuthenticatedPayload,
    CapabilitiesPayload, ChallengePayload, DeviceFrame, DeviceMessage, DeviceSearchQuery,
    DeviceSourceStatus, HeartbeatPayload, PublicReadiness, RpcCapability, SearchResponsePayload,
    SourceStatusPayload, DEVICE_PROTOCOL, MAXIMUM_RESULT_COUNT, MAX_DEVICE_FRAME_BYTES,
};
use botmem_device_core::{
    CancellationToken, DeviceStore, LocalSearchError, LocalSearchService, SourceId, SourceReadiness,
};
use chrono::{DateTime, SecondsFormat, Utc};
use config::TunnelConfig;
use futures_util::{SinkExt, StreamExt};
use rustls::{ClientConfig, RootCertStore};
use std::collections::HashMap;
use std::io::BufReader;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};
use thiserror::Error;
use tokio::sync::{mpsc, Semaphore};
use tokio_tungstenite::tungstenite::protocol::{Message, WebSocketConfig};
use tokio_tungstenite::{connect_async_tls_with_config, Connector};
use uuid::Uuid;

const MAX_CONCURRENT_SEARCHES: usize = 8;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

pub async fn run(config: TunnelConfig) -> Result<(), TunnelError> {
    let connector = tls_connector(config.trust_anchor_pem.as_deref())?;
    let websocket = WebSocketConfig::default()
        .max_message_size(Some(MAX_DEVICE_FRAME_BYTES))
        .max_frame_size(Some(MAX_DEVICE_FRAME_BYTES));
    let (mut socket, _) = connect_async_tls_with_config(
        config.tunnel_url()?.as_str(),
        Some(websocket),
        false,
        Some(connector),
    )
    .await
    .map_err(|_| TunnelError::ConnectionFailed)?;

    let client_nonce = Uuid::new_v4().to_string();
    send(
        &mut socket,
        frame(
            DeviceMessage::Hello(botmem_device_core::protocol::HelloPayload {
                device_id: config.device_id.clone(),
                client_version: config.client_version.clone(),
                nonce: client_nonce.clone(),
            }),
            Duration::from_secs(15),
        )?,
    )
    .await?;
    let challenge = receive_challenge(&mut socket, &client_nonce).await?;
    let signature = signer::sign_authentication(
        &config.signing_socket,
        &config.device_id,
        &config.key_id,
        &client_nonce,
        &challenge.server_nonce,
    )
    .await?;
    send(
        &mut socket,
        frame(
            DeviceMessage::Authenticate(AuthenticatePayload {
                device_id: config.device_id.clone(),
                key_id: config.key_id.clone(),
                signature,
            }),
            Duration::from_secs(15),
        )?,
    )
    .await?;
    let authenticated = receive_authenticated(&mut socket).await?;
    active_session(socket, config, authenticated).await
}

async fn active_session<S>(
    mut socket: tokio_tungstenite::WebSocketStream<S>,
    config: TunnelConfig,
    authenticated: AuthenticatedPayload,
) -> Result<(), TunnelError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    send(
        &mut socket,
        frame(
            DeviceMessage::Capabilities(CapabilitiesPayload {
                connectors: config.connectors.clone(),
                rpc: vec![
                    RpcCapability::SourceStatus,
                    RpcCapability::SearchQuery,
                    RpcCapability::SearchCancel,
                ],
                maximum_result_count: MAXIMUM_RESULT_COUNT as u16,
            }),
            Duration::from_secs(15),
        )?,
    )
    .await?;
    send_status(&mut socket, &config).await?;

    let heartbeat = Duration::from_millis(authenticated.heartbeat_interval_ms);
    let mut heartbeat_tick = tokio::time::interval(heartbeat);
    heartbeat_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    heartbeat_tick.tick().await;
    let expires_at = DateTime::parse_from_rfc3339(&authenticated.credential_expires_at)
        .map_err(|_| TunnelError::Protocol)?;
    let until_expiry = (expires_at.timestamp_millis() - now_millis()).max(1) as u64;
    let expiry = tokio::time::sleep(Duration::from_millis(until_expiry));
    tokio::pin!(expiry);
    let mut heartbeat_sequence = 0_u64;
    let cancellations = Arc::new(Mutex::new(HashMap::<String, CancellationToken>::new()));
    let permits = Arc::new(Semaphore::new(MAX_CONCURRENT_SEARCHES));
    let (responses, mut response_receiver) = mpsc::channel(MAX_CONCURRENT_SEARCHES * 2);
    let mut termination = termination_signal()?;

    loop {
        tokio::select! {
            inbound = socket.next() => {
                let message = inbound.ok_or(TunnelError::Disconnected)?
                    .map_err(|_| TunnelError::Disconnected)?;
                match message {
                    Message::Binary(bytes) => {
                        let incoming = parse_runtime_frame(&bytes)?;
                        if handle_incoming(
                            incoming,
                            &config,
                            cancellations.clone(),
                            permits.clone(),
                            responses.clone(),
                        )? == IncomingAction::Revoked {
                            cancel_all(&cancellations);
                            return Err(TunnelError::Revoked);
                        }
                    }
                    Message::Text(text) => {
                        let incoming = parse_runtime_frame(text.as_bytes())?;
                        if handle_incoming(
                            incoming,
                            &config,
                            cancellations.clone(),
                            permits.clone(),
                            responses.clone(),
                        )? == IncomingAction::Revoked {
                            cancel_all(&cancellations);
                            return Err(TunnelError::Revoked);
                        }
                    }
                    Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await
                        .map_err(|_| TunnelError::Disconnected)?,
                    Message::Close(_) => return Err(TunnelError::Disconnected),
                    Message::Pong(_) | Message::Frame(_) => {}
                }
            }
            Some(response) = response_receiver.recv() => {
                match response {
                    SearchOutcome::Complete { payload, deadline_at } => {
                        if DateTime::parse_from_rfc3339(&deadline_at)
                            .map_err(|_| TunnelError::Protocol)?
                            .timestamp_millis() > now_millis()
                        {
                            send(&mut socket, frame_until(
                                DeviceMessage::SearchResponse(payload),
                                deadline_at,
                            )?).await?;
                        }
                    }
                    SearchOutcome::Cancelled => {}
                    SearchOutcome::Failed => {
                        cancel_all(&cancellations);
                        return Err(TunnelError::LocalSearchFailed);
                    }
                }
            }
            _ = heartbeat_tick.tick() => {
                send(&mut socket, frame(
                    DeviceMessage::Heartbeat(HeartbeatPayload {
                        session_id: authenticated.session_id.clone(),
                        sequence: heartbeat_sequence,
                    }),
                    heartbeat,
                )?).await?;
                heartbeat_sequence = heartbeat_sequence.saturating_add(1);
                send_status(&mut socket, &config).await?;
            }
            _ = &mut expiry => {
                cancel_all(&cancellations);
                // Credential expiry is not an operator-requested shutdown. A
                // transient exit lets the supervisor reconnect and obtain a
                // fresh bounded credential instead of treating the tunnel as
                // intentionally stopped.
                return Err(TunnelError::AuthenticationFailed);
            }
            Some(()) = termination.recv() => {
                cancel_all(&cancellations);
                return Ok(());
            }
            result = tokio::signal::ctrl_c() => {
                result.map_err(TunnelError::Io)?;
                cancel_all(&cancellations);
                return Ok(());
            }
        }
    }
}

fn handle_incoming(
    incoming: DeviceFrame,
    config: &TunnelConfig,
    cancellations: Arc<Mutex<HashMap<String, CancellationToken>>>,
    permits: Arc<Semaphore>,
    responses: mpsc::Sender<SearchOutcome>,
) -> Result<IncomingAction, TunnelError> {
    match incoming.message {
        DeviceMessage::SearchRequest(payload) => {
            let deadline_at = incoming.deadline_at;
            let deadline_wall = DateTime::parse_from_rfc3339(&deadline_at)
                .map_err(|_| TunnelError::Protocol)?
                .timestamp_millis();
            if deadline_wall <= now_millis() {
                return Ok(IncomingAction::Continue);
            }
            let mut query = payload.query;
            query.connectors = enabled_query_connectors(query.connectors, &config.connectors);
            let query_id = payload.query_id;
            if query.connectors.as_ref().is_some_and(Vec::is_empty) {
                responses
                    .try_send(SearchOutcome::Complete {
                        payload: SearchResponsePayload {
                            query_id,
                            items: vec![],
                            found: 0,
                            next_cursor: None,
                            took_ms: 0,
                        },
                        deadline_at,
                    })
                    .map_err(|_| TunnelError::Capacity)?;
                return Ok(IncomingAction::Continue);
            }
            let cancellation = CancellationToken::default();
            {
                let mut active = cancellations.lock().map_err(|_| TunnelError::Internal)?;
                if active.len() >= MAX_CONCURRENT_SEARCHES || active.contains_key(&query_id) {
                    return Err(TunnelError::Capacity);
                }
                active.insert(query_id.clone(), cancellation.clone());
            }
            let index_root = config.index_root.clone();
            tokio::spawn(async move {
                let permit = permits.acquire_owned().await;
                let result = if permit.is_err() {
                    SearchOutcome::Failed
                } else {
                    let duration =
                        Duration::from_millis((deadline_wall - now_millis()).max(1) as u64);
                    let local_deadline = Instant::now() + duration;
                    let query_for_search = query.clone();
                    match tokio::task::spawn_blocking(move || {
                        let store = DeviceStore::open_readonly(index_root)?;
                        LocalSearchService::new(&store)
                            .search(&query_for_search, local_deadline, cancellation)
                            .map_err(SearchTaskError::from)
                    })
                    .await
                    {
                        Ok(Ok(local)) => SearchOutcome::Complete {
                            payload: SearchResponsePayload {
                                query_id: query_id.clone(),
                                items: local.items,
                                found: local.found,
                                next_cursor: local.next_cursor,
                                took_ms: local.took_ms,
                            },
                            deadline_at,
                        },
                        Ok(Err(SearchTaskError::Search(
                            LocalSearchError::Cancelled | LocalSearchError::DeadlineExceeded,
                        ))) => SearchOutcome::Cancelled,
                        _ => SearchOutcome::Failed,
                    }
                };
                if let Ok(mut active) = cancellations.lock() {
                    active.remove(&query_id);
                }
                let _ = responses.send(result).await;
            });
            Ok(IncomingAction::Continue)
        }
        DeviceMessage::SearchCancel(payload) => {
            if let Ok(active) = cancellations.lock() {
                if let Some(token) = active.get(&payload.query_id) {
                    token.cancel();
                }
            }
            Ok(IncomingAction::Continue)
        }
        DeviceMessage::Revoke(_) => Ok(IncomingAction::Revoked),
        _ => Err(TunnelError::Protocol),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IncomingAction {
    Continue,
    Revoked,
}

fn enabled_query_connectors(
    requested: Option<Vec<SourceId>>,
    enabled: &[SourceId],
) -> Option<Vec<SourceId>> {
    let selected = requested.unwrap_or_else(|| enabled.to_vec());
    Some(
        selected
            .into_iter()
            .filter(|source| enabled.contains(source))
            .collect(),
    )
}

async fn send_status<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    config: &TunnelConfig,
) -> Result<(), TunnelError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let sources = source_statuses(config)?;
    send(
        socket,
        frame(
            DeviceMessage::SourceStatus(SourceStatusPayload { sources }),
            Duration::from_secs(15),
        )?,
    )
    .await
}

fn source_statuses(config: &TunnelConfig) -> Result<Vec<DeviceSourceStatus>, TunnelError> {
    let store = DeviceStore::open_readonly(&config.index_root)?;
    let mut sources = Vec::with_capacity(config.connectors.len());
    for source in &config.connectors {
        let status = store.status(*source)?;
        let probe_at = if status.searchable() {
            let probe = DeviceSearchQuery {
                query: "botmemprobe".to_owned(),
                connectors: Some(vec![*source]),
                kinds: None,
                from: None,
                to: None,
                participant_id: None,
                authored_by_me: None,
                limit: 1,
                cursor: None,
            };
            LocalSearchService::new(&store)
                .explain_query_plan(&probe)
                .ok()
                .map(|_| now_timestamp())
        } else {
            None
        };
        let checkpoint_at = status
            .checkpoint
            .as_ref()
            .and_then(|checkpoint| timestamp_from_millis(checkpoint.completed_at_ms));
        let indexed_count = status
            .checkpoint
            .as_ref()
            .map(|checkpoint| checkpoint.items_indexed);
        let searchable = status.searchable() && checkpoint_at.is_some() && probe_at.is_some();
        let readiness = public_readiness(status.readiness, searchable);
        let reason_code = if searchable {
            None
        } else {
            status
                .last_error
                .or_else(|| Some(status.readiness.as_str().to_owned()))
        };
        sources.push(DeviceSourceStatus {
            connector: *source,
            readiness,
            detail: Some(status.readiness),
            searchable,
            indexed_count,
            checkpoint_at,
            last_probe_at: probe_at,
            reason_code,
        });
    }
    Ok(sources)
}

fn public_readiness(readiness: SourceReadiness, searchable: bool) -> PublicReadiness {
    match readiness {
        SourceReadiness::Ready if searchable => PublicReadiness::Ready,
        SourceReadiness::Ready => PublicReadiness::Degraded,
        SourceReadiness::Indexing => PublicReadiness::Indexing,
        SourceReadiness::PermissionRequired => PublicReadiness::Locked,
        SourceReadiness::Error => PublicReadiness::Error,
        SourceReadiness::Disabled | SourceReadiness::NotInstalled => PublicReadiness::Disconnected,
        SourceReadiness::SchemaUnsupported => PublicReadiness::Degraded,
    }
}

async fn receive_challenge<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    client_nonce: &str,
) -> Result<ChallengePayload, TunnelError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let frame = receive_handshake(socket).await?;
    let DeviceMessage::Challenge(challenge) = frame.message else {
        return Err(TunnelError::Protocol);
    };
    if challenge.nonce != client_nonce {
        return Err(TunnelError::Protocol);
    }
    Ok(challenge)
}

async fn receive_authenticated<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
) -> Result<AuthenticatedPayload, TunnelError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let frame = receive_handshake(socket).await?;
    let DeviceMessage::Authenticated(authenticated) = frame.message else {
        return Err(TunnelError::AuthenticationFailed);
    };
    Ok(authenticated)
}

async fn receive_handshake<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
) -> Result<DeviceFrame, TunnelError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let message = tokio::time::timeout(HANDSHAKE_TIMEOUT, socket.next())
        .await
        .map_err(|_| TunnelError::AuthenticationFailed)?
        .ok_or(TunnelError::Disconnected)?
        .map_err(|_| TunnelError::Disconnected)?;
    match message {
        Message::Binary(bytes) => parse_runtime_frame(&bytes),
        Message::Text(text) => parse_runtime_frame(text.as_bytes()),
        _ => Err(TunnelError::Protocol),
    }
}

fn parse_runtime_frame(bytes: &[u8]) -> Result<DeviceFrame, TunnelError> {
    if bytes.len() > MAX_DEVICE_FRAME_BYTES {
        return Err(TunnelError::FrameTooLarge);
    }
    let frame = parse_device_frame(bytes)?;
    if DateTime::parse_from_rfc3339(&frame.deadline_at)
        .map_err(|_| TunnelError::Protocol)?
        .timestamp_millis()
        <= now_millis()
    {
        return Err(TunnelError::Protocol);
    }
    Ok(frame)
}

async fn send<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    frame: DeviceFrame,
) -> Result<(), TunnelError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let bytes = encode_device_frame(&frame)?;
    socket
        .send(Message::Binary(bytes.into()))
        .await
        .map_err(|_| TunnelError::Disconnected)
}

fn frame(message: DeviceMessage, lifetime: Duration) -> Result<DeviceFrame, TunnelError> {
    let sent_at = now_timestamp();
    let deadline_at = timestamp_from_system_time(SystemTime::now() + lifetime);
    frame_until(message, deadline_at).map(|mut frame| {
        frame.sent_at = sent_at;
        frame
    })
}

fn frame_until(message: DeviceMessage, deadline_at: String) -> Result<DeviceFrame, TunnelError> {
    let frame = DeviceFrame {
        protocol: DEVICE_PROTOCOL.to_owned(),
        request_id: Uuid::new_v4().to_string(),
        sent_at: now_timestamp(),
        deadline_at,
        message,
    };
    frame.validate()?;
    Ok(frame)
}

fn tls_connector(extra_anchor: Option<&str>) -> Result<Connector, TunnelError> {
    let mut roots = RootCertStore::empty();
    let native = rustls_native_certs::load_native_certs();
    for certificate in native.certs {
        roots.add(certificate).map_err(|_| TunnelError::Tls)?;
    }
    if let Some(pem) = extra_anchor {
        let mut reader = BufReader::new(pem.as_bytes());
        let certificates = rustls_pemfile::certs(&mut reader)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| TunnelError::Tls)?;
        if certificates.is_empty() {
            return Err(TunnelError::Tls);
        }
        for certificate in certificates {
            roots.add(certificate).map_err(|_| TunnelError::Tls)?;
        }
    }
    let tls = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(Connector::Rustls(Arc::new(tls)))
}

fn cancel_all(cancellations: &Mutex<HashMap<String, CancellationToken>>) {
    if let Ok(active) = cancellations.lock() {
        for token in active.values() {
            token.cancel();
        }
    }
}

fn termination_signal() -> Result<tokio::signal::unix::Signal, TunnelError> {
    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(TunnelError::Io)
}

fn now_timestamp() -> String {
    timestamp_from_system_time(SystemTime::now())
}

fn timestamp_from_system_time(value: SystemTime) -> String {
    DateTime::<Utc>::from(value).to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn timestamp_from_millis(value: i64) -> Option<String> {
    DateTime::<Utc>::from_timestamp_millis(value)
        .map(|timestamp| timestamp.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |duration| {
            duration.as_millis().min(i64::MAX as u128) as i64
        })
}

enum SearchOutcome {
    Complete {
        payload: SearchResponsePayload,
        deadline_at: String,
    },
    Cancelled,
    Failed,
}

#[derive(Debug, Error)]
enum SearchTaskError {
    #[error(transparent)]
    Store(#[from] botmem_device_core::storage::StoreError),
    #[error(transparent)]
    Search(#[from] LocalSearchError),
}

#[derive(Debug, Error)]
pub enum TunnelError {
    #[error("relay connection failed")]
    ConnectionFailed,
    #[error("relay disconnected")]
    Disconnected,
    #[error("device authentication failed")]
    AuthenticationFailed,
    #[error("device session permanently revoked")]
    Revoked,
    #[error("device protocol violation")]
    Protocol,
    #[error("device frame exceeds one MiB")]
    FrameTooLarge,
    #[error("local search capacity exhausted")]
    Capacity,
    #[error("local search failed")]
    LocalSearchFailed,
    #[error("TLS configuration failed")]
    Tls,
    #[error("internal tunnel state failed")]
    Internal,
    #[error(transparent)]
    Config(#[from] config::ConfigError),
    #[error(transparent)]
    Signing(#[from] signer::SigningError),
    #[error(transparent)]
    ProtocolDetail(#[from] botmem_device_core::protocol::ProtocolError),
    #[error(transparent)]
    Store(#[from] botmem_device_core::storage::StoreError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl TunnelError {
    /// Stable reason code only. Error objects are deliberately not logged
    /// because transport and database errors may echo local message content.
    pub const fn reason_code(&self) -> &'static str {
        match self {
            Self::ConnectionFailed => "connection_failed",
            Self::Disconnected => "disconnected",
            Self::AuthenticationFailed => "authentication_failed",
            Self::Revoked => "session_revoked",
            Self::Protocol => "protocol_error",
            Self::FrameTooLarge => "frame_too_large",
            Self::Capacity => "search_capacity_exhausted",
            Self::LocalSearchFailed => "local_search_failed",
            Self::Tls => "tls_configuration_failed",
            Self::Internal => "internal_state_failed",
            Self::Config(_) => "configuration_invalid",
            Self::Signing(_) => "signing_failed",
            Self::ProtocolDetail(_) => "protocol_error",
            Self::Store(_) => "local_store_failed",
            Self::Io(_) => "io_failed",
        }
    }

    /// A dedicated permanent exit lets the macOS supervisor distinguish a
    /// server revoke from a transient transport failure and avoid reconnecting.
    pub const fn process_exit_code(&self) -> i32 {
        match self {
            Self::Revoked => 20,
            _ => 1,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_every_search_to_enabled_connectors() {
        assert_eq!(
            enabled_query_connectors(None, &[SourceId::IMessage]),
            Some(vec![SourceId::IMessage])
        );
        assert_eq!(
            enabled_query_connectors(
                Some(vec![SourceId::IMessage, SourceId::Whatsapp]),
                &[SourceId::Whatsapp],
            ),
            Some(vec![SourceId::Whatsapp])
        );
    }

    #[test]
    fn production_tls_roots_build_without_disabling_verification() {
        assert!(matches!(tls_connector(None), Ok(Connector::Rustls(_))));
    }

    #[test]
    fn revoke_uses_permanent_process_exit_code() {
        assert_eq!(TunnelError::Revoked.reason_code(), "session_revoked");
        assert_eq!(TunnelError::Revoked.process_exit_code(), 20);
        assert_eq!(TunnelError::Disconnected.process_exit_code(), 1);
    }
}
