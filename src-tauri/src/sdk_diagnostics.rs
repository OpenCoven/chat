use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

const MAX_SNAPSHOT_NODES: usize = 4_096;
const MAX_SNAPSHOT_STRING_CHARACTERS: usize = 64 * 1024;
const SAFE_ERROR_MESSAGE: &str = "Cave operation failed.";

#[derive(Clone, Copy, PartialEq, Eq)]
enum SnapshotPolicy {
    Strict,
    CanonicalResponse(NativeResponseOperation),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeResponseOperation {
    Health,
    ListFamiliars,
    ListProjects,
    ListConversations,
    GetConversation,
    ListConversationMessages,
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
    fn object_child(self, key: &str, operation: Option<NativeResponseOperation>) -> Self {
        match (self, key) {
            (Self::Root, "data") => Self::Data,
            (Self::Data, "messages")
                if operation == Some(NativeResponseOperation::ListConversationMessages) =>
            {
                Self::Messages
            }
            (Self::Data, "conversations")
                if operation == Some(NativeResponseOperation::ListConversations) =>
            {
                Self::Conversations
            }
            (Self::Data, "conversation")
                if operation == Some(NativeResponseOperation::GetConversation) =>
            {
                Self::Conversation
            }
            (Self::Data, "familiars")
                if operation == Some(NativeResponseOperation::ListFamiliars) =>
            {
                Self::Familiars
            }
            (Self::Data, "projects")
                if operation == Some(NativeResponseOperation::ListProjects) =>
            {
                Self::Projects
            }
            (Self::Message, "text")
                if operation == Some(NativeResponseOperation::ListConversationMessages) =>
            {
                Self::CanonicalContent
            }
            (Self::Conversation, "title")
                if matches!(
                    operation,
                    Some(
                        NativeResponseOperation::ListConversations
                            | NativeResponseOperation::GetConversation
                    )
                ) =>
            {
                Self::CanonicalContent
            }
            (Self::Familiar, "displayName" | "description")
                if operation == Some(NativeResponseOperation::ListFamiliars) =>
            {
                Self::CanonicalContent
            }
            (Self::Project, "name") if operation == Some(NativeResponseOperation::ListProjects) => {
                Self::CanonicalContent
            }
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
    #[serde(skip)]
    operation: NativeResponseOperation,
    status_code: u16,
    payload: Value,
}

impl std::fmt::Debug for NativeResponse {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NativeResponse")
            .field("operation", &self.operation)
            .field("status_code", &self.status_code)
            .field("payload", &"<redacted>")
            .finish()
    }
}

impl NativeResponse {
    pub fn snapshot(
        operation: NativeResponseOperation,
        status_code: u16,
        payload: Value,
    ) -> Result<Self, NativeError> {
        if !(100..=599).contains(&status_code) {
            return Err(NativeError::invalid_response());
        }
        let mut payload = payload;
        let mut budget = SnapshotBudget::default();
        let policy = if (200..=299).contains(&status_code) {
            SnapshotPolicy::CanonicalResponse(operation)
        } else {
            SnapshotPolicy::Strict
        };
        validate_snapshot(
            &payload,
            SnapshotLocation::Root,
            false,
            false,
            policy,
            &mut budget,
        )?;
        project_snapshot(&mut payload, false);
        Ok(Self {
            operation,
            status_code,
            payload,
        })
    }

    pub fn validate_operation(&self, expected: NativeResponseOperation) -> Result<(), NativeError> {
        if self.operation != expected {
            return Err(NativeError::invalid_response());
        }
        Ok(())
    }
}

#[derive(Default)]
struct SnapshotBudget {
    nodes: usize,
    string_characters: usize,
}

fn validate_snapshot(
    value: &Value,
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
            let canonical_content = matches!(policy, SnapshotPolicy::CanonicalResponse(_))
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
                validate_snapshot(entry, entry_location, inside_error, false, policy, budget)?;
            }
            Ok(())
        }
        Value::Object(object) => {
            if object.len() > 256 {
                return Err(NativeError::new(DiagnosticCode::BodyLimit, false));
            }
            for (key, entry) in object {
                budget.string_characters = budget
                    .string_characters
                    .checked_add(key.chars().count())
                    .ok_or_else(NativeError::invalid_response)?;
                if budget.string_characters > MAX_SNAPSHOT_STRING_CHARACTERS
                    || forbidden_snapshot_key(key)
                {
                    return Err(NativeError::invalid_response());
                }
                if error_object && key == "message" && !entry.is_string() {
                    return Err(NativeError::invalid_response());
                }
                let child_is_error = key == "error";
                if child_is_error && !entry.is_object() {
                    return Err(NativeError::invalid_response());
                }
                let child_inside_error = inside_error || child_is_error;
                let child_location = if child_inside_error {
                    SnapshotLocation::Other
                } else {
                    location.object_child(
                        key,
                        match policy {
                            SnapshotPolicy::Strict => None,
                            SnapshotPolicy::CanonicalResponse(operation) => Some(operation),
                        },
                    )
                };
                validate_snapshot(
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

fn project_snapshot(value: &mut Value, error_object: bool) {
    match value {
        Value::Array(entries) => {
            for entry in entries {
                project_snapshot(entry, false);
            }
        }
        Value::Object(object) => {
            if error_object {
                object.remove("details");
                if let Some(message) = object.get_mut("message") {
                    *message = Value::String(SAFE_ERROR_MESSAGE.into());
                }
            }
            for (key, entry) in object {
                project_snapshot(entry, key == "error");
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
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
    let mut run = 0;
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-') {
            run += 1;
        } else {
            if run == 43 {
                return true;
            }
            run = 0;
        }
    }
    run == 43
}

pub fn validate_public_snapshot(value: Value) -> Result<Value, NativeError> {
    let mut value = value;
    let mut budget = SnapshotBudget::default();
    validate_snapshot(
        &value,
        SnapshotLocation::Other,
        false,
        false,
        SnapshotPolicy::Strict,
        &mut budget,
    )?;
    project_snapshot(&mut value, false);
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
        NativeResponseOperation, MAX_SNAPSHOT_STRING_CHARACTERS, SAFE_ERROR_MESSAGE,
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
                NativeResponse::snapshot(NativeResponseOperation::Health, 200, payload)
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
            NativeResponseOperation::ListConversationMessages,
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
                NativeResponse::snapshot(
                    NativeResponseOperation::ListConversationMessages,
                    200,
                    payload,
                )
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
                NativeResponseOperation::Health,
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
    fn snapshots_reject_secret_shaped_original_error_messages() {
        assert_eq!(
            NativeResponse::snapshot(
                NativeResponseOperation::Health,
                500,
                json!({
                    "error": {
                        "code": "internal_error",
                        "message": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
                    }
                }),
            )
            .expect_err("the original error message must be validated before redaction")
            .code,
            DiagnosticCode::InvalidResponse
        );
    }

    #[test]
    fn snapshots_validate_nested_error_details_before_redaction() {
        for details in [
            json!({
                "context": {
                    "credentials": {
                        "authorization": "credential"
                    }
                }
            }),
            json!({
                "context": {
                    "traceValue": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
                }
            }),
        ] {
            assert_eq!(
                NativeResponse::snapshot(
                    NativeResponseOperation::Health,
                    500,
                    json!({
                        "error": {
                            "code": "internal_error",
                            "message": "safe",
                            "details": details
                        }
                    }),
                )
                .expect_err("nested error details must be validated before redaction")
                .code,
                DiagnosticCode::InvalidResponse
            );
        }
    }

    #[test]
    fn snapshots_reject_non_object_error_values() {
        assert_eq!(
            NativeResponse::snapshot(
                NativeResponseOperation::Health,
                500,
                json!({
                    "error": [{
                        "message": "failed at /Users/private/.opencoven/cave.json",
                        "details": {"path": "/Users/private"}
                    }]
                }),
            )
            .expect_err("error output must have a redactable object shape")
            .code,
            DiagnosticCode::InvalidResponse
        );
    }

    #[test]
    fn forbidden_credential_keys_are_rejected_in_canonical_content() {
        for key in ["bearer", "pairingSecret", "accessToken", "authorization"] {
            assert_eq!(
                NativeResponse::snapshot(
                    NativeResponseOperation::ListConversationMessages,
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
            NativeResponseOperation::Health,
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
            NativeResponseOperation::Health,
            200,
            json!({"data": {"text": "x".repeat(MAX_SNAPSHOT_STRING_CHARACTERS + 1)}}),
        )
        .expect_err("oversized snapshots must fail closed");
        assert_eq!(error.code, DiagnosticCode::BodyLimit);
    }

    #[test]
    fn snapshots_scope_content_exemptions_to_the_requested_operation() {
        let value = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        let messages = json!({
            "data": {
                "messages": [{
                    "id": "message-1",
                    "text": value
                }]
            }
        });

        NativeResponse::snapshot(
            NativeResponseOperation::ListConversationMessages,
            200,
            messages.clone(),
        )
        .expect("message text is content for the messages operation");
        assert_eq!(
            NativeResponse::snapshot(NativeResponseOperation::ListProjects, 200, messages)
                .expect_err("message paths are not content for project reads")
                .code,
            DiagnosticCode::InvalidResponse
        );
    }

    #[test]
    fn snapshots_cannot_be_reused_for_a_different_operation() {
        let response = NativeResponse::snapshot(
            NativeResponseOperation::ListConversationMessages,
            200,
            json!({"data": {"messages": []}}),
        )
        .expect("snapshot should be valid for messages");

        assert_eq!(
            response
                .validate_operation(NativeResponseOperation::ListProjects)
                .expect_err("operation tags are not interchangeable")
                .code,
            DiagnosticCode::InvalidResponse
        );
    }

    #[test]
    fn health_snapshots_reject_all_canonical_content_exemptions() {
        assert_eq!(
            NativeResponse::snapshot(
                NativeResponseOperation::Health,
                200,
                json!({
                    "data": {
                        "messages": [{
                            "id": "message-1",
                            "text": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
                        }]
                    }
                }),
            )
            .expect_err("health has no user-content paths")
            .code,
            DiagnosticCode::InvalidResponse
        );
    }

    #[test]
    fn snapshots_reject_wrapped_secret_shaped_values_outside_allowed_content() {
        assert_eq!(
            NativeResponse::snapshot(
                NativeResponseOperation::ListConversationMessages,
                200,
                json!({
                    "data": {
                        "metadata": {
                            "trace": "prefix AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA suffix"
                        }
                    }
                }),
            )
            .expect_err("wrapped bearer-shaped material must not bypass strict fields")
            .code,
            DiagnosticCode::InvalidResponse
        );
    }

    #[test]
    fn correct_operation_allows_credential_shaped_user_text() {
        let text =
            "A user pasted Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA into the chat.";
        let response = NativeResponse::snapshot(
            NativeResponseOperation::ListConversationMessages,
            200,
            json!({
                "data": {
                    "messages": [{
                        "id": "message-1",
                        "text": text
                    }]
                }
            }),
        )
        .expect("actual message text remains arbitrary user content");
        let rendered = serde_json::to_value(response).expect("snapshot should serialize");

        assert_eq!(rendered["payload"]["data"]["messages"][0]["text"], text);
    }

    #[test]
    fn diagnostics_use_the_frozen_platform_vocabulary() {
        let diagnostics = NativeDiagnostics::new(Vec::new());
        assert!(["darwin", "linux", "win32", "unsupported"].contains(&diagnostics.platform));
        assert!(["arm64", "x64", "unsupported"].contains(&diagnostics.architecture));
    }
}
