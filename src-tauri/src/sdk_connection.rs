use std::{
    collections::HashSet,
    fmt::Write as _,
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicU64, Ordering as AtomicOrdering},
        Arc, Condvar, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    cave_credentials::{
        CredentialCustody, CredentialDeleteResult, CredentialLookup, CredentialRecord,
        CredentialStoreAvailability, KeyringCredentialCustody, PreparedCredential, SecretValue,
    },
    metadata::{APP_IDENTIFIER, APP_NAME},
    sdk_diagnostics::{
        validate_public_snapshot, DiagnosticCode, NativeDiagnostics, NativeError, NativeResponse,
        NativeResponseOperation, SecurityCheck, SecurityComponent, SecurityStatus,
    },
};

const HPKE_KEY_ID_DOMAIN: &[u8] = b"OpenCoven/client-v1/hpke-bound-v1/key-id\0";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_REQUEST_ID_CHARACTERS: usize = 128;
const MAX_HANDLE_CHARACTERS: usize = 128;
const MAX_RETAINED_DISCOVERIES: usize = 64;
const MAX_RETAINED_PAIRINGS: usize = 64;
const MAX_RETAINED_CREDENTIALS: usize = 64;
const DISCOVERY_TTL_MILLIS: u64 = 30 * 1_000;
const PENDING_CREDENTIAL_TTL_MILLIS: u64 = 5 * 60 * 1_000;
const TERMINAL_CREDENTIAL_TTL_MILLIS: u64 = 5 * 60 * 1_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorityEndpoint {
    kind: String,
    url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorityFreshness {
    pid: u32,
    nonce: String,
    started_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorityRecord {
    identity: String,
    device: u64,
    inode: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthoritySuite {
    kem_id: u16,
    kdf_id: u16,
    aead_id: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorityHpke {
    mechanism: String,
    mode: String,
    key_id: String,
    public_key: String,
    suite: AuthoritySuite,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorityDescriptor {
    version: u8,
    endpoint: AuthorityEndpoint,
    freshness: AuthorityFreshness,
    record: AuthorityRecord,
    authority: AuthorityHpke,
    instance_id: String,
}

impl AuthorityDescriptor {
    pub fn from_json(value: Value) -> Result<Self, NativeError> {
        let descriptor =
            serde_json::from_value::<Self>(value).map_err(|_| NativeError::invalid_request())?;
        descriptor.validate()?;
        Ok(descriptor)
    }

    fn validate(&self) -> Result<(), NativeError> {
        if self.version != 2
            || self.endpoint.kind != "http"
            || !valid_loopback_url(&self.endpoint.url)
        {
            return Err(NativeError::new(DiagnosticCode::UnsafeEndpoint, false));
        }
        let instance_id =
            Uuid::parse_str(&self.instance_id).map_err(|_| NativeError::invalid_request())?;
        if instance_id.to_string() != self.instance_id
            || self.freshness.pid == 0
            || !valid_base64url_32(&self.freshness.nonce)
            || !valid_timestamp_shape(&self.freshness.started_at)
            || !valid_record_identity(&self.record.identity)
            || self.record.device > MAX_SAFE_INTEGER
            || self.record.inode > MAX_SAFE_INTEGER
            || self.authority.mechanism != "hpke-bound-v1"
            || (self.authority.mode != "advertise" && self.authority.mode != "enforce")
            || self.authority.suite.kem_id != 32
            || self.authority.suite.kdf_id != 1
            || self.authority.suite.aead_id != 2
            || !valid_base64url_32(&self.authority.public_key)
            || !valid_base64url_32(&self.authority.key_id)
            || !authority_key_id_matches(&self.authority.public_key, &self.authority.key_id)
        {
            return Err(NativeError::invalid_request());
        }
        Ok(())
    }

    pub fn endpoint_url(&self) -> &str {
        &self.endpoint.url
    }

    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }

    pub fn runtime_nonce(&self) -> &str {
        &self.freshness.nonce
    }

    pub fn authority_key_id(&self) -> &str {
        &self.authority.key_id
    }

    pub fn authority_public_key(&self) -> &str {
        &self.authority.public_key
    }

    fn fingerprint(&self) -> Result<String, NativeError> {
        let bytes = serde_json::to_vec(self).map_err(|_| NativeError::invalid_request())?;
        let digest = Sha256::digest(bytes);
        let mut rendered = String::with_capacity(71);
        rendered.push_str("sha256:");
        for byte in digest {
            write!(rendered, "{byte:02x}").map_err(|_| NativeError::service_unavailable())?;
        }
        Ok(rendered)
    }

    fn binding(&self) -> CaveAuthorityBinding {
        CaveAuthorityBinding {
            version: 1,
            instance_id: self.instance_id.clone(),
            endpoint: CaveAuthorityBindingEndpoint {
                kind: "http",
                url: self.endpoint.url.clone(),
            },
            record: CaveAuthorityBindingRecord {
                identity: self.record.identity.clone(),
                device: self.record.device,
                inode: self.record.inode,
            },
            freshness: CaveAuthorityBindingFreshness {
                pid: self.freshness.pid,
                nonce: self.freshness.nonce.clone(),
                started_at: self.freshness.started_at.clone(),
            },
        }
    }

    fn managed_snapshot(&self) -> Result<ManagedDiscoverySnapshot, NativeError> {
        let bytes = serde_json::to_string(&serde_json::json!({
            "version": self.version,
            "endpoint": self.endpoint.url,
            "pid": self.freshness.pid,
            "nonce": self.freshness.nonce,
            "startedAt": self.freshness.started_at,
            "authority": {
                "mechanism": self.authority.mechanism,
                "mode": self.authority.mode,
                "keyId": self.authority.key_id,
                "publicKey": self.authority.public_key,
                "suite": {
                    "kemId": self.authority.suite.kem_id,
                    "kdfId": self.authority.suite.kdf_id,
                    "aeadId": self.authority.suite.aead_id,
                }
            }
        }))
        .map_err(|_| NativeError::invalid_response())?;
        Ok(ManagedDiscoverySnapshot {
            bytes,
            record: ManagedDiscoveryRecord {
                identity: self.record.identity.clone(),
                device: self.record.device,
                inode: self.record.inode,
                process_alive: true,
            },
        })
    }
}

fn valid_loopback_url(value: &str) -> bool {
    if value.len() > 128 || value.chars().any(char::is_control) {
        return false;
    }
    let Some(authority) = value.strip_prefix("http://") else {
        return false;
    };
    let authority = authority.strip_suffix('/').unwrap_or(authority);
    if authority.contains(['/', '?', '#', '@', '\\']) {
        return false;
    }
    let Some((host, port)) = authority.rsplit_once(':') else {
        return false;
    };
    if host != "127.0.0.1" && host != "localhost" && host != "[::1]" {
        return false;
    }
    port.parse::<u16>().is_ok_and(|port| port > 0)
}

fn valid_base64url_32(value: &str) -> bool {
    if value.len() != 43 || value.contains('=') {
        return false;
    }
    URL_SAFE_NO_PAD
        .decode(value)
        .is_ok_and(|decoded| decoded.len() == 32 && URL_SAFE_NO_PAD.encode(decoded) == value)
}

fn authority_key_id_matches(public_key: &str, key_id: &str) -> bool {
    let Ok(public_key) = URL_SAFE_NO_PAD.decode(public_key) else {
        return false;
    };
    let mut digest = Sha256::new();
    digest.update(HPKE_KEY_ID_DOMAIN);
    digest.update(public_key);
    URL_SAFE_NO_PAD.encode(digest.finalize()) == key_id
}

fn valid_timestamp_shape(value: &str) -> bool {
    if !(20..=35).contains(&value.len()) || !value.is_ascii() {
        return false;
    }
    let bytes = value.as_bytes();
    if bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
    {
        return false;
    }
    let parse = |start: usize, end: usize| {
        value
            .get(start..end)
            .filter(|part| part.bytes().all(|byte| byte.is_ascii_digit()))
            .and_then(|part| part.parse::<u32>().ok())
    };
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) = (
        parse(0, 4),
        parse(5, 7),
        parse(8, 10),
        parse(11, 13),
        parse(14, 16),
        parse(17, 19),
    ) else {
        return false;
    };
    let leap_year =
        year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let days = [
        31,
        if leap_year { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if month == 0
        || month > 12
        || day == 0
        || day > days[(month - 1) as usize]
        || hour > 23
        || minute > 59
        || second > 59
    {
        return false;
    }

    let mut suffix = &value[19..];
    if let Some(fraction) = suffix.strip_prefix('.') {
        let digit_count = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if digit_count == 0 || digit_count > 9 {
            return false;
        }
        suffix = &fraction[digit_count..];
    }
    if suffix == "Z" {
        return true;
    }
    if suffix.len() != 6
        || !matches!(suffix.as_bytes()[0], b'+' | b'-')
        || suffix.as_bytes()[3] != b':'
    {
        return false;
    }
    let Some(offset_hour) = suffix[1..3].parse::<u8>().ok() else {
        return false;
    };
    let Some(offset_minute) = suffix[4..6].parse::<u8>().ok() else {
        return false;
    };
    offset_hour <= 23 && offset_minute <= 59
}

fn valid_record_identity(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorityReference {
    pub handle: String,
    pub generation: u64,
}

impl AuthorityReference {
    fn validate(&self) -> Result<(), NativeError> {
        let Some(uuid) = self.handle.strip_prefix("authority:") else {
            return Err(NativeError::invalid_request());
        };
        if self.handle.len() > MAX_HANDLE_CHARACTERS
            || Uuid::parse_str(uuid).is_err()
            || self.generation == 0
        {
            return Err(NativeError::invalid_request());
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct RequestLease {
    authority: AuthorityReference,
    request_id: String,
}

#[derive(Debug, Clone)]
struct ActiveAuthority {
    reference: AuthorityReference,
    descriptor: AuthorityDescriptor,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AuthorityContext {
    generation: u64,
    active: Option<AuthorityReference>,
}

#[derive(Default)]
struct LifecycleState {
    generation: u64,
    active: Option<ActiveAuthority>,
    requests: HashSet<(u64, String)>,
}

impl LifecycleState {
    fn context(&self) -> AuthorityContext {
        AuthorityContext {
            generation: self.generation,
            active: self.active.as_ref().map(|active| active.reference.clone()),
        }
    }
}

#[derive(Default)]
pub struct AuthorityLifecycle {
    state: Mutex<LifecycleState>,
}

impl AuthorityLifecycle {
    pub fn replace(
        &self,
        descriptor: AuthorityDescriptor,
    ) -> Result<AuthorityReference, NativeError> {
        descriptor.validate()?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| NativeError::service_unavailable())?;
        Self::replace_locked(&mut state, descriptor)
    }

    fn replace_locked(
        state: &mut LifecycleState,
        descriptor: AuthorityDescriptor,
    ) -> Result<AuthorityReference, NativeError> {
        state.generation = state
            .generation
            .checked_add(1)
            .ok_or_else(|| NativeError::new(DiagnosticCode::Conflict, false))?;
        let reference = AuthorityReference {
            handle: format!("authority:{}", Uuid::new_v4()),
            generation: state.generation,
        };
        state.active = Some(ActiveAuthority {
            reference: reference.clone(),
            descriptor,
        });
        state.requests.clear();
        Ok(reference)
    }

    fn replace_if_context(
        &self,
        descriptor: AuthorityDescriptor,
        expected: &AuthorityContext,
    ) -> Result<AuthorityReference, NativeError> {
        descriptor.validate()?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| NativeError::service_unavailable())?;
        if state.context() != *expected {
            return Err(NativeError::reconcile_required());
        }
        Self::replace_locked(&mut state, descriptor)
    }

    fn context(&self) -> Result<AuthorityContext, NativeError> {
        let state = self
            .state
            .lock()
            .map_err(|_| NativeError::service_unavailable())?;
        Ok(state.context())
    }

    pub fn close(&self, reference: &AuthorityReference) -> Result<bool, NativeError> {
        reference.validate()?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| NativeError::service_unavailable())?;
        let Some(active) = state.active.as_ref() else {
            return Ok(false);
        };
        if active.reference != *reference {
            return Err(NativeError::reconcile_required());
        }
        state.active = None;
        state.requests.clear();
        Ok(true)
    }

    fn validate_request(&self, request: &RequestLease) -> Result<(), NativeError> {
        let state = self
            .state
            .lock()
            .map_err(|_| NativeError::service_unavailable())?;
        let key = (request.authority.generation, request.request_id.clone());
        if state.active.as_ref().map(|active| &active.reference) != Some(&request.authority)
            || !state.requests.contains(&key)
        {
            return Err(NativeError::reconcile_required());
        }
        Ok(())
    }

    pub fn begin_request(
        &self,
        authority: &AuthorityReference,
        request_id: &str,
    ) -> Result<RequestLease, NativeError> {
        authority.validate()?;
        validate_request_id(request_id)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| NativeError::service_unavailable())?;
        if state.active.as_ref().map(|active| &active.reference) != Some(authority) {
            return Err(NativeError::reconcile_required());
        }
        if !state
            .requests
            .insert((authority.generation, request_id.to_owned()))
        {
            return Err(NativeError::new(DiagnosticCode::OperationInProgress, true));
        }
        Ok(RequestLease {
            authority: authority.clone(),
            request_id: request_id.to_owned(),
        })
    }

    pub fn finish_request(&self, request: &RequestLease) -> Result<(), NativeError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| NativeError::service_unavailable())?;
        if state.active.as_ref().map(|active| &active.reference) != Some(&request.authority) {
            return Err(NativeError::reconcile_required());
        }
        if !state
            .requests
            .remove(&(request.authority.generation, request.request_id.clone()))
        {
            return Err(NativeError::reconcile_required());
        }
        Ok(())
    }

    fn cancel_request(&self, request: &RequestLease) {
        if let Ok(mut state) = self.state.lock() {
            state
                .requests
                .remove(&(request.authority.generation, request.request_id.clone()));
        }
    }

    fn descriptor(
        &self,
        authority: &AuthorityReference,
    ) -> Result<AuthorityDescriptor, NativeError> {
        authority.validate()?;
        let state = self
            .state
            .lock()
            .map_err(|_| NativeError::service_unavailable())?;
        match state.active.as_ref() {
            Some(active) if active.reference == *authority => Ok(active.descriptor.clone()),
            _ => Err(NativeError::reconcile_required()),
        }
    }
}

fn validate_request_id(value: &str) -> Result<(), NativeError> {
    let lowercase = value.to_ascii_lowercase();
    if value.is_empty()
        || value.len() > MAX_REQUEST_ID_CHARACTERS
        || value
            .bytes()
            .any(|byte| !byte.is_ascii_alphanumeric() && !matches!(byte, b'.' | b'_' | b':' | b'-'))
        || lowercase.contains("bearer")
        || lowercase.contains("secret")
        || (value.len() == 43
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')))
    {
        return Err(NativeError::invalid_request());
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HealthCommandInput {
    pub authority: AuthorityReference,
    pub request_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloseAuthorityInput {
    pub authority: AuthorityReference,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairingRequest {
    app_name: String,
    installation_id: String,
    scopes: Vec<String>,
}

impl PairingRequest {
    fn validate(&self, installation_id: &str) -> Result<(), NativeError> {
        if self.app_name != APP_NAME
            || self.installation_id != installation_id
            || self.scopes != ["chat:read"]
        {
            return Err(NativeError::invalid_request());
        }
        Ok(())
    }

    pub fn app_name(&self) -> &str {
        &self.app_name
    }

    pub fn installation_id(&self) -> &str {
        &self.installation_id
    }

    pub fn scopes(&self) -> &[String] {
        &self.scopes
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairingCreateCommandInput {
    pub authority: AuthorityReference,
    pub request_id: String,
    pub request: PairingRequest,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairingHandleCommandInput {
    pub authority: AuthorityReference,
    pub request_id: String,
    pub pairing_handle: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedPairingCommandInput {
    pub authority: AuthorityReference,
    pub request_id: String,
    pub pairing_request_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitHandleCommandInput {
    pub authority: AuthorityReference,
    pub request_id: String,
    pub commit_handle: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialCommandInput {
    pub authority: AuthorityReference,
    pub request_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalPageOptions {
    pub limit: u16,
    #[serde(default, deserialize_with = "deserialize_optional_non_null_string")]
    pub cursor: Option<String>,
}

impl CanonicalPageOptions {
    fn validate(&self) -> Result<(), NativeError> {
        if self.limit == 0
            || self.limit > 100
            || self
                .cursor
                .as_deref()
                .is_some_and(|cursor| !valid_cursor(cursor))
        {
            return Err(NativeError::invalid_request());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalPageCommandInput {
    pub authority: AuthorityReference,
    pub request_id: String,
    pub options: CanonicalPageOptions,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationCommandInput {
    pub authority: AuthorityReference,
    pub request_id: String,
    pub conversation_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationPageCommandInput {
    pub authority: AuthorityReference,
    pub request_id: String,
    pub conversation_id: String,
    pub options: CanonicalPageOptions,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallationIdentity {
    pub installation_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityCloseResult {
    pub closed: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiscoveryHandleInput {
    pub discovery_handle: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryReadOutput {
    pub handle: String,
    pub snapshot: ManagedDiscoverySnapshot,
}

#[derive(Debug, Clone, Serialize)]
pub struct ManagedDiscoverySnapshot {
    pub bytes: String,
    pub record: ManagedDiscoveryRecord,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedDiscoveryRecord {
    pub identity: String,
    pub device: u64,
    pub inode: u64,
    pub process_alive: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult<T> {
    pub authority: AuthorityReference,
    pub request_id: String,
    pub result: T,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCreatedOutput {
    pub handle: String,
    pub request_id: String,
    pub expires_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingExchangeOutput {
    pub authority_binding: CaveAuthorityBinding,
    pub commit_handle: String,
    pub credential: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedPairingCreatedOutput {
    pub request_id: String,
    pub expires_at: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ManagedPairingExchangeOutput {
    pub credential: Value,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PairingDiscardResult {
    Absent,
    Changed,
    Deleted,
}

impl From<CredentialDeleteResult> for PairingDiscardResult {
    fn from(value: CredentialDeleteResult) -> Self {
        match value {
            CredentialDeleteResult::Absent => Self::Absent,
            CredentialDeleteResult::Changed => Self::Changed,
            CredentialDeleteResult::Deleted => Self::Deleted,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialState {
    Missing,
    Present,
    UpdateInProgress,
    Invalid,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStateOutput {
    pub status: CredentialState,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaveAuthorityBinding {
    version: u8,
    instance_id: String,
    endpoint: CaveAuthorityBindingEndpoint,
    record: CaveAuthorityBindingRecord,
    freshness: CaveAuthorityBindingFreshness,
}

#[derive(Debug, Clone, Serialize)]
struct CaveAuthorityBindingEndpoint {
    kind: &'static str,
    url: String,
}

#[derive(Debug, Clone, Serialize)]
struct CaveAuthorityBindingRecord {
    identity: String,
    device: u64,
    inode: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaveAuthorityBindingFreshness {
    pid: u32,
    nonce: String,
    started_at: String,
}

pub type ProviderFuture<T> = Pin<Box<dyn Future<Output = Result<T, NativeError>> + Send + 'static>>;

pub struct ProviderPairingCreated {
    pub remote_request_id: String,
    pub expires_at: u64,
    pub pairing_secret: SecretValue,
}

pub struct ProviderPairingExchange {
    pub bearer: SecretValue,
    pub credential: Value,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderCredentialMetadata {
    id: String,
    app_name: String,
    installation_id: String,
    scopes: Vec<String>,
    created_at: u64,
    last_used_at: Option<u64>,
    revoked_at: Option<u64>,
    revocation_reason: Option<String>,
}

const PROVIDER_CREDENTIAL_METADATA_FIELDS: &[&str] = &[
    "id",
    "appName",
    "installationId",
    "scopes",
    "createdAt",
    "lastUsedAt",
    "revokedAt",
    "revocationReason",
];

fn valid_credential_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    value.len() == 36
        && bytes.get(8) == Some(&b'-')
        && bytes.get(13) == Some(&b'-')
        && bytes.get(18) == Some(&b'-')
        && bytes.get(23) == Some(&b'-')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 8 | 13 | 18 | 23) || byte.is_ascii_hexdigit())
        && bytes
            .get(14)
            .is_some_and(|byte| (b'1'..=b'8').contains(byte))
        && bytes
            .get(19)
            .is_some_and(|byte| matches!(byte.to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b'))
}

fn valid_provider_scope(value: &str) -> bool {
    matches!(
        value,
        "chat:read"
            | "chat:write"
            | "conversations:write"
            | "attachments:write"
            | "tasks:write"
            | "github:write"
    )
}

fn validate_provider_credential_metadata(
    value: Value,
    expected_app_name: &str,
    expected_installation_id: &str,
    expected_scopes: &[String],
) -> Result<Value, NativeError> {
    let object = value
        .as_object()
        .ok_or_else(NativeError::invalid_response)?;
    if object.len() != PROVIDER_CREDENTIAL_METADATA_FIELDS.len()
        || PROVIDER_CREDENTIAL_METADATA_FIELDS
            .iter()
            .any(|field| !object.contains_key(*field))
    {
        return Err(NativeError::invalid_response());
    }
    let metadata = serde_json::from_value::<ProviderCredentialMetadata>(value)
        .map_err(|_| NativeError::invalid_response())?;
    let mut seen_scopes = HashSet::new();
    if !valid_credential_uuid(&metadata.id)
        || metadata.app_name != expected_app_name
        || metadata.installation_id != expected_installation_id
        || metadata.scopes != expected_scopes
        || metadata.scopes.is_empty()
        || metadata
            .scopes
            .iter()
            .any(|scope| !valid_provider_scope(scope) || !seen_scopes.insert(scope))
        || metadata.created_at > MAX_SAFE_INTEGER
        || metadata
            .last_used_at
            .is_some_and(|value| value > MAX_SAFE_INTEGER)
        || metadata.revoked_at.is_some()
        || metadata.revocation_reason.is_some()
    {
        return Err(NativeError::invalid_response());
    }
    serde_json::to_value(metadata).map_err(|_| NativeError::invalid_response())
}

pub trait ManagedNativeAuthorityProvider: Send + Sync {
    fn available(&self) -> bool;
    fn discover(&self) -> ProviderFuture<AuthorityDescriptor> {
        unavailable_future()
    }
    fn health(&self, authority: AuthorityDescriptor) -> ProviderFuture<NativeResponse>;
    fn pairing_create(
        &self,
        authority: AuthorityDescriptor,
        request: PairingRequest,
    ) -> ProviderFuture<ProviderPairingCreated>;
    fn pairing_poll(
        &self,
        authority: AuthorityDescriptor,
        remote_request_id: String,
        pairing_secret: SecretValue,
    ) -> ProviderFuture<Value>;
    fn pairing_exchange(
        &self,
        authority: AuthorityDescriptor,
        remote_request_id: String,
        pairing_secret: SecretValue,
    ) -> ProviderFuture<ProviderPairingExchange>;
    fn list_familiars(
        &self,
        _authority: AuthorityDescriptor,
        _bearer: SecretValue,
        _options: CanonicalPageOptions,
    ) -> ProviderFuture<NativeResponse> {
        unavailable_future()
    }
    fn list_projects(
        &self,
        _authority: AuthorityDescriptor,
        _bearer: SecretValue,
        _options: CanonicalPageOptions,
    ) -> ProviderFuture<NativeResponse> {
        unavailable_future()
    }
    fn list_conversations(
        &self,
        _authority: AuthorityDescriptor,
        _bearer: SecretValue,
        _options: CanonicalPageOptions,
    ) -> ProviderFuture<NativeResponse> {
        unavailable_future()
    }
    fn get_conversation(
        &self,
        _authority: AuthorityDescriptor,
        _bearer: SecretValue,
        _conversation_id: String,
    ) -> ProviderFuture<NativeResponse> {
        unavailable_future()
    }
    fn list_conversation_messages(
        &self,
        _authority: AuthorityDescriptor,
        _bearer: SecretValue,
        _conversation_id: String,
        _options: CanonicalPageOptions,
    ) -> ProviderFuture<NativeResponse> {
        unavailable_future()
    }
}

pub struct UnavailableManagedNativeAuthorityProvider;

fn unavailable_future<T>() -> ProviderFuture<T> {
    Box::pin(async { Err(NativeError::platform_security_unavailable()) })
}

impl ManagedNativeAuthorityProvider for UnavailableManagedNativeAuthorityProvider {
    fn available(&self) -> bool {
        false
    }

    fn discover(&self) -> ProviderFuture<AuthorityDescriptor> {
        unavailable_future()
    }

    fn health(&self, _authority: AuthorityDescriptor) -> ProviderFuture<NativeResponse> {
        unavailable_future()
    }

    fn pairing_create(
        &self,
        _authority: AuthorityDescriptor,
        _request: PairingRequest,
    ) -> ProviderFuture<ProviderPairingCreated> {
        unavailable_future()
    }

    fn pairing_poll(
        &self,
        _authority: AuthorityDescriptor,
        _remote_request_id: String,
        _pairing_secret: SecretValue,
    ) -> ProviderFuture<Value> {
        unavailable_future()
    }

    fn pairing_exchange(
        &self,
        _authority: AuthorityDescriptor,
        _remote_request_id: String,
        _pairing_secret: SecretValue,
    ) -> ProviderFuture<ProviderPairingExchange> {
        unavailable_future()
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PendingPairingStatus {
    Ready,
    Polling,
}

struct PendingPairing {
    authority: AuthorityReference,
    app_name: String,
    installation_id: String,
    scopes: Vec<String>,
    remote_request_id: String,
    pairing_secret: SecretValue,
    expires_at: u64,
    sequence: u64,
    status: PendingPairingStatus,
}

enum StagedCredentialState {
    Pending,
    Writing {
        discard_requested: bool,
    },
    Committed,
    RollbackNeeded {
        expected: PreparedCredential,
        completion_error: NativeError,
    },
    Discarding,
    Finished(CredentialDeleteResult),
    Failed(NativeError),
}

enum RecoverableCleanup {
    NotNeeded,
    Pending,
    Completed,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RecoverableCleanupMode {
    Observe,
    Invalidate,
}

enum StagedCredentialRetention {
    Pending(u64),
    Protected,
    Terminal(u64),
}

struct StagedCredential {
    authority: AuthorityReference,
    credential: PreparedCredential,
    staged_at: AtomicU64,
    terminal_at: AtomicU64,
    state: Mutex<StagedCredentialState>,
    completed: Condvar,
}

impl StagedCredential {
    fn new(authority: AuthorityReference, credential: PreparedCredential, staged_at: u64) -> Self {
        Self {
            authority,
            credential,
            staged_at: AtomicU64::new(staged_at),
            terminal_at: AtomicU64::new(0),
            state: Mutex::new(StagedCredentialState::Pending),
            completed: Condvar::new(),
        }
    }

    fn set_terminal_state(
        &self,
        state: &mut StagedCredentialState,
        terminal: StagedCredentialState,
    ) {
        let _ = self.terminal_at.compare_exchange(
            0,
            current_time_millis(),
            AtomicOrdering::Release,
            AtomicOrdering::Relaxed,
        );
        *state = terminal;
    }

    fn terminal_retained_at(&self) -> u64 {
        let retained_at = self.terminal_at.load(AtomicOrdering::Acquire);
        if retained_at != 0 {
            return retained_at;
        }
        let now = current_time_millis();
        match self.terminal_at.compare_exchange(
            0,
            now,
            AtomicOrdering::AcqRel,
            AtomicOrdering::Acquire,
        ) {
            Ok(_) => now,
            Err(retained_at) => retained_at,
        }
    }

    fn begin_write(&self) -> Result<PreparedCredential, NativeError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| NativeError::service_unavailable())?;
        match *state {
            StagedCredentialState::Pending => {
                *state = StagedCredentialState::Writing {
                    discard_requested: false,
                };
                Ok(self.credential.clone())
            }
            StagedCredentialState::Writing { .. } | StagedCredentialState::Discarding => {
                Err(NativeError::new(DiagnosticCode::OperationInProgress, true))
            }
            StagedCredentialState::Committed
            | StagedCredentialState::RollbackNeeded { .. }
            | StagedCredentialState::Finished(_)
            | StagedCredentialState::Failed(_) => Err(NativeError::reconcile_required()),
        }
    }

    fn resolve_rollback_before_commit(
        &self,
        custody: &dyn CredentialCustody,
    ) -> Result<Option<NativeError>, NativeError> {
        let rollback = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| NativeError::service_unavailable())?;
            match &mut *state {
                StagedCredentialState::RollbackNeeded {
                    expected,
                    completion_error,
                } => {
                    let rollback = (expected.clone(), completion_error.clone());
                    *state = StagedCredentialState::Discarding;
                    Some(rollback)
                }
                StagedCredentialState::Discarding | StagedCredentialState::Writing { .. } => {
                    return Err(NativeError::new(DiagnosticCode::OperationInProgress, true));
                }
                _ => None,
            }
        };
        let Some((expected, completion_error)) = rollback else {
            return Ok(None);
        };
        let result = custody.compare_delete_credential(&expected);
        let mut state = self
            .state
            .lock()
            .map_err(|_| NativeError::service_unavailable())?;
        match result {
            Ok(result) => {
                self.set_terminal_state(&mut state, StagedCredentialState::Finished(result));
                self.completed.notify_all();
                Ok(Some(completion_error))
            }
            Err(error) if error.code == DiagnosticCode::CredentialUpdateInProgress => {
                *state = StagedCredentialState::RollbackNeeded {
                    expected,
                    completion_error,
                };
                self.completed.notify_all();
                Err(error)
            }
            Err(_) => {
                let error = NativeError::secret_store_rollback_failed();
                self.set_terminal_state(&mut state, StagedCredentialState::Failed(error.clone()));
                self.completed.notify_all();
                Err(error)
            }
        }
    }

    fn finish_write(
        &self,
        custody: &dyn CredentialCustody,
        write_result: Result<(), NativeError>,
        lifecycle_error: Option<NativeError>,
    ) -> Result<(), NativeError> {
        if let Err(write_error) = write_result {
            if write_error.code == DiagnosticCode::CredentialUpdateInProgress {
                let mut state = self
                    .state
                    .lock()
                    .map_err(|_| NativeError::service_unavailable())?;
                if lifecycle_error.is_some() {
                    self.set_terminal_state(
                        &mut state,
                        StagedCredentialState::Finished(CredentialDeleteResult::Absent),
                    );
                } else {
                    self.staged_at
                        .store(current_time_millis(), AtomicOrdering::Release);
                    *state = StagedCredentialState::Pending;
                }
                self.completed.notify_all();
                return Err(lifecycle_error.unwrap_or(write_error));
            }
            let rollback = custody.compare_delete_credential(&self.credential);
            let mut state = self
                .state
                .lock()
                .map_err(|_| NativeError::service_unavailable())?;
            match rollback {
                Ok(result) => {
                    self.set_terminal_state(&mut state, StagedCredentialState::Finished(result));
                    self.completed.notify_all();
                    return Err(write_error);
                }
                Err(error) => {
                    if error.code == DiagnosticCode::CredentialUpdateInProgress {
                        *state = StagedCredentialState::RollbackNeeded {
                            expected: self.credential.clone(),
                            completion_error: write_error,
                        };
                        self.completed.notify_all();
                        return Err(error);
                    }
                    let error = NativeError::secret_store_rollback_failed();
                    self.set_terminal_state(
                        &mut state,
                        StagedCredentialState::Failed(error.clone()),
                    );
                    self.completed.notify_all();
                    return Err(error);
                }
            }
        }

        let rollback_error = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| NativeError::service_unavailable())?;
            let discard_requested = match *state {
                StagedCredentialState::Writing { discard_requested } => discard_requested,
                _ => return Err(NativeError::reconcile_required()),
            };
            if lifecycle_error.is_some() || discard_requested {
                *state = StagedCredentialState::Discarding;
                Some(
                    lifecycle_error
                        .clone()
                        .unwrap_or_else(NativeError::reconcile_required),
                )
            } else {
                self.set_terminal_state(&mut state, StagedCredentialState::Committed);
                self.completed.notify_all();
                None
            }
        };

        let Some(error) = rollback_error else {
            return Ok(());
        };
        let rollback = custody.compare_delete_credential(&self.credential);
        let mut state = self
            .state
            .lock()
            .map_err(|_| NativeError::service_unavailable())?;
        match rollback {
            Ok(result) => {
                self.set_terminal_state(&mut state, StagedCredentialState::Finished(result));
                self.completed.notify_all();
                Err(error)
            }
            Err(rollback_error)
                if rollback_error.code == DiagnosticCode::CredentialUpdateInProgress =>
            {
                *state = StagedCredentialState::RollbackNeeded {
                    expected: self.credential.clone(),
                    completion_error: error,
                };
                self.completed.notify_all();
                Err(rollback_error)
            }
            Err(_) => {
                let rollback_error = NativeError::secret_store_rollback_failed();
                self.set_terminal_state(
                    &mut state,
                    StagedCredentialState::Failed(rollback_error.clone()),
                );
                self.completed.notify_all();
                Err(rollback_error)
            }
        }
    }

    fn discard(
        &self,
        custody: &dyn CredentialCustody,
    ) -> Result<CredentialDeleteResult, NativeError> {
        loop {
            let mut state = self
                .state
                .lock()
                .map_err(|_| NativeError::service_unavailable())?;
            match &mut *state {
                StagedCredentialState::Pending => {
                    self.set_terminal_state(
                        &mut state,
                        StagedCredentialState::Finished(CredentialDeleteResult::Absent),
                    );
                    self.completed.notify_all();
                    return Ok(CredentialDeleteResult::Absent);
                }
                StagedCredentialState::Writing { discard_requested } => {
                    *discard_requested = true;
                    state = self
                        .completed
                        .wait(state)
                        .map_err(|_| NativeError::service_unavailable())?;
                    drop(state);
                }
                StagedCredentialState::Committed => {
                    *state = StagedCredentialState::Discarding;
                    drop(state);
                    let result = custody.compare_delete_credential(&self.credential);
                    let mut state = self
                        .state
                        .lock()
                        .map_err(|_| NativeError::service_unavailable())?;
                    match result {
                        Ok(result) => {
                            self.set_terminal_state(
                                &mut state,
                                StagedCredentialState::Finished(result),
                            );
                            self.completed.notify_all();
                            return Ok(result);
                        }
                        Err(error) => {
                            if error.code == DiagnosticCode::CredentialUpdateInProgress {
                                self.set_terminal_state(
                                    &mut state,
                                    StagedCredentialState::Committed,
                                );
                                self.completed.notify_all();
                                return Err(error);
                            }
                            self.set_terminal_state(
                                &mut state,
                                StagedCredentialState::Failed(error.clone()),
                            );
                            self.completed.notify_all();
                            return Err(error);
                        }
                    }
                }
                StagedCredentialState::RollbackNeeded {
                    expected,
                    completion_error,
                } => {
                    let expected = expected.clone();
                    let completion_error = completion_error.clone();
                    *state = StagedCredentialState::Discarding;
                    drop(state);
                    let result = custody.compare_delete_credential(&expected);
                    let mut state = self
                        .state
                        .lock()
                        .map_err(|_| NativeError::service_unavailable())?;
                    match result {
                        Ok(result) => {
                            self.set_terminal_state(
                                &mut state,
                                StagedCredentialState::Finished(result),
                            );
                            self.completed.notify_all();
                            return Ok(result);
                        }
                        Err(error) if error.code == DiagnosticCode::CredentialUpdateInProgress => {
                            *state = StagedCredentialState::RollbackNeeded {
                                expected,
                                completion_error,
                            };
                            self.completed.notify_all();
                            return Err(error);
                        }
                        Err(_) => {
                            let error = NativeError::secret_store_rollback_failed();
                            self.set_terminal_state(
                                &mut state,
                                StagedCredentialState::Failed(error.clone()),
                            );
                            self.completed.notify_all();
                            return Err(error);
                        }
                    }
                }
                StagedCredentialState::Discarding => {
                    state = self
                        .completed
                        .wait(state)
                        .map_err(|_| NativeError::service_unavailable())?;
                    drop(state);
                }
                StagedCredentialState::Finished(result) => return Ok(*result),
                StagedCredentialState::Failed(error) => return Err(error.clone()),
            }
        }
    }

    fn update_in_progress(&self) -> Result<bool, NativeError> {
        let state = self
            .state
            .lock()
            .map_err(|_| NativeError::service_unavailable())?;
        Ok(matches!(
            *state,
            StagedCredentialState::Pending
                | StagedCredentialState::Writing { .. }
                | StagedCredentialState::RollbackNeeded { .. }
                | StagedCredentialState::Discarding
        ))
    }

    fn requires_recoverable_cleanup(&self) -> Result<bool, NativeError> {
        let state = self
            .state
            .lock()
            .map_err(|_| NativeError::service_unavailable())?;
        Ok(matches!(
            *state,
            StagedCredentialState::Writing { .. }
                | StagedCredentialState::RollbackNeeded { .. }
                | StagedCredentialState::Discarding
        ))
    }

    fn retention(&self) -> Result<StagedCredentialRetention, NativeError> {
        let state = self
            .state
            .lock()
            .map_err(|_| NativeError::service_unavailable())?;
        Ok(match &*state {
            StagedCredentialState::Pending => {
                StagedCredentialRetention::Pending(self.staged_at.load(AtomicOrdering::Acquire))
            }
            StagedCredentialState::Writing { .. }
            | StagedCredentialState::RollbackNeeded { .. }
            | StagedCredentialState::Discarding => StagedCredentialRetention::Protected,
            StagedCredentialState::Committed
            | StagedCredentialState::Finished(_)
            | StagedCredentialState::Failed(_) => {
                StagedCredentialRetention::Terminal(self.terminal_retained_at())
            }
        })
    }

    fn cleanup_recoverable(
        &self,
        custody: &dyn CredentialCustody,
        mode: RecoverableCleanupMode,
    ) -> Result<RecoverableCleanup, NativeError> {
        let rollback = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| NativeError::service_unavailable())?;
            match &mut *state {
                StagedCredentialState::RollbackNeeded {
                    expected,
                    completion_error,
                } => {
                    let rollback = (expected.clone(), completion_error.clone());
                    *state = StagedCredentialState::Discarding;
                    Some(rollback)
                }
                StagedCredentialState::Writing { discard_requested } => {
                    if mode == RecoverableCleanupMode::Invalidate {
                        *discard_requested = true;
                    }
                    return Ok(RecoverableCleanup::Pending);
                }
                StagedCredentialState::Discarding => {
                    return Ok(RecoverableCleanup::Pending);
                }
                StagedCredentialState::Finished(_) => {
                    return Ok(RecoverableCleanup::Completed);
                }
                StagedCredentialState::Failed(_) => return Ok(RecoverableCleanup::NotNeeded),
                StagedCredentialState::Pending | StagedCredentialState::Committed => {
                    return Ok(RecoverableCleanup::NotNeeded);
                }
            }
        };
        let Some((expected, completion_error)) = rollback else {
            return Err(NativeError::service_unavailable());
        };
        let result = custody.compare_delete_credential(&expected);
        let mut state = self
            .state
            .lock()
            .map_err(|_| NativeError::service_unavailable())?;
        match result {
            Ok(result) => {
                self.set_terminal_state(&mut state, StagedCredentialState::Finished(result));
                self.completed.notify_all();
                Ok(RecoverableCleanup::Completed)
            }
            Err(error) if error.code == DiagnosticCode::CredentialUpdateInProgress => {
                *state = StagedCredentialState::RollbackNeeded {
                    expected,
                    completion_error,
                };
                self.completed.notify_all();
                Err(error)
            }
            Err(_) => {
                let error = NativeError::secret_store_rollback_failed();
                self.set_terminal_state(&mut state, StagedCredentialState::Failed(error.clone()));
                self.completed.notify_all();
                Err(error)
            }
        }
    }
}

struct PendingDiscovery {
    descriptor: AuthorityDescriptor,
    context: AuthorityContext,
    expires_at: u64,
    sequence: u64,
}

struct CredentialReservation {
    authority: AuthorityReference,
    expires_at: u64,
}

#[derive(Default)]
struct TransientState {
    discoveries: std::collections::HashMap<String, PendingDiscovery>,
    pairings: std::collections::HashMap<String, PendingPairing>,
    managed_pairings: std::collections::HashMap<String, String>,
    credential_reservations: std::collections::HashMap<String, CredentialReservation>,
    credentials: std::collections::HashMap<String, Arc<StagedCredential>>,
    next_sequence: u64,
}

impl TransientState {
    fn allocate_sequence(&mut self) -> Result<u64, NativeError> {
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or_else(|| NativeError::new(DiagnosticCode::Conflict, false))?;
        Ok(self.next_sequence)
    }

    fn remove_pairing(&mut self, handle: &str) -> Option<PendingPairing> {
        let removed = self.pairings.remove(handle);
        if removed.is_some() {
            self.managed_pairings
                .retain(|_, pairing_handle| pairing_handle != handle);
        }
        removed
    }

    fn prune_discoveries(&mut self, now: u64) {
        self.discoveries
            .retain(|_, discovery| discovery.expires_at > now);
        while self.discoveries.len() > MAX_RETAINED_DISCOVERIES {
            let oldest = self
                .discoveries
                .iter()
                .min_by_key(|(_, discovery)| discovery.sequence)
                .map(|(handle, _)| handle.clone());
            let Some(handle) = oldest else {
                break;
            };
            self.discoveries.remove(&handle);
        }
    }

    fn retain_managed_pairings(&mut self) {
        let valid_pairings = self.pairings.keys().cloned().collect::<HashSet<_>>();
        self.managed_pairings
            .retain(|_, handle| valid_pairings.contains(handle));
    }

    fn prune_pairings(&mut self, now: u64) {
        let expired = self
            .pairings
            .iter()
            .filter(|(_, pairing)| pairing.expires_at <= now)
            .map(|(handle, _)| handle.clone())
            .collect::<Vec<_>>();
        for handle in expired {
            self.remove_pairing(&handle);
        }
        while self.pairings.len() > MAX_RETAINED_PAIRINGS {
            let oldest = self
                .pairings
                .iter()
                .min_by_key(|(_, pairing)| pairing.sequence)
                .map(|(handle, _)| handle.clone());
            let Some(handle) = oldest else {
                break;
            };
            self.remove_pairing(&handle);
        }
    }

    fn prune_credentials(&mut self, now: u64) -> Result<(), NativeError> {
        self.credential_reservations
            .retain(|_, reservation| reservation.expires_at > now);
        let mut expired = Vec::new();
        for (handle, credential) in &self.credentials {
            let expired_at = match credential.retention()? {
                StagedCredentialRetention::Pending(staged_at) => {
                    now.saturating_sub(staged_at) >= PENDING_CREDENTIAL_TTL_MILLIS
                }
                StagedCredentialRetention::Protected => false,
                StagedCredentialRetention::Terminal(terminal_at) => {
                    now.saturating_sub(terminal_at) >= TERMINAL_CREDENTIAL_TTL_MILLIS
                }
            };
            if expired_at && Arc::strong_count(credential) == 1 {
                expired.push(handle.clone());
            }
        }
        for handle in expired {
            self.credentials.remove(&handle);
        }

        Ok(())
    }

    fn ensure_credential_slot(&mut self, now: u64) -> Result<(), NativeError> {
        self.prune_credentials(now)?;
        if self
            .credentials
            .len()
            .saturating_add(self.credential_reservations.len())
            >= MAX_RETAINED_CREDENTIALS
        {
            return Err(NativeError::credential_update_in_progress());
        }
        Ok(())
    }

    fn credential_update_in_progress(
        &self,
        authority: &AuthorityReference,
    ) -> Result<bool, NativeError> {
        let staged = self
            .credentials
            .values()
            .filter(|credential| credential.authority == *authority)
            .try_fold(false, |in_progress, credential| {
                Ok(in_progress || credential.update_in_progress()?)
            })?;
        Ok(staged
            || self
                .credential_reservations
                .values()
                .any(|reservation| reservation.authority == *authority))
    }

    fn credential_mutation_in_progress_except(
        &self,
        staged: &Arc<StagedCredential>,
    ) -> Result<bool, NativeError> {
        let staged = self
            .credentials
            .values()
            .filter(|credential| !Arc::ptr_eq(credential, staged))
            .try_fold(false, |in_progress, credential| {
                Ok(in_progress || credential.requires_recoverable_cleanup()?)
            })?;
        Ok(staged || !self.credential_reservations.is_empty())
    }
}

fn current_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .unwrap_or(u64::MAX)
}

fn terminal_pairing_status(value: &Value) -> bool {
    value
        .as_object()
        .and_then(|object| object.get("status"))
        .and_then(Value::as_str)
        .is_some_and(|status| matches!(status, "denied" | "expired"))
}

pub struct NativeSdkBoundary {
    lifecycle: AuthorityLifecycle,
    custody: Arc<dyn CredentialCustody>,
    provider: Arc<dyn ManagedNativeAuthorityProvider>,
    authority_mutation: Mutex<()>,
    transient: Mutex<TransientState>,
}

impl NativeSdkBoundary {
    fn new(
        custody: Arc<dyn CredentialCustody>,
        provider: Arc<dyn ManagedNativeAuthorityProvider>,
    ) -> Self {
        Self {
            lifecycle: AuthorityLifecycle::default(),
            custody,
            provider,
            authority_mutation: Mutex::new(()),
            transient: Mutex::new(TransientState::default()),
        }
    }

    fn lock_authority_mutation(&self) -> Result<std::sync::MutexGuard<'_, ()>, NativeError> {
        self.authority_mutation
            .lock()
            .map_err(|_| NativeError::service_unavailable())
    }

    pub fn with_provider(provider: Arc<dyn ManagedNativeAuthorityProvider>) -> Self {
        Self::new(
            Arc::new(KeyringCredentialCustody::new(APP_IDENTIFIER)),
            provider,
        )
    }

    pub fn production() -> Self {
        Self::with_provider(Arc::new(UnavailableManagedNativeAuthorityProvider))
    }

    pub fn installation_identity(&self) -> Result<InstallationIdentity, NativeError> {
        Ok(InstallationIdentity {
            installation_id: self.custody.installation_id()?,
        })
    }

    pub fn authority_open(
        &self,
        authority: AuthorityDescriptor,
    ) -> Result<AuthorityReference, NativeError> {
        self.authority_open_with_transition(authority, |_| {})
    }

    pub async fn discovery_read(&self) -> Result<DiscoveryReadOutput, NativeError> {
        self.discovery_read_at(current_time_millis()).await
    }

    async fn discovery_read_at(&self, now: u64) -> Result<DiscoveryReadOutput, NativeError> {
        let descriptor = self.provider.discover().await?;
        descriptor.validate()?;
        let snapshot = descriptor.managed_snapshot()?;
        let context = self.lifecycle.context()?;
        let expires_at = now
            .checked_add(DISCOVERY_TTL_MILLIS)
            .ok_or_else(NativeError::invalid_response)?;
        let handle = format!("discovery:{}", Uuid::new_v4());
        let mut transient = self
            .transient
            .lock()
            .map_err(|_| NativeError::service_unavailable())?;
        transient.prune_discoveries(now);
        let sequence = transient.allocate_sequence()?;
        transient.discoveries.insert(
            handle.clone(),
            PendingDiscovery {
                descriptor,
                context,
                expires_at,
                sequence,
            },
        );
        transient.prune_discoveries(now);
        Ok(DiscoveryReadOutput { handle, snapshot })
    }

    pub fn authority_establish(
        &self,
        input: DiscoveryHandleInput,
    ) -> Result<AuthorityReference, NativeError> {
        self.authority_establish_at(input, current_time_millis())
    }

    fn authority_establish_at(
        &self,
        input: DiscoveryHandleInput,
        now: u64,
    ) -> Result<AuthorityReference, NativeError> {
        validate_opaque_handle(&input.discovery_handle, "discovery:")?;
        let context = self.lifecycle.context()?;
        let discovery = {
            let mut transient = self
                .transient
                .lock()
                .map_err(|_| NativeError::service_unavailable())?;
            transient.prune_discoveries(now);
            transient
                .discoveries
                .remove(&input.discovery_handle)
                .ok_or_else(NativeError::reconcile_required)?
        };
        if discovery.context != context {
            return Err(NativeError::reconcile_required());
        }
        discovery.descriptor.validate()?;
        self.authority_open_from_context(discovery.descriptor, &context)
    }

    fn authority_open_with_transition(
        &self,
        authority: AuthorityDescriptor,
        after_replace: impl FnOnce(&AuthorityReference),
    ) -> Result<AuthorityReference, NativeError> {
        authority.validate()?;
        let reference = {
            let _mutation = self.lock_authority_mutation()?;
            self.cleanup_recoverable_credentials(|_| true, RecoverableCleanupMode::Invalidate)?;
            self.lifecycle.replace(authority)?
        };
        self.finish_authority_open(reference, after_replace)
    }

    fn authority_open_from_context(
        &self,
        authority: AuthorityDescriptor,
        context: &AuthorityContext,
    ) -> Result<AuthorityReference, NativeError> {
        authority.validate()?;
        let reference = {
            let _mutation = self.lock_authority_mutation()?;
            if self.lifecycle.context()? != *context {
                return Err(NativeError::reconcile_required());
            }
            self.cleanup_recoverable_credentials(|_| true, RecoverableCleanupMode::Invalidate)?;
            self.lifecycle.replace_if_context(authority, context)?
        };
        self.finish_authority_open(reference, |_| {})
    }

    fn finish_authority_open(
        &self,
        reference: AuthorityReference,
        after_replace: impl FnOnce(&AuthorityReference),
    ) -> Result<AuthorityReference, NativeError> {
        after_replace(&reference);
        {
            let _mutation = self.lock_authority_mutation()?;
            self.lifecycle.descriptor(&reference)?;
            self.invalidate_transients_before(reference.generation)?;
        }
        Ok(reference)
    }

    pub fn authority_close(
        &self,
        input: CloseAuthorityInput,
    ) -> Result<AuthorityCloseResult, NativeError> {
        self.authority_close_with_transition(input, || {})
    }

    fn authority_close_with_transition(
        &self,
        input: CloseAuthorityInput,
        after_close: impl FnOnce(),
    ) -> Result<AuthorityCloseResult, NativeError> {
        input.authority.validate()?;
        let generation = input.authority.generation;
        let closed = {
            let _mutation = self.lock_authority_mutation()?;
            let context = self.lifecycle.context()?;
            match context.active.as_ref() {
                None => false,
                Some(active) if active != &input.authority => {
                    return Err(NativeError::reconcile_required());
                }
                Some(_) => {
                    self.cleanup_recoverable_credentials(
                        |credential| credential.authority.generation <= generation,
                        RecoverableCleanupMode::Invalidate,
                    )?;
                    let closed = self.lifecycle.close(&input.authority)?;
                    if !closed {
                        return Err(NativeError::reconcile_required());
                    }
                    self.invalidate_transients_through(generation)?;
                    true
                }
            }
        };
        if closed {
            after_close();
        }
        Ok(AuthorityCloseResult { closed })
    }

    fn invalidate_transients_before(&self, minimum_generation: u64) -> Result<(), NativeError> {
        let mut transient = self
            .transient
            .lock()
            .map_err(|_| NativeError::service_unavailable())?;
        let now = current_time_millis();
        transient.prune_pairings(now);
        transient.prune_credentials(now)?;
        transient
            .pairings
            .retain(|_, pairing| pairing.authority.generation >= minimum_generation);
        transient
            .credential_reservations
            .retain(|_, reservation| reservation.authority.generation >= minimum_generation);
        transient.discoveries.clear();
        transient.retain_managed_pairings();
        let mut remove = Vec::new();
        for (handle, credential) in &transient.credentials {
            if credential.authority.generation < minimum_generation
                && !credential.requires_recoverable_cleanup()?
            {
                remove.push(handle.clone());
            }
        }
        for handle in remove {
            transient.credentials.remove(&handle);
        }
        Ok(())
    }

    fn invalidate_transients_through(&self, generation: u64) -> Result<(), NativeError> {
        let mut transient = self
            .transient
            .lock()
            .map_err(|_| NativeError::service_unavailable())?;
        let now = current_time_millis();
        transient.prune_pairings(now);
        transient.prune_credentials(now)?;
        transient
            .pairings
            .retain(|_, pairing| pairing.authority.generation > generation);
        transient
            .credential_reservations
            .retain(|_, reservation| reservation.authority.generation > generation);
        transient.discoveries.clear();
        transient.retain_managed_pairings();
        let mut remove = Vec::new();
        for (handle, credential) in &transient.credentials {
            if credential.authority.generation <= generation
                && !credential.requires_recoverable_cleanup()?
            {
                remove.push(handle.clone());
            }
        }
        for handle in remove {
            transient.credentials.remove(&handle);
        }
        Ok(())
    }

    fn cleanup_recoverable_credentials(
        &self,
        include: impl Fn(&StagedCredential) -> bool,
        mode: RecoverableCleanupMode,
    ) -> Result<bool, NativeError> {
        let candidates = {
            let transient = self
                .transient
                .lock()
                .map_err(|_| NativeError::service_unavailable())?;
            transient
                .credentials
                .iter()
                .filter(|(_, credential)| include(credential))
                .map(|(handle, credential)| (handle.clone(), Arc::clone(credential)))
                .collect::<Vec<_>>()
        };
        let mut pending = false;
        for (handle, credential) in candidates {
            match credential.cleanup_recoverable(self.custody.as_ref(), mode)? {
                RecoverableCleanup::NotNeeded => {}
                RecoverableCleanup::Pending => pending = true,
                RecoverableCleanup::Completed => {
                    let mut transient = self
                        .transient
                        .lock()
                        .map_err(|_| NativeError::service_unavailable())?;
                    let is_same = transient
                        .credentials
                        .get(&handle)
                        .is_some_and(|current| Arc::ptr_eq(current, &credential));
                    if is_same {
                        transient.credentials.remove(&handle);
                    }
                }
            }
        }
        Ok(pending)
    }

    fn recoverable_cleanup_pending(&self) -> Result<bool, NativeError> {
        let transient = self
            .transient
            .lock()
            .map_err(|_| NativeError::service_unavailable())?;
        transient
            .credentials
            .values()
            .try_fold(false, |pending, credential| {
                Ok(pending || credential.requires_recoverable_cleanup()?)
            })
    }

    #[cfg(test)]
    fn insert_test_pairing(&self, authority: &AuthorityReference, handle: &str) {
        let mut transient = self.transient.lock().expect("test transient lock");
        let sequence = transient
            .allocate_sequence()
            .expect("test pairing sequence");
        transient.pairings.insert(
            handle.into(),
            PendingPairing {
                authority: authority.clone(),
                app_name: "OpenCoven Chat".into(),
                installation_id: "00000000-0000-4000-8000-000000000010".into(),
                scopes: vec!["chat:read".into()],
                remote_request_id: "11111111-1111-4111-8111-111111111111".into(),
                pairing_secret: SecretValue::pairing(
                    b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_vec(),
                )
                .expect("test pairing secret"),
                expires_at: u64::MAX,
                sequence,
                status: PendingPairingStatus::Ready,
            },
        );
    }

    #[cfg(test)]
    fn insert_test_staged_credential(&self, authority: &AuthorityReference, handle: &str) {
        let credential = CredentialRecord {
            installation_id: "00000000-0000-4000-8000-000000000010".into(),
            authority_fingerprint: format!("sha256:{}", "a".repeat(64)),
            bearer: SecretValue::bearer(b"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB".to_vec())
                .expect("test bearer"),
        };
        let mut transient = self.transient.lock().expect("test transient lock");
        transient.credentials.insert(
            handle.into(),
            Arc::new(StagedCredential::new(
                authority.clone(),
                PreparedCredential::from_record(&credential).expect("test credential"),
                current_time_millis(),
            )),
        );
    }

    pub async fn health(
        &self,
        input: HealthCommandInput,
    ) -> Result<OperationResult<NativeResponse>, NativeError> {
        let request = self
            .lifecycle
            .begin_request(&input.authority, &input.request_id)?;
        let authority = self.lifecycle.descriptor(&input.authority)?;
        let response = match self.provider.health(authority).await {
            Ok(response) => response,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
        };
        if let Err(error) = response.validate_operation(NativeResponseOperation::Health) {
            self.lifecycle.cancel_request(&request);
            return Err(error);
        }
        self.lifecycle.finish_request(&request)?;
        Ok(OperationResult {
            authority: input.authority,
            request_id: input.request_id,
            result: response,
        })
    }

    pub async fn pairing_create(
        &self,
        input: PairingCreateCommandInput,
    ) -> Result<OperationResult<PairingCreatedOutput>, NativeError> {
        let custody = Arc::clone(&self.custody);
        let installation_id =
            tauri::async_runtime::spawn_blocking(move || custody.installation_id())
                .await
                .map_err(|_| NativeError::service_unavailable())??;
        input.request.validate(&installation_id)?;
        let app_name = input.request.app_name.clone();
        let scopes = input.request.scopes.clone();
        let request = self
            .lifecycle
            .begin_request(&input.authority, &input.request_id)?;
        let authority = self.lifecycle.descriptor(&input.authority)?;
        let created = match self.provider.pairing_create(authority, input.request).await {
            Ok(created) => created,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
        };
        if let Err(error) = validate_remote_request_id(&created.remote_request_id) {
            self.lifecycle.cancel_request(&request);
            return Err(error);
        }
        if created.expires_at > MAX_SAFE_INTEGER {
            self.lifecycle.cancel_request(&request);
            return Err(NativeError::invalid_response());
        }
        let handle = format!("pairing:{}", Uuid::new_v4());
        let remote_request_id = created.remote_request_id;
        let now = current_time_millis();
        let stage_result = (|| {
            let _mutation = self.lock_authority_mutation()?;
            self.lifecycle.validate_request(&request)?;
            self.lifecycle.finish_request(&request)?;
            let mut transient = self
                .transient
                .lock()
                .map_err(|_| NativeError::service_unavailable())?;
            transient.prune_pairings(now);
            let sequence = transient.allocate_sequence()?;
            transient.pairings.insert(
                handle.clone(),
                PendingPairing {
                    authority: input.authority.clone(),
                    app_name,
                    installation_id,
                    scopes,
                    remote_request_id: remote_request_id.clone(),
                    pairing_secret: created.pairing_secret,
                    expires_at: created.expires_at,
                    sequence,
                    status: PendingPairingStatus::Ready,
                },
            );
            transient.prune_pairings(now);
            Ok(())
        })();
        if let Err(error) = stage_result {
            self.lifecycle.cancel_request(&request);
            return Err(error);
        }

        Ok(OperationResult {
            authority: input.authority,
            request_id: input.request_id,
            result: PairingCreatedOutput {
                handle,
                request_id: remote_request_id,
                expires_at: created.expires_at,
            },
        })
    }

    pub async fn managed_pairing_create(
        &self,
        input: PairingCreateCommandInput,
    ) -> Result<OperationResult<ManagedPairingCreatedOutput>, NativeError> {
        let created = self.pairing_create(input).await?;
        let pairing_handle = created.result.handle;
        let pairing_request_id = created.result.request_id;
        let _mutation = self.lock_authority_mutation()?;
        self.lifecycle.descriptor(&created.authority)?;
        let mut transient = self
            .transient
            .lock()
            .map_err(|_| NativeError::service_unavailable())?;
        transient.prune_pairings(current_time_millis());
        if !transient.pairings.contains_key(&pairing_handle) {
            return Ok(OperationResult {
                authority: created.authority,
                request_id: created.request_id,
                result: ManagedPairingCreatedOutput {
                    request_id: pairing_request_id,
                    expires_at: created.result.expires_at,
                },
            });
        }
        if let Some(previous_handle) = transient
            .managed_pairings
            .insert(pairing_request_id.clone(), pairing_handle.clone())
        {
            transient
                .managed_pairings
                .insert(pairing_request_id, previous_handle);
            transient.remove_pairing(&pairing_handle);
            return Err(NativeError::invalid_response());
        }
        Ok(OperationResult {
            authority: created.authority,
            request_id: created.request_id,
            result: ManagedPairingCreatedOutput {
                request_id: pairing_request_id,
                expires_at: created.result.expires_at,
            },
        })
    }

    pub async fn pairing_poll(
        &self,
        input: PairingHandleCommandInput,
    ) -> Result<OperationResult<Value>, NativeError> {
        validate_opaque_handle(&input.pairing_handle, "pairing:")?;
        let request = self
            .lifecycle
            .begin_request(&input.authority, &input.request_id)?;
        let authority = match self.lifecycle.descriptor(&input.authority) {
            Ok(authority) => authority,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
        };
        let pending = (|| {
            let _mutation = self.lock_authority_mutation()?;
            self.lifecycle.validate_request(&request)?;
            let mut transient = self
                .transient
                .lock()
                .map_err(|_| NativeError::service_unavailable())?;
            transient.prune_pairings(current_time_millis());
            let pending = transient
                .pairings
                .get_mut(&input.pairing_handle)
                .ok_or_else(NativeError::reconcile_required)?;
            if pending.authority != input.authority {
                return Err(NativeError::reconcile_required());
            }
            if pending.status != PendingPairingStatus::Ready {
                return Err(NativeError::new(DiagnosticCode::OperationInProgress, true));
            }
            pending.status = PendingPairingStatus::Polling;
            Ok((
                pending.remote_request_id.clone(),
                pending.pairing_secret.clone(),
            ))
        })();
        let (remote_request_id, pairing_secret) = match pending {
            Ok(pending) => pending,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
        };
        let status = match self
            .provider
            .pairing_poll(authority, remote_request_id, pairing_secret)
            .await
        {
            Ok(status) => match validate_public_snapshot(status) {
                Ok(status) => status,
                Err(error) => {
                    self.lifecycle.cancel_request(&request);
                    self.finish_pending_pairing(
                        &input.pairing_handle,
                        &input.authority,
                        !error.retryable,
                    );
                    return Err(error);
                }
            },
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                self.finish_pending_pairing(
                    &input.pairing_handle,
                    &input.authority,
                    !error.retryable,
                );
                return Err(error);
            }
        };
        self.lifecycle.finish_request(&request)?;
        self.finish_pending_pairing(
            &input.pairing_handle,
            &input.authority,
            terminal_pairing_status(&status),
        );
        self.lifecycle.descriptor(&input.authority)?;
        Ok(OperationResult {
            authority: input.authority,
            request_id: input.request_id,
            result: status,
        })
    }

    pub async fn pairing_exchange(
        &self,
        input: PairingHandleCommandInput,
    ) -> Result<OperationResult<PairingExchangeOutput>, NativeError> {
        validate_opaque_handle(&input.pairing_handle, "pairing:")?;
        let request = self
            .lifecycle
            .begin_request(&input.authority, &input.request_id)?;
        let authority = match self.lifecycle.descriptor(&input.authority) {
            Ok(authority) => authority,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
        };
        self.pairing_exchange_with_request(input, request, authority, false)
            .await
    }

    async fn pairing_exchange_with_request(
        &self,
        input: PairingHandleCommandInput,
        request: RequestLease,
        authority: AuthorityDescriptor,
        managed: bool,
    ) -> Result<OperationResult<PairingExchangeOutput>, NativeError> {
        let commit_handle = format!("commit:{}", Uuid::new_v4());
        let pending = match (|| {
            let _mutation = self.lock_authority_mutation()?;
            self.lifecycle.validate_request(&request)?;
            let now = current_time_millis();
            let mut transient = self
                .transient
                .lock()
                .map_err(|_| NativeError::service_unavailable())?;
            transient.prune_pairings(now);
            transient.prune_credentials(now)?;
            if managed && transient.credential_update_in_progress(&input.authority)? {
                return Err(NativeError::credential_update_in_progress());
            }
            let reservation_expires_at = {
                let pending = transient
                    .pairings
                    .get(&input.pairing_handle)
                    .ok_or_else(NativeError::reconcile_required)?;
                if pending.authority != input.authority {
                    return Err(NativeError::reconcile_required());
                }
                if pending.status != PendingPairingStatus::Ready {
                    return Err(NativeError::new(DiagnosticCode::OperationInProgress, true));
                }
                pending.expires_at
            };
            transient.ensure_credential_slot(now)?;
            if transient.credentials.contains_key(&commit_handle)
                || transient
                    .credential_reservations
                    .contains_key(&commit_handle)
            {
                return Err(NativeError::new(DiagnosticCode::Conflict, false));
            }
            let pending = transient
                .remove_pairing(&input.pairing_handle)
                .ok_or_else(NativeError::reconcile_required)?;
            transient.credential_reservations.insert(
                commit_handle.clone(),
                CredentialReservation {
                    authority: input.authority.clone(),
                    expires_at: reservation_expires_at,
                },
            );
            Ok(pending)
        })() {
            Ok(pending) => pending,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
        };
        let app_name = pending.app_name;
        let installation_id = pending.installation_id;
        let scopes = pending.scopes;
        let exchanged = match self
            .provider
            .pairing_exchange(
                authority.clone(),
                pending.remote_request_id,
                pending.pairing_secret,
            )
            .await
        {
            Ok(exchanged) => exchanged,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                self.remove_credential_reservation(&commit_handle, &input.authority)?;
                return Err(error);
            }
        };
        let public_credential = match validate_provider_credential_metadata(
            exchanged.credential,
            &app_name,
            &installation_id,
            &scopes,
        ) {
            Ok(credential) => credential,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                self.remove_credential_reservation(&commit_handle, &input.authority)?;
                return Err(error);
            }
        };
        let authority_fingerprint = match authority.fingerprint() {
            Ok(fingerprint) => fingerprint,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                self.remove_credential_reservation(&commit_handle, &input.authority)?;
                return Err(error);
            }
        };
        let credential = CredentialRecord {
            installation_id,
            authority_fingerprint,
            bearer: exchanged.bearer,
        };
        let credential = match PreparedCredential::from_record(&credential) {
            Ok(credential) => credential,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                self.remove_credential_reservation(&commit_handle, &input.authority)?;
                return Err(error);
            }
        };
        let now = current_time_millis();
        let stage_result = (|| {
            let _mutation = self.lock_authority_mutation()?;
            self.lifecycle.validate_request(&request)?;
            {
                let mut transient = self
                    .transient
                    .lock()
                    .map_err(|_| NativeError::service_unavailable())?;
                transient.prune_credentials(now)?;
                let reserved = transient
                    .credential_reservations
                    .get(&commit_handle)
                    .is_some_and(|reservation| reservation.authority == input.authority);
                if !reserved {
                    return Err(NativeError::reconcile_required());
                }
            }
            self.lifecycle.finish_request(&request)?;
            let mut transient = self
                .transient
                .lock()
                .map_err(|_| NativeError::service_unavailable())?;
            let reserved = transient
                .credential_reservations
                .get(&commit_handle)
                .is_some_and(|reservation| reservation.authority == input.authority);
            if !reserved {
                return Err(NativeError::reconcile_required());
            }
            transient.credential_reservations.remove(&commit_handle);
            transient.credentials.insert(
                commit_handle.clone(),
                Arc::new(StagedCredential::new(
                    input.authority.clone(),
                    credential,
                    now,
                )),
            );
            Ok(())
        })();
        if let Err(error) = stage_result {
            self.lifecycle.cancel_request(&request);
            self.remove_credential_reservation(&commit_handle, &input.authority)?;
            return Err(error);
        }
        Ok(OperationResult {
            authority: input.authority,
            request_id: input.request_id,
            result: PairingExchangeOutput {
                authority_binding: authority.binding(),
                commit_handle,
                credential: public_credential,
            },
        })
    }

    pub async fn managed_pairing_poll(
        &self,
        input: ManagedPairingCommandInput,
    ) -> Result<OperationResult<Value>, NativeError> {
        validate_remote_request_id(&input.pairing_request_id)?;
        let pairing_handle = {
            let _mutation = self.lock_authority_mutation()?;
            self.lifecycle.descriptor(&input.authority)?;
            let mut transient = self
                .transient
                .lock()
                .map_err(|_| NativeError::service_unavailable())?;
            transient.prune_pairings(current_time_millis());
            transient
                .managed_pairings
                .get(&input.pairing_request_id)
                .cloned()
                .ok_or_else(NativeError::reconcile_required)?
        };
        self.pairing_poll(PairingHandleCommandInput {
            authority: input.authority,
            request_id: input.request_id,
            pairing_handle,
        })
        .await
    }

    pub async fn managed_pairing_exchange(
        self: &Arc<Self>,
        input: ManagedPairingCommandInput,
    ) -> Result<OperationResult<ManagedPairingExchangeOutput>, NativeError> {
        validate_remote_request_id(&input.pairing_request_id)?;
        let request = self
            .lifecycle
            .begin_request(&input.authority, &input.request_id)?;
        let authority = match self.lifecycle.descriptor(&input.authority) {
            Ok(authority) => authority,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
        };
        let pairing_handle = match (|| {
            let _mutation = self.lock_authority_mutation()?;
            self.lifecycle.validate_request(&request)?;
            let mut transient = self
                .transient
                .lock()
                .map_err(|_| NativeError::service_unavailable())?;
            Ok({
                transient.prune_pairings(current_time_millis());
                transient
                    .managed_pairings
                    .get(&input.pairing_request_id)
                    .cloned()
            })
        })() {
            Ok(pairing_handle) => pairing_handle,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
        };
        let Some(pairing_handle) = pairing_handle else {
            self.lifecycle.cancel_request(&request);
            return Err(NativeError::reconcile_required());
        };
        if let Err(error) = validate_opaque_handle(&pairing_handle, "pairing:") {
            self.lifecycle.cancel_request(&request);
            return Err(error);
        }
        let boundary = Arc::clone(self);
        let cleanup_request = request.clone();
        let cleanup_authority = input.authority.clone();
        let cleanup = tauri::async_runtime::spawn_blocking(move || {
            let _mutation = boundary.lock_authority_mutation()?;
            boundary.lifecycle.validate_request(&cleanup_request)?;
            let prior_cleanup_pending = boundary.cleanup_recoverable_credentials(
                |credential| credential.authority.generation < cleanup_authority.generation,
                RecoverableCleanupMode::Invalidate,
            )?;
            let current_cleanup_pending = boundary.cleanup_recoverable_credentials(
                |credential| credential.authority == cleanup_authority,
                RecoverableCleanupMode::Observe,
            )?;
            Ok(prior_cleanup_pending || current_cleanup_pending)
        })
        .await;
        let cleanup_pending = match cleanup {
            Ok(Ok(cleanup_pending)) => cleanup_pending,
            Ok(Err(error)) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
            Err(_) => {
                self.lifecycle.cancel_request(&request);
                return Err(NativeError::service_unavailable());
            }
        };
        if cleanup_pending {
            self.lifecycle.cancel_request(&request);
            return Err(NativeError::credential_update_in_progress());
        }
        let exchanged_result = self
            .pairing_exchange_with_request(
                PairingHandleCommandInput {
                    authority: input.authority.clone(),
                    request_id: input.request_id.clone(),
                    pairing_handle: pairing_handle.clone(),
                },
                request,
                authority,
                true,
            )
            .await;
        let exchanged = exchanged_result?;
        let commit_handle = exchanged.result.commit_handle;
        let credential = exchanged.result.credential;
        let boundary = Arc::clone(self);
        let commit = CommitHandleCommandInput {
            authority: input.authority.clone(),
            request_id: input.request_id.clone(),
            commit_handle: commit_handle.clone(),
        };
        let commit_result =
            match tauri::async_runtime::spawn_blocking(move || boundary.pairing_commit(commit))
                .await
            {
                Ok(result) => result.map(|_| ()),
                Err(_) => Err(NativeError::service_unavailable()),
            };
        if let Err(commit_error) = commit_result {
            let boundary = Arc::clone(self);
            let cleanup_handle = commit_handle.clone();
            let cleanup_authority = input.authority.clone();
            let cleanup_result = tauri::async_runtime::spawn_blocking(move || {
                boundary.cleanup_managed_commit_failure(&cleanup_handle, &cleanup_authority)
            })
            .await
            .map_err(|_| NativeError::service_unavailable())?;
            return match cleanup_result {
                Ok(()) => Err(commit_error),
                Err(cleanup_error) => Err(cleanup_error),
            };
        }
        self.transient
            .lock()
            .map_err(|_| NativeError::service_unavailable())?
            .credentials
            .remove(&commit_handle);
        Ok(OperationResult {
            authority: input.authority,
            request_id: input.request_id,
            result: ManagedPairingExchangeOutput { credential },
        })
    }

    pub fn pairing_commit(
        &self,
        input: CommitHandleCommandInput,
    ) -> Result<OperationResult<()>, NativeError> {
        self.pairing_commit_with_transition(input, || {})
    }

    fn pairing_commit_with_transition(
        &self,
        input: CommitHandleCommandInput,
        after_lookup: impl FnOnce(),
    ) -> Result<OperationResult<()>, NativeError> {
        validate_opaque_handle(&input.commit_handle, "commit:")?;
        let request = self
            .lifecycle
            .begin_request(&input.authority, &input.request_id)?;
        let staged = match (|| {
            let _mutation = self.lock_authority_mutation()?;
            self.lifecycle.validate_request(&request)?;
            let mut transient = self
                .transient
                .lock()
                .map_err(|_| NativeError::service_unavailable())?;
            transient.prune_credentials(current_time_millis())?;
            Ok(transient.credentials.get(&input.commit_handle).cloned())
        })() {
            Ok(staged) => staged,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
        };
        let Some(staged) = staged else {
            self.lifecycle.cancel_request(&request);
            return Err(NativeError::reconcile_required());
        };
        if staged.authority != input.authority {
            self.lifecycle.cancel_request(&request);
            return Err(NativeError::reconcile_required());
        }
        after_lookup();
        match staged.resolve_rollback_before_commit(self.custody.as_ref()) {
            Ok(Some(completion_error)) => {
                let lifecycle_error = self.lifecycle.finish_request(&request).err();
                return Err(lifecycle_error.unwrap_or(completion_error));
            }
            Ok(None) => {}
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
        }
        let credential = match (|| {
            let _mutation = self.lock_authority_mutation()?;
            self.lifecycle.validate_request(&request)?;
            let prior_cleanup_pending = self.cleanup_recoverable_credentials(
                |credential| credential.authority.generation < input.authority.generation,
                RecoverableCleanupMode::Invalidate,
            )?;
            if prior_cleanup_pending {
                return Err(NativeError::credential_update_in_progress());
            }
            let (is_attached, competing_mutation) = {
                let mut transient = self
                    .transient
                    .lock()
                    .map_err(|_| NativeError::service_unavailable())?;
                transient.prune_credentials(current_time_millis())?;
                (
                    transient
                        .credentials
                        .get(&input.commit_handle)
                        .is_some_and(|current| Arc::ptr_eq(current, &staged)),
                    transient.credential_mutation_in_progress_except(&staged)?,
                )
            };
            if !is_attached {
                return Err(NativeError::reconcile_required());
            }
            if competing_mutation {
                return Err(NativeError::credential_update_in_progress());
            }
            staged.begin_write()
        })() {
            Ok(credential) => credential,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
        };
        let write_result = self.custody.write_credential(&credential);
        let lifecycle_error = self.lifecycle.finish_request(&request).err();
        let request_became_stale = lifecycle_error.is_some();
        let finish_result =
            staged.finish_write(self.custody.as_ref(), write_result, lifecycle_error);
        if request_became_stale && !staged.requires_recoverable_cleanup()? {
            self.remove_staged_credential_if_same(&input.commit_handle, &staged)?;
        }
        finish_result?;
        if let Ok(mut transient) = self.transient.lock() {
            let _ = transient.prune_credentials(current_time_millis());
        }
        Ok(OperationResult {
            authority: input.authority,
            request_id: input.request_id,
            result: (),
        })
    }

    fn cleanup_managed_commit_failure(
        &self,
        commit_handle: &str,
        authority: &AuthorityReference,
    ) -> Result<(), NativeError> {
        let staged = self
            .transient
            .lock()
            .map_err(|_| NativeError::service_unavailable())?
            .credentials
            .get(commit_handle)
            .cloned();
        let Some(staged) = staged else {
            return Ok(());
        };
        if staged.authority != *authority {
            return Err(NativeError::reconcile_required());
        }
        match staged.discard(self.custody.as_ref()) {
            Ok(_) => self.remove_staged_credential_if_same(commit_handle, &staged),
            Err(error) if error.code == DiagnosticCode::CredentialUpdateInProgress => Err(error),
            Err(error) => {
                self.remove_staged_credential_if_same(commit_handle, &staged)?;
                Err(error)
            }
        }
    }

    fn remove_staged_credential_if_same(
        &self,
        commit_handle: &str,
        staged: &Arc<StagedCredential>,
    ) -> Result<(), NativeError> {
        let mut transient = self
            .transient
            .lock()
            .map_err(|_| NativeError::service_unavailable())?;
        if transient
            .credentials
            .get(commit_handle)
            .is_some_and(|current| Arc::ptr_eq(current, staged))
        {
            transient.credentials.remove(commit_handle);
        }
        Ok(())
    }

    fn remove_credential_reservation(
        &self,
        commit_handle: &str,
        authority: &AuthorityReference,
    ) -> Result<(), NativeError> {
        let mut transient = self
            .transient
            .lock()
            .map_err(|_| NativeError::service_unavailable())?;
        let is_same = transient
            .credential_reservations
            .get(commit_handle)
            .is_some_and(|reservation| reservation.authority == *authority);
        if is_same {
            transient.credential_reservations.remove(commit_handle);
        }
        Ok(())
    }

    pub fn pairing_discard(
        &self,
        input: CommitHandleCommandInput,
    ) -> Result<OperationResult<PairingDiscardResult>, NativeError> {
        validate_opaque_handle(&input.commit_handle, "commit:")?;
        let request = self
            .lifecycle
            .begin_request(&input.authority, &input.request_id)?;
        let staged = match (|| {
            let _mutation = self.lock_authority_mutation()?;
            self.lifecycle.validate_request(&request)?;
            let mut transient = self
                .transient
                .lock()
                .map_err(|_| NativeError::service_unavailable())?;
            transient.prune_credentials(current_time_millis())?;
            Ok(transient.credentials.get(&input.commit_handle).cloned())
        })() {
            Ok(staged) => staged,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
        };
        let result = match staged {
            None => PairingDiscardResult::Absent,
            Some(staged) if staged.authority != input.authority => PairingDiscardResult::Changed,
            Some(staged) => {
                let result = match staged.discard(self.custody.as_ref()) {
                    Ok(result) => result,
                    Err(error) => {
                        self.lifecycle.cancel_request(&request);
                        return Err(error);
                    }
                };
                self.remove_staged_credential_if_same(&input.commit_handle, &staged)?;
                result.into()
            }
        };
        self.lifecycle.finish_request(&request)?;
        Ok(OperationResult {
            authority: input.authority,
            request_id: input.request_id,
            result,
        })
    }

    pub fn credential_state(
        &self,
        input: CredentialCommandInput,
    ) -> Result<OperationResult<CredentialStateOutput>, NativeError> {
        let request = self
            .lifecycle
            .begin_request(&input.authority, &input.request_id)?;
        let authority = match self.lifecycle.descriptor(&input.authority) {
            Ok(authority) => authority,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
        };
        let authority_fingerprint = match authority.fingerprint() {
            Ok(fingerprint) => fingerprint,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
        };
        let cleanup = (|| {
            let _mutation = self.lock_authority_mutation()?;
            self.lifecycle.validate_request(&request)?;
            let prior_cleanup_pending = self.cleanup_recoverable_credentials(
                |credential| credential.authority.generation < input.authority.generation,
                RecoverableCleanupMode::Invalidate,
            )?;
            let current_cleanup_pending = self.cleanup_recoverable_credentials(
                |credential| credential.authority == input.authority,
                RecoverableCleanupMode::Observe,
            )?;
            let update_in_progress = {
                let mut transient = self
                    .transient
                    .lock()
                    .map_err(|_| NativeError::service_unavailable())?;
                transient.prune_credentials(current_time_millis())?;
                transient.credential_update_in_progress(&input.authority)?
            };
            Ok((
                prior_cleanup_pending || current_cleanup_pending,
                update_in_progress,
            ))
        })();
        let (cleanup_pending, update_in_progress) = match cleanup {
            Ok(cleanup) => cleanup,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
        };
        let status = if cleanup_pending || update_in_progress {
            CredentialState::UpdateInProgress
        } else {
            let installation_id = match self.custody.installation_id() {
                Ok(installation_id) => installation_id,
                Err(error) => {
                    self.lifecycle.cancel_request(&request);
                    return Err(error);
                }
            };
            let lookup = match self.custody.read_credential(&installation_id) {
                Ok(lookup) => lookup,
                Err(error) => {
                    self.lifecycle.cancel_request(&request);
                    return Err(error);
                }
            };
            match lookup {
                CredentialLookup::Missing => CredentialState::Missing,
                CredentialLookup::Invalid => CredentialState::Invalid,
                CredentialLookup::Present(credential)
                    if credential.authority_fingerprint == authority_fingerprint =>
                {
                    CredentialState::Present
                }
                CredentialLookup::Present(_) => CredentialState::Invalid,
            }
        };
        self.lifecycle.finish_request(&request)?;
        Ok(OperationResult {
            authority: input.authority,
            request_id: input.request_id,
            result: CredentialStateOutput { status },
        })
    }

    pub fn forget_credential(
        &self,
        input: CredentialCommandInput,
    ) -> Result<OperationResult<bool>, NativeError> {
        let request = self
            .lifecycle
            .begin_request(&input.authority, &input.request_id)?;
        let authority = match self.lifecycle.descriptor(&input.authority) {
            Ok(authority) => authority,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
        };
        let authority_fingerprint = match authority.fingerprint() {
            Ok(fingerprint) => fingerprint,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
        };
        let installation_id = match self.custody.installation_id() {
            Ok(installation_id) => installation_id,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
        };
        let lookup = match self.custody.read_credential(&installation_id) {
            Ok(lookup) => lookup,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
        };
        let expected = match lookup {
            CredentialLookup::Present(credential)
                if credential.authority_fingerprint == authority_fingerprint =>
            {
                match PreparedCredential::from_record(&credential) {
                    Ok(expected) => Some(expected),
                    Err(error) => {
                        self.lifecycle.cancel_request(&request);
                        return Err(error);
                    }
                }
            }
            CredentialLookup::Missing => None,
            CredentialLookup::Invalid | CredentialLookup::Present(_) => {
                self.lifecycle.finish_request(&request)?;
                return Err(NativeError::new(DiagnosticCode::StaleRecord, false));
            }
        };
        let deleted = match expected {
            Some(expected) => {
                let _mutation = match self.lock_authority_mutation() {
                    Ok(mutation) => mutation,
                    Err(error) => {
                        self.lifecycle.cancel_request(&request);
                        return Err(error);
                    }
                };
                if let Err(error) = self.lifecycle.validate_request(&request) {
                    self.lifecycle.cancel_request(&request);
                    return Err(error);
                }
                let outcome = match self.custody.compare_delete_credential(&expected) {
                    Ok(result) => result,
                    Err(error) => {
                        self.lifecycle.cancel_request(&request);
                        return Err(error);
                    }
                };
                self.lifecycle.finish_request(&request)?;
                match outcome {
                    CredentialDeleteResult::Deleted => true,
                    CredentialDeleteResult::Absent => false,
                    CredentialDeleteResult::Changed => {
                        return Err(NativeError::credential_update_in_progress());
                    }
                }
            }
            None => {
                self.lifecycle.finish_request(&request)?;
                false
            }
        };
        Ok(OperationResult {
            authority: input.authority,
            request_id: input.request_id,
            result: deleted,
        })
    }

    pub async fn list_familiars(
        &self,
        input: CanonicalPageCommandInput,
    ) -> Result<OperationResult<NativeResponse>, NativeError> {
        input.options.validate()?;
        let (request, authority, bearer) = self
            .begin_authenticated_read(&input.authority, &input.request_id)
            .await?;
        let response = match self
            .provider
            .list_familiars(authority, bearer, input.options)
            .await
        {
            Ok(response) => response,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
        };
        self.finish_read(
            request,
            input.authority,
            input.request_id,
            NativeResponseOperation::ListFamiliars,
            response,
        )
    }

    pub async fn list_projects(
        &self,
        input: CanonicalPageCommandInput,
    ) -> Result<OperationResult<NativeResponse>, NativeError> {
        input.options.validate()?;
        let (request, authority, bearer) = self
            .begin_authenticated_read(&input.authority, &input.request_id)
            .await?;
        let response = match self
            .provider
            .list_projects(authority, bearer, input.options)
            .await
        {
            Ok(response) => response,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
        };
        self.finish_read(
            request,
            input.authority,
            input.request_id,
            NativeResponseOperation::ListProjects,
            response,
        )
    }

    pub async fn list_conversations(
        &self,
        input: CanonicalPageCommandInput,
    ) -> Result<OperationResult<NativeResponse>, NativeError> {
        input.options.validate()?;
        let (request, authority, bearer) = self
            .begin_authenticated_read(&input.authority, &input.request_id)
            .await?;
        let response = match self
            .provider
            .list_conversations(authority, bearer, input.options)
            .await
        {
            Ok(response) => response,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
        };
        self.finish_read(
            request,
            input.authority,
            input.request_id,
            NativeResponseOperation::ListConversations,
            response,
        )
    }

    pub async fn get_conversation(
        &self,
        input: ConversationCommandInput,
    ) -> Result<OperationResult<NativeResponse>, NativeError> {
        validate_conversation_id(&input.conversation_id)?;
        let (request, authority, bearer) = self
            .begin_authenticated_read(&input.authority, &input.request_id)
            .await?;
        let response = match self
            .provider
            .get_conversation(authority, bearer, input.conversation_id)
            .await
        {
            Ok(response) => response,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
        };
        self.finish_read(
            request,
            input.authority,
            input.request_id,
            NativeResponseOperation::GetConversation,
            response,
        )
    }

    pub async fn list_conversation_messages(
        &self,
        input: ConversationPageCommandInput,
    ) -> Result<OperationResult<NativeResponse>, NativeError> {
        input.options.validate()?;
        validate_conversation_id(&input.conversation_id)?;
        let (request, authority, bearer) = self
            .begin_authenticated_read(&input.authority, &input.request_id)
            .await?;
        let response = match self
            .provider
            .list_conversation_messages(authority, bearer, input.conversation_id, input.options)
            .await
        {
            Ok(response) => response,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
        };
        self.finish_read(
            request,
            input.authority,
            input.request_id,
            NativeResponseOperation::ListConversationMessages,
            response,
        )
    }

    async fn begin_authenticated_read(
        &self,
        authority_reference: &AuthorityReference,
        request_id: &str,
    ) -> Result<(RequestLease, AuthorityDescriptor, SecretValue), NativeError> {
        let request = self
            .lifecycle
            .begin_request(authority_reference, request_id)?;
        let authority = match self.lifecycle.descriptor(authority_reference) {
            Ok(authority) => authority,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
        };
        let authority_fingerprint = match authority.fingerprint() {
            Ok(fingerprint) => fingerprint,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
        };
        let custody = Arc::clone(&self.custody);
        let credential = tauri::async_runtime::spawn_blocking(move || {
            let installation_id = custody.installation_id()?;
            custody.read_credential(&installation_id)
        })
        .await
        .map_err(|_| NativeError::service_unavailable());
        let credential = match credential {
            Ok(Ok(CredentialLookup::Present(credential)))
                if credential.authority_fingerprint == authority_fingerprint =>
            {
                credential
            }
            Ok(Ok(
                CredentialLookup::Missing
                | CredentialLookup::Invalid
                | CredentialLookup::Present(_),
            )) => {
                self.lifecycle.cancel_request(&request);
                return Err(NativeError::reconcile_required());
            }
            Ok(Err(error)) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
        };
        Ok((request, authority, credential.bearer))
    }

    fn finish_read(
        &self,
        request: RequestLease,
        authority: AuthorityReference,
        request_id: String,
        operation: NativeResponseOperation,
        response: NativeResponse,
    ) -> Result<OperationResult<NativeResponse>, NativeError> {
        if let Err(error) = response.validate_operation(operation) {
            self.lifecycle.cancel_request(&request);
            return Err(error);
        }
        self.lifecycle.finish_request(&request)?;
        Ok(OperationResult {
            authority,
            request_id,
            result: response,
        })
    }

    pub fn diagnostics(&self) -> NativeDiagnostics {
        let cleanup_pending = self.recoverable_cleanup_pending();
        let custody = match cleanup_pending {
            Err(error) => SecurityCheck {
                component: SecurityComponent::CaveCredentialCustody,
                status: SecurityStatus::Unavailable,
                code: Some(error.code),
            },
            Ok(true) => SecurityCheck {
                component: SecurityComponent::CaveCredentialCustody,
                status: SecurityStatus::Unavailable,
                code: Some(DiagnosticCode::CredentialUpdateInProgress),
            },
            Ok(false) => match self.custody.availability() {
                CredentialStoreAvailability::Available => SecurityCheck {
                    component: SecurityComponent::CaveCredentialCustody,
                    status: SecurityStatus::Available,
                    code: None,
                },
                CredentialStoreAvailability::PlatformUnavailable => SecurityCheck {
                    component: SecurityComponent::CaveCredentialCustody,
                    status: SecurityStatus::Unavailable,
                    code: Some(DiagnosticCode::PlatformSecurityUnavailable),
                },
                CredentialStoreAvailability::Unavailable => SecurityCheck {
                    component: SecurityComponent::CaveCredentialCustody,
                    status: SecurityStatus::Unavailable,
                    code: Some(DiagnosticCode::SecureStoreUnavailable),
                },
            },
        };
        let provider = if self.provider.available() {
            SecurityCheck {
                component: SecurityComponent::CaveProtectedAuthority,
                status: SecurityStatus::Available,
                code: None,
            }
        } else {
            SecurityCheck {
                component: SecurityComponent::CaveProtectedAuthority,
                status: SecurityStatus::Unavailable,
                code: Some(DiagnosticCode::PlatformSecurityUnavailable),
            }
        };
        let unix = if cfg!(any(target_os = "linux", target_os = "macos")) {
            SecurityCheck {
                component: SecurityComponent::CovenUnixPeerIdentity,
                status: SecurityStatus::Available,
                code: None,
            }
        } else {
            SecurityCheck {
                component: SecurityComponent::CovenUnixPeerIdentity,
                status: SecurityStatus::Unavailable,
                code: Some(DiagnosticCode::PlatformSecurityUnavailable),
            }
        };
        let windows = SecurityCheck {
            component: SecurityComponent::CovenWindowsPipeIdentity,
            status: SecurityStatus::Unavailable,
            code: Some(DiagnosticCode::PlatformSecurityUnavailable),
        };
        NativeDiagnostics::new(vec![custody, provider, unix, windows])
    }

    fn finish_pending_pairing(&self, handle: &str, authority: &AuthorityReference, terminal: bool) {
        if let Ok(mut transient) = self.transient.lock() {
            let matches_authority = transient
                .pairings
                .get(handle)
                .is_some_and(|pending| pending.authority == *authority);
            if matches_authority {
                if terminal {
                    transient.remove_pairing(handle);
                } else if let Some(pending) = transient.pairings.get_mut(handle) {
                    pending.status = PendingPairingStatus::Ready;
                }
            }
        }
    }
}

fn validate_remote_request_id(value: &str) -> Result<(), NativeError> {
    let parsed = Uuid::parse_str(value).map_err(|_| NativeError::invalid_response())?;
    if parsed.to_string() != value {
        return Err(NativeError::invalid_response());
    }
    Ok(())
}

fn deserialize_optional_non_null_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    String::deserialize(deserializer).map(Some)
}

fn validate_conversation_id(value: &str) -> Result<(), NativeError> {
    if value.is_empty()
        || value.len() > 512
        || value == "."
        || value == ".."
        || value.chars().any(char::is_control)
    {
        return Err(NativeError::invalid_request());
    }
    Ok(())
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
    let Some(last) = value.bytes().last() else {
        return false;
    };
    let trailing_value = match last {
        b'A'..=b'Z' => last - b'A',
        b'a'..=b'z' => last - b'a' + 26,
        b'0'..=b'9' => last - b'0' + 52,
        b'-' => 62,
        b'_' => 63,
        _ => return false,
    };
    match value.len() % 4 {
        0 => true,
        2 => trailing_value % 16 == 0,
        3 => trailing_value % 4 == 0,
        _ => false,
    }
}

fn validate_opaque_handle(value: &str, prefix: &str) -> Result<(), NativeError> {
    let Some(uuid) = value.strip_prefix(prefix) else {
        return Err(NativeError::invalid_request());
    };
    if value.len() > MAX_HANDLE_CHARACTERS || Uuid::parse_str(uuid).is_err() {
        return Err(NativeError::invalid_request());
    }
    Ok(())
}

#[cfg(test)]
async fn run_blocking_native<T>(
    operation: impl FnOnce() -> Result<T, NativeError> + Send + 'static,
) -> Result<T, NativeError>
where
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| NativeError::service_unavailable())?
}

pub struct NativeSdkState {
    boundary: Arc<NativeSdkBoundary>,
}

impl NativeSdkState {
    pub fn new(boundary: NativeSdkBoundary) -> Self {
        Self {
            boundary: Arc::new(boundary),
        }
    }

    pub fn production() -> Self {
        Self::new(NativeSdkBoundary::production())
    }
}

#[tauri::command]
pub async fn sdk_installation_identity(
    state: tauri::State<'_, NativeSdkState>,
) -> Result<InstallationIdentity, NativeError> {
    let boundary = Arc::clone(&state.boundary);
    tauri::async_runtime::spawn_blocking(move || boundary.installation_identity())
        .await
        .map_err(|_| NativeError::service_unavailable())?
}

#[tauri::command]
pub async fn sdk_discovery_read(
    state: tauri::State<'_, NativeSdkState>,
) -> Result<DiscoveryReadOutput, NativeError> {
    state.boundary.discovery_read().await
}

#[tauri::command]
pub async fn sdk_authority_establish(
    state: tauri::State<'_, NativeSdkState>,
    input: DiscoveryHandleInput,
) -> Result<AuthorityReference, NativeError> {
    let boundary = Arc::clone(&state.boundary);
    tauri::async_runtime::spawn_blocking(move || boundary.authority_establish(input))
        .await
        .map_err(|_| NativeError::service_unavailable())?
}

#[tauri::command]
pub async fn sdk_authority_close(
    state: tauri::State<'_, NativeSdkState>,
    input: CloseAuthorityInput,
) -> Result<AuthorityCloseResult, NativeError> {
    let boundary = Arc::clone(&state.boundary);
    tauri::async_runtime::spawn_blocking(move || boundary.authority_close(input))
        .await
        .map_err(|_| NativeError::service_unavailable())?
}

#[tauri::command]
pub async fn cave_health(
    state: tauri::State<'_, NativeSdkState>,
    input: HealthCommandInput,
) -> Result<OperationResult<NativeResponse>, NativeError> {
    state.boundary.health(input).await
}

#[tauri::command]
pub async fn cave_managed_pairing_create(
    state: tauri::State<'_, NativeSdkState>,
    input: PairingCreateCommandInput,
) -> Result<OperationResult<ManagedPairingCreatedOutput>, NativeError> {
    state.boundary.managed_pairing_create(input).await
}

#[tauri::command]
pub async fn cave_managed_pairing_poll(
    state: tauri::State<'_, NativeSdkState>,
    input: ManagedPairingCommandInput,
) -> Result<OperationResult<Value>, NativeError> {
    state.boundary.managed_pairing_poll(input).await
}

#[tauri::command]
pub async fn cave_managed_pairing_exchange(
    state: tauri::State<'_, NativeSdkState>,
    input: ManagedPairingCommandInput,
) -> Result<OperationResult<ManagedPairingExchangeOutput>, NativeError> {
    let boundary = Arc::clone(&state.boundary);
    boundary.managed_pairing_exchange(input).await
}

#[tauri::command]
pub async fn cave_credential_state(
    state: tauri::State<'_, NativeSdkState>,
    input: CredentialCommandInput,
) -> Result<OperationResult<CredentialStateOutput>, NativeError> {
    let boundary = Arc::clone(&state.boundary);
    tauri::async_runtime::spawn_blocking(move || boundary.credential_state(input))
        .await
        .map_err(|_| NativeError::service_unavailable())?
}

#[tauri::command]
pub async fn cave_forget_credential(
    state: tauri::State<'_, NativeSdkState>,
    input: CredentialCommandInput,
) -> Result<OperationResult<bool>, NativeError> {
    let boundary = Arc::clone(&state.boundary);
    tauri::async_runtime::spawn_blocking(move || boundary.forget_credential(input))
        .await
        .map_err(|_| NativeError::service_unavailable())?
}

#[tauri::command]
pub async fn cave_list_familiars(
    state: tauri::State<'_, NativeSdkState>,
    input: CanonicalPageCommandInput,
) -> Result<OperationResult<NativeResponse>, NativeError> {
    state.boundary.list_familiars(input).await
}

#[tauri::command]
pub async fn cave_list_projects(
    state: tauri::State<'_, NativeSdkState>,
    input: CanonicalPageCommandInput,
) -> Result<OperationResult<NativeResponse>, NativeError> {
    state.boundary.list_projects(input).await
}

#[tauri::command]
pub async fn cave_list_conversations(
    state: tauri::State<'_, NativeSdkState>,
    input: CanonicalPageCommandInput,
) -> Result<OperationResult<NativeResponse>, NativeError> {
    state.boundary.list_conversations(input).await
}

#[tauri::command]
pub async fn cave_get_conversation(
    state: tauri::State<'_, NativeSdkState>,
    input: ConversationCommandInput,
) -> Result<OperationResult<NativeResponse>, NativeError> {
    state.boundary.get_conversation(input).await
}

#[tauri::command]
pub async fn cave_list_conversation_messages(
    state: tauri::State<'_, NativeSdkState>,
    input: ConversationPageCommandInput,
) -> Result<OperationResult<NativeResponse>, NativeError> {
    state.boundary.list_conversation_messages(input).await
}

#[tauri::command]
pub async fn sdk_native_diagnostics(
    state: tauri::State<'_, NativeSdkState>,
) -> Result<NativeDiagnostics, NativeError> {
    let boundary = Arc::clone(&state.boundary);
    tauri::async_runtime::spawn_blocking(move || boundary.diagnostics())
        .await
        .map_err(|_| NativeError::service_unavailable())
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Barrier, Condvar, Mutex,
    };
    use std::time::{Duration, Instant};

    use serde_json::{json, Value};

    use super::{
        AuthorityDescriptor, AuthorityLifecycle, CanonicalPageCommandInput, CanonicalPageOptions,
        CredentialCommandInput, ManagedNativeAuthorityProvider, NativeSdkBoundary,
        PairingCreateCommandInput, PairingHandleCommandInput, PairingRequest, ProviderFuture,
        ProviderPairingCreated, ProviderPairingExchange,
    };
    use crate::cave_credentials::{
        CredentialCustody, CredentialDeleteResult, CredentialLookup, CredentialRecord,
        CredentialStoreAvailability, PreparedCredential, SecretValue,
    };
    use crate::sdk_diagnostics::{DiagnosticCode, NativeResponseOperation};

    const PUBLIC_KEY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const KEY_ID: &str = "tDE1VahIyqtAoH7mJ7uT3yzaF6EnK70vG9JMvTMCOAM";

    fn authority(instance_id: &str) -> AuthorityDescriptor {
        AuthorityDescriptor::from_json(json!({
            "version": 2,
            "endpoint": {"kind": "http", "url": "http://localhost:3020/"},
            "freshness": {
                "pid": 10,
                "nonce": PUBLIC_KEY,
                "startedAt": "2026-08-28T00:00:00Z"
            },
            "record": {
                "identity": format!("sha256:{}", "a".repeat(64)),
                "device": 1,
                "inode": 2
            },
            "authority": {
                "mechanism": "hpke-bound-v1",
                "mode": "enforce",
                "keyId": KEY_ID,
                "publicKey": PUBLIC_KEY,
                "suite": {"kemId": 32, "kdfId": 1, "aeadId": 2}
            },
            "instanceId": instance_id
        }))
        .expect("fixture should be valid")
    }

    #[test]
    fn duplicate_request_identity_is_rejected_until_completion() {
        let lifecycle = AuthorityLifecycle::default();
        let authority = lifecycle
            .replace(authority("00000000-0000-4000-8000-000000000001"))
            .expect("authority should open");
        let request = lifecycle
            .begin_request(&authority, "request-1")
            .expect("first request should begin");
        assert_eq!(
            lifecycle
                .begin_request(&authority, "request-1")
                .expect_err("duplicate request must fail")
                .code,
            DiagnosticCode::OperationInProgress
        );
        lifecycle
            .finish_request(&request)
            .expect("request should finish");
        assert!(lifecycle.begin_request(&authority, "request-1").is_ok());
    }

    #[test]
    fn closing_requires_the_exact_authority_reference() {
        let lifecycle = AuthorityLifecycle::default();
        let first = lifecycle
            .replace(authority("00000000-0000-4000-8000-000000000001"))
            .expect("authority should open");
        let second = lifecycle
            .replace(authority("00000000-0000-4000-8000-000000000002"))
            .expect("replacement should open");
        assert_eq!(
            lifecycle
                .close(&first)
                .expect_err("stale close must fail")
                .code,
            DiagnosticCode::ReconcileRequired
        );
        assert!(lifecycle.close(&second).expect("current close should work"));
        assert!(!lifecycle
            .close(&second)
            .expect("second close should be absent"));
    }

    #[test]
    fn open_open_interleaving_preserves_new_generation_transients() {
        let boundary =
            NativeSdkBoundary::new(Arc::new(RaceCustody::new(false)), Arc::new(FakeProvider));
        let mut second = None;
        let first = boundary.authority_open_with_transition(
            authority("00000000-0000-4000-8000-000000000001"),
            |_| {
                let reference = boundary
                    .authority_open(authority("00000000-0000-4000-8000-000000000002"))
                    .expect("second authority should open");
                boundary.insert_test_pairing(&reference, "pairing:new-generation");
                boundary.insert_test_staged_credential(&reference, "commit:new-generation");
                second = Some(reference);
            },
        );
        assert_eq!(
            first.expect_err("first open became stale").code,
            DiagnosticCode::ReconcileRequired
        );
        let second = second.expect("second authority reference");
        assert!(boundary.lifecycle.descriptor(&second).is_ok());
        assert!(boundary
            .transient
            .lock()
            .expect("transient lock")
            .pairings
            .contains_key("pairing:new-generation"));
        assert!(boundary
            .transient
            .lock()
            .expect("transient lock")
            .credentials
            .contains_key("commit:new-generation"));
    }

    #[test]
    fn close_open_interleaving_preserves_new_generation_transients() {
        let boundary =
            NativeSdkBoundary::new(Arc::new(RaceCustody::new(false)), Arc::new(FakeProvider));
        let first = boundary
            .authority_open(authority("00000000-0000-4000-8000-000000000001"))
            .expect("first authority should open");
        let mut second = None;
        let closed = boundary
            .authority_close_with_transition(
                super::CloseAuthorityInput { authority: first },
                || {
                    let reference = boundary
                        .authority_open(authority("00000000-0000-4000-8000-000000000002"))
                        .expect("replacement authority should open");
                    boundary.insert_test_pairing(&reference, "pairing:new-generation");
                    boundary.insert_test_staged_credential(&reference, "commit:new-generation");
                    second = Some(reference);
                },
            )
            .expect("close transition should complete");
        assert!(closed.closed);
        let second = second.expect("replacement reference");
        assert!(boundary.lifecycle.descriptor(&second).is_ok());
        assert!(boundary
            .transient
            .lock()
            .expect("transient lock")
            .pairings
            .contains_key("pairing:new-generation"));
        assert!(boundary
            .transient
            .lock()
            .expect("transient lock")
            .credentials
            .contains_key("commit:new-generation"));
    }

    struct FakeCustody {
        writes: AtomicUsize,
    }

    struct ReadableCustody {
        present: AtomicBool,
        authority_fingerprint: String,
    }

    impl CredentialCustody for ReadableCustody {
        fn availability(&self) -> CredentialStoreAvailability {
            CredentialStoreAvailability::Available
        }

        fn installation_id(&self) -> Result<String, crate::NativeError> {
            Ok("00000000-0000-4000-8000-000000000010".into())
        }

        fn read_credential(
            &self,
            _installation_id: &str,
        ) -> Result<CredentialLookup, crate::NativeError> {
            if !self.present.load(Ordering::Relaxed) {
                return Ok(CredentialLookup::Missing);
            }
            Ok(CredentialLookup::Present(
                crate::cave_credentials::CredentialRecord {
                    installation_id: "00000000-0000-4000-8000-000000000010".into(),
                    authority_fingerprint: self.authority_fingerprint.clone(),
                    bearer: SecretValue::bearer(
                        b"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB".to_vec(),
                    )?,
                },
            ))
        }

        fn write_credential(
            &self,
            _credential: &PreparedCredential,
        ) -> Result<(), crate::NativeError> {
            self.present.store(true, Ordering::Relaxed);
            Ok(())
        }

        fn compare_delete_credential(
            &self,
            _expected: &PreparedCredential,
        ) -> Result<CredentialDeleteResult, crate::NativeError> {
            self.present.store(false, Ordering::Relaxed);
            Ok(CredentialDeleteResult::Deleted)
        }
    }

    impl CredentialCustody for FakeCustody {
        fn availability(&self) -> CredentialStoreAvailability {
            CredentialStoreAvailability::Available
        }

        fn installation_id(&self) -> Result<String, crate::NativeError> {
            Ok("00000000-0000-4000-8000-000000000010".into())
        }

        fn read_credential(
            &self,
            _installation_id: &str,
        ) -> Result<CredentialLookup, crate::NativeError> {
            Ok(CredentialLookup::Missing)
        }

        fn write_credential(
            &self,
            _credential: &PreparedCredential,
        ) -> Result<(), crate::NativeError> {
            self.writes.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }

        fn compare_delete_credential(
            &self,
            _expected: &PreparedCredential,
        ) -> Result<CredentialDeleteResult, crate::NativeError> {
            Ok(CredentialDeleteResult::Absent)
        }
    }

    struct FakeProvider;

    struct MetadataProvider {
        credential: Value,
    }

    struct SequencedPairingProvider {
        next: AtomicUsize,
        expires_at: u64,
        poll_status: &'static str,
    }

    impl SequencedPairingProvider {
        fn new(expires_at: u64, poll_status: &'static str) -> Self {
            Self {
                next: AtomicUsize::new(1),
                expires_at,
                poll_status,
            }
        }
    }

    impl ManagedNativeAuthorityProvider for SequencedPairingProvider {
        fn available(&self) -> bool {
            true
        }

        fn health(&self, authority: AuthorityDescriptor) -> ProviderFuture<crate::NativeResponse> {
            FakeProvider.health(authority)
        }

        fn pairing_create(
            &self,
            _authority: AuthorityDescriptor,
            _request: PairingRequest,
        ) -> ProviderFuture<ProviderPairingCreated> {
            let next = self.next.fetch_add(1, Ordering::Relaxed);
            let expires_at = self.expires_at;
            Box::pin(async move {
                Ok(ProviderPairingCreated {
                    remote_request_id: format!("00000000-0000-4000-8000-{next:012x}"),
                    expires_at,
                    pairing_secret: SecretValue::pairing(
                        b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_vec(),
                    )?,
                })
            })
        }

        fn pairing_poll(
            &self,
            _authority: AuthorityDescriptor,
            remote_request_id: String,
            _pairing_secret: SecretValue,
        ) -> ProviderFuture<Value> {
            let expires_at = self.expires_at;
            let status = self.poll_status;
            Box::pin(async move {
                Ok(json!({
                    "id": remote_request_id,
                    "status": status,
                    "expiresAt": expires_at
                }))
            })
        }

        fn pairing_exchange(
            &self,
            authority: AuthorityDescriptor,
            remote_request_id: String,
            pairing_secret: SecretValue,
        ) -> ProviderFuture<ProviderPairingExchange> {
            FakeProvider.pairing_exchange(authority, remote_request_id, pairing_secret)
        }
    }

    impl ManagedNativeAuthorityProvider for MetadataProvider {
        fn available(&self) -> bool {
            true
        }

        fn health(&self, authority: AuthorityDescriptor) -> ProviderFuture<crate::NativeResponse> {
            FakeProvider.health(authority)
        }

        fn pairing_create(
            &self,
            authority: AuthorityDescriptor,
            request: PairingRequest,
        ) -> ProviderFuture<ProviderPairingCreated> {
            FakeProvider.pairing_create(authority, request)
        }

        fn pairing_poll(
            &self,
            authority: AuthorityDescriptor,
            remote_request_id: String,
            pairing_secret: SecretValue,
        ) -> ProviderFuture<Value> {
            FakeProvider.pairing_poll(authority, remote_request_id, pairing_secret)
        }

        fn pairing_exchange(
            &self,
            _authority: AuthorityDescriptor,
            _remote_request_id: String,
            pairing_secret: SecretValue,
        ) -> ProviderFuture<ProviderPairingExchange> {
            let credential = self.credential.clone();
            Box::pin(async move {
                assert_eq!(
                    pairing_secret.expose(),
                    b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
                );
                Ok(ProviderPairingExchange {
                    bearer: SecretValue::bearer(
                        b"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB".to_vec(),
                    )?,
                    credential,
                })
            })
        }
    }

    struct FlakyConfirmationCustody {
        present: AtomicBool,
        fail_reads: AtomicUsize,
        writes: AtomicUsize,
        authority_fingerprint: String,
    }

    impl CredentialCustody for FlakyConfirmationCustody {
        fn availability(&self) -> CredentialStoreAvailability {
            CredentialStoreAvailability::Available
        }

        fn installation_id(&self) -> Result<String, crate::NativeError> {
            Ok("00000000-0000-4000-8000-000000000010".into())
        }

        fn read_credential(
            &self,
            _installation_id: &str,
        ) -> Result<CredentialLookup, crate::NativeError> {
            if self
                .fail_reads
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                    value.checked_sub(1)
                })
                .is_ok()
            {
                return Err(crate::NativeError::service_unavailable());
            }
            if !self.present.load(Ordering::Relaxed) {
                return Ok(CredentialLookup::Missing);
            }
            Ok(CredentialLookup::Present(
                crate::cave_credentials::CredentialRecord {
                    installation_id: "00000000-0000-4000-8000-000000000010".into(),
                    authority_fingerprint: self.authority_fingerprint.clone(),
                    bearer: SecretValue::bearer(
                        b"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB".to_vec(),
                    )?,
                },
            ))
        }

        fn write_credential(
            &self,
            _credential: &PreparedCredential,
        ) -> Result<(), crate::NativeError> {
            self.writes.fetch_add(1, Ordering::Relaxed);
            self.present.store(true, Ordering::Relaxed);
            Ok(())
        }

        fn compare_delete_credential(
            &self,
            _expected: &PreparedCredential,
        ) -> Result<CredentialDeleteResult, crate::NativeError> {
            self.present.store(false, Ordering::Relaxed);
            Ok(CredentialDeleteResult::Deleted)
        }
    }

    impl ManagedNativeAuthorityProvider for FakeProvider {
        fn available(&self) -> bool {
            true
        }

        fn discover(&self) -> ProviderFuture<AuthorityDescriptor> {
            Box::pin(async { Ok(authority("00000000-0000-4000-8000-000000000001")) })
        }

        fn health(&self, _authority: AuthorityDescriptor) -> ProviderFuture<crate::NativeResponse> {
            Box::pin(async {
                crate::NativeResponse::snapshot(
                    NativeResponseOperation::Health,
                    200,
                    json!({
                        "apiVersion": "1.0",
                        "minimumClientVersion": "0.1.0",
                        "capabilities": ["health"],
                        "operations": ["health.read"],
                        "data": {
                            "instanceId": "00000000-0000-4000-8000-000000000001",
                            "pairingRequired": true,
                            "releaseVersion": "0.1.0"
                        }
                    }),
                )
            })
        }

        fn pairing_create(
            &self,
            _authority: AuthorityDescriptor,
            _request: PairingRequest,
        ) -> ProviderFuture<ProviderPairingCreated> {
            Box::pin(async {
                Ok(ProviderPairingCreated {
                    remote_request_id: "11111111-1111-4111-8111-111111111111".into(),
                    expires_at: 2_000_000_000_000,
                    pairing_secret: SecretValue::pairing(
                        b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_vec(),
                    )?,
                })
            })
        }

        fn pairing_poll(
            &self,
            _authority: AuthorityDescriptor,
            _remote_request_id: String,
            pairing_secret: SecretValue,
        ) -> ProviderFuture<Value> {
            Box::pin(async move {
                assert_eq!(
                    pairing_secret.expose(),
                    b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
                );
                Ok(json!({
                    "id": "11111111-1111-4111-8111-111111111111",
                    "status": "approved",
                    "expiresAt": 2_000_000_000_000_u64
                }))
            })
        }

        fn pairing_exchange(
            &self,
            _authority: AuthorityDescriptor,
            _remote_request_id: String,
            pairing_secret: SecretValue,
        ) -> ProviderFuture<ProviderPairingExchange> {
            Box::pin(async move {
                assert_eq!(
                    pairing_secret.expose(),
                    b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
                );
                Ok(ProviderPairingExchange {
                    bearer: SecretValue::bearer(
                        b"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB".to_vec(),
                    )?,
                    credential: json!({
                        "id": "22222222-2222-4222-8222-222222222222",
                        "appName": "OpenCoven Chat",
                        "installationId": "00000000-0000-4000-8000-000000000010",
                        "scopes": ["chat:read"],
                        "createdAt": 2_000_000_000_000_u64,
                        "lastUsedAt": null,
                        "revokedAt": null,
                        "revocationReason": null
                    }),
                })
            })
        }

        fn list_familiars(
            &self,
            _authority: AuthorityDescriptor,
            bearer: SecretValue,
            _options: CanonicalPageOptions,
        ) -> ProviderFuture<crate::NativeResponse> {
            Box::pin(async move {
                assert_eq!(
                    bearer.expose(),
                    b"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
                );
                crate::NativeResponse::snapshot(
                    NativeResponseOperation::ListFamiliars,
                    200,
                    json!({
                        "apiVersion": "1.0",
                        "minimumClientVersion": "0.1.0",
                        "capabilities": ["familiars", "cursors"],
                        "operations": ["familiars.list"],
                        "data": {
                            "familiars": [{
                                "id": "familiar-1",
                                "displayName": "Astra",
                                "role": "Research"
                            }]
                        }
                    }),
                )
            })
        }

        fn list_conversations(
            &self,
            _authority: AuthorityDescriptor,
            bearer: SecretValue,
            _options: CanonicalPageOptions,
        ) -> ProviderFuture<crate::NativeResponse> {
            Box::pin(async move {
                assert_eq!(
                    bearer.expose(),
                    b"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
                );
                crate::NativeResponse::snapshot(
                    NativeResponseOperation::ListConversations,
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
                                "updatedAt": "2026-08-28T11:00:00Z"
                            }]
                        }
                    }),
                )
            })
        }
    }

    struct RaceCustody {
        stored: Mutex<Option<Vec<u8>>>,
        fail_after_write: bool,
        writes: AtomicUsize,
    }

    #[derive(Clone)]
    struct StoredCredentialFixture {
        authority_fingerprint: String,
        bearer: Vec<u8>,
        encoded: Vec<u8>,
    }

    struct ForgetRaceCustody {
        stored: Mutex<Option<StoredCredentialFixture>>,
        gate: Mutex<(bool, bool)>,
        changed: Condvar,
    }

    impl ForgetRaceCustody {
        fn blocking(authority_fingerprint: String, bearer: &[u8]) -> Self {
            Self::new(authority_fingerprint, bearer, false)
        }

        fn ready(authority_fingerprint: String, bearer: &[u8]) -> Self {
            Self::new(authority_fingerprint, bearer, true)
        }

        fn new(authority_fingerprint: String, bearer: &[u8], released: bool) -> Self {
            Self {
                stored: Mutex::new(Some(Self::fixture(authority_fingerprint, bearer))),
                gate: Mutex::new((false, released)),
                changed: Condvar::new(),
            }
        }

        fn fixture(authority_fingerprint: String, bearer: &[u8]) -> StoredCredentialFixture {
            let credential = CredentialRecord {
                installation_id: "00000000-0000-4000-8000-000000000010".into(),
                authority_fingerprint: authority_fingerprint.clone(),
                bearer: SecretValue::bearer(bearer.to_vec()).expect("test bearer"),
            };
            let encoded = PreparedCredential::from_record(&credential)
                .expect("test credential")
                .exact_value()
                .to_vec();
            StoredCredentialFixture {
                authority_fingerprint,
                bearer: bearer.to_vec(),
                encoded,
            }
        }

        fn block_until_released(&self) {
            let mut gate = self.gate.lock().expect("forget gate lock");
            gate.0 = true;
            self.changed.notify_all();
            while !gate.1 {
                gate = self.changed.wait(gate).expect("forget gate wait");
            }
        }

        fn wait_until_operation_starts(&self) {
            let mut gate = self.gate.lock().expect("forget gate lock");
            while !gate.0 {
                gate = self.changed.wait(gate).expect("forget gate wait");
            }
        }

        fn release(&self) {
            let mut gate = self.gate.lock().expect("forget gate lock");
            gate.1 = true;
            self.changed.notify_all();
        }

        fn replace(&self, authority_fingerprint: String, bearer: &[u8]) {
            *self.stored.lock().expect("forget store lock") =
                Some(Self::fixture(authority_fingerprint, bearer));
        }

        fn stored(&self) -> Option<Vec<u8>> {
            self.stored
                .lock()
                .expect("forget store lock")
                .as_ref()
                .map(|credential| credential.encoded.clone())
        }
    }

    impl CredentialCustody for ForgetRaceCustody {
        fn availability(&self) -> CredentialStoreAvailability {
            CredentialStoreAvailability::Available
        }

        fn installation_id(&self) -> Result<String, crate::NativeError> {
            Ok("00000000-0000-4000-8000-000000000010".into())
        }

        fn read_credential(
            &self,
            _installation_id: &str,
        ) -> Result<CredentialLookup, crate::NativeError> {
            let credential = self.stored.lock().expect("forget store lock").clone();
            self.block_until_released();
            let Some(credential) = credential else {
                return Ok(CredentialLookup::Missing);
            };
            Ok(CredentialLookup::Present(CredentialRecord {
                installation_id: "00000000-0000-4000-8000-000000000010".into(),
                authority_fingerprint: credential.authority_fingerprint,
                bearer: SecretValue::bearer(credential.bearer)?,
            }))
        }

        fn write_credential(
            &self,
            credential: &PreparedCredential,
        ) -> Result<(), crate::NativeError> {
            let mut stored = self.stored.lock().expect("forget store lock");
            let Some(current) = stored.as_mut() else {
                return Err(crate::NativeError::invalid_response());
            };
            current.encoded = credential.exact_value().to_vec();
            Ok(())
        }

        fn compare_delete_credential(
            &self,
            expected: &PreparedCredential,
        ) -> Result<CredentialDeleteResult, crate::NativeError> {
            let mut stored = self.stored.lock().expect("forget store lock");
            match stored.as_ref() {
                None => Ok(CredentialDeleteResult::Absent),
                Some(current) if current.encoded.as_slice() != expected.exact_value() => {
                    Ok(CredentialDeleteResult::Changed)
                }
                Some(_) => {
                    *stored = None;
                    Ok(CredentialDeleteResult::Deleted)
                }
            }
        }
    }

    impl RaceCustody {
        fn new(fail_after_write: bool) -> Self {
            Self {
                stored: Mutex::new(None),
                fail_after_write,
                writes: AtomicUsize::new(0),
            }
        }

        fn stored(&self) -> Option<Vec<u8>> {
            self.stored.lock().expect("test store lock").clone()
        }

        fn replace(&self, value: &[u8]) {
            *self.stored.lock().expect("test store lock") = Some(value.to_vec());
        }
    }

    impl CredentialCustody for RaceCustody {
        fn availability(&self) -> CredentialStoreAvailability {
            CredentialStoreAvailability::Available
        }

        fn installation_id(&self) -> Result<String, crate::NativeError> {
            Ok("00000000-0000-4000-8000-000000000010".into())
        }

        fn read_credential(
            &self,
            _installation_id: &str,
        ) -> Result<CredentialLookup, crate::NativeError> {
            Ok(CredentialLookup::Missing)
        }

        fn write_credential(
            &self,
            credential: &PreparedCredential,
        ) -> Result<(), crate::NativeError> {
            self.writes.fetch_add(1, Ordering::Relaxed);
            *self.stored.lock().expect("test store lock") = Some(credential.exact_value().to_vec());
            if self.fail_after_write {
                return Err(crate::NativeError::new(DiagnosticCode::Timeout, false));
            }
            Ok(())
        }

        fn compare_delete_credential(
            &self,
            expected: &PreparedCredential,
        ) -> Result<CredentialDeleteResult, crate::NativeError> {
            let mut stored = self.stored.lock().expect("test store lock");
            match stored.as_ref() {
                None => Ok(CredentialDeleteResult::Absent),
                Some(current) if current.as_slice() != expected.exact_value() => {
                    Ok(CredentialDeleteResult::Changed)
                }
                Some(_) => {
                    *stored = None;
                    Ok(CredentialDeleteResult::Deleted)
                }
            }
        }
    }

    struct BlockingCustody {
        stored: Mutex<Option<Vec<u8>>>,
        gate: Mutex<(bool, bool)>,
        changed: Condvar,
        writes: AtomicUsize,
    }

    struct ContentionCustody {
        stored: Mutex<Option<Vec<u8>>>,
        write_contentions: AtomicUsize,
        delete_contentions: AtomicUsize,
    }

    struct PartialWriteCustody {
        stored: Mutex<Option<Vec<u8>>>,
        rollback_contentions: AtomicUsize,
        writes: AtomicUsize,
    }

    impl PartialWriteCustody {
        fn new() -> Self {
            Self::with_contentions(1)
        }

        fn with_contentions(rollback_contentions: usize) -> Self {
            Self {
                stored: Mutex::new(None),
                rollback_contentions: AtomicUsize::new(rollback_contentions),
                writes: AtomicUsize::new(0),
            }
        }

        fn stored(&self) -> Option<Vec<u8>> {
            self.stored.lock().expect("partial store lock").clone()
        }

        fn replace(&self, value: &[u8]) {
            *self.stored.lock().expect("partial store lock") = Some(value.to_vec());
        }
    }

    impl CredentialCustody for PartialWriteCustody {
        fn availability(&self) -> CredentialStoreAvailability {
            CredentialStoreAvailability::Available
        }

        fn installation_id(&self) -> Result<String, crate::NativeError> {
            Ok("00000000-0000-4000-8000-000000000010".into())
        }

        fn read_credential(
            &self,
            _installation_id: &str,
        ) -> Result<CredentialLookup, crate::NativeError> {
            Ok(CredentialLookup::Missing)
        }

        fn write_credential(
            &self,
            credential: &PreparedCredential,
        ) -> Result<(), crate::NativeError> {
            self.writes.fetch_add(1, Ordering::Relaxed);
            *self.stored.lock().expect("partial store lock") =
                Some(credential.exact_value().to_vec());
            Err(crate::NativeError::new(DiagnosticCode::Timeout, false))
        }

        fn compare_delete_credential(
            &self,
            expected: &PreparedCredential,
        ) -> Result<CredentialDeleteResult, crate::NativeError> {
            if self
                .rollback_contentions
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                    value.checked_sub(1)
                })
                .is_ok()
            {
                return Err(crate::NativeError::credential_update_in_progress());
            }
            let mut stored = self.stored.lock().expect("partial store lock");
            match stored.as_ref() {
                None => Ok(CredentialDeleteResult::Absent),
                Some(current) if current.as_slice() != expected.exact_value() => {
                    Ok(CredentialDeleteResult::Changed)
                }
                Some(_) => {
                    *stored = None;
                    Ok(CredentialDeleteResult::Deleted)
                }
            }
        }
    }

    impl ContentionCustody {
        fn new(write_contentions: usize, delete_contentions: usize) -> Self {
            Self {
                stored: Mutex::new(None),
                write_contentions: AtomicUsize::new(write_contentions),
                delete_contentions: AtomicUsize::new(delete_contentions),
            }
        }
    }

    impl CredentialCustody for ContentionCustody {
        fn availability(&self) -> CredentialStoreAvailability {
            CredentialStoreAvailability::Available
        }

        fn installation_id(&self) -> Result<String, crate::NativeError> {
            Ok("00000000-0000-4000-8000-000000000010".into())
        }

        fn read_credential(
            &self,
            _installation_id: &str,
        ) -> Result<CredentialLookup, crate::NativeError> {
            Ok(CredentialLookup::Missing)
        }

        fn write_credential(
            &self,
            credential: &PreparedCredential,
        ) -> Result<(), crate::NativeError> {
            if self
                .write_contentions
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                    value.checked_sub(1)
                })
                .is_ok()
            {
                return Err(crate::NativeError::credential_update_in_progress());
            }
            *self.stored.lock().expect("contention store lock") =
                Some(credential.exact_value().to_vec());
            Ok(())
        }

        fn compare_delete_credential(
            &self,
            expected: &PreparedCredential,
        ) -> Result<CredentialDeleteResult, crate::NativeError> {
            if self
                .delete_contentions
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                    value.checked_sub(1)
                })
                .is_ok()
            {
                return Err(crate::NativeError::credential_update_in_progress());
            }
            let mut stored = self.stored.lock().expect("contention store lock");
            match stored.as_ref() {
                None => Ok(CredentialDeleteResult::Absent),
                Some(current) if current.as_slice() != expected.exact_value() => {
                    Ok(CredentialDeleteResult::Changed)
                }
                Some(_) => {
                    *stored = None;
                    Ok(CredentialDeleteResult::Deleted)
                }
            }
        }
    }

    struct BlockingPollProvider {
        gate: Arc<(Mutex<(bool, bool)>, Condvar)>,
    }

    struct BlockingExchangeProvider {
        gate: Arc<(Mutex<(bool, bool)>, Condvar)>,
        next_pairing: AtomicUsize,
        exchanges: AtomicUsize,
    }

    impl BlockingExchangeProvider {
        fn new() -> Self {
            Self {
                gate: Arc::new((Mutex::new((false, false)), Condvar::new())),
                next_pairing: AtomicUsize::new(1),
                exchanges: AtomicUsize::new(0),
            }
        }

        fn wait_until_exchanging(&self) {
            let (lock, changed) = &*self.gate;
            let mut state = lock.lock().expect("exchange gate");
            while !state.0 {
                state = changed.wait(state).expect("exchange wait");
            }
        }

        fn release_exchange(&self) {
            let (lock, changed) = &*self.gate;
            let mut state = lock.lock().expect("exchange gate");
            state.1 = true;
            changed.notify_all();
        }
    }

    impl ManagedNativeAuthorityProvider for BlockingExchangeProvider {
        fn available(&self) -> bool {
            true
        }

        fn health(&self, authority: AuthorityDescriptor) -> ProviderFuture<crate::NativeResponse> {
            FakeProvider.health(authority)
        }

        fn pairing_create(
            &self,
            _authority: AuthorityDescriptor,
            _request: PairingRequest,
        ) -> ProviderFuture<ProviderPairingCreated> {
            let next = self.next_pairing.fetch_add(1, Ordering::Relaxed);
            Box::pin(async move {
                Ok(ProviderPairingCreated {
                    remote_request_id: format!("00000000-0000-4000-8000-{next:012x}"),
                    expires_at: 2_000_000_000_000,
                    pairing_secret: SecretValue::pairing(
                        b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_vec(),
                    )?,
                })
            })
        }

        fn pairing_poll(
            &self,
            authority: AuthorityDescriptor,
            remote_request_id: String,
            pairing_secret: SecretValue,
        ) -> ProviderFuture<Value> {
            FakeProvider.pairing_poll(authority, remote_request_id, pairing_secret)
        }

        fn pairing_exchange(
            &self,
            authority: AuthorityDescriptor,
            remote_request_id: String,
            pairing_secret: SecretValue,
        ) -> ProviderFuture<ProviderPairingExchange> {
            if self.exchanges.fetch_add(1, Ordering::Relaxed) == 0 {
                let (lock, changed) = &*self.gate;
                let mut state = match lock.lock() {
                    Ok(state) => state,
                    Err(_) => {
                        return Box::pin(async { Err(crate::NativeError::service_unavailable()) });
                    }
                };
                state.0 = true;
                changed.notify_all();
                while !state.1 {
                    state = match changed.wait(state) {
                        Ok(state) => state,
                        Err(_) => {
                            return Box::pin(async {
                                Err(crate::NativeError::service_unavailable())
                            });
                        }
                    };
                }
            }
            FakeProvider.pairing_exchange(authority, remote_request_id, pairing_secret)
        }
    }

    impl BlockingPollProvider {
        fn new() -> Self {
            Self {
                gate: Arc::new((Mutex::new((false, false)), Condvar::new())),
            }
        }

        fn wait_until_polling(&self) {
            let (lock, changed) = &*self.gate;
            let mut state = lock.lock().expect("poll gate");
            while !state.0 {
                state = changed.wait(state).expect("poll wait");
            }
        }

        fn release_poll(&self) {
            let (lock, changed) = &*self.gate;
            let mut state = lock.lock().expect("poll gate");
            state.1 = true;
            changed.notify_all();
        }
    }

    impl ManagedNativeAuthorityProvider for BlockingPollProvider {
        fn available(&self) -> bool {
            true
        }

        fn health(&self, authority: AuthorityDescriptor) -> ProviderFuture<crate::NativeResponse> {
            FakeProvider.health(authority)
        }

        fn pairing_create(
            &self,
            authority: AuthorityDescriptor,
            request: PairingRequest,
        ) -> ProviderFuture<ProviderPairingCreated> {
            FakeProvider.pairing_create(authority, request)
        }

        fn pairing_poll(
            &self,
            authority: AuthorityDescriptor,
            remote_request_id: String,
            pairing_secret: SecretValue,
        ) -> ProviderFuture<Value> {
            let (lock, changed) = &*self.gate;
            let mut state = match lock.lock() {
                Ok(state) => state,
                Err(_) => {
                    return Box::pin(async { Err(crate::NativeError::service_unavailable()) });
                }
            };
            state.0 = true;
            changed.notify_all();
            while !state.1 {
                state = match changed.wait(state) {
                    Ok(state) => state,
                    Err(_) => {
                        return Box::pin(async { Err(crate::NativeError::service_unavailable()) });
                    }
                };
            }
            drop(state);
            FakeProvider.pairing_poll(authority, remote_request_id, pairing_secret)
        }

        fn pairing_exchange(
            &self,
            authority: AuthorityDescriptor,
            remote_request_id: String,
            pairing_secret: SecretValue,
        ) -> ProviderFuture<ProviderPairingExchange> {
            FakeProvider.pairing_exchange(authority, remote_request_id, pairing_secret)
        }
    }

    struct HungReadCustody {
        gate: Mutex<(bool, bool)>,
        changed: Condvar,
    }

    impl HungReadCustody {
        fn new() -> Self {
            Self {
                gate: Mutex::new((false, false)),
                changed: Condvar::new(),
            }
        }

        fn wait_until_blocked(&self) {
            let mut gate = self.gate.lock().expect("hung store gate");
            while !gate.0 {
                gate = self.changed.wait(gate).expect("hung store wait");
            }
        }

        fn release(&self) {
            let mut gate = self.gate.lock().expect("hung store gate");
            gate.1 = true;
            self.changed.notify_all();
        }

        fn block(&self) {
            let mut gate = self.gate.lock().expect("hung store gate");
            gate.0 = true;
            self.changed.notify_all();
            while !gate.1 {
                gate = self.changed.wait(gate).expect("hung store wait");
            }
        }
    }

    impl CredentialCustody for HungReadCustody {
        fn availability(&self) -> CredentialStoreAvailability {
            CredentialStoreAvailability::Available
        }

        fn installation_id(&self) -> Result<String, crate::NativeError> {
            self.block();
            Ok("00000000-0000-4000-8000-000000000010".into())
        }

        fn read_credential(
            &self,
            _installation_id: &str,
        ) -> Result<CredentialLookup, crate::NativeError> {
            Ok(CredentialLookup::Missing)
        }

        fn write_credential(
            &self,
            _credential: &PreparedCredential,
        ) -> Result<(), crate::NativeError> {
            Ok(())
        }

        fn compare_delete_credential(
            &self,
            _expected: &PreparedCredential,
        ) -> Result<CredentialDeleteResult, crate::NativeError> {
            Ok(CredentialDeleteResult::Absent)
        }
    }

    impl BlockingCustody {
        fn new() -> Self {
            Self {
                stored: Mutex::new(None),
                gate: Mutex::new((false, false)),
                changed: Condvar::new(),
                writes: AtomicUsize::new(0),
            }
        }

        fn wait_until_write_starts(&self) {
            let mut gate = self.gate.lock().expect("test gate lock");
            while !gate.0 {
                gate = self.changed.wait(gate).expect("test gate wait");
            }
        }

        fn release_write(&self) {
            let mut gate = self.gate.lock().expect("test gate lock");
            gate.1 = true;
            self.changed.notify_all();
        }

        fn stored(&self) -> Option<Vec<u8>> {
            self.stored.lock().expect("test store lock").clone()
        }
    }

    impl CredentialCustody for BlockingCustody {
        fn availability(&self) -> CredentialStoreAvailability {
            CredentialStoreAvailability::Available
        }

        fn installation_id(&self) -> Result<String, crate::NativeError> {
            Ok("00000000-0000-4000-8000-000000000010".into())
        }

        fn read_credential(
            &self,
            _installation_id: &str,
        ) -> Result<CredentialLookup, crate::NativeError> {
            Ok(CredentialLookup::Missing)
        }

        fn write_credential(
            &self,
            credential: &PreparedCredential,
        ) -> Result<(), crate::NativeError> {
            if self.writes.fetch_add(1, Ordering::Relaxed) == 0 {
                let mut gate = self.gate.lock().expect("test gate lock");
                gate.0 = true;
                self.changed.notify_all();
                while !gate.1 {
                    gate = self.changed.wait(gate).expect("test gate wait");
                }
            }
            *self.stored.lock().expect("test store lock") = Some(credential.exact_value().to_vec());
            Ok(())
        }

        fn compare_delete_credential(
            &self,
            expected: &PreparedCredential,
        ) -> Result<CredentialDeleteResult, crate::NativeError> {
            let mut stored = self.stored.lock().expect("test store lock");
            match stored.as_ref() {
                None => Ok(CredentialDeleteResult::Absent),
                Some(current) if current.as_slice() != expected.exact_value() => {
                    Ok(CredentialDeleteResult::Changed)
                }
                Some(_) => {
                    *stored = None;
                    Ok(CredentialDeleteResult::Deleted)
                }
            }
        }
    }

    async fn stage_test_credential(
        boundary: &NativeSdkBoundary,
    ) -> (super::AuthorityReference, String) {
        let authority = boundary
            .authority_open(authority("00000000-0000-4000-8000-000000000001"))
            .expect("authority should open");
        let created = boundary
            .pairing_create(PairingCreateCommandInput {
                authority: authority.clone(),
                request_id: "request-create".into(),
                request: PairingRequest {
                    app_name: "OpenCoven Chat".into(),
                    installation_id: "00000000-0000-4000-8000-000000000010".into(),
                    scopes: vec!["chat:read".into()],
                },
            })
            .await
            .expect("pairing should be created");
        let exchanged = boundary
            .pairing_exchange(PairingHandleCommandInput {
                authority: authority.clone(),
                request_id: "request-exchange".into(),
                pairing_handle: created.result.handle,
            })
            .await
            .expect("pairing should exchange");
        (authority, exchanged.result.commit_handle)
    }

    #[test]
    fn managed_exchange_rejects_mismatched_or_revoked_metadata_before_persistence() {
        tauri::async_runtime::block_on(async {
            let cases = [
                (
                    "wrong-app",
                    json!({
                        "id": "22222222-2222-4222-8222-222222222222",
                        "appName": "Different App",
                        "installationId": "00000000-0000-4000-8000-000000000010",
                        "scopes": ["chat:read"],
                        "createdAt": 2_000_000_000_000_u64,
                        "lastUsedAt": null,
                        "revokedAt": null,
                        "revocationReason": null
                    }),
                ),
                (
                    "wrong-installation",
                    json!({
                        "id": "22222222-2222-4222-8222-222222222222",
                        "appName": "OpenCoven Chat",
                        "installationId": "00000000-0000-4000-8000-000000000099",
                        "scopes": ["chat:read"],
                        "createdAt": 2_000_000_000_000_u64,
                        "lastUsedAt": null,
                        "revokedAt": null,
                        "revocationReason": null
                    }),
                ),
                (
                    "missing-required-scope",
                    json!({
                        "id": "22222222-2222-4222-8222-222222222222",
                        "appName": "OpenCoven Chat",
                        "installationId": "00000000-0000-4000-8000-000000000010",
                        "scopes": ["chat:write"],
                        "createdAt": 2_000_000_000_000_u64,
                        "lastUsedAt": null,
                        "revokedAt": null,
                        "revocationReason": null
                    }),
                ),
                (
                    "unrequested-privileged-scope",
                    json!({
                        "id": "22222222-2222-4222-8222-222222222222",
                        "appName": "OpenCoven Chat",
                        "installationId": "00000000-0000-4000-8000-000000000010",
                        "scopes": ["chat:read", "chat:write"],
                        "createdAt": 2_000_000_000_000_u64,
                        "lastUsedAt": null,
                        "revokedAt": null,
                        "revocationReason": null
                    }),
                ),
                (
                    "revoked-metadata",
                    json!({
                        "id": "22222222-2222-4222-8222-222222222222",
                        "appName": "OpenCoven Chat",
                        "installationId": "00000000-0000-4000-8000-000000000010",
                        "scopes": ["chat:read"],
                        "createdAt": 2_000_000_000_000_u64,
                        "lastUsedAt": null,
                        "revokedAt": 2_000_000_000_001_u64,
                        "revocationReason": "revoked"
                    }),
                ),
                (
                    "producer-schema-mismatch",
                    json!({
                        "id": "22222222-2222-4222-8222-222222222222",
                        "appName": "OpenCoven Chat",
                        "installationId": "00000000-0000-4000-8000-000000000010",
                        "scopes": ["chat:read"],
                        "createdAt": 2_000_000_000_000_u64,
                        "lastUsedAt": null,
                        "revokedAt": null,
                        "revocationReason": null,
                        "unexpected": true
                    }),
                ),
            ];

            for (index, (label, credential)) in cases.into_iter().enumerate() {
                let custody = Arc::new(RaceCustody::new(false));
                let boundary = Arc::new(NativeSdkBoundary::new(
                    custody.clone(),
                    Arc::new(MetadataProvider { credential }),
                ));
                let authority = boundary
                    .authority_open(authority("00000000-0000-4000-8000-000000000001"))
                    .expect("authority should open");
                let created = boundary
                    .managed_pairing_create(PairingCreateCommandInput {
                        authority: authority.clone(),
                        request_id: format!("request-create-metadata-{index}"),
                        request: PairingRequest {
                            app_name: "OpenCoven Chat".into(),
                            installation_id: "00000000-0000-4000-8000-000000000010".into(),
                            scopes: vec!["chat:read".into()],
                        },
                    })
                    .await
                    .expect("managed pairing should be created");

                assert_eq!(
                    boundary
                        .managed_pairing_exchange(super::ManagedPairingCommandInput {
                            authority,
                            request_id: format!("request-exchange-metadata-{index}"),
                            pairing_request_id: created.result.request_id,
                        })
                        .await
                        .expect_err(label)
                        .code,
                    DiagnosticCode::InvalidResponse
                );
                assert_eq!(
                    custody.writes.load(Ordering::Relaxed),
                    0,
                    "{label} must fail before persistence"
                );
                assert!(
                    custody.stored().is_none(),
                    "{label} must not leave a credential behind"
                );
            }
        });
    }

    #[test]
    fn discovery_handles_expire_before_establishment() {
        tauri::async_runtime::block_on(async {
            let boundary =
                NativeSdkBoundary::new(Arc::new(RaceCustody::new(false)), Arc::new(FakeProvider));
            let discovered = boundary
                .discovery_read_at(1_000)
                .await
                .expect("discovery should succeed");

            assert_eq!(
                boundary
                    .authority_establish_at(
                        super::DiscoveryHandleInput {
                            discovery_handle: discovered.handle,
                        },
                        1_000 + super::DISCOVERY_TTL_MILLIS,
                    )
                    .expect_err("expired discovery must fail")
                    .code,
                DiagnosticCode::ReconcileRequired
            );
        });
    }

    #[test]
    fn discovery_handles_are_count_bounded() {
        tauri::async_runtime::block_on(async {
            let boundary =
                NativeSdkBoundary::new(Arc::new(RaceCustody::new(false)), Arc::new(FakeProvider));
            let mut handles = Vec::new();
            for index in 0..=super::MAX_RETAINED_DISCOVERIES {
                handles.push(
                    boundary
                        .discovery_read_at(1_000 + index as u64)
                        .await
                        .expect("discovery should succeed")
                        .handle,
                );
            }

            assert_eq!(
                boundary
                    .authority_establish_at(
                        super::DiscoveryHandleInput {
                            discovery_handle: handles[0].clone(),
                        },
                        2_000,
                    )
                    .expect_err("the oldest discovery should be pruned")
                    .code,
                DiagnosticCode::ReconcileRequired
            );
        });
    }

    #[test]
    fn discovery_handles_are_consumed_once() {
        tauri::async_runtime::block_on(async {
            let boundary =
                NativeSdkBoundary::new(Arc::new(RaceCustody::new(false)), Arc::new(FakeProvider));
            let discovered = boundary
                .discovery_read_at(1_000)
                .await
                .expect("discovery should succeed");
            let input = super::DiscoveryHandleInput {
                discovery_handle: discovered.handle,
            };

            boundary
                .authority_establish_at(input.clone(), 1_001)
                .expect("first establishment should win");
            assert_eq!(
                boundary
                    .authority_establish_at(input, 1_002)
                    .expect_err("replayed discovery must fail")
                    .code,
                DiagnosticCode::ReconcileRequired
            );
        });
    }

    #[test]
    fn concurrent_discovery_establishment_has_one_winner() {
        tauri::async_runtime::block_on(async {
            let boundary = Arc::new(NativeSdkBoundary::new(
                Arc::new(RaceCustody::new(false)),
                Arc::new(FakeProvider),
            ));
            let discovered = boundary
                .discovery_read()
                .await
                .expect("discovery should succeed");
            let workers = 16;
            let gate = Arc::new(Barrier::new(workers));
            let mut threads = Vec::new();
            for _ in 0..workers {
                let boundary = Arc::clone(&boundary);
                let gate = Arc::clone(&gate);
                let discovery_handle = discovered.handle.clone();
                threads.push(std::thread::spawn(move || {
                    gate.wait();
                    boundary.authority_establish(super::DiscoveryHandleInput { discovery_handle })
                }));
            }
            let successes = threads
                .into_iter()
                .map(|thread| thread.join().expect("worker should not panic"))
                .filter(Result::is_ok)
                .count();

            assert_eq!(successes, 1, "one-time discovery must have one winner");
        });
    }

    #[test]
    fn concurrent_discoveries_from_one_generation_cannot_replace_each_other() {
        tauri::async_runtime::block_on(async {
            let boundary = Arc::new(NativeSdkBoundary::new(
                Arc::new(RaceCustody::new(false)),
                Arc::new(FakeProvider),
            ));
            let first = boundary
                .discovery_read()
                .await
                .expect("first discovery should succeed");
            let second = boundary
                .discovery_read()
                .await
                .expect("second discovery should succeed");
            let gate = Arc::new(Barrier::new(2));
            let threads = [first.handle, second.handle].map(|discovery_handle| {
                let boundary = Arc::clone(&boundary);
                let gate = Arc::clone(&gate);
                std::thread::spawn(move || {
                    gate.wait();
                    boundary.authority_establish(super::DiscoveryHandleInput { discovery_handle })
                })
            });
            let successes = threads
                .into_iter()
                .map(|thread| thread.join().expect("worker should not panic"))
                .filter(Result::is_ok)
                .count();

            assert_eq!(
                successes, 1,
                "only one handle from a captured authority generation may establish"
            );
        });
    }

    #[test]
    fn late_timed_out_write_is_deleted_by_exact_discard() {
        tauri::async_runtime::block_on(async {
            let custody = Arc::new(RaceCustody::new(true));
            let boundary = NativeSdkBoundary::new(custody.clone(), Arc::new(FakeProvider));
            let (authority, commit_handle) = stage_test_credential(&boundary).await;

            assert_eq!(
                boundary
                    .pairing_commit(super::CommitHandleCommandInput {
                        authority: authority.clone(),
                        request_id: "request-commit".into(),
                        commit_handle: commit_handle.clone(),
                    })
                    .expect_err("the test store reports a timeout after writing")
                    .code,
                DiagnosticCode::Timeout
            );
            let discarded = boundary
                .pairing_discard(super::CommitHandleCommandInput {
                    authority,
                    request_id: "request-discard".into(),
                    commit_handle,
                })
                .expect("late exact discard should complete");
            assert!(matches!(
                discarded.result,
                super::PairingDiscardResult::Deleted
            ));
            assert!(custody.stored().is_none());
        });
    }

    #[test]
    fn discard_deletes_the_exact_committed_value() {
        tauri::async_runtime::block_on(async {
            let custody = Arc::new(RaceCustody::new(false));
            let boundary = NativeSdkBoundary::new(custody.clone(), Arc::new(FakeProvider));
            let (authority, commit_handle) = stage_test_credential(&boundary).await;
            boundary
                .pairing_commit(super::CommitHandleCommandInput {
                    authority: authority.clone(),
                    request_id: "request-commit".into(),
                    commit_handle: commit_handle.clone(),
                })
                .expect("credential should commit");

            let discarded = boundary
                .pairing_discard(super::CommitHandleCommandInput {
                    authority,
                    request_id: "request-discard".into(),
                    commit_handle,
                })
                .expect("exact discard should complete");
            assert!(matches!(
                discarded.result,
                super::PairingDiscardResult::Deleted
            ));
            assert!(custody.stored().is_none());
        });
    }

    #[test]
    fn discard_never_deletes_a_replacement_credential() {
        tauri::async_runtime::block_on(async {
            let custody = Arc::new(RaceCustody::new(false));
            let boundary = NativeSdkBoundary::new(custody.clone(), Arc::new(FakeProvider));
            let (authority, commit_handle) = stage_test_credential(&boundary).await;
            boundary
                .pairing_commit(super::CommitHandleCommandInput {
                    authority: authority.clone(),
                    request_id: "request-commit".into(),
                    commit_handle: commit_handle.clone(),
                })
                .expect("credential should commit");
            custody.replace(b"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC");

            let discarded = boundary
                .pairing_discard(super::CommitHandleCommandInput {
                    authority,
                    request_id: "request-discard".into(),
                    commit_handle,
                })
                .expect("replacement-aware discard should complete");
            assert!(matches!(
                discarded.result,
                super::PairingDiscardResult::Changed
            ));
            assert_eq!(
                custody.stored(),
                Some(b"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC".to_vec())
            );
        });
    }

    #[test]
    fn forget_never_deletes_a_same_authority_replacement_credential() {
        let descriptor = authority("00000000-0000-4000-8000-000000000001");
        let custody = Arc::new(ForgetRaceCustody::blocking(
            descriptor.fingerprint().expect("fixture fingerprint"),
            b"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        ));
        let boundary = Arc::new(NativeSdkBoundary::new(
            custody.clone(),
            Arc::new(FakeProvider),
        ));
        let authority = boundary
            .authority_open(descriptor.clone())
            .expect("authority should open");
        let forget_boundary = Arc::clone(&boundary);
        let forget = std::thread::spawn(move || {
            forget_boundary.forget_credential(CredentialCommandInput {
                authority,
                request_id: "request-forget".into(),
            })
        });

        custody.wait_until_operation_starts();
        custody.replace(
            descriptor.fingerprint().expect("replacement fingerprint"),
            b"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
        );
        let replacement = custody.stored();
        custody.release();

        let error = forget
            .join()
            .expect("forget thread")
            .expect_err("replacement-aware forget must surface contention");
        assert_eq!(error.code, DiagnosticCode::CredentialUpdateInProgress);
        assert!(error.retryable);
        assert_eq!(custody.stored(), replacement);
    }

    #[test]
    fn stale_forget_never_deletes_a_replacement_authority_credential() {
        let first_descriptor = authority("00000000-0000-4000-8000-000000000001");
        let second_descriptor = authority("00000000-0000-4000-8000-000000000002");
        let custody = Arc::new(ForgetRaceCustody::blocking(
            first_descriptor
                .fingerprint()
                .expect("first fixture fingerprint"),
            b"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        ));
        let boundary = Arc::new(NativeSdkBoundary::new(
            custody.clone(),
            Arc::new(FakeProvider),
        ));
        let first = boundary
            .authority_open(first_descriptor)
            .expect("first authority should open");
        let forget_boundary = Arc::clone(&boundary);
        let forget = std::thread::spawn(move || {
            forget_boundary.forget_credential(CredentialCommandInput {
                authority: first,
                request_id: "request-stale-forget".into(),
            })
        });

        custody.wait_until_operation_starts();
        let second = boundary
            .authority_open(second_descriptor.clone())
            .expect("replacement authority should open");
        custody.replace(
            second_descriptor
                .fingerprint()
                .expect("replacement fixture fingerprint"),
            b"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
        );
        let replacement = custody.stored();
        custody.release();

        assert_eq!(
            forget
                .join()
                .expect("forget thread")
                .expect_err("stale forget must fail before deletion")
                .code,
            DiagnosticCode::ReconcileRequired
        );
        assert_eq!(custody.stored(), replacement);
        assert!(boundary.lifecycle.descriptor(&second).is_ok());
    }

    #[test]
    fn wrong_authority_forget_does_not_delete_the_current_credential() {
        let descriptor = authority("00000000-0000-4000-8000-000000000001");
        let custody = Arc::new(ForgetRaceCustody::ready(
            format!("sha256:{}", "b".repeat(64)),
            b"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
        ));
        let expected = custody.stored();
        let boundary = NativeSdkBoundary::new(custody.clone(), Arc::new(FakeProvider));
        let authority = boundary
            .authority_open(descriptor)
            .expect("authority should open");

        let error = boundary
            .forget_credential(CredentialCommandInput {
                authority,
                request_id: "request-wrong-authority-forget".into(),
            })
            .expect_err("wrong-authority credential must not be reported as missing");

        assert_eq!(error.code, DiagnosticCode::StaleRecord);
        assert_eq!(custody.stored(), expected);
    }

    #[test]
    fn forget_reports_false_only_for_confirmed_absence() {
        let boundary =
            NativeSdkBoundary::new(Arc::new(RaceCustody::new(false)), Arc::new(FakeProvider));
        let authority = boundary
            .authority_open(authority("00000000-0000-4000-8000-000000000001"))
            .expect("authority should open");

        let forgotten = boundary
            .forget_credential(CredentialCommandInput {
                authority,
                request_id: "request-forget-missing".into(),
            })
            .expect("confirmed absence should complete");

        assert!(!forgotten.result);
    }

    #[test]
    fn commit_handle_can_retry_after_lock_contention() {
        tauri::async_runtime::block_on(async {
            let custody = Arc::new(ContentionCustody::new(1, 0));
            let boundary = Arc::new(NativeSdkBoundary::new(custody, Arc::new(FakeProvider)));
            let (authority_reference, commit_handle) = stage_test_credential(&boundary).await;
            assert_eq!(
                boundary
                    .pairing_commit(super::CommitHandleCommandInput {
                        authority: authority_reference.clone(),
                        request_id: "request-commit-1".into(),
                        commit_handle: commit_handle.clone(),
                    })
                    .expect_err("first commit should report lock contention")
                    .code,
                DiagnosticCode::CredentialUpdateInProgress
            );
            boundary
                .pairing_commit(super::CommitHandleCommandInput {
                    authority: authority_reference,
                    request_id: "request-commit-2".into(),
                    commit_handle,
                })
                .expect("same commit handle should retry successfully");
        });
    }

    #[test]
    fn retryable_write_contention_refreshes_pending_credential_retention() {
        let authority = super::AuthorityReference {
            handle: "authority:00000000-0000-4000-8000-000000000001".into(),
            generation: 1,
        };
        let credential = CredentialRecord {
            installation_id: "00000000-0000-4000-8000-000000000010".into(),
            authority_fingerprint: format!("sha256:{}", "a".repeat(64)),
            bearer: SecretValue::bearer(b"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB".to_vec())
                .expect("test bearer"),
        };
        let staged = super::StagedCredential::new(
            authority,
            PreparedCredential::from_record(&credential).expect("test credential"),
            0,
        );
        let _credential = staged.begin_write().expect("write should begin");

        assert_eq!(
            staged
                .finish_write(
                    &FakeCustody {
                        writes: AtomicUsize::new(0),
                    },
                    Err(crate::NativeError::credential_update_in_progress()),
                    None,
                )
                .expect_err("retryable contention should preserve the handle")
                .code,
            DiagnosticCode::CredentialUpdateInProgress
        );
        assert!(matches!(
            staged.retention().expect("retention should remain readable"),
            super::StagedCredentialRetention::Pending(staged_at) if staged_at > 0
        ));
    }

    #[test]
    fn managed_exchange_reserves_capacity_before_consuming_pairing_state() {
        tauri::async_runtime::block_on(async {
            let provider = Arc::new(BlockingExchangeProvider::new());
            let boundary = Arc::new(NativeSdkBoundary::new(
                Arc::new(RaceCustody::new(false)),
                provider.clone(),
            ));
            let authority = boundary
                .authority_open(authority("00000000-0000-4000-8000-000000000001"))
                .expect("authority should open");
            let first = boundary
                .managed_pairing_create(PairingCreateCommandInput {
                    authority: authority.clone(),
                    request_id: "request-first-create".into(),
                    request: PairingRequest {
                        app_name: "OpenCoven Chat".into(),
                        installation_id: "00000000-0000-4000-8000-000000000010".into(),
                        scopes: vec!["chat:read".into()],
                    },
                })
                .await
                .expect("first managed pairing should be created");
            let second = boundary
                .managed_pairing_create(PairingCreateCommandInput {
                    authority: authority.clone(),
                    request_id: "request-second-create".into(),
                    request: PairingRequest {
                        app_name: "OpenCoven Chat".into(),
                        installation_id: "00000000-0000-4000-8000-000000000010".into(),
                        scopes: vec!["chat:read".into()],
                    },
                })
                .await
                .expect("second managed pairing should be created");
            let first_request_id = first.result.request_id;
            let second_request_id = second.result.request_id;
            let first_boundary = Arc::clone(&boundary);
            let first_authority = authority.clone();
            let first_exchange = std::thread::spawn(move || {
                tauri::async_runtime::block_on(first_boundary.managed_pairing_exchange(
                    super::ManagedPairingCommandInput {
                        authority: first_authority,
                        request_id: "request-first-exchange".into(),
                        pairing_request_id: first_request_id,
                    },
                ))
            });
            provider.wait_until_exchanging();
            assert_eq!(
                boundary
                    .transient
                    .lock()
                    .expect("transient lock")
                    .credential_reservations
                    .len(),
                1
            );

            let second_result = boundary
                .managed_pairing_exchange(super::ManagedPairingCommandInput {
                    authority,
                    request_id: "request-second-exchange".into(),
                    pairing_request_id: second_request_id.clone(),
                })
                .await;
            provider.release_exchange();
            first_exchange
                .join()
                .expect("first exchange thread")
                .expect("first exchange should complete");

            assert_eq!(
                second_result
                    .expect_err("second exchange must wait for the active reservation")
                    .code,
                DiagnosticCode::CredentialUpdateInProgress
            );
            assert_eq!(provider.exchanges.load(Ordering::Relaxed), 1);
            let transient = boundary.transient.lock().expect("transient lock");
            assert!(transient.managed_pairings.contains_key(&second_request_id));
            assert!(transient.credential_reservations.is_empty());
        });
    }

    #[test]
    fn managed_write_contention_drops_unreachable_commit_handles() {
        tauri::async_runtime::block_on(async {
            let attempts = 65;
            let custody = Arc::new(ContentionCustody::new(attempts, 0));
            let boundary = Arc::new(NativeSdkBoundary::new(
                custody,
                Arc::new(SequencedPairingProvider::new(2_000_000_000_000, "approved")),
            ));
            let authority = boundary
                .authority_open(authority("00000000-0000-4000-8000-000000000001"))
                .expect("authority should open");

            for index in 0..attempts {
                let created = boundary
                    .managed_pairing_create(PairingCreateCommandInput {
                        authority: authority.clone(),
                        request_id: format!("request-create-contention-{index}"),
                        request: PairingRequest {
                            app_name: "OpenCoven Chat".into(),
                            installation_id: "00000000-0000-4000-8000-000000000010".into(),
                            scopes: vec!["chat:read".into()],
                        },
                    })
                    .await
                    .expect("managed pairing should be created");
                assert_eq!(
                    boundary
                        .managed_pairing_exchange(super::ManagedPairingCommandInput {
                            authority: authority.clone(),
                            request_id: format!("request-exchange-contention-{index}"),
                            pairing_request_id: created.result.request_id,
                        })
                        .await
                        .expect_err("managed persistence should report retryable contention")
                        .code,
                    DiagnosticCode::CredentialUpdateInProgress
                );
                assert!(
                    boundary
                        .transient
                        .lock()
                        .expect("transient lock")
                        .credentials
                        .is_empty(),
                    "unreachable managed commit handles must be consumed"
                );
            }
        });
    }

    #[test]
    fn managed_rollback_contention_is_bounded_and_status_reachable() {
        tauri::async_runtime::block_on(async {
            let custody = Arc::new(PartialWriteCustody::with_contentions(100));
            let boundary = Arc::new(NativeSdkBoundary::new(
                custody.clone(),
                Arc::new(SequencedPairingProvider::new(2_000_000_000_000, "approved")),
            ));
            let authority = boundary
                .authority_open(authority("00000000-0000-4000-8000-000000000001"))
                .expect("authority should open");

            for index in 0..8 {
                let created = boundary
                    .managed_pairing_create(PairingCreateCommandInput {
                        authority: authority.clone(),
                        request_id: format!("request-create-rollback-{index}"),
                        request: PairingRequest {
                            app_name: "OpenCoven Chat".into(),
                            installation_id: "00000000-0000-4000-8000-000000000010".into(),
                            scopes: vec!["chat:read".into()],
                        },
                    })
                    .await
                    .expect("managed pairing should be created");
                assert_eq!(
                    boundary
                        .managed_pairing_exchange(super::ManagedPairingCommandInput {
                            authority: authority.clone(),
                            request_id: format!("request-exchange-rollback-{index}"),
                            pairing_request_id: created.result.request_id,
                        })
                        .await
                        .expect_err("rollback contention should remain retryable")
                        .code,
                    DiagnosticCode::CredentialUpdateInProgress
                );
                assert!(
                    boundary
                        .transient
                        .lock()
                        .expect("transient lock")
                        .credentials
                        .len()
                        <= 1,
                    "managed rollback retries must not accumulate credential copies"
                );
            }
            assert_eq!(
                custody.writes.load(Ordering::Relaxed),
                1,
                "status recovery must not replay the ambiguous write"
            );

            custody.rollback_contentions.store(0, Ordering::Relaxed);
            let status = boundary
                .credential_state(CredentialCommandInput {
                    authority,
                    request_id: "request-status-cleanup".into(),
                })
                .expect("credential status should finish exact rollback");
            assert!(matches!(
                status.result.status,
                super::CredentialState::Missing
            ));
            assert!(boundary
                .transient
                .lock()
                .expect("transient lock")
                .credentials
                .is_empty());
        });
    }

    #[test]
    fn stale_managed_exchange_does_not_run_credential_cleanup() {
        tauri::async_runtime::block_on(async {
            let custody = Arc::new(PartialWriteCustody::with_contentions(2));
            let boundary = Arc::new(NativeSdkBoundary::new(
                custody.clone(),
                Arc::new(FakeProvider),
            ));
            let (authority, commit_handle) = stage_test_credential(&boundary).await;
            assert_eq!(
                boundary
                    .pairing_commit(super::CommitHandleCommandInput {
                        authority: authority.clone(),
                        request_id: "request-commit".into(),
                        commit_handle,
                    })
                    .expect_err("initial rollback should contend")
                    .code,
                DiagnosticCode::CredentialUpdateInProgress
            );
            assert_eq!(custody.rollback_contentions.load(Ordering::Relaxed), 1);

            let mut stale_authority = authority;
            stale_authority.generation += 1;
            assert_eq!(
                boundary
                    .managed_pairing_exchange(super::ManagedPairingCommandInput {
                        authority: stale_authority,
                        request_id: "request-stale-managed-exchange".into(),
                        pairing_request_id: "11111111-1111-4111-8111-111111111111".into(),
                    })
                    .await
                    .expect_err("stale authority must fail before cleanup")
                    .code,
                DiagnosticCode::ReconcileRequired
            );
            assert_eq!(
                custody.rollback_contentions.load(Ordering::Relaxed),
                1,
                "unauthorized stale commands must not advance credential cleanup"
            );
        });
    }

    #[test]
    fn stale_authority_close_does_not_run_credential_cleanup() {
        tauri::async_runtime::block_on(async {
            let custody = Arc::new(PartialWriteCustody::with_contentions(2));
            let boundary = NativeSdkBoundary::new(custody.clone(), Arc::new(FakeProvider));
            let (authority, commit_handle) = stage_test_credential(&boundary).await;
            assert_eq!(
                boundary
                    .pairing_commit(super::CommitHandleCommandInput {
                        authority: authority.clone(),
                        request_id: "request-commit".into(),
                        commit_handle,
                    })
                    .expect_err("initial rollback should contend")
                    .code,
                DiagnosticCode::CredentialUpdateInProgress
            );
            assert_eq!(custody.rollback_contentions.load(Ordering::Relaxed), 1);

            let mut stale_authority = authority;
            stale_authority.generation += 1;
            assert_eq!(
                boundary
                    .authority_close(super::CloseAuthorityInput {
                        authority: stale_authority,
                    })
                    .expect_err("stale close must fail before cleanup")
                    .code,
                DiagnosticCode::ReconcileRequired
            );
            assert_eq!(
                custody.rollback_contentions.load(Ordering::Relaxed),
                1,
                "stale close must not advance credential cleanup"
            );
            assert!(custody.stored().is_some());
        });
    }

    #[test]
    fn stale_credential_state_does_not_run_credential_cleanup() {
        tauri::async_runtime::block_on(async {
            let custody = Arc::new(PartialWriteCustody::with_contentions(2));
            let boundary = NativeSdkBoundary::new(custody.clone(), Arc::new(FakeProvider));
            let (authority, commit_handle) = stage_test_credential(&boundary).await;
            assert_eq!(
                boundary
                    .pairing_commit(super::CommitHandleCommandInput {
                        authority: authority.clone(),
                        request_id: "request-commit".into(),
                        commit_handle,
                    })
                    .expect_err("initial rollback should contend")
                    .code,
                DiagnosticCode::CredentialUpdateInProgress
            );
            assert_eq!(custody.rollback_contentions.load(Ordering::Relaxed), 1);

            let mut stale_authority = authority;
            stale_authority.generation += 1;
            assert_eq!(
                boundary
                    .credential_state(CredentialCommandInput {
                        authority: stale_authority,
                        request_id: "request-stale-state".into(),
                    })
                    .expect_err("stale state must fail before cleanup")
                    .code,
                DiagnosticCode::ReconcileRequired
            );
            assert_eq!(
                custody.rollback_contentions.load(Ordering::Relaxed),
                1,
                "stale state must not advance credential cleanup"
            );
            assert!(custody.stored().is_some());
        });
    }

    #[test]
    fn credential_state_does_not_abort_an_active_credential_write() {
        tauri::async_runtime::block_on(async {
            let custody = Arc::new(BlockingCustody::new());
            let boundary = Arc::new(NativeSdkBoundary::new(
                custody.clone(),
                Arc::new(FakeProvider),
            ));
            let (authority, commit_handle) = stage_test_credential(&boundary).await;
            let commit_boundary = Arc::clone(&boundary);
            let commit_authority = authority.clone();
            let commit = std::thread::spawn(move || {
                commit_boundary.pairing_commit(super::CommitHandleCommandInput {
                    authority: commit_authority,
                    request_id: "request-commit".into(),
                    commit_handle,
                })
            });
            custody.wait_until_write_starts();

            let state = boundary
                .credential_state(CredentialCommandInput {
                    authority,
                    request_id: "request-state-during-write".into(),
                })
                .expect("status should observe an active write");
            assert!(matches!(
                state.result.status,
                super::CredentialState::UpdateInProgress
            ));
            custody.release_write();

            commit
                .join()
                .expect("commit thread")
                .expect("status must not abort the active write");
            assert!(custody.stored().is_some());
        });
    }

    #[test]
    fn diagnostics_does_not_advance_recoverable_credential_cleanup() {
        tauri::async_runtime::block_on(async {
            let custody = Arc::new(PartialWriteCustody::with_contentions(2));
            let boundary = NativeSdkBoundary::new(custody.clone(), Arc::new(FakeProvider));
            let (authority, commit_handle) = stage_test_credential(&boundary).await;
            assert_eq!(
                boundary
                    .pairing_commit(super::CommitHandleCommandInput {
                        authority,
                        request_id: "request-commit".into(),
                        commit_handle,
                    })
                    .expect_err("initial rollback should contend")
                    .code,
                DiagnosticCode::CredentialUpdateInProgress
            );
            assert_eq!(custody.rollback_contentions.load(Ordering::Relaxed), 1);

            let diagnostics = boundary.diagnostics();

            assert_eq!(
                custody.rollback_contentions.load(Ordering::Relaxed),
                1,
                "passive diagnostics must not advance credential cleanup"
            );
            assert!(custody.stored().is_some());
            assert!(diagnostics
                .checks
                .iter()
                .any(|check| { check.code == Some(DiagnosticCode::CredentialUpdateInProgress) }));
        });
    }

    #[test]
    fn discard_handle_can_retry_after_lock_contention() {
        tauri::async_runtime::block_on(async {
            let custody = Arc::new(ContentionCustody::new(0, 1));
            let boundary = Arc::new(NativeSdkBoundary::new(custody, Arc::new(FakeProvider)));
            let (authority, commit_handle) = stage_test_credential(&boundary).await;
            boundary
                .pairing_commit(super::CommitHandleCommandInput {
                    authority: authority.clone(),
                    request_id: "request-commit".into(),
                    commit_handle: commit_handle.clone(),
                })
                .expect("credential should commit");
            assert_eq!(
                boundary
                    .pairing_discard(super::CommitHandleCommandInput {
                        authority: authority.clone(),
                        request_id: "request-discard-1".into(),
                        commit_handle: commit_handle.clone(),
                    })
                    .expect_err("first discard should report lock contention")
                    .code,
                DiagnosticCode::CredentialUpdateInProgress
            );
            let discarded = boundary
                .pairing_discard(super::CommitHandleCommandInput {
                    authority,
                    request_id: "request-discard-2".into(),
                    commit_handle,
                })
                .expect("same discard handle should retry");
            assert!(matches!(
                discarded.result,
                super::PairingDiscardResult::Deleted
            ));
        });
    }

    #[test]
    fn partial_write_rollback_contention_preserves_handle_for_discard() {
        tauri::async_runtime::block_on(async {
            let custody = Arc::new(PartialWriteCustody::new());
            let boundary = NativeSdkBoundary::new(custody.clone(), Arc::new(FakeProvider));
            let (authority_reference, commit_handle) = stage_test_credential(&boundary).await;
            assert_eq!(
                boundary
                    .pairing_commit(super::CommitHandleCommandInput {
                        authority: authority_reference.clone(),
                        request_id: "request-commit".into(),
                        commit_handle: commit_handle.clone(),
                    })
                    .expect_err("rollback lock contention should remain retryable")
                    .code,
                DiagnosticCode::CredentialUpdateInProgress
            );
            assert!(custody.stored().is_some());

            let discarded = boundary
                .pairing_discard(super::CommitHandleCommandInput {
                    authority: authority_reference,
                    request_id: "request-discard".into(),
                    commit_handle,
                })
                .expect("discard must retry exact rollback");
            assert!(matches!(
                discarded.result,
                super::PairingDiscardResult::Deleted
            ));
            assert!(custody.stored().is_none());
        });
    }

    #[test]
    fn partial_write_rollback_contention_is_resolved_before_commit_retry() {
        tauri::async_runtime::block_on(async {
            let custody = Arc::new(PartialWriteCustody::new());
            let boundary = NativeSdkBoundary::new(custody.clone(), Arc::new(FakeProvider));
            let (authority, commit_handle) = stage_test_credential(&boundary).await;
            assert_eq!(
                boundary
                    .pairing_commit(super::CommitHandleCommandInput {
                        authority: authority.clone(),
                        request_id: "request-commit-1".into(),
                        commit_handle: commit_handle.clone(),
                    })
                    .expect_err("first rollback should contend")
                    .code,
                DiagnosticCode::CredentialUpdateInProgress
            );
            assert_eq!(
                boundary
                    .pairing_commit(super::CommitHandleCommandInput {
                        authority: authority.clone(),
                        request_id: "request-commit-2".into(),
                        commit_handle: commit_handle.clone(),
                    })
                    .expect_err("retry must finish rollback before any new write")
                    .code,
                DiagnosticCode::Timeout
            );
            assert_eq!(custody.writes.load(Ordering::Relaxed), 1);
            assert!(custody.stored().is_none());

            let discarded = boundary
                .pairing_discard(super::CommitHandleCommandInput {
                    authority,
                    request_id: "request-discard".into(),
                    commit_handle,
                })
                .expect("resolved rollback result should remain observable");
            assert!(matches!(
                discarded.result,
                super::PairingDiscardResult::Deleted
            ));
        });
    }

    #[test]
    fn partial_write_rollback_never_deletes_a_replacement() {
        tauri::async_runtime::block_on(async {
            let custody = Arc::new(PartialWriteCustody::new());
            let boundary = NativeSdkBoundary::new(custody.clone(), Arc::new(FakeProvider));
            let (authority, commit_handle) = stage_test_credential(&boundary).await;
            assert_eq!(
                boundary
                    .pairing_commit(super::CommitHandleCommandInput {
                        authority: authority.clone(),
                        request_id: "request-commit".into(),
                        commit_handle: commit_handle.clone(),
                    })
                    .expect_err("rollback should initially contend")
                    .code,
                DiagnosticCode::CredentialUpdateInProgress
            );
            custody.replace(b"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC");

            let discarded = boundary
                .pairing_discard(super::CommitHandleCommandInput {
                    authority,
                    request_id: "request-discard".into(),
                    commit_handle,
                })
                .expect("rollback retry should compare exact value");
            assert!(matches!(
                discarded.result,
                super::PairingDiscardResult::Changed
            ));
            assert_eq!(
                custody.stored(),
                Some(b"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC".to_vec())
            );
        });
    }

    #[test]
    fn authority_replace_retries_rollback_before_consuming_stale_token() {
        tauri::async_runtime::block_on(async {
            let custody = Arc::new(PartialWriteCustody::with_contentions(2));
            let boundary = NativeSdkBoundary::new(custody.clone(), Arc::new(FakeProvider));
            let (authority_reference, commit_handle) = stage_test_credential(&boundary).await;
            assert_eq!(
                boundary
                    .pairing_commit(super::CommitHandleCommandInput {
                        authority: authority_reference.clone(),
                        request_id: "request-commit".into(),
                        commit_handle: commit_handle.clone(),
                    })
                    .expect_err("initial rollback should contend")
                    .code,
                DiagnosticCode::CredentialUpdateInProgress
            );

            assert_eq!(
                boundary
                    .authority_open(authority("00000000-0000-4000-8000-000000000002"))
                    .expect_err("replacement must surface pending cleanup")
                    .code,
                DiagnosticCode::CredentialUpdateInProgress
            );
            assert!(boundary.lifecycle.descriptor(&authority_reference).is_ok());
            boundary
                .authority_open(authority("00000000-0000-4000-8000-000000000002"))
                .expect("replacement should succeed after exact cleanup");
            assert!(custody.stored().is_none());
            assert!(!boundary
                .transient
                .lock()
                .expect("transient lock")
                .credentials
                .contains_key(&commit_handle));
        });
    }

    #[test]
    fn authority_close_retries_rollback_before_consuming_stale_token() {
        tauri::async_runtime::block_on(async {
            let custody = Arc::new(PartialWriteCustody::with_contentions(2));
            let boundary = NativeSdkBoundary::new(custody.clone(), Arc::new(FakeProvider));
            let (authority, commit_handle) = stage_test_credential(&boundary).await;
            assert_eq!(
                boundary
                    .pairing_commit(super::CommitHandleCommandInput {
                        authority: authority.clone(),
                        request_id: "request-commit".into(),
                        commit_handle: commit_handle.clone(),
                    })
                    .expect_err("initial rollback should contend")
                    .code,
                DiagnosticCode::CredentialUpdateInProgress
            );

            assert_eq!(
                boundary
                    .authority_close(super::CloseAuthorityInput {
                        authority: authority.clone(),
                    })
                    .expect_err("close must surface pending cleanup")
                    .code,
                DiagnosticCode::CredentialUpdateInProgress
            );
            assert!(boundary.lifecycle.descriptor(&authority).is_ok());
            assert!(
                boundary
                    .authority_close(super::CloseAuthorityInput { authority })
                    .expect("close should succeed after exact cleanup")
                    .closed
            );
            assert!(custody.stored().is_none());
            assert!(!boundary
                .transient
                .lock()
                .expect("transient lock")
                .credentials
                .contains_key(&commit_handle));
        });
    }

    #[test]
    fn authority_close_retains_inflight_cleanup_until_exact_disposition() {
        tauri::async_runtime::block_on(async {
            let custody = Arc::new(BlockingCustody::new());
            let boundary = Arc::new(NativeSdkBoundary::new(
                custody.clone(),
                Arc::new(FakeProvider),
            ));
            let (authority, commit_handle) = stage_test_credential(&boundary).await;
            let commit_boundary = Arc::clone(&boundary);
            let commit_authority = authority.clone();
            let commit_handle_for_thread = commit_handle.clone();
            let commit = std::thread::spawn(move || {
                commit_boundary.pairing_commit(super::CommitHandleCommandInput {
                    authority: commit_authority,
                    request_id: "request-commit".into(),
                    commit_handle: commit_handle_for_thread,
                })
            });
            custody.wait_until_write_starts();

            assert!(
                boundary
                    .authority_close(super::CloseAuthorityInput { authority })
                    .expect("close should retain in-flight cleanup state")
                    .closed
            );
            custody.release_write();
            assert_eq!(
                commit
                    .join()
                    .expect("commit thread")
                    .expect_err("closed authority makes commit stale")
                    .code,
                DiagnosticCode::ReconcileRequired
            );
            let _ = boundary.diagnostics();
            assert!(!boundary
                .transient
                .lock()
                .expect("transient lock")
                .credentials
                .contains_key(&commit_handle));
            assert!(custody.stored().is_none());
        });
    }

    #[test]
    fn discard_reports_absent_for_an_unknown_exact_handle() {
        let boundary =
            NativeSdkBoundary::new(Arc::new(RaceCustody::new(false)), Arc::new(FakeProvider));
        let authority = boundary
            .authority_open(authority("00000000-0000-4000-8000-000000000001"))
            .expect("authority should open");
        let discarded = boundary
            .pairing_discard(super::CommitHandleCommandInput {
                authority,
                request_id: "request-discard".into(),
                commit_handle: format!("commit:{}", uuid::Uuid::new_v4()),
            })
            .expect("unknown exact handles should be reported");
        assert!(matches!(
            discarded.result,
            super::PairingDiscardResult::Absent
        ));
    }

    #[test]
    fn discard_reports_absent_for_a_pending_unwritten_credential() {
        tauri::async_runtime::block_on(async {
            let boundary =
                NativeSdkBoundary::new(Arc::new(RaceCustody::new(false)), Arc::new(FakeProvider));
            let (authority, commit_handle) = stage_test_credential(&boundary).await;
            let discarded = boundary
                .pairing_discard(super::CommitHandleCommandInput {
                    authority,
                    request_id: "request-discard".into(),
                    commit_handle,
                })
                .expect("pending exact discard should complete");
            assert!(matches!(
                discarded.result,
                super::PairingDiscardResult::Absent
            ));
        });
    }

    #[test]
    fn timeout_discard_waits_for_a_late_write_and_rolls_it_back() {
        tauri::async_runtime::block_on(async {
            let custody = Arc::new(BlockingCustody::new());
            let boundary = Arc::new(NativeSdkBoundary::new(
                custody.clone(),
                Arc::new(FakeProvider),
            ));
            let (authority, commit_handle) = stage_test_credential(&boundary).await;
            let staged = boundary
                .transient
                .lock()
                .expect("transient state lock")
                .credentials
                .get(&commit_handle)
                .cloned()
                .expect("staged mutation");

            let commit_boundary = Arc::clone(&boundary);
            let commit_authority = authority.clone();
            let commit_handle_for_thread = commit_handle.clone();
            let commit = std::thread::spawn(move || {
                commit_boundary.pairing_commit(super::CommitHandleCommandInput {
                    authority: commit_authority,
                    request_id: "request-commit".into(),
                    commit_handle: commit_handle_for_thread,
                })
            });
            custody.wait_until_write_starts();

            let discard_boundary = Arc::clone(&boundary);
            let discard = std::thread::spawn(move || {
                discard_boundary.pairing_discard(super::CommitHandleCommandInput {
                    authority,
                    request_id: "request-discard".into(),
                    commit_handle,
                })
            });
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let requested = staged.state.lock().is_ok_and(|state| {
                    matches!(
                        *state,
                        super::StagedCredentialState::Writing {
                            discard_requested: true
                        }
                    )
                });
                if requested {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "discard did not reach the mutation"
                );
                std::thread::yield_now();
            }

            custody.release_write();
            assert_eq!(
                commit
                    .join()
                    .expect("commit thread")
                    .expect_err("discarded commit must not report success")
                    .code,
                DiagnosticCode::ReconcileRequired
            );
            let discarded = discard
                .join()
                .expect("discard thread")
                .expect("discard should complete");
            assert!(matches!(
                discarded.result,
                super::PairingDiscardResult::Deleted
            ));
            assert!(custody.stored().is_none());
        });
    }

    #[test]
    fn authority_replacement_before_write_keeps_rollback_state_attached() {
        tauri::async_runtime::block_on(async {
            let custody = Arc::new(PartialWriteCustody::with_contentions(1));
            let boundary = NativeSdkBoundary::new(custody.clone(), Arc::new(FakeProvider));
            let (authority_reference, commit_handle) = stage_test_credential(&boundary).await;
            let commit_handle_for_assertion = commit_handle.clone();

            assert_eq!(
                boundary
                    .pairing_commit_with_transition(
                        super::CommitHandleCommandInput {
                            authority: authority_reference,
                            request_id: "request-commit".into(),
                            commit_handle,
                        },
                        || {
                            boundary
                                .authority_open(authority("00000000-0000-4000-8000-000000000002"))
                                .expect("replacement authority should open");
                        },
                    )
                    .expect_err("stale commit must fail before writing")
                    .code,
                DiagnosticCode::ReconcileRequired
            );
            assert_eq!(custody.writes.load(Ordering::Relaxed), 0);
            assert!(custody.stored().is_none());
            assert!(!boundary
                .transient
                .lock()
                .expect("transient lock")
                .credentials
                .contains_key(&commit_handle_for_assertion));
        });
    }

    #[test]
    fn replacement_credential_waits_for_prior_generation_write_disposition() {
        tauri::async_runtime::block_on(async {
            let custody = Arc::new(BlockingCustody::new());
            let boundary = Arc::new(NativeSdkBoundary::new(
                custody.clone(),
                Arc::new(FakeProvider),
            ));
            let (first_authority, first_commit_handle) = stage_test_credential(&boundary).await;
            let first_boundary = Arc::clone(&boundary);
            let first_commit = std::thread::spawn(move || {
                first_boundary.pairing_commit(super::CommitHandleCommandInput {
                    authority: first_authority,
                    request_id: "request-first-commit".into(),
                    commit_handle: first_commit_handle,
                })
            });
            custody.wait_until_write_starts();

            let second_authority = boundary
                .authority_open(authority("00000000-0000-4000-8000-000000000002"))
                .expect("replacement authority should open");
            let created = boundary
                .pairing_create(PairingCreateCommandInput {
                    authority: second_authority.clone(),
                    request_id: "request-second-create".into(),
                    request: PairingRequest {
                        app_name: "OpenCoven Chat".into(),
                        installation_id: "00000000-0000-4000-8000-000000000010".into(),
                        scopes: vec!["chat:read".into()],
                    },
                })
                .await
                .expect("replacement pairing should be created");
            let exchanged = boundary
                .pairing_exchange(PairingHandleCommandInput {
                    authority: second_authority.clone(),
                    request_id: "request-second-exchange".into(),
                    pairing_handle: created.result.handle,
                })
                .await
                .expect("replacement pairing should exchange");
            let second_commit_handle = exchanged.result.commit_handle;

            let second_result = boundary.pairing_commit(super::CommitHandleCommandInput {
                authority: second_authority.clone(),
                request_id: "request-second-commit".into(),
                commit_handle: second_commit_handle.clone(),
            });
            custody.release_write();
            assert_eq!(
                first_commit
                    .join()
                    .expect("first commit thread")
                    .expect_err("prior generation write should roll back")
                    .code,
                DiagnosticCode::ReconcileRequired
            );

            assert_eq!(
                second_result
                    .expect_err("replacement write must wait for prior disposition")
                    .code,
                DiagnosticCode::CredentialUpdateInProgress
            );
            boundary
                .pairing_commit(super::CommitHandleCommandInput {
                    authority: second_authority,
                    request_id: "request-second-commit-retry".into(),
                    commit_handle: second_commit_handle,
                })
                .expect("replacement write should succeed after prior rollback");
            assert!(custody.stored().is_some());
        });
    }

    #[test]
    fn authority_replacement_rolls_back_a_late_write() {
        tauri::async_runtime::block_on(async {
            let custody = Arc::new(BlockingCustody::new());
            let boundary = Arc::new(NativeSdkBoundary::new(
                custody.clone(),
                Arc::new(FakeProvider),
            ));
            let (authority_reference, commit_handle) = stage_test_credential(&boundary).await;
            let commit_boundary = Arc::clone(&boundary);
            let commit = std::thread::spawn(move || {
                commit_boundary.pairing_commit(super::CommitHandleCommandInput {
                    authority: authority_reference,
                    request_id: "request-commit".into(),
                    commit_handle,
                })
            });
            custody.wait_until_write_starts();

            boundary
                .authority_open(authority("00000000-0000-4000-8000-000000000002"))
                .expect("replacement authority should open");
            custody.release_write();

            assert_eq!(
                commit
                    .join()
                    .expect("commit thread")
                    .expect_err("stale late commit must fail")
                    .code,
                DiagnosticCode::ReconcileRequired
            );
            assert!(custody.stored().is_none());
        });
    }

    #[test]
    fn concurrent_poll_does_not_consume_pairing_before_exchange_validation() {
        tauri::async_runtime::block_on(async {
            let provider = Arc::new(BlockingPollProvider::new());
            let boundary = Arc::new(NativeSdkBoundary::new(
                Arc::new(RaceCustody::new(false)),
                provider.clone(),
            ));
            let authority = boundary
                .authority_open(authority("00000000-0000-4000-8000-000000000001"))
                .expect("authority should open");
            let created = boundary
                .pairing_create(PairingCreateCommandInput {
                    authority: authority.clone(),
                    request_id: "request-create".into(),
                    request: PairingRequest {
                        app_name: "OpenCoven Chat".into(),
                        installation_id: "00000000-0000-4000-8000-000000000010".into(),
                        scopes: vec!["chat:read".into()],
                    },
                })
                .await
                .expect("pairing should be created");
            let pairing_handle = created.result.handle;
            let poll_boundary = Arc::clone(&boundary);
            let poll_authority = authority.clone();
            let poll_handle = pairing_handle.clone();
            let poll = std::thread::spawn(move || {
                tauri::async_runtime::block_on(poll_boundary.pairing_poll(
                    PairingHandleCommandInput {
                        authority: poll_authority,
                        request_id: "request-poll".into(),
                        pairing_handle: poll_handle,
                    },
                ))
            });
            provider.wait_until_polling();

            assert_eq!(
                boundary
                    .pairing_exchange(PairingHandleCommandInput {
                        authority: authority.clone(),
                        request_id: "request-exchange-busy".into(),
                        pairing_handle: pairing_handle.clone(),
                    })
                    .await
                    .expect_err("exchange must reject a concurrent poll")
                    .code,
                DiagnosticCode::OperationInProgress
            );
            assert!(boundary
                .transient
                .lock()
                .expect("transient lock")
                .pairings
                .contains_key(&pairing_handle));
            provider.release_poll();
            poll.join()
                .expect("poll thread")
                .expect("poll should complete");
            boundary
                .pairing_exchange(PairingHandleCommandInput {
                    authority,
                    request_id: "request-exchange-retry".into(),
                    pairing_handle,
                })
                .await
                .expect("pairing should survive and exchange");
        });
    }

    #[test]
    fn mismatched_pairing_authority_does_not_remove_handle() {
        tauri::async_runtime::block_on(async {
            let boundary =
                NativeSdkBoundary::new(Arc::new(RaceCustody::new(false)), Arc::new(FakeProvider));
            let authority = boundary
                .authority_open(authority("00000000-0000-4000-8000-000000000001"))
                .expect("authority should open");
            let pairing_handle = format!("pairing:{}", uuid::Uuid::new_v4());
            let mismatched = super::AuthorityReference {
                handle: format!("authority:{}", uuid::Uuid::new_v4()),
                generation: authority.generation,
            };
            {
                let mut transient = boundary.transient.lock().expect("transient lock");
                let sequence = transient
                    .allocate_sequence()
                    .expect("test pairing sequence");
                transient.pairings.insert(
                    pairing_handle.clone(),
                    super::PendingPairing {
                        authority: mismatched,
                        app_name: "OpenCoven Chat".into(),
                        installation_id: "00000000-0000-4000-8000-000000000010".into(),
                        scopes: vec!["chat:read".into()],
                        remote_request_id: "11111111-1111-4111-8111-111111111111".into(),
                        pairing_secret: SecretValue::pairing(
                            b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_vec(),
                        )
                        .expect("pairing secret"),
                        expires_at: u64::MAX,
                        sequence,
                        status: super::PendingPairingStatus::Ready,
                    },
                );
            }

            assert_eq!(
                boundary
                    .pairing_exchange(PairingHandleCommandInput {
                        authority,
                        request_id: "request-exchange".into(),
                        pairing_handle: pairing_handle.clone(),
                    })
                    .await
                    .expect_err("mismatched pairing authority must fail")
                    .code,
                DiagnosticCode::ReconcileRequired
            );
            assert!(boundary
                .transient
                .lock()
                .expect("transient lock")
                .pairings
                .contains_key(&pairing_handle));
        });
    }

    #[test]
    fn hung_credential_io_does_not_block_authority_replacement() {
        let custody = Arc::new(HungReadCustody::new());
        let boundary = Arc::new(NativeSdkBoundary::new(
            custody.clone(),
            Arc::new(FakeProvider),
        ));
        let first = boundary
            .authority_open(authority("00000000-0000-4000-8000-000000000001"))
            .expect("first authority should open");
        let state_boundary = Arc::clone(&boundary);
        let state = std::thread::spawn(move || {
            state_boundary.credential_state(CredentialCommandInput {
                authority: first,
                request_id: "request-state".into(),
            })
        });
        custody.wait_until_blocked();

        let open_boundary = Arc::clone(&boundary);
        let (opened_tx, opened_rx) = std::sync::mpsc::channel();
        let open = std::thread::spawn(move || {
            opened_tx
                .send(
                    open_boundary.authority_open(authority("00000000-0000-4000-8000-000000000002")),
                )
                .expect("send open result");
        });
        let responsive = opened_rx.recv_timeout(Duration::from_secs(1));
        custody.release();
        open.join().expect("open thread");
        assert!(responsive
            .expect("authority replacement must not wait for credential I/O")
            .is_ok());
        assert_eq!(
            state
                .join()
                .expect("credential state thread")
                .expect_err("stale state must be rejected")
                .code,
            DiagnosticCode::ReconcileRequired
        );
    }

    #[test]
    fn contended_transition_cleanup_does_not_stall_unrelated_runtime_work() {
        tauri::async_runtime::block_on(async {
            let service = "ai.opencoven.chat.runtime-test";
            let account = format!("test-{}", uuid::Uuid::new_v4());
            let held = crate::credential_lock::CredentialMutationLock::acquire(service, &account)
                .expect("hold test lock");
            let blocked_account = account.clone();
            let blocked = tauri::async_runtime::spawn(async move {
                super::run_blocking_native(move || {
                    crate::credential_lock::CredentialMutationLock::acquire_with_timeout(
                        service,
                        &blocked_account,
                        Duration::from_millis(50),
                    )
                    .map(drop)
                })
                .await
            });
            let unrelated = tauri::async_runtime::spawn(async { 7_u8 });
            assert_eq!(unrelated.await.expect("unrelated runtime task"), 7);
            assert_eq!(
                blocked
                    .await
                    .expect("blocked transition task")
                    .expect_err("lock acquisition should time out")
                    .code,
                DiagnosticCode::CredentialUpdateInProgress
            );
            drop(held);
            crate::credential_lock::remove_test_lock(service, &account);
        });
    }

    #[test]
    fn blocked_authority_transition_does_not_hold_the_lifecycle_lock() {
        let boundary = Arc::new(NativeSdkBoundary::new(
            Arc::new(RaceCustody::new(false)),
            Arc::new(FakeProvider),
        ));
        let authority = boundary
            .authority_open(authority("00000000-0000-4000-8000-000000000001"))
            .expect("authority should open");
        let transient = boundary.transient.lock().expect("hold transient lock");
        let close_boundary = Arc::clone(&boundary);
        let close = std::thread::spawn(move || {
            close_boundary.authority_close(super::CloseAuthorityInput { authority })
        });

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match boundary.authority_mutation.try_lock() {
                Err(std::sync::TryLockError::WouldBlock) => break,
                Err(std::sync::TryLockError::Poisoned(_)) => {
                    panic!("authority mutation lock poisoned")
                }
                Ok(mutation) => drop(mutation),
            }
            assert!(
                Instant::now() < deadline,
                "close did not begin its guarded transition"
            );
            std::thread::yield_now();
        }

        let lifecycle = Arc::clone(&boundary);
        let (sent, received) = std::sync::mpsc::channel();
        let context = std::thread::spawn(move || {
            sent.send(lifecycle.lifecycle.context())
                .expect("send lifecycle result");
        });
        let responsive = received.recv_timeout(Duration::from_secs(1));
        drop(transient);

        let closed = close
            .join()
            .expect("close thread")
            .expect("close should complete");
        context.join().expect("context thread");
        assert!(
            responsive.is_ok(),
            "transition waiting on transient state must not retain the lifecycle lock"
        );
        assert!(closed.closed);
    }

    #[test]
    fn terminal_managed_pairing_status_consumes_native_state() {
        tauri::async_runtime::block_on(async {
            let boundary = NativeSdkBoundary::new(
                Arc::new(RaceCustody::new(false)),
                Arc::new(SequencedPairingProvider::new(2_000_000_000_000, "denied")),
            );
            let authority = boundary
                .authority_open(authority("00000000-0000-4000-8000-000000000001"))
                .expect("authority should open");
            let created = boundary
                .managed_pairing_create(PairingCreateCommandInput {
                    authority: authority.clone(),
                    request_id: "request-create-terminal".into(),
                    request: PairingRequest {
                        app_name: "OpenCoven Chat".into(),
                        installation_id: "00000000-0000-4000-8000-000000000010".into(),
                        scopes: vec!["chat:read".into()],
                    },
                })
                .await
                .expect("pairing should be created");

            let status = boundary
                .managed_pairing_poll(super::ManagedPairingCommandInput {
                    authority,
                    request_id: "request-poll-terminal".into(),
                    pairing_request_id: created.result.request_id.clone(),
                })
                .await
                .expect("terminal status should still be returned");
            assert_eq!(status.result["status"], "denied");

            let transient = boundary.transient.lock().expect("transient lock");
            assert!(transient.pairings.is_empty());
            assert!(!transient
                .managed_pairings
                .contains_key(&created.result.request_id));
        });
    }

    #[test]
    fn expired_pairing_is_pruned_before_native_poll() {
        tauri::async_runtime::block_on(async {
            let boundary = NativeSdkBoundary::new(
                Arc::new(RaceCustody::new(false)),
                Arc::new(SequencedPairingProvider::new(1, "approved")),
            );
            let authority = boundary
                .authority_open(authority("00000000-0000-4000-8000-000000000001"))
                .expect("authority should open");
            let created = boundary
                .managed_pairing_create(PairingCreateCommandInput {
                    authority: authority.clone(),
                    request_id: "request-create-expired".into(),
                    request: PairingRequest {
                        app_name: "OpenCoven Chat".into(),
                        installation_id: "00000000-0000-4000-8000-000000000010".into(),
                        scopes: vec!["chat:read".into()],
                    },
                })
                .await
                .expect("pairing creation response should be returned");

            assert_eq!(
                boundary
                    .managed_pairing_poll(super::ManagedPairingCommandInput {
                        authority,
                        request_id: "request-poll-expired".into(),
                        pairing_request_id: created.result.request_id,
                    })
                    .await
                    .expect_err("expired native state must be consumed before polling")
                    .code,
                DiagnosticCode::ReconcileRequired
            );
        });
    }

    #[test]
    fn managed_pairing_retention_evicts_the_oldest_entry_at_the_bound() {
        tauri::async_runtime::block_on(async {
            let boundary = NativeSdkBoundary::new(
                Arc::new(RaceCustody::new(false)),
                Arc::new(SequencedPairingProvider::new(2_000_000_000_000, "pending")),
            );
            let authority = boundary
                .authority_open(authority("00000000-0000-4000-8000-000000000001"))
                .expect("authority should open");
            let mut first_request_id = None;
            for index in 0..65 {
                let created = boundary
                    .managed_pairing_create(PairingCreateCommandInput {
                        authority: authority.clone(),
                        request_id: format!("request-create-{index}"),
                        request: PairingRequest {
                            app_name: "OpenCoven Chat".into(),
                            installation_id: "00000000-0000-4000-8000-000000000010".into(),
                            scopes: vec!["chat:read".into()],
                        },
                    })
                    .await
                    .expect("bounded pairing should be created");
                first_request_id.get_or_insert(created.result.request_id);
            }

            let transient = boundary.transient.lock().expect("transient lock");
            assert_eq!(transient.pairings.len(), 64);
            assert_eq!(transient.managed_pairings.len(), 64);
            assert!(!transient
                .managed_pairings
                .contains_key(first_request_id.as_deref().expect("first request id")));
        });
    }

    #[test]
    fn committed_credential_retention_rejects_new_stages_at_the_count_bound() {
        tauri::async_runtime::block_on(async {
            let boundary =
                NativeSdkBoundary::new(Arc::new(RaceCustody::new(false)), Arc::new(FakeProvider));
            let authority = boundary
                .authority_open(authority("00000000-0000-4000-8000-000000000001"))
                .expect("authority should open");
            let mut first_commit_handle = None;
            for index in 0..super::MAX_RETAINED_CREDENTIALS {
                let created = boundary
                    .pairing_create(PairingCreateCommandInput {
                        authority: authority.clone(),
                        request_id: format!("request-create-credential-{index}"),
                        request: PairingRequest {
                            app_name: "OpenCoven Chat".into(),
                            installation_id: "00000000-0000-4000-8000-000000000010".into(),
                            scopes: vec!["chat:read".into()],
                        },
                    })
                    .await
                    .expect("pairing should be created");
                let exchanged = boundary
                    .pairing_exchange(PairingHandleCommandInput {
                        authority: authority.clone(),
                        request_id: format!("request-exchange-credential-{index}"),
                        pairing_handle: created.result.handle,
                    })
                    .await
                    .expect("pairing should exchange");
                let commit_handle = exchanged.result.commit_handle;
                first_commit_handle.get_or_insert(commit_handle.clone());
                boundary
                    .pairing_commit(super::CommitHandleCommandInput {
                        authority: authority.clone(),
                        request_id: format!("request-commit-credential-{index}"),
                        commit_handle,
                    })
                    .expect("credential should commit");
            }

            let rejected = boundary
                .pairing_create(PairingCreateCommandInput {
                    authority: authority.clone(),
                    request_id: "request-create-credential-overflow".into(),
                    request: PairingRequest {
                        app_name: "OpenCoven Chat".into(),
                        installation_id: "00000000-0000-4000-8000-000000000010".into(),
                        scopes: vec!["chat:read".into()],
                    },
                })
                .await
                .expect("overflow pairing should be created");
            assert_eq!(
                boundary
                    .pairing_exchange(PairingHandleCommandInput {
                        authority,
                        request_id: "request-exchange-credential-overflow".into(),
                        pairing_handle: rejected.result.handle,
                    })
                    .await
                    .expect_err("live committed handles must not be evicted")
                    .code,
                DiagnosticCode::CredentialUpdateInProgress
            );

            let mut transient = boundary.transient.lock().expect("transient lock");
            assert_eq!(transient.credentials.len(), super::MAX_RETAINED_CREDENTIALS);
            assert!(transient
                .credentials
                .contains_key(first_commit_handle.as_deref().expect("first commit handle")));
            transient
                .prune_credentials(u64::MAX)
                .expect("terminal TTL cleanup should succeed");
            assert!(transient.credentials.is_empty());
        });
    }

    #[test]
    fn abandoned_direct_stages_reject_overflow_without_evicting_reachable_handles() {
        tauri::async_runtime::block_on(async {
            let custody = Arc::new(RaceCustody::new(false));
            let boundary = NativeSdkBoundary::new(custody.clone(), Arc::new(FakeProvider));
            let authority = boundary
                .authority_open(authority("00000000-0000-4000-8000-000000000001"))
                .expect("authority should open");
            let mut first_commit_handle = None;
            let mut first_staged = None;
            let mut latest_commit_handle = None;
            for index in 0..super::MAX_RETAINED_CREDENTIALS {
                let created = boundary
                    .pairing_create(PairingCreateCommandInput {
                        authority: authority.clone(),
                        request_id: format!("request-create-abandoned-{index}"),
                        request: PairingRequest {
                            app_name: "OpenCoven Chat".into(),
                            installation_id: "00000000-0000-4000-8000-000000000010".into(),
                            scopes: vec!["chat:read".into()],
                        },
                    })
                    .await
                    .expect("pairing should be created");
                let exchanged = boundary
                    .pairing_exchange(PairingHandleCommandInput {
                        authority: authority.clone(),
                        request_id: format!("request-exchange-abandoned-{index}"),
                        pairing_handle: created.result.handle,
                    })
                    .await
                    .expect("pairing should exchange");
                let commit_handle = exchanged.result.commit_handle;
                if first_commit_handle.is_none() {
                    first_staged = boundary
                        .transient
                        .lock()
                        .expect("transient lock")
                        .credentials
                        .get(&commit_handle)
                        .map(Arc::downgrade);
                    first_commit_handle = Some(commit_handle.clone());
                }
                latest_commit_handle = Some(commit_handle);
            }

            let rejected = boundary
                .pairing_create(PairingCreateCommandInput {
                    authority: authority.clone(),
                    request_id: "request-create-abandoned-overflow".into(),
                    request: PairingRequest {
                        app_name: "OpenCoven Chat".into(),
                        installation_id: "00000000-0000-4000-8000-000000000010".into(),
                        scopes: vec!["chat:read".into()],
                    },
                })
                .await
                .expect("overflow pairing should be created");
            assert_eq!(
                boundary
                    .pairing_exchange(PairingHandleCommandInput {
                        authority: authority.clone(),
                        request_id: "request-exchange-abandoned-overflow".into(),
                        pairing_handle: rejected.result.handle,
                    })
                    .await
                    .expect_err("live pending handles must not be evicted")
                    .code,
                DiagnosticCode::CredentialUpdateInProgress
            );

            let latest_commit_handle = latest_commit_handle.expect("latest commit handle");
            {
                let transient = boundary.transient.lock().expect("transient lock");
                assert_eq!(transient.credentials.len(), super::MAX_RETAINED_CREDENTIALS);
                assert!(transient
                    .credentials
                    .contains_key(first_commit_handle.as_deref().expect("first commit handle")));
                assert!(transient.credentials.contains_key(&latest_commit_handle));
            }
            assert!(first_staged
                .expect("first staged credential")
                .upgrade()
                .is_some());

            boundary
                .pairing_commit(super::CommitHandleCommandInput {
                    authority,
                    request_id: "request-commit-latest".into(),
                    commit_handle: latest_commit_handle,
                })
                .expect("latest reachable confirmation should still commit");
            assert_eq!(custody.writes.load(Ordering::Relaxed), 1);
        });
    }

    #[test]
    fn abandoned_direct_staged_credentials_are_ttl_pruned_and_dropped() {
        tauri::async_runtime::block_on(async {
            let boundary =
                NativeSdkBoundary::new(Arc::new(RaceCustody::new(false)), Arc::new(FakeProvider));
            let (_authority, commit_handle) = stage_test_credential(&boundary).await;
            let staged = {
                let transient = boundary.transient.lock().expect("transient lock");
                Arc::downgrade(
                    transient
                        .credentials
                        .get(&commit_handle)
                        .expect("staged credential"),
                )
            };

            boundary
                .transient
                .lock()
                .expect("transient lock")
                .prune_credentials(u64::MAX)
                .expect("staged TTL cleanup should succeed");

            assert!(!boundary
                .transient
                .lock()
                .expect("transient lock")
                .credentials
                .contains_key(&commit_handle));
            assert!(staged.upgrade().is_none());
        });
    }

    #[test]
    fn credential_reservations_are_ttl_pruned() {
        let mut transient = super::TransientState::default();
        transient.credential_reservations.insert(
            "commit:00000000-0000-4000-8000-000000000001".into(),
            super::CredentialReservation {
                authority: super::AuthorityReference {
                    handle: "authority:00000000-0000-4000-8000-000000000001".into(),
                    generation: 1,
                },
                expires_at: 10,
            },
        );

        transient
            .prune_credentials(10)
            .expect("reservation TTL cleanup should succeed");

        assert!(transient.credential_reservations.is_empty());
    }

    #[test]
    fn confirmation_retry_reads_status_without_retaining_or_recommitting() {
        tauri::async_runtime::block_on(async {
            let descriptor = authority("00000000-0000-4000-8000-000000000001");
            let custody = Arc::new(FlakyConfirmationCustody {
                present: AtomicBool::new(false),
                fail_reads: AtomicUsize::new(1),
                writes: AtomicUsize::new(0),
                authority_fingerprint: descriptor.fingerprint().expect("fixture fingerprint"),
            });
            let boundary = Arc::new(NativeSdkBoundary::new(
                custody.clone(),
                Arc::new(FakeProvider),
            ));
            let authority = boundary
                .authority_open(descriptor)
                .expect("authority should open");
            let created = boundary
                .managed_pairing_create(PairingCreateCommandInput {
                    authority: authority.clone(),
                    request_id: "request-create-confirm".into(),
                    request: PairingRequest {
                        app_name: "OpenCoven Chat".into(),
                        installation_id: "00000000-0000-4000-8000-000000000010".into(),
                        scopes: vec!["chat:read".into()],
                    },
                })
                .await
                .expect("pairing should be created");
            boundary
                .managed_pairing_exchange(super::ManagedPairingCommandInput {
                    authority: authority.clone(),
                    request_id: "request-exchange-confirm".into(),
                    pairing_request_id: created.result.request_id,
                })
                .await
                .expect("exchange and persistence should succeed");

            assert_eq!(custody.writes.load(Ordering::Relaxed), 1);
            assert!(boundary
                .transient
                .lock()
                .expect("transient lock")
                .credentials
                .is_empty());
            assert_eq!(
                boundary
                    .credential_state(CredentialCommandInput {
                        authority: authority.clone(),
                        request_id: "request-confirm-failed".into(),
                    })
                    .expect_err("first confirmation read should fail")
                    .code,
                DiagnosticCode::ServiceUnavailable
            );
            let confirmed = boundary
                .credential_state(CredentialCommandInput {
                    authority,
                    request_id: "request-confirm-retry".into(),
                })
                .expect("confirmation retry should read the persisted credential");
            assert!(matches!(
                confirmed.result.status,
                super::CredentialState::Present
            ));
            assert_eq!(custody.writes.load(Ordering::Relaxed), 1);
        });
    }

    #[test]
    fn pairing_lifecycle_keeps_secrets_out_of_command_results() {
        tauri::async_runtime::block_on(async {
            let custody = Arc::new(FakeCustody {
                writes: AtomicUsize::new(0),
            });
            let boundary = NativeSdkBoundary::new(custody.clone(), Arc::new(FakeProvider));
            let authority = boundary
                .authority_open(authority("00000000-0000-4000-8000-000000000001"))
                .expect("authority should open");
            let created = boundary
                .pairing_create(PairingCreateCommandInput {
                    authority: authority.clone(),
                    request_id: "request-create".into(),
                    request: PairingRequest {
                        app_name: "OpenCoven Chat".into(),
                        installation_id: "00000000-0000-4000-8000-000000000010".into(),
                        scopes: vec!["chat:read".into()],
                    },
                })
                .await
                .expect("pairing should be created");
            let pairing_handle = created.result.handle.clone();
            let created_json = serde_json::to_string(&created).expect("result should serialize");
            assert!(!created_json.contains("secret-sentinel"));

            boundary
                .pairing_poll(PairingHandleCommandInput {
                    authority: authority.clone(),
                    request_id: "request-poll".into(),
                    pairing_handle: pairing_handle.clone(),
                })
                .await
                .expect("pairing should poll");

            let exchanged = boundary
                .pairing_exchange(PairingHandleCommandInput {
                    authority: authority.clone(),
                    request_id: "request-exchange".into(),
                    pairing_handle: pairing_handle.clone(),
                })
                .await
                .expect("pairing should exchange");
            let commit_handle = exchanged.result.commit_handle.clone();
            let exchanged_json =
                serde_json::to_string(&exchanged).expect("result should serialize");
            assert!(!exchanged_json.contains("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"));
            assert_eq!(
                boundary
                    .pairing_exchange(PairingHandleCommandInput {
                        authority: authority.clone(),
                        request_id: "request-exchange-replay".into(),
                        pairing_handle,
                    })
                    .await
                    .expect_err("exchange handles are single use")
                    .code,
                DiagnosticCode::ReconcileRequired
            );

            boundary
                .pairing_commit(super::CommitHandleCommandInput {
                    authority: authority.clone(),
                    request_id: "request-commit".into(),
                    commit_handle,
                })
                .expect("staged credential should commit");
            assert_eq!(custody.writes.load(Ordering::Relaxed), 1);

            let state = boundary
                .credential_state(CredentialCommandInput {
                    authority,
                    request_id: "request-state".into(),
                })
                .expect("credential state should remain non-secret");
            assert!(!serde_json::to_string(&state)
                .expect("state should serialize")
                .contains("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"));
        });
    }

    #[test]
    fn discovery_and_authenticated_reads_keep_authority_and_secrets_native() {
        tauri::async_runtime::block_on(async {
            let descriptor = authority("00000000-0000-4000-8000-000000000001");
            let custody = Arc::new(ReadableCustody {
                present: AtomicBool::new(false),
                authority_fingerprint: descriptor.fingerprint().expect("fixture fingerprint"),
            });
            let boundary = Arc::new(NativeSdkBoundary::new(custody, Arc::new(FakeProvider)));
            let discovered = boundary
                .discovery_read()
                .await
                .expect("native discovery should return a safe snapshot");
            let authority = boundary
                .authority_establish(super::DiscoveryHandleInput {
                    discovery_handle: discovered.handle,
                })
                .expect("trusted discovery should open an opaque authority");
            let created = boundary
                .managed_pairing_create(PairingCreateCommandInput {
                    authority: authority.clone(),
                    request_id: "request-create-read".into(),
                    request: PairingRequest {
                        app_name: "OpenCoven Chat".into(),
                        installation_id: "00000000-0000-4000-8000-000000000010".into(),
                        scopes: vec!["chat:read".into()],
                    },
                })
                .await
                .expect("pairing should be created");
            let created_json =
                serde_json::to_string(&created).expect("managed creation should serialize");
            assert!(!created_json.contains("pairing:"));
            assert!(!created_json.contains("commit:"));
            let polled = boundary
                .managed_pairing_poll(super::ManagedPairingCommandInput {
                    authority: authority.clone(),
                    request_id: "request-poll-read".into(),
                    pairing_request_id: created.result.request_id.clone(),
                })
                .await
                .expect("pairing should poll");
            assert_eq!(polled.result["id"], created.result.request_id);
            let exchanged = boundary
                .managed_pairing_exchange(super::ManagedPairingCommandInput {
                    authority: authority.clone(),
                    request_id: "request-exchange-read".into(),
                    pairing_request_id: created.result.request_id,
                })
                .await
                .expect("pairing should exchange and commit");
            let exchanged_json =
                serde_json::to_string(&exchanged).expect("managed exchange should serialize");
            assert!(!exchanged_json.contains("pairing:"));
            assert!(!exchanged_json.contains("commit:"));
            assert_eq!(
                exchanged.result.credential["id"],
                "22222222-2222-4222-8222-222222222222"
            );

            let response = boundary
                .list_conversations(CanonicalPageCommandInput {
                    authority,
                    request_id: "request-read".into(),
                    options: CanonicalPageOptions {
                        limit: 25,
                        cursor: None,
                    },
                })
                .await
                .expect("canonical read should succeed");
            let rendered = serde_json::to_string(&response).expect("response should serialize");

            assert!(rendered.contains("conversation-1"));
            assert!(!rendered.contains("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"));
            assert!(!rendered.contains("bearer"));
        });
    }
}
