use std::{
    collections::HashSet,
    fmt::Write as _,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    cave_credentials::{
        CredentialCustody, CredentialLookup, CredentialRecord, CredentialStoreAvailability,
        KeyringCredentialCustody, SecretValue,
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

    fn synchronous_request<T>(
        &self,
        authority: &AuthorityReference,
        request_id: &str,
        operation: impl FnOnce(&AuthorityDescriptor) -> Result<T, NativeError>,
    ) -> Result<T, NativeError> {
        authority.validate()?;
        validate_request_id(request_id)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| NativeError::service_unavailable())?;
        let Some(active) = state.active.as_ref() else {
            return Err(NativeError::reconcile_required());
        };
        if active.reference != *authority {
            return Err(NativeError::reconcile_required());
        }
        let descriptor = active.descriptor.clone();
        let request_key = (authority.generation, request_id.to_owned());
        if !state.requests.insert(request_key.clone()) {
            return Err(NativeError::new(DiagnosticCode::OperationInProgress, true));
        }
        let result = operation(&descriptor);
        state.requests.remove(&request_key);
        result
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

struct StagedCredential {
    authority: AuthorityReference,
    credential: CredentialRecord,
}

#[derive(Default)]
struct TransientState {
    pairings: std::collections::HashMap<String, PendingPairing>,
    credentials: std::collections::HashMap<String, StagedCredential>,
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
        let reference = self.lifecycle.replace(authority)?;
        let mut transient = self
            .transient
            .lock()
            .map_err(|_| NativeError::service_unavailable())?;
        transient.pairings.clear();
        transient.credentials.clear();
        Ok(reference)
    }

    pub fn authority_close(
        &self,
        input: CloseAuthorityInput,
    ) -> Result<AuthorityCloseResult, NativeError> {
        let closed = self.lifecycle.close(&input.authority)?;
        if closed {
            let mut transient = self
                .transient
                .lock()
                .map_err(|_| NativeError::service_unavailable())?;
            transient.pairings.clear();
            transient.credentials.clear();
        }
        Ok(AuthorityCloseResult { closed })
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
        let installation_id = self.custody.installation_id()?;
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
        let pending = self
            .transient
            .lock()
            .map_err(|_| NativeError::service_unavailable())?
            .pairings
            .remove(&input.pairing_handle);
        let Some(pending) = pending else {
            self.lifecycle.cancel_request(&request);
            return Err(NativeError::reconcile_required());
        };
        if pending.authority != input.authority || pending.status != PendingPairingStatus::Ready {
            self.lifecycle.cancel_request(&request);
            return Err(NativeError::reconcile_required());
        }
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
        self.transient
            .lock()
            .map_err(|_| NativeError::service_unavailable())?
            .credentials
            .insert(
                commit_handle.clone(),
                StagedCredential {
                    authority: input.authority.clone(),
                    credential,
                },
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
        self.lifecycle
            .synchronous_request(&input.authority, &input.request_id, |_authority| {
                let staged = self
                    .transient
                    .lock()
                    .map_err(|_| NativeError::service_unavailable())?
                    .credentials
                    .remove(&input.commit_handle)
                    .ok_or_else(NativeError::reconcile_required)?;
                if staged.authority != input.authority {
                    return Err(NativeError::reconcile_required());
                }
                self.custody.write_credential(&staged.credential)
            })?;
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
        let result = self.lifecycle.synchronous_request(
            &input.authority,
            &input.request_id,
            |_authority| {
                Ok(
                    match self
                        .transient
                        .lock()
                        .map_err(|_| NativeError::service_unavailable())?
                        .credentials
                        .remove(&input.commit_handle)
                    {
                        None => PairingDiscardResult::Absent,
                        Some(staged) if staged.authority == input.authority => {
                            PairingDiscardResult::Deleted
                        }
                        Some(_) => PairingDiscardResult::Changed,
                    },
                )
            },
        )?;
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
        let status = self.lifecycle.synchronous_request(
            &input.authority,
            &input.request_id,
            |authority| {
                let installation_id = self.custody.installation_id()?;
                Ok(match self.custody.read_credential(&installation_id)? {
                    CredentialLookup::Missing => CredentialState::Missing,
                    CredentialLookup::Invalid => CredentialState::Invalid,
                    CredentialLookup::Present(credential)
                        if credential.authority_fingerprint == authority.fingerprint()? =>
                    {
                        CredentialState::Present
                    }
                    CredentialLookup::Present(_) => CredentialState::Invalid,
                })
            },
        )?;
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
        let deleted = self.lifecycle.synchronous_request(
            &input.authority,
            &input.request_id,
            |_authority| {
                let installation_id = self.custody.installation_id()?;
                self.custody.delete_credential(&installation_id)
            },
        )?;
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
    boundary: NativeSdkBoundary,
}

impl NativeSdkState {
    pub fn new(boundary: NativeSdkBoundary) -> Self {
        Self { boundary }
    }

    pub fn production() -> Self {
        Self::new(NativeSdkBoundary::production())
    }
}

#[tauri::command]
pub fn sdk_installation_identity(
    state: tauri::State<'_, NativeSdkState>,
) -> Result<InstallationIdentity, NativeError> {
    state.boundary.installation_identity()
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
pub fn cave_pairing_commit(
    state: tauri::State<'_, NativeSdkState>,
    input: CommitHandleCommandInput,
) -> Result<OperationResult<()>, NativeError> {
    state.boundary.pairing_commit(input)
}

#[tauri::command]
pub fn cave_pairing_discard(
    state: tauri::State<'_, NativeSdkState>,
    input: CommitHandleCommandInput,
) -> Result<OperationResult<PairingDiscardResult>, NativeError> {
    state.boundary.pairing_discard(input)
}

#[tauri::command]
pub fn cave_credential_state(
    state: tauri::State<'_, NativeSdkState>,
    input: CredentialCommandInput,
) -> Result<OperationResult<CredentialStateOutput>, NativeError> {
    state.boundary.credential_state(input)
}

#[tauri::command]
pub fn cave_forget_credential(
    state: tauri::State<'_, NativeSdkState>,
    input: CredentialCommandInput,
) -> Result<OperationResult<bool>, NativeError> {
    state.boundary.forget_credential(input)
}

#[tauri::command]
pub fn sdk_native_diagnostics(state: tauri::State<'_, NativeSdkState>) -> NativeDiagnostics {
    state.boundary.diagnostics()
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    use serde_json::json;

    use super::{
        AuthorityDescriptor, AuthorityLifecycle, CredentialCommandInput,
        ManagedNativeAuthorityProvider, NativeSdkBoundary, PairingCreateCommandInput,
        PairingHandleCommandInput, PairingRequest, ProviderFuture, ProviderPairingCreated,
        ProviderPairingExchange,
    };
    use crate::cave_credentials::{
        CredentialCustody, CredentialLookup, CredentialRecord, CredentialStoreAvailability,
        SecretValue,
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
            credential: &CredentialRecord,
        ) -> Result<(), crate::NativeError> {
            assert_eq!(
                credential.installation_id,
                "00000000-0000-4000-8000-000000000010"
            );
            assert_eq!(
                credential.bearer.expose(),
                b"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
            );
            self.writes.fetch_add(1, Ordering::Relaxed);
            Ok(())
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
                crate::NativeResponse::new(
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
                    response: crate::NativeResponse::new(
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
                crate::NativeResponse::new(
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
                    response: crate::NativeResponse::new(
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
