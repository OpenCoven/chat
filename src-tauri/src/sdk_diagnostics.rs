use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

const MAX_SNAPSHOT_NODES: usize = 4_096;
const MAX_SNAPSHOT_STRING_CHARACTERS: usize = 64 * 1024;
const SAFE_ERROR_MESSAGE: &str = "Cave operation failed.";

#[derive(Clone, Copy, PartialEq, Eq)]
enum SnapshotPolicy {
    Strict,
    CanonicalResponse,
}

#[derive(Clone, Copy)]
enum SnapshotLocation {
    Root,
    Data,
    Messages,
    Message,
    Conversations,
    Conversation,
    Familiars,
    Familiar,
    Projects,
    Project,
    CanonicalContent,
    Other,
}

impl SnapshotLocation {
    fn object_child(self, key: &str) -> Self {
        match (self, key) {
            (Self::Root, "data") => Self::Data,
            (Self::Data, "messages") => Self::Messages,
            (Self::Data, "conversations") => Self::Conversations,
            (Self::Data, "conversation") => Self::Conversation,
            (Self::Data, "familiars") => Self::Familiars,
            (Self::Data, "projects") => Self::Projects,
            (Self::Message, "text")
            | (Self::Conversation, "title")
            | (Self::Familiar, "displayName")
            | (Self::Familiar, "description")
            | (Self::Project, "name") => Self::CanonicalContent,
            _ => Self::Other,
        }
    }

    fn array_entry(self) -> Self {
        match self {
            Self::Messages => Self::Message,
            Self::Conversations => Self::Conversation,
            Self::Familiars => Self::Familiar,
            Self::Projects => Self::Project,
            _ => Self::Other,
        }
    }
}

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
        Self {
            code,
            retryable,
            diagnostic_id: Uuid::new_v4().to_string(),
        }
    }

    pub fn invalid_request() -> Self {
        Self::new(DiagnosticCode::InvalidRequest, false)
    }

    pub fn invalid_response() -> Self {
        Self::new(DiagnosticCode::InvalidResponse, false)
    }

    pub fn credential_update_in_progress() -> Self {
        Self::new(DiagnosticCode::CredentialUpdateInProgress, true)
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
    pub fn snapshot(status_code: u16, payload: Value) -> Result<Self, NativeError> {
        if !(100..=599).contains(&status_code) {
            return Err(NativeError::invalid_response());
        }
        let mut payload = payload;
        let mut budget = SnapshotBudget::default();
        sanitize_snapshot(
            &mut payload,
            SnapshotLocation::Root,
            false,
            false,
            SnapshotPolicy::CanonicalResponse,
            &mut budget,
        )?;
        Ok(Self {
            status_code,
            payload,
        })
    }
}

#[derive(Default)]
struct SnapshotBudget {
    nodes: usize,
    string_characters: usize,
}

