use std::collections::BTreeMap;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use uuid::{Uuid, Version};

use crate::metadata::APP_NAME;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const SAFE_ERROR_MESSAGE: &str = "Cave operation failed.";

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
    pub fn health(status_code: u16, payload: Value) -> Result<Self, NativeError> {
        operation_response::<HealthData>(
            status_code,
            payload,
            200,
            "health",
            "health.read",
            HealthData::validate,
        )
    }

    pub fn pairing_create(status_code: u16, payload: Value) -> Result<Self, NativeError> {
        operation_response::<PairingCreatedData>(
            status_code,
            payload,
            201,
            "pairing",
            "pairing.create",
            PairingCreatedData::validate,
        )
    }

    pub fn pairing_poll(status_code: u16, payload: Value) -> Result<Self, NativeError> {
        operation_response::<PairingStatusData>(
            status_code,
            payload,
            200,
            "pairing",
            "pairing.poll",
            PairingStatusData::validate,
        )
    }

    pub fn pairing_exchange(status_code: u16, payload: Value) -> Result<Self, NativeError> {
        operation_response::<PairingExchangeData>(
            status_code,
            payload,
            200,
            "pairing",
            "pairing.exchange",
            PairingExchangeData::validate,
        )
    }

    pub fn list_familiars(status_code: u16, payload: Value) -> Result<Self, NativeError> {
        canonical_operation_response::<CanonicalFamiliarsData>(
            status_code,
            payload,
            "familiars",
            "familiars.list",
            CanonicalFamiliarsData::validate,
        )
    }

    pub fn list_projects(status_code: u16, payload: Value) -> Result<Self, NativeError> {
        canonical_operation_response::<CanonicalProjectsData>(
            status_code,
            payload,
            "projects",
            "projects.list",
            CanonicalProjectsData::validate,
        )
    }

    pub fn list_conversations(status_code: u16, payload: Value) -> Result<Self, NativeError> {
        canonical_operation_response::<CanonicalConversationsData>(
            status_code,
            payload,
            "conversations",
            "conversations.list",
            CanonicalConversationsData::validate,
        )
    }

    pub fn get_conversation(status_code: u16, payload: Value) -> Result<Self, NativeError> {
        canonical_operation_response::<CanonicalConversationData>(
            status_code,
            payload,
            "conversations",
            "conversations.read",
            CanonicalConversationData::validate,
        )
    }

    pub fn list_conversation_messages(
        status_code: u16,
        payload: Value,
    ) -> Result<Self, NativeError> {
        canonical_operation_response::<CanonicalMessagesData>(
            status_code,
            payload,
            "conversation-messages",
            "messages.list",
            CanonicalMessagesData::validate,
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
    #[serde(default, deserialize_with = "deserialize_optional_non_null")]
    details: Option<BTreeMap<String, String>>,
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

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CanonicalCursor {
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null_string",
        skip_serializing_if = "Option::is_none"
    )]
    current: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null_string",
        skip_serializing_if = "Option::is_none"
    )]
    next: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null_string",
        skip_serializing_if = "Option::is_none"
    )]
    previous: Option<String>,
    has_more: bool,
}

impl CanonicalCursor {
    fn validate(&self) -> bool {
        self.current.as_deref().is_none_or(valid_cursor)
            && self.next.as_deref().is_none_or(valid_cursor)
            && self.previous.as_deref().is_none_or(valid_cursor)
            && (!self.has_more || self.next.is_some())
            && (self.current.is_none() || self.current != self.next)
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CanonicalSuccessEnvelope<T> {
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
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    cursor: Option<CanonicalCursor>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CanonicalFamiliar {
    id: String,
    display_name: String,
    role: String,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null_string",
        skip_serializing_if = "Option::is_none"
    )]
    description: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null_string",
        skip_serializing_if = "Option::is_none"
    )]
    pronouns: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null_string",
        skip_serializing_if = "Option::is_none"
    )]
    status: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null_string",
        skip_serializing_if = "Option::is_none"
    )]
    last_seen_at: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    active_sessions: Option<u64>,
}

