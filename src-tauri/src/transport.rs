use std::time::Duration;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::cave::{
    parse_discovery_document, DiscoveryDocument, NativeDiagnostic, NativeResult,
    ValidatedCaveAuthority,
};

const MAX_JSON_BODY_BYTES: usize = 4 * 1024 * 1024;
#[allow(dead_code)]
pub const MAX_SSE_FRAME_BYTES: usize = 1024 * 1024;
const PAIRING_SCOPES: [&str; 6] = [
    "chat:read",
    "chat:write",
    "conversations:write",
    "attachments:write",
    "tasks:write",
    "github:write",
];

#[derive(Clone)]
pub(crate) struct ConstrainedTransport {
    client: reqwest::Client,
    authority: ValidatedCaveAuthority,
}

#[derive(Clone)]
pub(crate) struct PairingIssued {
    pub request_id: String,
    pub secret: String,
    pub expires_at: u64,
}

pub(crate) struct PairingGrant {
    pub bearer: String,
    pub metadata: crate::keyring::CredentialMetadata,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PairingStatus {
    Pending,
    Approved,
    Denied,
    Expired,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartConversationInput {
    pub familiar_id: String,
    pub project_root: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationStartDto {
    pub conversation_id: String,
}

struct ConversationStartRequest {
    body: serde_json::Value,
    idempotency_header: &'static str,
    idempotency_key: String,
}

#[derive(Clone)]
pub(crate) struct HealthMetadata {
    api_version: String,
    minimum_client_version: String,
    capabilities: Vec<String>,
}

impl HealthMetadata {
    pub(crate) fn supports_pairing(&self) -> bool {
        self.api_version == "1.0"
            && client_version_is_compatible(&self.minimum_client_version)
            && self
                .capabilities
                .iter()
                .any(|capability| capability == "pairing")
            && self
                .capabilities
                .iter()
                .any(|capability| capability == "credentials")
    }
}

#[cfg(test)]
pub(crate) fn test_health_metadata() -> HealthMetadata {
    HealthMetadata {
        api_version: "1.0".to_owned(),
        minimum_client_version: "0.1.0".to_owned(),
        capabilities: vec!["pairing".to_owned(), "credentials".to_owned()],
    }
}

#[derive(Clone, Copy)]
pub(crate) enum ClientV1Operation {
    Health,
    Pairing,
    Conversation,
}

impl ConstrainedTransport {
    pub(crate) fn new(authority: ValidatedCaveAuthority) -> NativeResult<Self> {
        Ok(Self {
            client: client()?,
            authority,
        })
    }

    pub(crate) async fn discover(discovery_url: url::Url) -> NativeResult<ValidatedCaveAuthority> {
        let response = client()?
            .get(discovery_url.clone())
            .send()
            .await
            .map_err(|_| NativeDiagnostic::new("discovery_unavailable", true))?;
        let document: DiscoveryDocument = serde_json::from_value(read_json_value(response).await?)
            .map_err(|_| NativeDiagnostic::new("invalid_discovery_response", false))?;
        parse_discovery_document(discovery_url, document)
    }

    pub(crate) async fn health(&self, bearer: Option<&str>) -> NativeResult<HealthMetadata> {
        let request = self.client.get(self.endpoint("api/client/v1/health")?);
        let request = match bearer {
            Some(value) => {
                request.header(reqwest::header::AUTHORIZATION, format!("Bearer {value}"))
            }
            None => request,
        };
        let response = request
            .send()
            .await
            .map_err(|_| NativeDiagnostic::new("transport_unavailable", true))?;
        let (data, metadata) = read_client_data(response, ClientV1Operation::Health).await?;
        validate_health_data(&data)?;
        Ok(metadata)
    }

    pub(crate) async fn create_pairing(
        &self,
        installation_id: &str,
    ) -> NativeResult<PairingIssued> {
        let response = self
            .client
            .post(self.endpoint("api/client/v1/pairing/requests")?)
            .json(&pairing_request(installation_id))
            .send()
            .await
            .map_err(|_| NativeDiagnostic::new("transport_unavailable", true))?;
        let (data, _) = read_client_data(response, ClientV1Operation::Pairing).await?;
        let response: PairingIssuedResponse = serde_json::from_value(data)
            .map_err(|_| NativeDiagnostic::new("invalid_pairing_response", false))?;

        if response.request_id.is_empty() || response.secret.is_empty() {
            return Err(NativeDiagnostic::new("invalid_pairing_response", false));
        }

        Ok(PairingIssued {
            request_id: response.request_id,
            secret: response.secret,
            expires_at: response.expires_at,
        })
    }

    pub(crate) async fn poll_pairing(
        &self,
        request_id: &str,
        secret: &str,
    ) -> NativeResult<PairingStatus> {
        let response = self
            .client
            .get(self.pairing_endpoint(request_id)?)
            .header("X-Coven-Pairing-Secret", secret)
            .send()
            .await
            .map_err(|_| NativeDiagnostic::new("transport_unavailable", true))?;
        let (data, _) = read_client_data(response, ClientV1Operation::Pairing).await?;
        let response: PairingStatusResponse = serde_json::from_value(data)
            .map_err(|_| NativeDiagnostic::new("invalid_pairing_response", false))?;

        match response.status.as_str() {
            "pending" => Ok(PairingStatus::Pending),
            "approved" => Ok(PairingStatus::Approved),
            "denied" => Ok(PairingStatus::Denied),
            "expired" => Ok(PairingStatus::Expired),
            _ => Err(NativeDiagnostic::new("invalid_pairing_response", false)),
        }
    }

    pub(crate) async fn exchange_pairing(
        &self,
        request_id: &str,
        secret: &str,
    ) -> NativeResult<PairingGrant> {
        Self::validate_pairing_request_id(request_id)?;
        let endpoint = self
            .endpoint("api/client/v1/pairing/requests/")?
            .join(&format!("{request_id}/exchange"))
            .map_err(|_| NativeDiagnostic::new("invalid_cave_destination", false))?;
        let response = self
            .client
            .post(endpoint)
            .header("X-Coven-Pairing-Secret", secret)
            .send()
            .await
            .map_err(|_| NativeDiagnostic::new("transport_unavailable", true))?;
        let (data, _) = read_client_data(response, ClientV1Operation::Pairing).await?;
        parse_pairing_exchange_response(data)
    }

    pub(crate) async fn start_conversation(
        &self,
        bearer: &str,
        input: StartConversationInput,
    ) -> NativeResult<ConversationStartDto> {
        let request = conversation_start_request(&input);
        let response = self
            .client
            .post(self.endpoint("api/client/v1/conversations")?)
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {bearer}"))
            .header(request.idempotency_header, request.idempotency_key)
            .json(&request.body)
            .send()
            .await
            .map_err(|_| NativeDiagnostic::new("transport_unavailable", true))?;
        let (data, _) = read_client_data(response, ClientV1Operation::Conversation).await?;
        let response: ConversationStartDto = serde_json::from_value(data)
            .map_err(|_| NativeDiagnostic::new("invalid_conversation_response", false))?;

        if response.conversation_id.is_empty() {
            return Err(NativeDiagnostic::new(
                "invalid_conversation_response",
                false,
            ));
        }
        Ok(response)
    }

    fn endpoint(&self, path: &'static str) -> NativeResult<url::Url> {
        self.authority.client_url(path)
    }

    fn pairing_endpoint(&self, request_id: &str) -> NativeResult<url::Url> {
        Self::validate_pairing_request_id(request_id)?;

        self.endpoint("api/client/v1/pairing/requests/")?
            .join(request_id)
            .map_err(|_| NativeDiagnostic::new("invalid_cave_destination", false))
    }

    fn validate_pairing_request_id(request_id: &str) -> NativeResult<()> {
        if request_id.is_empty()
            || request_id.len() > 128
            || !request_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            Err(NativeDiagnostic::new("invalid_pairing_request", false))
        } else {
            Ok(())
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingIssuedResponse {
    request_id: String,
    secret: String,
    expires_at: u64,
}

#[derive(Deserialize)]
struct PairingStatusResponse {
    status: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingExchangeResponse {
    bearer: String,
    credential: PairingCredentialResponse,
}

#[derive(Deserialize)]
struct PairingCredentialResponse {
    id: String,
}

fn client() -> NativeResult<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| NativeDiagnostic::new("transport_unavailable", true))
}

async fn read_json_value(mut response: reqwest::Response) -> NativeResult<serde_json::Value> {
    if response.status().is_redirection() {
        return Err(NativeDiagnostic::new("redirect_rejected", false));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_JSON_BODY_BYTES as u64)
    {
        return Err(NativeDiagnostic::new("body_limit_exceeded", false));
    }

    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| NativeDiagnostic::new("transport_unavailable", true))?
    {
        if body.len().saturating_add(chunk.len()) > MAX_JSON_BODY_BYTES {
            return Err(NativeDiagnostic::new("body_limit_exceeded", false));
        }
        body.extend_from_slice(&chunk);
    }

    serde_json::from_slice(&body).map_err(|_| NativeDiagnostic::new("invalid_cave_response", false))
}

async fn read_client_data(
    response: reqwest::Response,
    operation: ClientV1Operation,
) -> NativeResult<(serde_json::Value, HealthMetadata)> {
    let status = response.status().as_u16();
    let value = read_json_value(response).await?;

    if (200..300).contains(&status) {
        parse_client_success_with_metadata(value, operation)
    } else {
        let diagnostic = parse_client_error_envelope(status, value, operation)?;
        Err(diagnostic)
    }
}

fn pairing_request(installation_id: &str) -> serde_json::Value {
    serde_json::json!({
        "appName": crate::APP_NAME,
        "installationId": installation_id,
        "scopes": PAIRING_SCOPES,
    })
}

#[cfg(test)]
fn bearer_header(bearer: &str) -> String {
    let mut header = String::from("Bearer");
    header.push(' ');
    header.push_str(bearer);
    header
}

fn parse_pairing_exchange_response(value: serde_json::Value) -> NativeResult<PairingGrant> {
    let response = serde_json::from_value::<PairingExchangeResponse>(value)
        .map_err(|_| NativeDiagnostic::new("invalid_pairing_response", false))?;

    if response.bearer.is_empty() || response.credential.id.is_empty() {
        return Err(NativeDiagnostic::new("invalid_pairing_response", false));
    }

    Ok(PairingGrant {
        bearer: response.bearer,
        metadata: crate::keyring::CredentialMetadata {
            credential_id: response.credential.id,
        },
    })
}

fn conversation_start_request(input: &StartConversationInput) -> ConversationStartRequest {
    let body = serde_json::json!({
        "familiarId": input.familiar_id,
        "projectRoot": input.project_root,
    });

    ConversationStartRequest {
        body,
        idempotency_header: "Idempotency-Key",
        idempotency_key: Uuid::new_v4().to_string(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClientV1SuccessEnvelope {
    api_version: String,
    minimum_client_version: String,
    capabilities: Vec<String>,
    data: serde_json::Value,
    request_id: Option<String>,
    identity: Option<serde_json::Value>,
    revision: Option<serde_json::Value>,
    cursor: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClientV1ErrorEnvelope {
    api_version: String,
    minimum_client_version: String,
    capabilities: Vec<String>,
    error: ClientV1Error,
    request_id: Option<String>,
    identity: Option<serde_json::Value>,
    revision: Option<serde_json::Value>,
    cursor: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ClientV1Error {
    code: String,
    message: String,
    details: Option<serde_json::Value>,
    retryable: bool,
}

#[cfg(test)]
fn parse_client_success_envelope(
    value: serde_json::Value,
    operation: ClientV1Operation,
) -> NativeResult<serde_json::Value> {
    Ok(parse_client_success_with_metadata(value, operation)?.0)
}

fn parse_client_success_with_metadata(
    value: serde_json::Value,
    operation: ClientV1Operation,
) -> NativeResult<(serde_json::Value, HealthMetadata)> {
    let envelope = serde_json::from_value::<ClientV1SuccessEnvelope>(value)
        .map_err(|_| NativeDiagnostic::new("invalid_cave_response", false))?;
    let metadata = validate_client_metadata(
        &envelope.api_version,
        &envelope.minimum_client_version,
        &envelope.capabilities,
        operation,
        true,
    )?;

    if envelope
        .request_id
        .as_deref()
        .is_some_and(|request_id| request_id.is_empty() || request_id.len() > 64)
    {
        return Err(NativeDiagnostic::new("invalid_cave_response", false));
    }
    let _ = (envelope.identity, envelope.revision, envelope.cursor);

    if !envelope.data.is_object() {
        return Err(NativeDiagnostic::new("invalid_cave_response", false));
    }

    if matches!(operation, ClientV1Operation::Health) {
        validate_health_data(&envelope.data)?;
    }

    Ok((envelope.data, metadata))
}

fn parse_client_error_envelope(
    status: u16,
    value: serde_json::Value,
    operation: ClientV1Operation,
) -> NativeResult<NativeDiagnostic> {
    let envelope = serde_json::from_value::<ClientV1ErrorEnvelope>(value)
        .map_err(|_| NativeDiagnostic::new("invalid_cave_response", false))?;
    validate_client_metadata(
        &envelope.api_version,
        &envelope.minimum_client_version,
        &envelope.capabilities,
        operation,
        false,
    )?;
    let _ = (
        envelope.error.message,
        envelope.error.details,
        envelope.request_id,
        envelope.identity,
        envelope.revision,
        envelope.cursor,
    );

    let expected_status = match envelope.error.code.as_str() {
        "invalid_request" => 400,
        "unauthorized" => 401,
        "scope_denied" | "pairing_denied" => 403,
        "not_found" => 404,
        "conflict" | "pairing_pending" | "reconcile_required" => 409,
        "pairing_expired" => 410,
        "incompatible_version" => 426,
        "rate_limited" => 429,
        "internal_error" => 500,
        "service_unavailable" => 503,
        _ => return Err(NativeDiagnostic::new("invalid_cave_response", false)),
    };
    if status != expected_status {
        return Err(NativeDiagnostic::new("invalid_cave_response", false));
    }

    Ok(NativeDiagnostic::new(
        match envelope.error.code.as_str() {
            "incompatible_version" => "incompatible_version",
            "unauthorized" => "unauthorized",
            _ => "transport_rejected",
        },
        envelope.error.retryable,
    ))
}

fn validate_client_metadata(
    api_version: &str,
    minimum_client_version: &str,
    capabilities: &[String],
    operation: ClientV1Operation,
    require_compatible_minimum: bool,
) -> NativeResult<HealthMetadata> {
    if api_version != "1.0" {
        return Err(NativeDiagnostic::new("incompatible_version", false));
    }
    if !is_version(minimum_client_version) {
        return Err(NativeDiagnostic::new("invalid_cave_response", false));
    }
    if require_compatible_minimum && !client_version_is_compatible(minimum_client_version) {
        return Err(NativeDiagnostic::new("incompatible_version", false));
    }
    if capabilities.is_empty()
        || capabilities.iter().any(|capability| {
            !matches!(
                capability.as_str(),
                "pairing"
                    | "credentials"
                    | "familiars"
                    | "projects"
                    | "conversations"
                    | "conversation-messages"
                    | "streaming"
                    | "cursors"
                    | "revisions"
            )
        })
        || has_duplicates(capabilities)
    {
        return Err(NativeDiagnostic::new("invalid_cave_response", false));
    }
    let required = match operation {
        ClientV1Operation::Health | ClientV1Operation::Pairing => {
            ["pairing", "credentials"].as_slice()
        }
        ClientV1Operation::Conversation => ["conversations"].as_slice(),
    };
    if required
        .iter()
        .any(|capability| !capabilities.iter().any(|provided| provided == capability))
    {
        return Err(NativeDiagnostic::new("incompatible_version", false));
    }

    Ok(HealthMetadata {
        api_version: api_version.to_owned(),
        minimum_client_version: minimum_client_version.to_owned(),
        capabilities: capabilities.to_vec(),
    })
}

fn validate_health_data(value: &serde_json::Value) -> NativeResult<()> {
    if value
        .as_object()
        .and_then(|data| data.get("status"))
        .and_then(serde_json::Value::as_str)
        == Some("ok")
    {
        Ok(())
    } else {
        Err(NativeDiagnostic::new("invalid_health_response", false))
    }
}

fn is_version(value: &str) -> bool {
    value.split('.').count() == 3
        && value
            .split('.')
            .all(|part| !part.is_empty() && part.parse::<u32>().is_ok())
}

fn client_version_is_compatible(minimum: &str) -> bool {
    let parse = |value: &str| {
        value
            .split('.')
            .map(str::parse::<u32>)
            .collect::<Result<Vec<_>, _>>()
    };
    parse(minimum)
        .ok()
        .is_some_and(|minimum| minimum <= vec![0, 1, 0])
}

fn has_duplicates(values: &[String]) -> bool {
    values
        .iter()
        .enumerate()
        .any(|(index, value)| values[..index].contains(value))
}

#[allow(dead_code)]
pub fn validate_sse_frame_size(size: usize) -> NativeResult<()> {
    if size > MAX_SSE_FRAME_BYTES {
        Err(NativeDiagnostic::new("frame_limit_exceeded", false))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use uuid::Uuid;

    use super::{
        bearer_header, conversation_start_request, pairing_request, parse_client_error_envelope,
        parse_client_success_envelope, parse_pairing_exchange_response, validate_client_metadata,
        validate_sse_frame_size, ClientV1Operation, StartConversationInput, PAIRING_SCOPES,
    };

    #[test]
    fn pairing_request_matches_the_locked_flat_client_v1_fixture() {
        assert_eq!(
            pairing_request("installation-7"),
            json!({
                "appName": crate::APP_NAME,
                "installationId": "installation-7",
                "scopes": PAIRING_SCOPES,
            })
        );
    }

    #[test]
    fn pairing_exchange_parses_the_locked_nested_credential_fixture() {
        let grant = parse_pairing_exchange_response(json!({
            "bearer": "issued-bearer",
            "credential": {
                "id": "credential-7",
            },
        }))
        .unwrap();

        assert_eq!(grant.metadata.credential_id, "credential-7");
    }

    #[test]
    fn client_v1_success_envelope_returns_data_after_validating_metadata() {
        let data = parse_client_success_envelope(
            json!({
                "apiVersion": "1.0",
                "minimumClientVersion": "0.1.0",
                "capabilities": ["pairing", "credentials"],
                "requestId": "request-success",
                "data": { "status": "ok" },
            }),
            ClientV1Operation::Pairing,
        )
        .unwrap();

        assert_eq!(data, json!({ "status": "ok" }));
    }

    #[test]
    fn compatible_older_minimum_client_versions_negotiate_pairing() {
        let metadata = validate_client_metadata(
            "1.0",
            "0.0.1",
            &["pairing".to_owned(), "credentials".to_owned()],
            ClientV1Operation::Health,
            true,
        )
        .unwrap();

        assert!(metadata.supports_pairing());
    }

    #[test]
    fn client_v1_error_envelope_preserves_only_typed_diagnostics() {
        let error = parse_client_error_envelope(
            426,
            json!({
                "apiVersion": "1.0",
                "minimumClientVersion": "9.0.0",
                "capabilities": ["pairing", "credentials"],
                "requestId": "request-error",
                "error": {
                    "code": "incompatible_version",
                    "message": "Update Chat",
                    "retryable": false,
                },
            }),
            ClientV1Operation::Health,
        )
        .unwrap();

        assert_eq!(error.code, "incompatible_version");
        assert!(!error.retryable);
    }

    #[test]
    fn client_v1_rejects_health_without_compatible_metadata_or_status() {
        let missing_metadata = parse_client_success_envelope(
            json!({ "data": { "status": "ok" } }),
            ClientV1Operation::Health,
        )
        .unwrap_err();
        let arbitrary_health = parse_client_success_envelope(
            json!({
                "apiVersion": "1.0",
                "minimumClientVersion": "0.1.0",
                "capabilities": ["pairing", "credentials"],
                "data": { "anything": true },
            }),
            ClientV1Operation::Health,
        )
        .unwrap_err();

        assert_eq!(missing_metadata.code, "invalid_cave_response");
        assert_eq!(arbitrary_health.code, "invalid_health_response");
    }

    #[test]
    fn conversation_startup_sends_required_payload_and_uuid_idempotency_key() {
        let request = conversation_start_request(&StartConversationInput {
            familiar_id: "astra".to_owned(),
            project_root: None,
        });

        assert_eq!(
            request.body,
            json!({
                "familiarId": "astra",
                "projectRoot": null,
            })
        );
        assert_eq!(request.idempotency_header, "Idempotency-Key");
        assert!(Uuid::parse_str(&request.idempotency_key).is_ok());
    }

    #[test]
    fn authenticated_requests_construct_the_bearer_header_inside_rust() {
        assert_eq!(bearer_header("credential-value"), "Bearer credential-value");
    }

    #[test]
    fn rejects_oversized_sse_frames() {
        assert_eq!(
            validate_sse_frame_size(1024 * 1024 + 1).unwrap_err().code,
            "frame_limit_exceeded"
        );
    }
}