fn sanitize_snapshot(
    value: &mut Value,
    location: SnapshotLocation,
    inside_error: bool,
    error_object: bool,
    policy: SnapshotPolicy,
    budget: &mut SnapshotBudget,
) -> Result<(), NativeError> {
    budget.nodes = budget
        .nodes
        .checked_add(1)
        .ok_or_else(NativeError::invalid_response)?;
    if budget.nodes > MAX_SNAPSHOT_NODES {
        return Err(NativeError::new(DiagnosticCode::BodyLimit, false));
    }

    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => Ok(()),
        Value::String(text) => {
            budget.string_characters = budget
                .string_characters
                .checked_add(text.chars().count())
                .ok_or_else(NativeError::invalid_response)?;
            if budget.string_characters > MAX_SNAPSHOT_STRING_CHARACTERS {
                return Err(NativeError::new(DiagnosticCode::BodyLimit, false));
            }
            let canonical_content = policy == SnapshotPolicy::CanonicalResponse
                && !inside_error
                && matches!(location, SnapshotLocation::CanonicalContent);
            if !canonical_content && secret_shaped_value(text) {
                return Err(NativeError::invalid_response());
            }
            Ok(())
        }
        Value::Array(entries) => {
            if entries.len() > MAX_SNAPSHOT_NODES {
                return Err(NativeError::new(DiagnosticCode::BodyLimit, false));
            }
            let entry_location = location.array_entry();
            for entry in entries {
                sanitize_snapshot(entry, entry_location, inside_error, false, policy, budget)?;
            }
            Ok(())
        }
        Value::Object(object) => {
            if object.len() > 256 {
                return Err(NativeError::new(DiagnosticCode::BodyLimit, false));
            }
            let keys = object.keys().cloned().collect::<Vec<_>>();
            for key in keys {
                budget.string_characters = budget
                    .string_characters
                    .checked_add(key.chars().count())
                    .ok_or_else(NativeError::invalid_response)?;
                if budget.string_characters > MAX_SNAPSHOT_STRING_CHARACTERS
                    || forbidden_snapshot_key(&key)
                {
                    return Err(NativeError::invalid_response());
                }
                if error_object && key == "details" {
                    object.remove(&key);
                    continue;
                }
                let Some(entry) = object.get_mut(&key) else {
                    return Err(NativeError::invalid_response());
                };
                if error_object && key == "message" {
                    if !entry.is_string() {
                        return Err(NativeError::invalid_response());
                    }
                    *entry = Value::String(SAFE_ERROR_MESSAGE.into());
                    continue;
                }
                let child_is_error = key == "error";
                let child_inside_error = inside_error || child_is_error;
                let child_location = if child_inside_error {
                    SnapshotLocation::Other
                } else {
                    location.object_child(&key)
                };
                sanitize_snapshot(
                    entry,
                    child_location,
                    child_inside_error,
                    child_is_error,
                    policy,
                    budget,
                )?;
            }
            Ok(())
        }
    }
}

fn forbidden_snapshot_key(key: &str) -> bool {
    let lowercase = key.to_ascii_lowercase();
    lowercase.contains("bearer")
        || lowercase.contains("secret")
        || lowercase.ends_with("token")
        || matches!(
            lowercase.as_str(),
            "apikey" | "authorization" | "password" | "privatekey"
        )
        || (lowercase.starts_with("attachment") && lowercase != "attachmentcount")
        || matches!(
            lowercase.as_str(),
            "cause" | "prompt" | "serializedkeychainrecord"
        )
}