impl CanonicalFamiliar {
    fn validate(&self) -> bool {
        valid_content(&self.id, 512)
            && valid_content(&self.display_name, 4_096)
            && valid_content(&self.role, 4_096)
            && self
                .description
                .as_deref()
                .is_none_or(|value| valid_content(value, 4_096))
            && self
                .pronouns
                .as_deref()
                .is_none_or(|value| valid_content(value, 4_096))
            && self
                .status
                .as_deref()
                .is_none_or(|value| valid_content(value, 4_096))
            && self
                .last_seen_at
                .as_deref()
                .is_none_or(|value| valid_content(value, 128))
            && self
                .active_sessions
                .is_none_or(|value| value <= MAX_SAFE_INTEGER)
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CanonicalProject {
    id: String,
    name: String,
    root: String,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null_string",
        skip_serializing_if = "Option::is_none"
    )]
    color: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null_string",
        skip_serializing_if = "Option::is_none"
    )]
    repo_url: Option<String>,
    created_at: String,
    updated_at: String,
}

impl CanonicalProject {
    fn validate(&self) -> bool {
        valid_content(&self.id, 512)
            && valid_content(&self.name, 4_096)
            && valid_content(&self.root, 4_096)
            && self
                .color
                .as_deref()
                .is_none_or(|value| valid_content(value, 128))
            && self
                .repo_url
                .as_deref()
                .is_none_or(|value| valid_content(value, 4_096))
            && valid_content(&self.created_at, 128)
            && valid_content(&self.updated_at, 128)
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CanonicalConversation {
    id: String,
    familiar_id: String,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null_string",
        skip_serializing_if = "Option::is_none"
    )]
    harness: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null_string",
        skip_serializing_if = "Option::is_none"
    )]
    model: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null_string",
        skip_serializing_if = "Option::is_none"
    )]
    runtime: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null_string",
        skip_serializing_if = "Option::is_none"
    )]
    title: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null_string",
        skip_serializing_if = "Option::is_none"
    )]
    origin: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null_string",
        skip_serializing_if = "Option::is_none"
    )]
    status: Option<String>,
    #[serde(default, skip_serializing_if = "OptionalNullable::is_absent")]
    exit_code: OptionalNullable<i64>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pending: Option<bool>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null_string",
        skip_serializing_if = "Option::is_none"
    )]
    created_at: Option<String>,
    updated_at: String,
}

