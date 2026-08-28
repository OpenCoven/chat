use std::sync::atomic::{AtomicU64, Ordering};

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use uuid::{Uuid, Version};

use crate::metadata::APP_NAME;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const SAFE_ERROR_MESSAGE: &str = "Cave operation failed.";

static NEXT_DIAGNOSTIC_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticCode {
    BodyLimit,
    Conflict,
    CredentialUpdateInProgress,
    InvalidRequest,
    InvalidResponse,
    OperationInProgress,
    OwnerMismatch,
    PairingExpired,
    PlatformSecurityUnavailable,
    ReconcileRequired,
    SecretStoreDeleteFailed,
    SecretStoreReadFailed,
    SecretStoreRollbackFailed,
    SecretStoreWriteFailed,
    SecureStoreUnavailable,
    ServiceUnavailable,
    StaleRecord,
    Timeout,
    UnsafeEndpoint,
    UnsupportedOperation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeError {
    pub code: DiagnosticCode,
    pub retryable: bool,
    pub diagnostic_id: String,
}

impl NativeError {
    pub fn new(code: DiagnosticCode, retryable: bool) -> Self {
        let sequence = NEXT_DIAGNOSTIC_ID.fetch_add(1, Ordering::Relaxed);
        Self {
            code,
            retryable,
            diagnostic_id: format!("native:{sequence:016x}"),
        }
    }

    pub fn invalid_request() -> Self {
        Self::new(DiagnosticCode::InvalidRequest, false)
    }

    pub fn invalid_response() -> Self {
        Self::new(DiagnosticCode::InvalidResponse, false)
    }

    pub fn platform_security_unavailable() -> Self {
        Self::new(DiagnosticCode::PlatformSecurityUnavailable, false)
    }

    pub fn reconcile_required() -> Self {
        Self::new(DiagnosticCode::ReconcileRequired, false)
    }

    pub fn secure_store_unavailable() -> Self {
        Self::new(DiagnosticCode::SecureStoreUnavailable, false)
    }

    pub fn secret_store_rollback_failed() -> Self {
        Self::new(DiagnosticCode::SecretStoreRollbackFailed, false)
    }

    pub fn service_unavailable() -> Self {
        Self::new(DiagnosticCode::ServiceUnavailable, true)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeResponse {
    status_code: u16,
    payload: Value,
}

impl std::fmt::Debug for NativeResponse {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NativeResponse")
            .field("status_code", &self.status_code)
            .field("payload", &"<redacted>")
            .finish()
    }
}

impl NativeResponse {
    pub fn health(status_code: u16, payload: Value) -> Result<Self, NativeError> {
        operation_response::<HealthData>(
            status_code,
            payload,
            "health",
            "health.read",
            HealthData::validate,
        )
    }

    pub fn pairing_create(status_code: u16, payload: Value) -> Result<Self, NativeError> {
        operation_response::<PairingCreatedData>(
            status_code,
            payload,
            "pairing",
            "pairing.create",
            PairingCreatedData::validate,
        )
    }

    pub fn pairing_poll(status_code: u16, payload: Value) -> Result<Self, NativeError> {
        operation_response::<PairingStatusData>(
            status_code,
            payload,
            "pairing",
            "pairing.poll",
            PairingStatusData::validate,
        )
    }

    pub fn pairing_exchange(status_code: u16, payload: Value) -> Result<Self, NativeError> {
        operation_response::<PairingExchangeData>(
            status_code,
            payload,
            "pairing",
            "pairing.exchange",
            PairingExchangeData::validate,
        )
    }

    pub const fn status_code(&self) -> u16 {
        self.status_code
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SuccessEnvelope<T> {
    api_version: String,
    minimum_client_version: String,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null_string",
        skip_serializing_if = "Option::is_none"
    )]
    request_id: Option<String>,
    capabilities: Vec<String>,
    operations: Vec<String>,
    data: T,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawErrorEnvelope {
    api_version: String,
    minimum_client_version: String,
    #[serde(default, deserialize_with = "deserialize_optional_non_null_string")]
    request_id: Option<String>,
    capabilities: Vec<String>,
    operations: Vec<String>,
    error: RawError,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawError {
    code: String,
    message: String,
    retryable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SafeErrorEnvelope {
    api_version: String,
    minimum_client_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    capabilities: Vec<String>,
    operations: Vec<String>,
    error: SafeError,
}

#[derive(Serialize)]
struct SafeError {
    code: String,
    message: &'static str,
    retryable: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HealthData {
    instance_id: String,
    pairing_required: bool,
    release_version: String,
}

impl HealthData {
    fn validate(&self) -> bool {
        valid_uuid(&self.instance_id) && valid_semver(&self.release_version)
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PairingCreatedData {
    request_id: String,
    expires_at: u64,
}

impl PairingCreatedData {
    fn validate(&self) -> bool {
        valid_uuid(&self.request_id) && self.expires_at <= MAX_SAFE_INTEGER
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PairingStatusData {
    id: String,
    status: String,
    expires_at: u64,
}

impl PairingStatusData {
    fn validate(&self) -> bool {
        valid_uuid(&self.id)
            && matches!(
                self.status.as_str(),
                "pending" | "approved" | "denied" | "expired"
            )
            && self.expires_at <= MAX_SAFE_INTEGER
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PairingExchangeData {
    credential: CredentialMetadata,
}

impl PairingExchangeData {
    fn validate(&self) -> bool {
        self.credential.validate()
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CredentialMetadata {
    id: String,
    app_name: String,
    installation_id: String,
    scopes: Vec<String>,
    created_at: u64,
    last_used_at: RequiredNullable<u64>,
    revoked_at: RequiredNullable<u64>,
    revocation_reason: RequiredNullable<String>,
}

impl CredentialMetadata {
    fn validate(&self) -> bool {
        valid_uuid(&self.id)
            && self.app_name == APP_NAME
            && valid_v4_uuid(&self.installation_id)
            && self.scopes == ["chat:read"]
            && self.created_at <= MAX_SAFE_INTEGER
            && self
                .last_used_at
                .0
                .is_none_or(|value| value <= MAX_SAFE_INTEGER)
            && self.revoked_at.0.is_none()
            && self.revocation_reason.0.is_none()
    }
}

#[derive(Serialize)]
#[serde(transparent)]
struct RequiredNullable<T>(Option<T>);

impl<'de, T> Deserialize<'de> for RequiredNullable<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Option::<T>::deserialize(deserializer).map(Self)
    }
}

fn deserialize_optional_non_null_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    String::deserialize(deserializer).map(Some)
}

fn operation_response<T>(
    status_code: u16,
    payload: Value,
    required_capability: &str,
    required_operation: &str,
    validate_data: impl FnOnce(&T) -> bool,
) -> Result<NativeResponse, NativeError>
where
    T: DeserializeOwned + Serialize,
{
    if (200..=299).contains(&status_code) {
        let envelope = serde_json::from_value::<SuccessEnvelope<T>>(payload)
            .map_err(|_| NativeError::invalid_response())?;
        if !validate_envelope(
            &envelope.api_version,
            &envelope.minimum_client_version,
            envelope.request_id.as_deref(),
            &envelope.capabilities,
            &envelope.operations,
        ) || !envelope
            .capabilities
            .iter()
            .any(|capability| capability == required_capability)
            || !envelope
                .operations
                .iter()
                .any(|operation| operation == required_operation)
            || !validate_data(&envelope.data)
        {
            return Err(NativeError::invalid_response());
        }
        return safe_response(status_code, &envelope);
    }
    if !(400..=599).contains(&status_code) {
        return Err(NativeError::invalid_response());
    }
    let envelope = serde_json::from_value::<RawErrorEnvelope>(payload)
        .map_err(|_| NativeError::invalid_response())?;
    if !validate_envelope(
        &envelope.api_version,
        &envelope.minimum_client_version,
        envelope.request_id.as_deref(),
        &envelope.capabilities,
        &envelope.operations,
    ) || !envelope
        .capabilities
        .iter()
        .any(|capability| capability == required_capability)
        || !envelope
            .operations
            .iter()
            .any(|operation| operation == required_operation)
        || !valid_error_code(&envelope.error.code)
        || envelope.error.message.is_empty()
        || envelope.error.message.chars().count() > 256
    {
        return Err(NativeError::invalid_response());
    }

    safe_response(
        status_code,
        &SafeErrorEnvelope {
            api_version: envelope.api_version,
            minimum_client_version: envelope.minimum_client_version,
            request_id: envelope.request_id,
            capabilities: envelope.capabilities,
            operations: envelope.operations,
            error: SafeError {
                code: envelope.error.code,
                message: SAFE_ERROR_MESSAGE,
                retryable: envelope.error.retryable,
            },
        },
    )
}

fn safe_response(status_code: u16, value: &impl Serialize) -> Result<NativeResponse, NativeError> {
    Ok(NativeResponse {
        status_code,
        payload: serde_json::to_value(value).map_err(|_| NativeError::invalid_response())?,
    })
}

fn validate_envelope(
    api_version: &str,
    minimum_client_version: &str,
    request_id: Option<&str>,
    capabilities: &[String],
    operations: &[String],
) -> bool {
    api_version
        .strip_prefix("1.")
        .is_some_and(valid_decimal_component)
        && valid_semver(minimum_client_version)
        && request_id.is_none_or(valid_request_id)
        && valid_unique_inventory(capabilities, valid_capability)
        && valid_unique_inventory(operations, valid_operation)
}

fn valid_unique_inventory(values: &[String], validate: impl Fn(&str) -> bool) -> bool {
    if values.len() > 32 || values.iter().any(|value| !validate(value)) {
        return false;
    }
    let mut sorted = values.to_vec();
    sorted.sort();
    sorted.dedup();
    sorted.len() == values.len()
}

fn valid_decimal_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 5
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && (value == "0" || !value.starts_with('0'))
}

fn valid_semver(value: &str) -> bool {
    let parts = value.split('.').collect::<Vec<_>>();
    parts.len() == 3 && parts.into_iter().all(valid_decimal_component)
}

fn valid_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|uuid| uuid.to_string() == value)
}

fn valid_v4_uuid(value: &str) -> bool {
    Uuid::parse_str(value)
        .is_ok_and(|uuid| uuid.to_string() == value && uuid.get_version() == Some(Version::Random))
}

fn valid_capability(value: &str) -> bool {
    matches!(
        value,
        "health"
            | "pairing"
            | "credentials"
            | "familiars"
            | "projects"
            | "conversations"
            | "conversation-messages"
            | "cursors"
    )
}

fn valid_operation(value: &str) -> bool {
    matches!(
        value,
        "health.read"
            | "pairing.create"
            | "pairing.poll"
            | "pairing.exchange"
            | "pairing.admin.list"
            | "pairing.admin.decide"
            | "credentials.admin.list"
            | "credentials.admin.revoke"
            | "familiars.list"
            | "projects.list"
            | "conversations.list"
            | "conversations.read"
            | "messages.list"
    )
}

fn valid_error_code(value: &str) -> bool {
    matches!(
        value,
        "aborted"
            | "body_limit"
            | "conflict"
            | "credential_update_in_progress"
            | "incompatible_version"
            | "invalid_request"
            | "invalid_response"
            | "not_found"
            | "operation_in_progress"
            | "owner_mismatch"
            | "pairing_denied"
            | "pairing_expired"
            | "pairing_pending"
            | "platform_security_unavailable"
            | "rate_limited"
            | "reconcile_required"
            | "scope_denied"
            | "secure_store_unavailable"
            | "service_unavailable"
            | "stale_record"
            | "timeout"
            | "unauthorized"
            | "unsafe_endpoint"
            | "unsupported_operation"
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SecurityStatus {
    Available,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SecurityComponent {
    CaveCredentialCustody,
    CaveProtectedAuthority,
    CovenUnixPeerIdentity,
    CovenWindowsPipeIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityCheck {
    pub component: SecurityComponent,
    pub status: SecurityStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<DiagnosticCode>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDiagnostics {
    pub version: u8,
    pub platform: &'static str,
    pub architecture: &'static str,
    pub checks: Vec<SecurityCheck>,
}

impl NativeDiagnostics {
    pub fn new(checks: Vec<SecurityCheck>) -> Self {
        Self {
            version: 1,
            platform: diagnostic_platform(),
            architecture: diagnostic_architecture(),
            checks,
        }
    }
}

const fn diagnostic_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "unsupported"
    }
}

const fn diagnostic_architecture() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else if cfg!(target_arch = "x86_64") {
        "x64"
    } else {
        "unsupported"
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{DiagnosticCode, NativeDiagnostics, NativeError, NativeResponse};

    #[test]
    fn serialized_errors_have_no_message_details_or_cause() {
        let error = NativeError::new(DiagnosticCode::ServiceUnavailable, true);
        let rendered = serde_json::to_value(error).expect("safe errors should serialize");
        let object = rendered.as_object().expect("error should be an object");

        assert_eq!(
            object.keys().map(String::as_str).collect::<Vec<_>>(),
            ["code", "diagnosticId", "retryable"]
        );
        assert!(!rendered.to_string().contains("secret-sentinel"));
        assert!(!rendered.to_string().contains("private/path"));
    }

    #[test]
    fn operation_inventories_have_deterministic_bounds() {
        let payload = json!({
            "apiVersion": "1.0",
            "minimumClientVersion": "0.1.0",
            "capabilities": vec!["health"; 33],
            "operations": ["health.read"],
            "data": {
                "instanceId": "00000000-0000-4000-8000-000000000001",
                "pairingRequired": true,
                "releaseVersion": "0.1.0"
            }
        });
        let error = NativeResponse::health(200, payload)
            .expect_err("oversized operation inventories must fail closed");
        assert_eq!(error.code, DiagnosticCode::InvalidResponse);
    }

    #[test]
    fn diagnostics_use_the_frozen_platform_vocabulary() {
        let diagnostics = NativeDiagnostics::new(Vec::new());
        assert!(["darwin", "linux", "win32", "unsupported"].contains(&diagnostics.platform));
        assert!(["arm64", "x64", "unsupported"].contains(&diagnostics.architecture));
    }
}
