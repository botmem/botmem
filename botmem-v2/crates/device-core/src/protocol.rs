use crate::state::{SourceId, SourceReadiness};
use chrono::DateTime;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

pub const DEVICE_PROTOCOL: &str = "botmem.device.v2";
pub const MAX_DEVICE_FRAME_BYTES: usize = 1_048_576;
pub const MAXIMUM_RESULT_COUNT: usize = 100;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceFrame {
    pub protocol: String,
    pub request_id: String,
    pub sent_at: String,
    pub deadline_at: String,
    #[serde(flatten)]
    pub message: DeviceMessage,
}

impl DeviceFrame {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.protocol != DEVICE_PROTOCOL {
            return Err(ProtocolError::UnsupportedProtocol(self.protocol.clone()));
        }
        validate_uuid("requestId", &self.request_id)?;
        let sent_at = parse_timestamp("sentAt", &self.sent_at)?;
        let deadline_at = parse_timestamp("deadlineAt", &self.deadline_at)?;
        if deadline_at <= sent_at {
            return Err(ProtocolError::InvalidField(
                "deadlineAt must be later than sentAt".to_owned(),
            ));
        }
        self.message.validate()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum DeviceMessage {
    #[serde(rename = "hello")]
    Hello(HelloPayload),
    #[serde(rename = "challenge")]
    Challenge(ChallengePayload),
    #[serde(rename = "authenticate")]
    Authenticate(AuthenticatePayload),
    #[serde(rename = "authenticated")]
    Authenticated(AuthenticatedPayload),
    #[serde(rename = "capabilities")]
    Capabilities(CapabilitiesPayload),
    #[serde(rename = "source.status")]
    SourceStatus(SourceStatusPayload),
    #[serde(rename = "heartbeat")]
    Heartbeat(HeartbeatPayload),
    #[serde(rename = "search.request")]
    SearchRequest(SearchRequestPayload),
    #[serde(rename = "search.response")]
    SearchResponse(SearchResponsePayload),
    #[serde(rename = "search.cancel")]
    SearchCancel(SearchCancelPayload),
    #[serde(rename = "error")]
    Error(ErrorPayload),
    #[serde(rename = "revoke")]
    Revoke(RevokePayload),
}

impl DeviceMessage {
    fn validate(&self) -> Result<(), ProtocolError> {
        match self {
            Self::Hello(payload) => {
                validate_uuid("deviceId", &payload.device_id)?;
                validate_string("clientVersion", &payload.client_version, 1, 64, true)?;
                validate_string("nonce", &payload.nonce, 16, 512, false)
            }
            Self::Challenge(payload) => {
                validate_string("nonce", &payload.nonce, 16, 512, false)?;
                validate_string("serverNonce", &payload.server_nonce, 16, 512, false)
            }
            Self::Authenticate(payload) => {
                validate_uuid("deviceId", &payload.device_id)?;
                validate_string("keyId", &payload.key_id, 1, 128, true)?;
                validate_string("signature", &payload.signature, 32, 1_024, false)
            }
            Self::Authenticated(payload) => {
                validate_uuid("sessionId", &payload.session_id)?;
                if !(5_000..=120_000).contains(&payload.heartbeat_interval_ms) {
                    return Err(ProtocolError::InvalidField(
                        "heartbeatIntervalMs must be between 5000 and 120000".to_owned(),
                    ));
                }
                parse_timestamp("credentialExpiresAt", &payload.credential_expires_at).map(|_| ())
            }
            Self::Capabilities(payload) => payload.validate(),
            Self::SourceStatus(payload) => payload.validate(),
            Self::Heartbeat(payload) => validate_uuid("sessionId", &payload.session_id),
            Self::SearchRequest(payload) => payload.validate(),
            Self::SearchResponse(payload) => payload.validate(),
            Self::SearchCancel(payload) => validate_uuid("queryId", &payload.query_id),
            Self::Error(payload) => validate_string("code", &payload.code, 1, 128, true),
            Self::Revoke(_) => Ok(()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HelloPayload {
    pub device_id: String,
    pub client_version: String,
    pub nonce: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChallengePayload {
    pub nonce: String,
    pub server_nonce: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthenticatePayload {
    pub device_id: String,
    pub key_id: String,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthenticatedPayload {
    pub session_id: String,
    pub heartbeat_interval_ms: u64,
    pub credential_expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum RpcCapability {
    #[serde(rename = "source.status")]
    SourceStatus,
    #[serde(rename = "search.query")]
    SearchQuery,
    #[serde(rename = "search.cancel")]
    SearchCancel,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilitiesPayload {
    pub connectors: Vec<SourceId>,
    pub rpc: Vec<RpcCapability>,
    pub maximum_result_count: u16,
}

impl CapabilitiesPayload {
    fn validate(&self) -> Result<(), ProtocolError> {
        if self.connectors.len() > 2 {
            return Err(ProtocolError::InvalidField(
                "connectors may contain at most two items".to_owned(),
            ));
        }
        if self.rpc.is_empty() || self.rpc.len() > 3 {
            return Err(ProtocolError::InvalidField(
                "rpc must contain one to three items".to_owned(),
            ));
        }
        if !(1..=100).contains(&self.maximum_result_count) {
            return Err(ProtocolError::InvalidField(
                "maximumResultCount must be between 1 and 100".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceStatusPayload {
    pub sources: Vec<DeviceSourceStatus>,
}

impl SourceStatusPayload {
    fn validate(&self) -> Result<(), ProtocolError> {
        if self.sources.len() > 2 {
            return Err(ProtocolError::InvalidField(
                "sources may contain at most two items".to_owned(),
            ));
        }
        for source in &self.sources {
            source.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceSourceStatus {
    pub connector: SourceId,
    pub readiness: PublicReadiness,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<SourceReadiness>,
    pub searchable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indexed_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkpoint_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_probe_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
}

impl DeviceSourceStatus {
    fn validate(&self) -> Result<(), ProtocolError> {
        if self.readiness == PublicReadiness::Ready
            && (!self.searchable || self.checkpoint_at.is_none() || self.last_probe_at.is_none())
        {
            return Err(ProtocolError::InvalidField(
                "ready source requires searchable, checkpointAt, and lastProbeAt".to_owned(),
            ));
        }
        if let Some(value) = &self.checkpoint_at {
            parse_timestamp("checkpointAt", value)?;
        }
        if let Some(value) = &self.last_probe_at {
            parse_timestamp("lastProbeAt", value)?;
        }
        if let Some(value) = &self.reason_code {
            validate_string("reasonCode", value, 1, 128, true)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PublicReadiness {
    Disconnected,
    Authorizing,
    Enrolling,
    Connected,
    Indexing,
    Ready,
    Locked,
    Degraded,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HeartbeatPayload {
    pub session_id: String,
    pub sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchRequestPayload {
    pub query_id: String,
    pub query: DeviceSearchQuery,
}

impl SearchRequestPayload {
    fn validate(&self) -> Result<(), ProtocolError> {
        validate_uuid("queryId", &self.query_id)?;
        self.query.validate()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceSearchQuery {
    pub query: String,
    pub connectors: Option<Vec<SourceId>>,
    pub kinds: Option<Vec<DeviceMemoryKind>>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub participant_id: Option<String>,
    pub authored_by_me: Option<bool>,
    pub limit: u16,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub cursor: Option<String>,
}

impl DeviceSearchQuery {
    pub(crate) fn validate(&self) -> Result<(), ProtocolError> {
        validate_string("query", &self.query, 1, 512, true)?;
        if self
            .connectors
            .as_ref()
            .is_some_and(|value| value.is_empty() || value.len() > 2)
        {
            return Err(ProtocolError::InvalidField(
                "connectors must contain one or two items".to_owned(),
            ));
        }
        if self.kinds.as_ref().is_some_and(|value| value.len() != 1) {
            return Err(ProtocolError::InvalidField(
                "kinds must contain exactly one message item".to_owned(),
            ));
        }
        if !(1..=100).contains(&self.limit) {
            return Err(ProtocolError::InvalidField(
                "limit must be between 1 and 100".to_owned(),
            ));
        }
        if let Some(value) = &self.participant_id {
            validate_string("participantId", value, 1, 512, true)?;
        }
        if let Some(value) = &self.cursor {
            validate_string("cursor", value, 1, 4_096, false)?;
        }
        let from = self
            .from
            .as_ref()
            .map(|value| parse_timestamp("from", value))
            .transpose()?;
        let to = self
            .to
            .as_ref()
            .map(|value| parse_timestamp("to", value))
            .transpose()?;
        if matches!((from, to), (Some(from), Some(to)) if from > to) {
            return Err(ProtocolError::InvalidField(
                "from must be earlier than or equal to to".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceMemoryKind {
    Message,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchResponsePayload {
    pub query_id: String,
    pub items: Vec<DeviceSearchItem>,
    pub found: u64,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub next_cursor: Option<String>,
    pub took_ms: u64,
}

impl SearchResponsePayload {
    fn validate(&self) -> Result<(), ProtocolError> {
        validate_uuid("queryId", &self.query_id)?;
        if self.items.len() > MAXIMUM_RESULT_COUNT {
            return Err(ProtocolError::InvalidField(
                "items exceeds maximum result count".to_owned(),
            ));
        }
        if let Some(value) = &self.next_cursor {
            validate_string("nextCursor", value, 1, 4_096, false)?;
        }
        for item in &self.items {
            item.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceSearchItem {
    pub r#ref: String,
    pub source_id: String,
    pub revision: String,
    pub connector: SourceId,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub occurred_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread: Option<Thread>,
    pub participants: Vec<Participant>,
    pub media: Vec<MediaDescriptor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authored_by_me: Option<bool>,
}

impl DeviceSearchItem {
    fn validate(&self) -> Result<(), ProtocolError> {
        validate_string("ref", &self.r#ref, 1, 2_048, true)?;
        validate_string("sourceId", &self.source_id, 1, 2_048, true)?;
        validate_string("revision", &self.revision, 1, 512, true)?;
        if let Some(value) = &self.occurred_at {
            parse_timestamp("occurredAt", value)?;
        }
        if let Some(value) = &self.title {
            validate_string("title", value, 1, 2_048, true)?;
        }
        if self.text.len() > 20_000 || self.participants.len() > 256 || self.media.len() > 128 {
            return Err(ProtocolError::InvalidField(
                "search item exceeds a collection or text bound".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Thread {
    pub durable_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Participant {
    pub durable_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default)]
    pub identifiers: Vec<DurableIdentifier>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DurableIdentifier {
    pub kind: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaDescriptor {
    pub durable_id: String,
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    pub availability: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchCancelPayload {
    pub query_id: String,
    pub reason_code: SearchCancelReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchCancelReason {
    CallerCancelled,
    DeadlineExceeded,
    SessionClosing,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ErrorPayload {
    pub code: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevokePayload {
    pub reason_code: RevokeReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RevokeReason {
    UserRevoked,
    CredentialRotated,
    DeviceDeleted,
}

pub fn parse_device_frame(bytes: &[u8]) -> Result<DeviceFrame, ProtocolError> {
    if bytes.len() > MAX_DEVICE_FRAME_BYTES {
        return Err(ProtocolError::FrameTooLarge {
            actual: bytes.len(),
            maximum: MAX_DEVICE_FRAME_BYTES,
        });
    }
    let frame: DeviceFrame = serde_json::from_slice(bytes)?;
    frame.validate()?;
    Ok(frame)
}

pub fn encode_device_frame(frame: &DeviceFrame) -> Result<Vec<u8>, ProtocolError> {
    frame.validate()?;
    let bytes = serde_json::to_vec(frame)?;
    if bytes.len() > MAX_DEVICE_FRAME_BYTES {
        return Err(ProtocolError::FrameTooLarge {
            actual: bytes.len(),
            maximum: MAX_DEVICE_FRAME_BYTES,
        });
    }
    Ok(bytes)
}

fn deserialize_required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

fn validate_uuid(field: &str, value: &str) -> Result<(), ProtocolError> {
    Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| ProtocolError::InvalidField(format!("{field} must be a UUID")))
}

fn parse_timestamp(
    field: &str,
    value: &str,
) -> Result<DateTime<chrono::FixedOffset>, ProtocolError> {
    DateTime::parse_from_rfc3339(value)
        .map_err(|_| ProtocolError::InvalidField(format!("{field} must be an RFC 3339 timestamp")))
}

fn validate_string(
    field: &str,
    value: &str,
    minimum: usize,
    maximum: usize,
    trimmed: bool,
) -> Result<(), ProtocolError> {
    let length = value.chars().count();
    if length < minimum || length > maximum || (trimmed && value.trim() != value) {
        return Err(ProtocolError::InvalidField(format!(
            "{field} must contain {minimum}..={maximum} characters"
        )));
    }
    Ok(())
}

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("device frame is {actual} bytes; maximum is {maximum}")]
    FrameTooLarge { actual: usize, maximum: usize },
    #[error("unsupported device protocol: {0}")]
    UnsupportedProtocol(String),
    #[error("invalid device frame field: {0}")]
    InvalidField(String),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_frame() -> DeviceFrame {
        DeviceFrame {
            protocol: DEVICE_PROTOCOL.to_owned(),
            request_id: "00000000-0000-4000-8000-000000000001".to_owned(),
            sent_at: "2026-07-13T10:00:00+00:00".to_owned(),
            deadline_at: "2026-07-13T10:00:05+00:00".to_owned(),
            message: DeviceMessage::SearchRequest(SearchRequestPayload {
                query_id: "00000000-0000-4000-8000-000000000002".to_owned(),
                query: DeviceSearchQuery {
                    query: "flight confirmation".to_owned(),
                    connectors: Some(vec![SourceId::IMessage]),
                    kinds: None,
                    from: None,
                    to: None,
                    participant_id: None,
                    authored_by_me: None,
                    limit: 20,
                    cursor: None,
                },
            }),
        }
    }

    #[test]
    fn valid_search_frame_round_trips() {
        let encoded = encode_device_frame(&valid_frame()).expect("encode frame");
        let decoded = parse_device_frame(&encoded).expect("parse frame");
        assert_eq!(decoded, valid_frame());
    }

    #[test]
    fn parses_the_cross_language_search_request_fixture() {
        let fixture =
            include_bytes!("../../../packages/contracts/fixtures/device-search-request.v2.json");
        let frame = parse_device_frame(fixture).expect("parse canonical TypeScript fixture");
        let DeviceMessage::SearchRequest(payload) = frame.message else {
            panic!("fixture must contain a search.request frame");
        };
        assert_eq!(payload.query.query, "launch");
        assert_eq!(
            payload.query.connectors,
            Some(vec![SourceId::IMessage, SourceId::Whatsapp])
        );
    }

    #[test]
    fn parses_search_request_with_message_kind_filter() {
        let fixture = include_bytes!("../tests/fixtures/device-search-with-kinds.v2.json");
        let frame = parse_device_frame(fixture).expect("parse kind-filter fixture");
        let DeviceMessage::SearchRequest(payload) = frame.message else {
            panic!("fixture must contain a search.request frame");
        };
        assert_eq!(payload.query.kinds, Some(vec![DeviceMemoryKind::Message]));
    }

    #[test]
    fn rejects_unsupported_protocol() {
        let mut frame = valid_frame();
        frame.protocol = "botmem.device.v1".to_owned();
        assert!(matches!(
            frame.validate(),
            Err(ProtocolError::UnsupportedProtocol(_))
        ));
    }

    #[test]
    fn rejects_invalid_deadline_and_query_bounds() {
        let mut frame = valid_frame();
        frame.deadline_at = frame.sent_at.clone();
        assert!(matches!(
            frame.validate(),
            Err(ProtocolError::InvalidField(_))
        ));

        let mut frame = valid_frame();
        if let DeviceMessage::SearchRequest(payload) = &mut frame.message {
            payload.query.query = "x".repeat(513);
        }
        assert!(matches!(
            frame.validate(),
            Err(ProtocolError::InvalidField(_))
        ));
    }

    #[test]
    fn rejects_oversized_frame_before_json_parsing() {
        let bytes = vec![b' '; MAX_DEVICE_FRAME_BYTES + 1];
        assert!(matches!(
            parse_device_frame(&bytes),
            Err(ProtocolError::FrameTooLarge { .. })
        ));
    }

    #[test]
    fn rejects_omitted_required_nullable_search_cursor() {
        let mut value = serde_json::to_value(valid_frame()).expect("serialize frame");
        value["payload"]["query"]
            .as_object_mut()
            .expect("query object")
            .remove("cursor");
        let error = parse_device_frame(&serde_json::to_vec(&value).expect("encode JSON"));
        assert!(matches!(error, Err(ProtocolError::Json(_))));
    }

    #[test]
    fn rejects_omitted_required_nullable_response_fields() {
        let response = DeviceFrame {
            protocol: DEVICE_PROTOCOL.to_owned(),
            request_id: "00000000-0000-4000-8000-000000000001".to_owned(),
            sent_at: "2026-07-13T10:00:00+00:00".to_owned(),
            deadline_at: "2026-07-13T10:00:05+00:00".to_owned(),
            message: DeviceMessage::SearchResponse(SearchResponsePayload {
                query_id: "00000000-0000-4000-8000-000000000002".to_owned(),
                items: vec![DeviceSearchItem {
                    r#ref: "imessage:fixture".to_owned(),
                    source_id: "fixture".to_owned(),
                    revision: "1".to_owned(),
                    connector: SourceId::IMessage,
                    occurred_at: None,
                    title: None,
                    text: "fixture".to_owned(),
                    thread: None,
                    participants: vec![],
                    media: vec![],
                    authored_by_me: None,
                }],
                found: 1,
                next_cursor: None,
                took_ms: 1,
            }),
        };

        for path in ["nextCursor", "occurredAt"] {
            let mut value = serde_json::to_value(&response).expect("serialize response");
            if path == "nextCursor" {
                value["payload"]
                    .as_object_mut()
                    .expect("payload object")
                    .remove(path);
            } else {
                value["payload"]["items"][0]
                    .as_object_mut()
                    .expect("item object")
                    .remove(path);
            }
            let error = parse_device_frame(&serde_json::to_vec(&value).expect("encode JSON"));
            assert!(matches!(error, Err(ProtocolError::Json(_))), "{path}");
        }
    }

    #[test]
    fn encoding_omits_optional_fields_but_preserves_required_nulls() {
        let response = DeviceFrame {
            protocol: DEVICE_PROTOCOL.to_owned(),
            request_id: "00000000-0000-4000-8000-000000000001".to_owned(),
            sent_at: "2026-07-13T10:00:00+00:00".to_owned(),
            deadline_at: "2026-07-13T10:00:05+00:00".to_owned(),
            message: DeviceMessage::SearchResponse(SearchResponsePayload {
                query_id: "00000000-0000-4000-8000-000000000002".to_owned(),
                items: vec![DeviceSearchItem {
                    r#ref: "imessage:fixture".to_owned(),
                    source_id: "fixture".to_owned(),
                    revision: "1".to_owned(),
                    connector: SourceId::IMessage,
                    occurred_at: None,
                    title: None,
                    text: "fixture".to_owned(),
                    thread: None,
                    participants: vec![],
                    media: vec![],
                    authored_by_me: None,
                }],
                found: 1,
                next_cursor: None,
                took_ms: 1,
            }),
        };
        let value = serde_json::to_value(response).expect("serialize response");
        let item = value["payload"]["items"][0]
            .as_object()
            .expect("item object");
        assert_eq!(item.get("occurredAt"), Some(&serde_json::Value::Null));
        assert!(!item.contains_key("title"));
        assert!(!item.contains_key("thread"));
        assert!(!item.contains_key("authoredByMe"));
        assert_eq!(value["payload"]["nextCursor"], serde_json::Value::Null);

        let status = DeviceSourceStatus {
            connector: SourceId::IMessage,
            readiness: PublicReadiness::Disconnected,
            detail: None,
            searchable: false,
            indexed_count: None,
            checkpoint_at: None,
            last_probe_at: None,
            reason_code: None,
        };
        let status = serde_json::to_value(status).expect("serialize status");
        let object = status.as_object().expect("status object");
        assert_eq!(object.len(), 3);
        assert!(!object.values().any(serde_json::Value::is_null));
    }
}