impl CanonicalConversation {
    fn validate(&self) -> bool {
        valid_content(&self.id, 512)
            && valid_content(&self.familiar_id, 512)
            && [
                self.harness.as_deref(),
                self.model.as_deref(),
                self.runtime.as_deref(),
                self.title.as_deref(),
                self.origin.as_deref(),
                self.status.as_deref(),
            ]
            .into_iter()
            .all(|value| value.is_none_or(|value| valid_content(value, 4_096)))
            && self
                .exit_code
                .value
                .is_none_or(|value| value.unsigned_abs() <= MAX_SAFE_INTEGER)
            && self
                .created_at
                .as_deref()
                .is_none_or(|value| valid_content(value, 128))
            && valid_content(&self.updated_at, 128)
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CanonicalMessage {
    id: String,
    conversation_id: String,
    parent_id: RequiredNullable<String>,
    role: String,
    text: String,
    created_at: String,
    attachment_count: u64,
    tool_count: u64,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    is_error: Option<bool>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    cancelled: Option<bool>,
}

impl CanonicalMessage {
    fn validate(&self) -> bool {
        valid_content(&self.id, 512)
            && valid_content(&self.conversation_id, 512)
            && self
                .parent_id
                .0
                .as_deref()
                .is_none_or(|value| valid_content(value, 512))
            && valid_content(&self.role, 128)
            && !self.text.contains('\0')
            && self.text.chars().count() <= 64 * 1024
            && valid_content(&self.created_at, 128)
            && self.attachment_count <= MAX_SAFE_INTEGER
            && self.tool_count <= MAX_SAFE_INTEGER
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CanonicalFamiliarsData {
    familiars: Vec<CanonicalFamiliar>,
}

impl CanonicalFamiliarsData {
    fn validate(&self) -> bool {
        self.familiars.len() <= 100 && self.familiars.iter().all(CanonicalFamiliar::validate)
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CanonicalProjectsData {
    projects: Vec<CanonicalProject>,
}

impl CanonicalProjectsData {
    fn validate(&self) -> bool {
        self.projects.len() <= 100 && self.projects.iter().all(CanonicalProject::validate)
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CanonicalConversationsData {
    conversations: Vec<CanonicalConversation>,
}

impl CanonicalConversationsData {
    fn validate(&self) -> bool {
        self.conversations.len() <= 100
            && self
                .conversations
                .iter()
                .all(CanonicalConversation::validate)
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CanonicalConversationData {
    conversation: CanonicalConversation,
}

impl CanonicalConversationData {
    fn validate(&self) -> bool {
        self.conversation.validate()
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CanonicalMessagesData {
    messages: Vec<CanonicalMessage>,
}

impl CanonicalMessagesData {
    fn validate(&self) -> bool {
        self.messages.len() <= 100 && self.messages.iter().all(CanonicalMessage::validate)
    }
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

struct OptionalNullable<T> {
    present: bool,
    value: Option<T>,
}

impl<T> OptionalNullable<T> {
    fn is_absent(&self) -> bool {
        !self.present
    }
}

impl<T> Default for OptionalNullable<T> {
    fn default() -> Self {
        Self {
            present: false,
            value: None,
        }
    }
}

impl<T> Serialize for OptionalNullable<T>
where
    T: Serialize,
{
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        self.value.serialize(serializer)
    }
}

impl<'de, T> Deserialize<'de> for OptionalNullable<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Ok(Self {
            present: true,
            value: Option::<T>::deserialize(deserializer)?,
        })
    }
}

fn deserialize_optional_non_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
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
    success_status: u16,
    required_capability: &str,
    required_operation: &str,
    validate_data: impl FnOnce(&T) -> bool,
) -> Result<NativeResponse, NativeError>
where
    T: DeserializeOwned + Serialize,
{
    if status_code == success_status {
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
    if (200..=299).contains(&status_code) {
        return Err(NativeError::invalid_response());
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
        || !valid_error_code(required_operation, status_code, &envelope.error.code)
        || envelope.error.message.is_empty()
        || envelope.error.message.chars().count() > 256
        || !valid_error_details(envelope.error.details.as_ref())
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

fn canonical_operation_response<T>(
    status_code: u16,
    payload: Value,
    required_capability: &str,
    required_operation: &str,
    validate_data: impl FnOnce(&T) -> bool,
) -> Result<NativeResponse, NativeError>
where
    T: DeserializeOwned + Serialize,
{
    if status_code == 200 {
        let envelope = serde_json::from_value::<CanonicalSuccessEnvelope<T>>(payload)
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
            || !envelope
                .cursor
                .as_ref()
                .is_none_or(CanonicalCursor::validate)
        {
            return Err(NativeError::invalid_response());
        }
        return safe_response(status_code, &envelope);
    }
    if (200..=299).contains(&status_code) || !(400..=599).contains(&status_code) {
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
        || !valid_error_code(required_operation, status_code, &envelope.error.code)
        || envelope.error.message.is_empty()
        || envelope.error.message.chars().count() > 256
        || !valid_error_details(envelope.error.details.as_ref())
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
    let lowercase = value.to_ascii_lowercase();
    if value.is_empty()
        || value.len() > 64
        || value
            .bytes()
            .any(|byte| !byte.is_ascii_alphanumeric() && !matches!(byte, b'.' | b'_' | b':' | b'-'))
        || lowercase.contains("bearer")
        || lowercase.contains("secret")
    {
        return false;
    }
    value.len() != 43
        || value
            .bytes()
            .any(|byte| !byte.is_ascii_alphanumeric() && !matches!(byte, b'_' | b'-'))
}

fn valid_cursor(value: &str) -> bool {
    if value.is_empty()
        || value.len() > 512
        || value
            .bytes()
            .any(|byte| !byte.is_ascii_alphanumeric() && !matches!(byte, b'_' | b'-'))
    {
        return false;
    }
    match value.len() % 4 {
        0 => true,
        2 => value
            .bytes()
            .last()
            .and_then(base64url_value)
            .is_some_and(|value| value % 16 == 0),
        3 => value
            .bytes()
            .last()
            .and_then(base64url_value)
            .is_some_and(|value| value % 4 == 0),
        _ => false,
    }
}

fn base64url_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'-' => Some(62),
        b'_' => Some(63),
        _ => None,
    }
}

fn valid_content(value: &str, maximum_characters: usize) -> bool {
    !value.is_empty() && !value.contains('\0') && value.chars().count() <= maximum_characters
}

fn valid_error_details(details: Option<&BTreeMap<String, String>>) -> bool {
    details.is_none_or(|details| {
        details.len() <= 16
            && details.iter().all(|(key, value)| {
                valid_content(key, 64)
                    && !key.chars().any(char::is_control)
                    && value.chars().count() <= 256
                    && !value.chars().any(char::is_control)
            })
    })
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

fn valid_error_code(operation: &str, status_code: u16, code: &str) -> bool {
    match (operation, code) {
        ("health.read", _) => false,
        ("pairing.create", "unauthorized") => status_code == 401,
        ("pairing.create", "rate_limited") => status_code == 429,
        ("pairing.create", "invalid_request") => status_code == 400,
        ("pairing.poll", "unauthorized") => status_code == 401,
        ("pairing.poll", "rate_limited") => status_code == 429,
        ("pairing.poll", "not_found") => status_code == 404,
        ("pairing.poll", "conflict") => status_code == 409,
        ("pairing.exchange", "unauthorized") => status_code == 401,
        ("pairing.exchange", "not_found") => status_code == 404,
        ("pairing.exchange", "pairing_pending" | "conflict") => status_code == 409,
        ("pairing.exchange", "pairing_denied") => status_code == 403,
        ("pairing.exchange", "pairing_expired") => status_code == 410,
        ("pairing.exchange", "rate_limited") => status_code == 429,
        ("pairing.exchange", "internal_error") => status_code == 500,
        (
            "familiars.list" | "projects.list" | "conversations.list" | "conversations.read"
            | "messages.list",
            "invalid_request",
        ) => status_code == 400,
        (
            "familiars.list" | "projects.list" | "conversations.list" | "conversations.read"
            | "messages.list",
            "unauthorized",
        ) => status_code == 401,
        (
            "familiars.list" | "projects.list" | "conversations.list" | "conversations.read"
            | "messages.list",
            "scope_denied",
        ) => status_code == 403,
        ("conversations.read" | "messages.list", "not_found") => status_code == 404,
        (
            "familiars.list" | "projects.list" | "conversations.list" | "conversations.read"
            | "messages.list",
            "conflict" | "reconcile_required",
        ) => status_code == 409,
        (
            "familiars.list" | "projects.list" | "conversations.list" | "conversations.read"
            | "messages.list",
            "rate_limited",
        ) => status_code == 429,
        (
            "familiars.list" | "projects.list" | "conversations.list" | "conversations.read"
            | "messages.list",
            "internal_error",
        ) => status_code == 500,
        (
            "familiars.list" | "projects.list" | "conversations.list" | "conversations.read"
            | "messages.list",
            "service_unavailable",
        ) => status_code == 503,
        _ => false,
    }
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
        DiagnosticCode, NativeDiagnostics, NativeError, NativeResponse, SAFE_ERROR_MESSAGE,
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
    fn canonical_read_responses_preserve_exact_public_dtos() {
        let response = NativeResponse::list_conversations(
            200,
            json!({
                "apiVersion": "1.0",
                "minimumClientVersion": "0.1.0",
                "capabilities": ["conversations", "cursors"],
                "operations": ["conversations.list"],
                "data": {
                    "conversations": [{
                        "id": "conversation-1",
                        "familiarId": "familiar-1",
                        "title": "Canonical title",
                        "updatedAt": "2026-08-28T11:00:00Z"
                    }]
                },
                "cursor": {
                    "current": "YQ",
                    "next": "Yg",
                    "hasMore": true
                }
            }),
        )
        .expect("canonical response should validate");
        let rendered = serde_json::to_value(response).expect("response should serialize");

        assert_eq!(
            rendered["payload"]["data"]["conversations"][0]["id"],
            "conversation-1"
        );
        assert_eq!(rendered["payload"]["cursor"]["next"], "Yg");
        assert!(!rendered.to_string().contains("bearer"));
        assert!(!rendered.to_string().contains("secret"));
    }

    #[test]
    fn canonical_read_responses_reject_unknown_fields_and_cursor_cycles() {
        let unknown = NativeResponse::list_projects(
            200,
            json!({
                "apiVersion": "1.0",
                "minimumClientVersion": "0.1.0",
                "capabilities": ["projects", "cursors"],
                "operations": ["projects.list"],
                "data": {
                    "projects": [{
                        "id": "project-1",
                        "name": "OpenCoven",
                        "root": "OpenCoven",
                        "createdAt": "2026-08-28T10:00:00Z",
                        "updatedAt": "2026-08-28T11:00:00Z",
                        "privatePath": "/Users/person/private"
                    }]
                }
            }),
        )
        .expect_err("unknown project fields must fail closed");
        assert_eq!(unknown.code, DiagnosticCode::InvalidResponse);

        let cycle = NativeResponse::list_familiars(
            200,
            json!({
                "apiVersion": "1.0",
                "minimumClientVersion": "0.1.0",
                "capabilities": ["familiars", "cursors"],
                "operations": ["familiars.list"],
                "data": {"familiars": []},
                "cursor": {"current": "YQ", "next": "YQ", "hasMore": true}
            }),
        )
        .expect_err("a response-local cursor cycle must fail closed");
        assert_eq!(cycle.code, DiagnosticCode::InvalidResponse);
    }

    #[test]
    fn all_canonical_read_shapes_are_operation_specific() {
        NativeResponse::get_conversation(
            200,
            json!({
                "apiVersion": "1.0",
                "minimumClientVersion": "0.1.0",
                "capabilities": ["conversations"],
                "operations": ["conversations.read"],
                "data": {
                    "conversation": {
                        "id": "conversation-1",
                        "familiarId": "familiar-1",
                        "updatedAt": "2026-08-28T11:00:00Z"
                    }
                }
            }),
        )
        .expect("conversation detail should validate");
        NativeResponse::list_conversation_messages(
            200,
            json!({
                "apiVersion": "1.0",
                "minimumClientVersion": "0.1.0",
                "capabilities": ["conversation-messages", "cursors"],
                "operations": ["messages.list"],
                "data": {
                    "messages": [{
                        "id": "message-1",
                        "conversationId": "conversation-1",
                        "parentId": null,
                        "role": "assistant",
                        "text": "Safe message body",
                        "createdAt": "2026-08-28T11:01:00Z",
                        "attachmentCount": 0,
                        "toolCount": 0
                    }]
                }
            }),
        )
        .expect("message page should validate");
    }

    #[test]
    fn canonical_optional_fields_reject_null_but_preserve_nullable_exit_codes() {
        let null_title = NativeResponse::list_conversations(
            200,
            json!({
                "apiVersion": "1.0",
                "minimumClientVersion": "0.1.0",
                "capabilities": ["conversations", "cursors"],
                "operations": ["conversations.list"],
                "data": {
                    "conversations": [{
                        "id": "conversation-1",
                        "familiarId": "familiar-1",
                        "title": null,
                        "updatedAt": "2026-08-28T11:00:00Z"
                    }]
                }
            }),
        )
        .expect_err("optional strings must reject explicit null");
        assert_eq!(null_title.code, DiagnosticCode::InvalidResponse);

        let nullable_exit = NativeResponse::get_conversation(
            200,
            json!({
                "apiVersion": "1.0",
                "minimumClientVersion": "0.1.0",
                "capabilities": ["conversations"],
                "operations": ["conversations.read"],
                "data": {
                    "conversation": {
                        "id": "conversation-1",
                        "familiarId": "familiar-1",
                        "exitCode": null,
                        "updatedAt": "2026-08-28T11:00:00Z"
                    }
                }
            }),
        )
        .expect("nullable exit code should validate");
        let rendered = serde_json::to_value(nullable_exit).expect("response should serialize");
        assert!(rendered["payload"]["data"]["conversation"]
            .as_object()
            .expect("conversation object")
            .contains_key("exitCode"));
        assert!(rendered["payload"]["data"]["conversation"]["exitCode"].is_null());
    }

    #[test]
    fn reconcile_details_are_validated_then_removed_from_command_output() {
        let response = NativeResponse::list_conversation_messages(
            409,
            json!({
                "apiVersion": "1.0",
                "minimumClientVersion": "0.1.0",
                "capabilities": ["conversation-messages", "cursors"],
                "operations": ["messages.list"],
                "error": {
                    "code": "reconcile_required",
                    "message": "Reload canonical state.",
                    "retryable": false,
                    "details": {
                        "reason": "resume_from_canonical_state"
                    }
                }
            }),
        )
        .expect("bounded reconcile details should validate");
        let rendered = serde_json::to_value(response).expect("response should serialize");

        assert_eq!(rendered["payload"]["error"]["code"], "reconcile_required");
        assert!(rendered["payload"]["error"].get("details").is_none());
        assert_eq!(rendered["payload"]["error"]["message"], SAFE_ERROR_MESSAGE);
    }

    #[test]
    fn diagnostics_use_the_frozen_platform_vocabulary() {
        let diagnostics = NativeDiagnostics::new(Vec::new());
        assert!(["darwin", "linux", "win32", "unsupported"].contains(&diagnostics.platform));
        assert!(["arm64", "x64", "unsupported"].contains(&diagnostics.architecture));
    }
}
