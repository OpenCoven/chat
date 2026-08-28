use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use serde_json::Value;

const MAX_PUBLIC_NODES: usize = 4_096;
const MAX_PUBLIC_STRING_CHARACTERS: usize = 64 * 1_024;
const MAX_PUBLIC_DEPTH: usize = 64;

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
    pub fn new(status_code: u16, payload: Value) -> Result<Self, NativeError> {
        if !(100..=599).contains(&status_code) {
            return Err(NativeError::invalid_response());
        }
        validate_public_value(&payload)?;
        Ok(Self {
            status_code,
            payload,
        })
    }

    pub const fn status_code(&self) -> u16 {
        self.status_code
    }
}

fn sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key.contains("bearer")
        || key.contains("secret")
        || key == "prompt"
        || key == "message"
        || key.ends_with("_prompt")
        || key.ends_with("_message")
}

fn suspicious_secret_string(value: &str) -> bool {
    let lowercase = value.to_ascii_lowercase();
    lowercase.contains("bearer ")
        || lowercase.contains("pairing-secret")
        || (value.len() == 43
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')))
}

pub fn validate_public_value(value: &Value) -> Result<(), NativeError> {
    let mut stack = vec![(value, 0_usize)];
    let mut nodes = 0_usize;
    let mut string_characters = 0_usize;

    while let Some((candidate, depth)) = stack.pop() {
        nodes = nodes.saturating_add(1);
        if nodes > MAX_PUBLIC_NODES || depth > MAX_PUBLIC_DEPTH {
            return Err(NativeError::new(DiagnosticCode::BodyLimit, false));
        }

        match candidate {
            Value::Null | Value::Bool(_) | Value::Number(_) => {}
            Value::String(value) => {
                string_characters = string_characters.saturating_add(value.chars().count());
                if string_characters > MAX_PUBLIC_STRING_CHARACTERS
                    || suspicious_secret_string(value)
                {
                    return Err(NativeError::invalid_response());
                }
            }
            Value::Array(values) => {
                for value in values {
                    stack.push((value, depth + 1));
                }
            }
            Value::Object(entries) => {
                for (key, value) in entries {
                    if sensitive_key(key) {
                        return Err(NativeError::invalid_response());
                    }
                    string_characters = string_characters.saturating_add(key.chars().count());
                    if string_characters > MAX_PUBLIC_STRING_CHARACTERS {
                        return Err(NativeError::new(DiagnosticCode::BodyLimit, false));
                    }
                    stack.push((value, depth + 1));
                }
            }
        }
    }

    Ok(())
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
    fn public_payloads_have_deterministic_complexity_bounds() {
        let payload = json!({
            "data": (0..4_096).map(|index| json!({"index": index})).collect::<Vec<_>>()
        });
        let error = NativeResponse::new(200, payload)
            .expect_err("oversized payload graphs must fail closed");
        assert_eq!(error.code, DiagnosticCode::BodyLimit);
    }

    #[test]
    fn diagnostics_use_the_frozen_platform_vocabulary() {
        let diagnostics = NativeDiagnostics::new(Vec::new());
        assert!(["darwin", "linux", "win32", "unsupported"].contains(&diagnostics.platform));
        assert!(["arm64", "x64", "unsupported"].contains(&diagnostics.architecture));
    }
}