fn secret_shaped_value(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

pub fn validate_public_snapshot(value: Value) -> Result<Value, NativeError> {
    let mut value = value;
    let mut budget = SnapshotBudget::default();
    sanitize_snapshot(
        &mut value,
        SnapshotLocation::Other,
        false,
        false,
        SnapshotPolicy::Strict,
        &mut budget,
    )?;
    Ok(value)
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
    use uuid::Uuid;

    use super::{
        validate_public_snapshot, DiagnosticCode, NativeDiagnostics, NativeError, NativeResponse,
        MAX_SNAPSHOT_STRING_CHARACTERS, SAFE_ERROR_MESSAGE,
    };

    #[test]
    fn serialized_errors_have_no_message_details_or_cause() {
        let error = NativeError::new(DiagnosticCode::ServiceUnavailable, true);
        let rendered = serde_json::to_value(error).expect("safe errors should serialize");
        let object = rendered.as_object().expect("error should be an object");

        assert_eq!(
            object.keys().map(String::as_str).collect::<Vec<_>>(),
            ["code", "diagnosticId", "retryable"]
        );
        assert!(Uuid::parse_str(
            rendered["diagnosticId"]
                .as_str()
                .expect("diagnostic id should be a string")
        )
        .is_ok());
    }

    #[test]
    fn snapshots_reject_secret_bearing_and_private_control_fields() {
        for payload in [
            json!({"data": {"bearer": "credential"}}),
            json!({"data": {"pairingSecret": "credential"}}),
            json!({"data": {"prompt": "private prompt"}}),
            json!({"error": {"cause": "raw keychain failure"}}),
            json!({"data": {"attachment": {"name": "private.pdf"}}}),
        ] {
            assert_eq!(
                NativeResponse::snapshot(200, payload)
                    .expect_err("private command output must fail closed")
                    .code,
                DiagnosticCode::InvalidResponse
            );
        }
    }

    #[test]
    fn snapshots_allow_public_content_that_resembles_secret_material() {
        let value = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        let response = NativeResponse::snapshot(
            200,
            json!({"data": {"messages": [{"id": "message-1", "text": value}]}}),
        )
        .expect("public canonical content is validated by the packed SDK");
        let rendered = serde_json::to_value(response).expect("snapshot should serialize");

        assert_eq!(rendered["payload"]["data"]["messages"][0]["text"], value);
    }

    #[test]
    fn snapshots_reject_secret_shaped_values_outside_canonical_content() {
        for payload in [
            json!({"data": {"metadata": {"accessToken": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}}}),
            json!({"data": {"messages": [{"id": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "text": "safe"}]}}),
            json!({"data": {"futureField": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}}),
        ] {
            assert_eq!(
                NativeResponse::snapshot(200, payload)
                    .expect_err("control and metadata values must reject secret-shaped material")
                    .code,
                DiagnosticCode::InvalidResponse
            );
        }
    }

    #[test]
    fn snapshots_reject_secret_shaped_error_metadata() {
        assert_eq!(
            NativeResponse::snapshot(
                500,
                json!({
                    "error": {
                        "code": "internal_error",
                        "message": "safe",
                        "metadata": {
                            "traceValue": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
                        }
                    }
                }),
            )
            .expect_err("error metadata must reject secret-shaped material")
            .code,
            DiagnosticCode::InvalidResponse
        );
    }

    #[test]
    fn forbidden_credential_keys_are_rejected_in_canonical_content() {
        for key in ["bearer", "pairingSecret", "accessToken", "authorization"] {
            assert_eq!(
                NativeResponse::snapshot(
                    200,
                    json!({"data": {"messages": [{"text": "safe", key: "credential"}]}}),
                )
                .expect_err("credential keys must be rejected at every structural location")
                .code,
                DiagnosticCode::InvalidResponse
            );
        }
    }

    #[test]
    fn strict_public_values_reject_secret_shaped_values_under_any_key() {
        for key in ["current", "next", "previous", "futureField"] {
            let value = json!({key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"});
            assert_eq!(
                validate_public_snapshot(value)
                    .expect_err("pairing and credential metadata must reject secret-shaped values")
                    .code,
                DiagnosticCode::InvalidResponse
            );
        }
    }

    #[test]
    fn snapshots_sanitize_error_copy_without_parsing_protocol_dtos() {
        let response = NativeResponse::snapshot(
            409,
            json!({
                "apiVersion": "future",
                "error": {
                    "code": "reconcile_required",
                    "message": "failed at /Users/private/.opencoven/cave.json",
                    "retryable": false,
                    "details": {"path": "/Users/private"}
                },
                "futureField": {"kept": true}
            }),
        )
        .expect("generic public snapshot should not parse Client v1");
        let rendered = serde_json::to_value(response).expect("response should serialize");

        assert_eq!(rendered["payload"]["error"]["message"], SAFE_ERROR_MESSAGE);
        assert!(rendered["payload"]["error"].get("details").is_none());
        assert_eq!(rendered["payload"]["futureField"]["kept"], true);
        assert!(!rendered.to_string().contains("/Users/private"));
    }

    #[test]
    fn snapshots_bound_untrusted_payloads() {
        let error = NativeResponse::snapshot(
            200,
            json!({"data": {"text": "x".repeat(MAX_SNAPSHOT_STRING_CHARACTERS + 1)}}),
        )
        .expect_err("oversized snapshots must fail closed");
        assert_eq!(error.code, DiagnosticCode::BodyLimit);
    }

    #[test]
    fn diagnostics_use_the_frozen_platform_vocabulary() {
        let diagnostics = NativeDiagnostics::new(Vec::new());
        assert!(["darwin", "linux", "win32", "unsupported"].contains(&diagnostics.platform));
        assert!(["arm64", "x64", "unsupported"].contains(&diagnostics.architecture));
    }
}
