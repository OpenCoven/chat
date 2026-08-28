use std::{
    collections::HashSet,
    fmt::Write as _,
    future::Future,
    pin::Pin,
    sync::{Arc, Condvar, Mutex},
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
        DiagnosticCode, NativeDiagnostics, NativeError, NativeResponse, SecurityCheck,
        SecurityComponent, SecurityStatus,
    },
};

const HPKE_KEY_ID_DOMAIN: &[u8] = b"OpenCoven/client-v1/hpke-bound-v1/key-id\0";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_REQUEST_ID_CHARACTERS: usize = 128;
const MAX_HANDLE_CHARACTERS: usize = 128;

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

#[derive(Default)]
struct LifecycleState {
    generation: u64,
    active: Option<ActiveAuthority>,
    requests: HashSet<(u64, String)>,
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

    fn is_current(&self, authority: &AuthorityReference) -> Result<bool, NativeError> {
        authority.validate()?;
        let state = self
            .state
            .lock()
            .map_err(|_| NativeError::service_unavailable())?;
        Ok(state.active.as_ref().map(|active| &active.reference) == Some(authority))
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
    pub response: NativeResponse,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingExchangeOutput {
    pub authority_binding: CaveAuthorityBinding,
    pub commit_handle: String,
    pub response: NativeResponse,
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
    pub response: NativeResponse,
}

pub struct ProviderPairingExchange {
    pub bearer: SecretValue,
    pub response: NativeResponse,
}

pub trait ManagedNativeAuthorityProvider: Send + Sync {
    fn available(&self) -> bool;
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
    ) -> ProviderFuture<NativeResponse>;
    fn pairing_exchange(
        &self,
        authority: AuthorityDescriptor,
        remote_request_id: String,
        pairing_secret: SecretValue,
    ) -> ProviderFuture<ProviderPairingExchange>;
}

pub struct UnavailableManagedNativeAuthorityProvider;

fn unavailable_future<T>() -> ProviderFuture<T> {
    Box::pin(async { Err(NativeError::platform_security_unavailable()) })
}

impl ManagedNativeAuthorityProvider for UnavailableManagedNativeAuthorityProvider {
    fn available(&self) -> bool {
        false
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
    ) -> ProviderFuture<NativeResponse> {
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
    installation_id: String,
    remote_request_id: String,
    pairing_secret: SecretValue,
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

struct StagedCredential {
    authority: AuthorityReference,
    credential: PreparedCredential,
    state: Mutex<StagedCredentialState>,
    completed: Condvar,
}

impl StagedCredential {
    fn new(authority: AuthorityReference, credential: PreparedCredential) -> Self {
        Self {
            authority,
            credential,
            state: Mutex::new(StagedCredentialState::Pending),
            completed: Condvar::new(),
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
            match &*state {
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
                *state = StagedCredentialState::Finished(result);
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
                *state = StagedCredentialState::Failed(error.clone());
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
                *state = if lifecycle_error.is_some() {
                    StagedCredentialState::Finished(CredentialDeleteResult::Absent)
                } else {
                    StagedCredentialState::Pending
                };
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
                    *state = StagedCredentialState::Finished(result);
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
                    *state = StagedCredentialState::Failed(error.clone());
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
                *state = StagedCredentialState::Committed;
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
                *state = StagedCredentialState::Finished(result);
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
                *state = StagedCredentialState::Failed(rollback_error.clone());
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
                    *state = StagedCredentialState::Finished(CredentialDeleteResult::Absent);
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
                            *state = StagedCredentialState::Finished(result);
                            self.completed.notify_all();
                            return Ok(result);
                        }
                        Err(error) => {
                            if error.code == DiagnosticCode::CredentialUpdateInProgress {
                                *state = StagedCredentialState::Committed;
                                self.completed.notify_all();
                                return Err(error);
                            }
                            *state = StagedCredentialState::Failed(error.clone());
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
                            *state = StagedCredentialState::Finished(result);
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
                            *state = StagedCredentialState::Failed(error.clone());
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
}

#[derive(Default)]
struct TransientState {
    pairings: std::collections::HashMap<String, PendingPairing>,
    credentials: std::collections::HashMap<String, Arc<StagedCredential>>,
}

pub struct NativeSdkBoundary {
    lifecycle: AuthorityLifecycle,
    custody: Arc<dyn CredentialCustody>,
    provider: Arc<dyn ManagedNativeAuthorityProvider>,
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
            transient: Mutex::new(TransientState::default()),
        }
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

    fn authority_open_with_transition(
        &self,
        authority: AuthorityDescriptor,
        after_replace: impl FnOnce(&AuthorityReference),
    ) -> Result<AuthorityReference, NativeError> {
        let reference = self.lifecycle.replace(authority)?;
        after_replace(&reference);
        self.invalidate_transients_before(reference.generation)?;
        if !self.lifecycle.is_current(&reference)? {
            return Err(NativeError::reconcile_required());
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
        let closed = self.lifecycle.close(&input.authority)?;
        if closed {
            after_close();
            self.invalidate_transients_through(input.authority.generation)?;
        }
        Ok(AuthorityCloseResult { closed })
    }

    fn invalidate_transients_before(&self, minimum_generation: u64) -> Result<(), NativeError> {
        let mut transient = self
            .transient
            .lock()
            .map_err(|_| NativeError::service_unavailable())?;
        transient
            .pairings
            .retain(|_, pairing| pairing.authority.generation >= minimum_generation);
        transient
            .credentials
            .retain(|_, credential| credential.authority.generation >= minimum_generation);
        Ok(())
    }

    fn invalidate_transients_through(&self, generation: u64) -> Result<(), NativeError> {
        let mut transient = self
            .transient
            .lock()
            .map_err(|_| NativeError::service_unavailable())?;
        transient
            .pairings
            .retain(|_, pairing| pairing.authority.generation > generation);
        transient
            .credentials
            .retain(|_, credential| credential.authority.generation > generation);
        Ok(())
    }

    #[cfg(test)]
    fn insert_test_pairing(&self, authority: &AuthorityReference, handle: &str) {
        self.transient
            .lock()
            .expect("test transient lock")
            .pairings
            .insert(
                handle.into(),
                PendingPairing {
                    authority: authority.clone(),
                    installation_id: "00000000-0000-4000-8000-000000000010".into(),
                    remote_request_id: "11111111-1111-4111-8111-111111111111".into(),
                    pairing_secret: SecretValue::pairing(
                        b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_vec(),
                    )
                    .expect("test pairing secret"),
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
        self.transient
            .lock()
            .expect("test transient lock")
            .credentials
            .insert(
                handle.into(),
                Arc::new(StagedCredential::new(
                    authority.clone(),
                    PreparedCredential::from_record(&credential).expect("test credential"),
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
        self.lifecycle.finish_request(&request)?;
        let handle = format!("pairing:{}", Uuid::new_v4());
        let pending = PendingPairing {
            authority: input.authority.clone(),
            installation_id,
            remote_request_id: created.remote_request_id,
            pairing_secret: created.pairing_secret,
            status: PendingPairingStatus::Ready,
        };
        self.transient
            .lock()
            .map_err(|_| NativeError::service_unavailable())?
            .pairings
            .insert(handle.clone(), pending);
        if let Err(error) = self.lifecycle.descriptor(&input.authority) {
            if let Ok(mut transient) = self.transient.lock() {
                transient.pairings.remove(&handle);
            }
            return Err(error);
        }

        Ok(OperationResult {
            authority: input.authority,
            request_id: input.request_id,
            result: PairingCreatedOutput {
                handle,
                response: created.response,
            },
        })
    }

    pub async fn pairing_poll(
        &self,
        input: PairingHandleCommandInput,
    ) -> Result<OperationResult<NativeResponse>, NativeError> {
        validate_opaque_handle(&input.pairing_handle, "pairing:")?;
        let request = self
            .lifecycle
            .begin_request(&input.authority, &input.request_id)?;
        let authority = self.lifecycle.descriptor(&input.authority)?;
        let (remote_request_id, pairing_secret) = {
            let mut transient = self
                .transient
                .lock()
                .map_err(|_| NativeError::service_unavailable())?;
            let Some(pending) = transient.pairings.get_mut(&input.pairing_handle) else {
                self.lifecycle.cancel_request(&request);
                return Err(NativeError::reconcile_required());
            };
            if pending.authority != input.authority {
                self.lifecycle.cancel_request(&request);
                return Err(NativeError::reconcile_required());
            }
            if pending.status != PendingPairingStatus::Ready {
                self.lifecycle.cancel_request(&request);
                return Err(NativeError::new(DiagnosticCode::OperationInProgress, true));
            }
            pending.status = PendingPairingStatus::Polling;
            (
                pending.remote_request_id.clone(),
                pending.pairing_secret.clone(),
            )
        };
        let response = match self
            .provider
            .pairing_poll(authority, remote_request_id, pairing_secret)
            .await
        {
            Ok(response) => response,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                self.reset_pending_pairing(&input.pairing_handle, &input.authority);
                return Err(error);
            }
        };
        self.lifecycle.finish_request(&request)?;
        self.reset_pending_pairing(&input.pairing_handle, &input.authority);
        self.lifecycle.descriptor(&input.authority)?;
        Ok(OperationResult {
            authority: input.authority,
            request_id: input.request_id,
            result: response,
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
        let authority = self.lifecycle.descriptor(&input.authority)?;
        let pending = {
            let mut transient = match self.transient.lock() {
                Ok(transient) => transient,
                Err(_) => {
                    self.lifecycle.cancel_request(&request);
                    return Err(NativeError::service_unavailable());
                }
            };
            let Some(pending) = transient.pairings.get(&input.pairing_handle) else {
                self.lifecycle.cancel_request(&request);
                return Err(NativeError::reconcile_required());
            };
            if pending.authority != input.authority {
                self.lifecycle.cancel_request(&request);
                return Err(NativeError::reconcile_required());
            }
            if pending.status != PendingPairingStatus::Ready {
                self.lifecycle.cancel_request(&request);
                return Err(NativeError::new(DiagnosticCode::OperationInProgress, true));
            }
            transient
                .pairings
                .remove(&input.pairing_handle)
                .ok_or_else(NativeError::reconcile_required)?
        };
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
                return Err(error);
            }
        };
        self.lifecycle.finish_request(&request)?;
        let commit_handle = format!("commit:{}", Uuid::new_v4());
        let credential = CredentialRecord {
            installation_id: pending.installation_id,
            authority_fingerprint: authority.fingerprint()?,
            bearer: exchanged.bearer,
        };
        let credential = PreparedCredential::from_record(&credential)?;
        self.transient
            .lock()
            .map_err(|_| NativeError::service_unavailable())?
            .credentials
            .insert(
                commit_handle.clone(),
                Arc::new(StagedCredential::new(input.authority.clone(), credential)),
            );
        if let Err(error) = self.lifecycle.descriptor(&input.authority) {
            if let Ok(mut transient) = self.transient.lock() {
                transient.credentials.remove(&commit_handle);
            }
            return Err(error);
        }
        Ok(OperationResult {
            authority: input.authority,
            request_id: input.request_id,
            result: PairingExchangeOutput {
                authority_binding: authority.binding(),
                commit_handle,
                response: exchanged.response,
            },
        })
    }

    pub fn pairing_commit(
        &self,
        input: CommitHandleCommandInput,
    ) -> Result<OperationResult<()>, NativeError> {
        validate_opaque_handle(&input.commit_handle, "commit:")?;
        let request = self
            .lifecycle
            .begin_request(&input.authority, &input.request_id)?;
        let staged = match self.transient.lock() {
            Ok(transient) => transient.credentials.get(&input.commit_handle).cloned(),
            Err(_) => {
                self.lifecycle.cancel_request(&request);
                return Err(NativeError::service_unavailable());
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
        let credential = match staged.begin_write() {
            Ok(credential) => credential,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
        };
        let write_result = self.custody.write_credential(&credential);
        let lifecycle_error = self.lifecycle.finish_request(&request).err();
        staged.finish_write(self.custody.as_ref(), write_result, lifecycle_error)?;
        Ok(OperationResult {
            authority: input.authority,
            request_id: input.request_id,
            result: (),
        })
    }

    pub fn pairing_discard(
        &self,
        input: CommitHandleCommandInput,
    ) -> Result<OperationResult<PairingDiscardResult>, NativeError> {
        validate_opaque_handle(&input.commit_handle, "commit:")?;
        let request = self
            .lifecycle
            .begin_request(&input.authority, &input.request_id)?;
        let staged = match self.transient.lock() {
            Ok(transient) => transient.credentials.get(&input.commit_handle).cloned(),
            Err(_) => {
                self.lifecycle.cancel_request(&request);
                return Err(NativeError::service_unavailable());
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
                match self.transient.lock() {
                    Ok(mut transient) => {
                        transient.credentials.remove(&input.commit_handle);
                    }
                    Err(_) => {
                        self.lifecycle.cancel_request(&request);
                        return Err(NativeError::service_unavailable());
                    }
                }
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
        let update_in_progress = {
            let transient = match self.transient.lock() {
                Ok(transient) => transient,
                Err(_) => {
                    self.lifecycle.cancel_request(&request);
                    return Err(NativeError::service_unavailable());
                }
            };
            transient
                .credentials
                .values()
                .filter(|credential| credential.authority == input.authority)
                .try_fold(false, |in_progress, credential| {
                    Ok::<_, NativeError>(in_progress || credential.update_in_progress()?)
                })
        };
        let update_in_progress = match update_in_progress {
            Ok(update_in_progress) => update_in_progress,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
        };
        let status = if update_in_progress {
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
        let installation_id = match self.custody.installation_id() {
            Ok(installation_id) => installation_id,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
        };
        let deleted = match self.custody.delete_credential(&installation_id) {
            Ok(deleted) => deleted,
            Err(error) => {
                self.lifecycle.cancel_request(&request);
                return Err(error);
            }
        };
        self.lifecycle.finish_request(&request)?;
        Ok(OperationResult {
            authority: input.authority,
            request_id: input.request_id,
            result: deleted,
        })
    }

    pub fn diagnostics(&self) -> NativeDiagnostics {
        let custody = match self.custody.availability() {
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

    fn reset_pending_pairing(&self, handle: &str, authority: &AuthorityReference) {
        if let Ok(mut transient) = self.transient.lock() {
            if let Some(pending) = transient.pairings.get_mut(handle) {
                if pending.authority == *authority {
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

fn validate_opaque_handle(value: &str, prefix: &str) -> Result<(), NativeError> {
    let Some(uuid) = value.strip_prefix(prefix) else {
        return Err(NativeError::invalid_request());
    };
    if value.len() > MAX_HANDLE_CHARACTERS || Uuid::parse_str(uuid).is_err() {
        return Err(NativeError::invalid_request());
    }
    Ok(())
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
pub fn sdk_authority_open(
    state: tauri::State<'_, NativeSdkState>,
    input: AuthorityDescriptor,
) -> Result<AuthorityReference, NativeError> {
    input.validate()?;
    state.boundary.authority_open(input)
}

#[tauri::command]
pub fn sdk_authority_close(
    state: tauri::State<'_, NativeSdkState>,
    input: CloseAuthorityInput,
) -> Result<AuthorityCloseResult, NativeError> {
    state.boundary.authority_close(input)
}

#[tauri::command]
pub async fn cave_health(
    state: tauri::State<'_, NativeSdkState>,
    input: HealthCommandInput,
) -> Result<OperationResult<NativeResponse>, NativeError> {
    state.boundary.health(input).await
}

#[tauri::command]
pub async fn cave_pairing_create(
    state: tauri::State<'_, NativeSdkState>,
    input: PairingCreateCommandInput,
) -> Result<OperationResult<PairingCreatedOutput>, NativeError> {
    state.boundary.pairing_create(input).await
}

#[tauri::command]
pub async fn cave_pairing_poll(
    state: tauri::State<'_, NativeSdkState>,
    input: PairingHandleCommandInput,
) -> Result<OperationResult<NativeResponse>, NativeError> {
    state.boundary.pairing_poll(input).await
}

#[tauri::command]
pub async fn cave_pairing_exchange(
    state: tauri::State<'_, NativeSdkState>,
    input: PairingHandleCommandInput,
) -> Result<OperationResult<PairingExchangeOutput>, NativeError> {
    state.boundary.pairing_exchange(input).await
}

#[tauri::command]
pub async fn cave_pairing_commit(
    state: tauri::State<'_, NativeSdkState>,
    input: CommitHandleCommandInput,
) -> Result<OperationResult<()>, NativeError> {
    let boundary = Arc::clone(&state.boundary);
    tauri::async_runtime::spawn_blocking(move || boundary.pairing_commit(input))
        .await
        .map_err(|_| NativeError::service_unavailable())?
}

#[tauri::command]
pub async fn cave_pairing_discard(
    state: tauri::State<'_, NativeSdkState>,
    input: CommitHandleCommandInput,
) -> Result<OperationResult<PairingDiscardResult>, NativeError> {
    let boundary = Arc::clone(&state.boundary);
    tauri::async_runtime::spawn_blocking(move || boundary.pairing_discard(input))
        .await
        .map_err(|_| NativeError::service_unavailable())?
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
        atomic::{AtomicUsize, Ordering},
        Arc, Condvar, Mutex,
    };
    use std::time::{Duration, Instant};

    use serde_json::json;

    use super::{
        AuthorityDescriptor, AuthorityLifecycle, CredentialCommandInput,
        ManagedNativeAuthorityProvider, NativeSdkBoundary, PairingCreateCommandInput,
        PairingHandleCommandInput, PairingRequest, ProviderFuture, ProviderPairingCreated,
        ProviderPairingExchange,
    };
    use crate::cave_credentials::{
        CredentialCustody, CredentialDeleteResult, CredentialLookup, CredentialStoreAvailability,
        PreparedCredential, SecretValue,
    };
    use crate::sdk_diagnostics::DiagnosticCode;

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

        fn delete_credential(&self, _installation_id: &str) -> Result<bool, crate::NativeError> {
            Ok(false)
        }
    }

    struct FakeProvider;

    impl ManagedNativeAuthorityProvider for FakeProvider {
        fn available(&self) -> bool {
            true
        }

        fn health(&self, _authority: AuthorityDescriptor) -> ProviderFuture<crate::NativeResponse> {
            Box::pin(async {
                crate::NativeResponse::health(
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
                    expires_at: 1_787_672_578_109,
                    pairing_secret: SecretValue::pairing(
                        b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_vec(),
                    )?,
                    response: crate::NativeResponse::pairing_create(
                        201,
                        json!({
                            "apiVersion": "1.0",
                            "minimumClientVersion": "0.1.0",
                            "capabilities": ["pairing"],
                            "operations": ["pairing.create"],
                            "data": {
                                "requestId": "11111111-1111-4111-8111-111111111111",
                                "expiresAt": 1_787_672_578_109_u64
                            }
                        }),
                    )?,
                })
            })
        }

        fn pairing_poll(
            &self,
            _authority: AuthorityDescriptor,
            _remote_request_id: String,
            pairing_secret: SecretValue,
        ) -> ProviderFuture<crate::NativeResponse> {
            Box::pin(async move {
                assert_eq!(
                    pairing_secret.expose(),
                    b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
                );
                crate::NativeResponse::pairing_poll(
                    200,
                    json!({
                        "apiVersion": "1.0",
                        "minimumClientVersion": "0.1.0",
                        "capabilities": ["pairing"],
                        "operations": ["pairing.poll"],
                        "data": {
                            "id": "11111111-1111-4111-8111-111111111111",
                            "status": "approved",
                            "expiresAt": 1_787_672_578_109_u64
                        }
                    }),
                )
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
                    response: crate::NativeResponse::pairing_exchange(
                        200,
                        json!({
                            "apiVersion": "1.0",
                            "minimumClientVersion": "0.1.0",
                            "capabilities": ["pairing", "credentials"],
                            "operations": ["pairing.exchange"],
                            "data": {
                                "credential": {
                                    "id": "22222222-2222-4222-8222-222222222222",
                                    "appName": "OpenCoven Chat",
                                    "installationId": "00000000-0000-4000-8000-000000000010",
                                    "scopes": ["chat:read"],
                                    "createdAt": 1_787_672_578_109_u64,
                                    "lastUsedAt": null,
                                    "revokedAt": null,
                                    "revocationReason": null
                                }
                            }
                        }),
                    )?,
                })
            })
        }
    }

    struct RaceCustody {
        stored: Mutex<Option<Vec<u8>>>,
        fail_after_write: bool,
    }

    impl RaceCustody {
        fn new(fail_after_write: bool) -> Self {
            Self {
                stored: Mutex::new(None),
                fail_after_write,
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

        fn delete_credential(&self, _installation_id: &str) -> Result<bool, crate::NativeError> {
            Ok(self
                .stored
                .lock()
                .expect("test store lock")
                .take()
                .is_some())
        }
    }

    struct BlockingCustody {
        stored: Mutex<Option<Vec<u8>>>,
        gate: Mutex<(bool, bool)>,
        changed: Condvar,
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
            Self {
                stored: Mutex::new(None),
                rollback_contentions: AtomicUsize::new(1),
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

        fn delete_credential(&self, _installation_id: &str) -> Result<bool, crate::NativeError> {
            Ok(false)
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

        fn delete_credential(&self, _installation_id: &str) -> Result<bool, crate::NativeError> {
            Ok(false)
        }
    }

    struct BlockingPollProvider {
        gate: Arc<(Mutex<(bool, bool)>, Condvar)>,
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
        ) -> ProviderFuture<crate::NativeResponse> {
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

        fn delete_credential(&self, _installation_id: &str) -> Result<bool, crate::NativeError> {
            Ok(false)
        }
    }

    impl BlockingCustody {
        fn new() -> Self {
            Self {
                stored: Mutex::new(None),
                gate: Mutex::new((false, false)),
                changed: Condvar::new(),
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
            let mut gate = self.gate.lock().expect("test gate lock");
            gate.0 = true;
            self.changed.notify_all();
            while !gate.1 {
                gate = self.changed.wait(gate).expect("test gate wait");
            }
            drop(gate);
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

        fn delete_credential(&self, _installation_id: &str) -> Result<bool, crate::NativeError> {
            Ok(self
                .stored
                .lock()
                .expect("test store lock")
                .take()
                .is_some())
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
    fn commit_handle_can_retry_after_lock_contention() {
        tauri::async_runtime::block_on(async {
            let custody = Arc::new(ContentionCustody::new(1, 0));
            let boundary = NativeSdkBoundary::new(custody, Arc::new(FakeProvider));
            let (authority, commit_handle) = stage_test_credential(&boundary).await;
            assert_eq!(
                boundary
                    .pairing_commit(super::CommitHandleCommandInput {
                        authority: authority.clone(),
                        request_id: "request-commit-1".into(),
                        commit_handle: commit_handle.clone(),
                    })
                    .expect_err("first commit should report lock contention")
                    .code,
                DiagnosticCode::CredentialUpdateInProgress
            );
            boundary
                .pairing_commit(super::CommitHandleCommandInput {
                    authority,
                    request_id: "request-commit-2".into(),
                    commit_handle,
                })
                .expect("same commit handle should retry successfully");
        });
    }

    #[test]
    fn discard_handle_can_retry_after_lock_contention() {
        tauri::async_runtime::block_on(async {
            let custody = Arc::new(ContentionCustody::new(0, 1));
            let boundary = NativeSdkBoundary::new(custody, Arc::new(FakeProvider));
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
            let (authority, commit_handle) = stage_test_credential(&boundary).await;
            assert_eq!(
                boundary
                    .pairing_commit(super::CommitHandleCommandInput {
                        authority: authority.clone(),
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
                    authority,
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
            boundary
                .transient
                .lock()
                .expect("transient lock")
                .pairings
                .insert(
                    pairing_handle.clone(),
                    super::PendingPairing {
                        authority: mismatched,
                        installation_id: "00000000-0000-4000-8000-000000000010".into(),
                        remote_request_id: "11111111-1111-4111-8111-111111111111".into(),
                        pairing_secret: SecretValue::pairing(
                            b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_vec(),
                        )
                        .expect("pairing secret"),
                        status: super::PendingPairingStatus::Ready,
                    },
                );

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
}
