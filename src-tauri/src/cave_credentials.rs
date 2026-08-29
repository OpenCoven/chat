use std::{
    io::{Read, Write},
    process::{Child, ChildStdout, Command, Stdio},
    sync::OnceLock,
    time::{Duration, Instant},
};

#[cfg(unix)]
use std::path::Path;

use keyring_core::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::{Uuid, Version};
use zeroize::{Zeroize, Zeroizing};

#[cfg(any(windows, test))]
use crate::credential_lock::{windows_persistence_action, WindowsPersistenceAction};
use crate::{
    credential_lock::CredentialMutationLock,
    sdk_diagnostics::{DiagnosticCode, NativeError},
};

const INSTALLATION_ACCOUNT: &str = "installation-id-v1";
const CREDENTIAL_ACCOUNT_PREFIX: &str = "cave-credential-v1:";
const MAX_CREDENTIAL_RECORD_BYTES: usize = 4 * 1024;
const MAX_HELPER_MESSAGE_BYTES: usize = MAX_CREDENTIAL_RECORD_BYTES + 128;
const CREDENTIAL_HELPER_DEADLINE: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialStoreAvailability {
    Available,
    PlatformUnavailable,
    Unavailable,
}

struct ZeroizingBuffer {
    value: Option<Vec<u8>>,
    #[cfg(test)]
    observer: Option<std::sync::Arc<ZeroizeTestObserver>>,
}

impl ZeroizingBuffer {
    fn new(value: Vec<u8>) -> Self {
        Self {
            value: Some(value),
            #[cfg(test)]
            observer: current_zeroize_test_observer(),
        }
    }

    fn as_slice(&self) -> &[u8] {
        self.value.as_deref().unwrap_or_default()
    }

    fn into_inner(mut self) -> Vec<u8> {
        self.value.take().unwrap_or_default()
    }
}

impl Drop for ZeroizingBuffer {
    fn drop(&mut self) {
        if let Some(value) = self.value.as_mut() {
            value.as_mut_slice().zeroize();
            #[cfg(test)]
            if let Some(observer) = &self.observer {
                observer.observe(value);
            }
            value.clear();
        }
    }
}

struct ZeroizingText {
    value: Option<String>,
    #[cfg(test)]
    observer: Option<std::sync::Arc<ZeroizeTestObserver>>,
}

impl ZeroizingText {
    fn into_bytes(mut self) -> Vec<u8> {
        self.value.take().unwrap_or_default().into_bytes()
    }
}

impl<'de> Deserialize<'de> for ZeroizingText {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Ok(Self {
            value: Some(String::deserialize(deserializer)?),
            #[cfg(test)]
            observer: current_zeroize_test_observer(),
        })
    }
}

impl Drop for ZeroizingText {
    fn drop(&mut self) {
        if let Some(value) = self.value.as_mut() {
            // SAFETY: replacing every byte with zero preserves valid UTF-8.
            let bytes = unsafe { value.as_bytes_mut() };
            bytes.zeroize();
            #[cfg(test)]
            if let Some(observer) = &self.observer {
                observer.observe(bytes);
            }
            value.clear();
        }
    }
}

pub struct SecretValue(ZeroizingBuffer);

impl SecretValue {
    pub fn bearer(value: Vec<u8>) -> Result<Self, NativeError> {
        Self::opaque_32_byte_base64url(value)
    }

    pub fn pairing(value: Vec<u8>) -> Result<Self, NativeError> {
        Self::opaque_32_byte_base64url(value)
    }

    fn opaque_32_byte_base64url(value: Vec<u8>) -> Result<Self, NativeError> {
        let value = ZeroizingBuffer::new(value);
        if value.as_slice().len() != 43
            || value
                .as_slice()
                .iter()
                .any(|byte| !byte.is_ascii_alphanumeric() && *byte != b'_' && *byte != b'-')
        {
            return Err(NativeError::invalid_response());
        }
        Ok(Self(value))
    }

    pub fn expose(&self) -> &[u8] {
        self.0.as_slice()
    }
}

impl Clone for SecretValue {
    fn clone(&self) -> Self {
        Self(ZeroizingBuffer::new(self.0.as_slice().to_vec()))
    }
}

pub struct CredentialRecord {
    pub installation_id: String,
    pub authority_fingerprint: String,
    pub bearer: SecretValue,
}

pub struct PreparedCredential {
    installation_id: String,
    encoded: Zeroizing<Vec<u8>>,
    delete_target: CredentialDeleteTarget,
}

#[derive(Clone, PartialEq, Eq)]
pub struct CredentialDeleteTarget {
    installation_id: String,
    record_id: Option<String>,
    legacy_digest: Option<[u8; 32]>,
}

impl CredentialDeleteTarget {
    fn new_record(installation_id: String, record_id: String) -> Self {
        Self {
            installation_id,
            record_id: Some(record_id),
            legacy_digest: None,
        }
    }

    fn from_wire(wire: &CredentialWire, encoded: &[u8]) -> Result<Self, NativeError> {
        match wire.version {
            2 => {
                let record_id = wire
                    .record_id
                    .as_deref()
                    .ok_or_else(NativeError::invalid_response)?;
                validate_record_id(record_id)?;
                Ok(Self::new_record(
                    wire.installation_id.clone(),
                    record_id.into(),
                ))
            }
            1 => {
                let digest: [u8; 32] = Sha256::digest(encoded).into();
                Ok(Self {
                    installation_id: wire.installation_id.clone(),
                    record_id: None,
                    legacy_digest: Some(digest),
                })
            }
            _ => Err(NativeError::invalid_response()),
        }
    }

    pub(crate) fn matches_encoded(&self, encoded: &[u8]) -> bool {
        let Ok(wire) = serde_json::from_slice::<CredentialWire>(encoded) else {
            return false;
        };
        if wire.installation_id != self.installation_id {
            return false;
        }
        match (&self.record_id, self.legacy_digest) {
            (Some(record_id), None) => {
                wire.version == 2 && wire.record_id.as_deref() == Some(record_id.as_str())
            }
            (None, Some(digest)) => {
                wire.version == 1 && Sha256::digest(encoded).as_slice() == digest
            }
            _ => false,
        }
    }

    #[cfg(test)]
    pub(crate) fn from_encoded_for_test(encoded: &[u8]) -> Result<Self, NativeError> {
        let wire = serde_json::from_slice::<CredentialWire>(encoded)
            .map_err(|_| NativeError::invalid_response())?;
        CredentialDeleteTarget::from_wire(&wire, encoded)
    }

    fn write_protocol(&self, output: &mut Vec<u8>) -> Result<(), NativeError> {
        push_limited_text(output, &self.installation_id)?;
        match (&self.record_id, self.legacy_digest) {
            (Some(record_id), None) => {
                output.push(1);
                push_limited_text(output, record_id)?;
            }
            (None, Some(digest)) => {
                output.push(2);
                output.extend_from_slice(&digest);
            }
            _ => return Err(NativeError::invalid_request()),
        }
        Ok(())
    }

    fn read_protocol(input: &[u8]) -> Result<Self, NativeError> {
        let mut cursor = 0;
        let installation_id = read_limited_text(input, &mut cursor)?;
        validate_installation_id(&installation_id)?;
        let mode = *input.get(cursor).ok_or_else(NativeError::invalid_request)?;
        cursor += 1;
        let target = match mode {
            1 => {
                let record_id = read_limited_text(input, &mut cursor)?;
                validate_record_id(&record_id)?;
                Self::new_record(installation_id, record_id)
            }
            2 => {
                let digest = input
                    .get(cursor..cursor + 32)
                    .ok_or_else(NativeError::invalid_request)?;
                cursor += 32;
                let digest: [u8; 32] = digest
                    .try_into()
                    .map_err(|_| NativeError::invalid_request())?;
                Self {
                    installation_id,
                    record_id: None,
                    legacy_digest: Some(digest),
                }
            }
            _ => return Err(NativeError::invalid_request()),
        };
        if cursor != input.len() {
            return Err(NativeError::invalid_request());
        }
        Ok(target)
    }
}

impl PreparedCredential {
    pub fn from_record(credential: &CredentialRecord) -> Result<Self, NativeError> {
        validate_installation_id(&credential.installation_id)?;
        validate_authority_fingerprint(&credential.authority_fingerprint)?;
        let bearer = std::str::from_utf8(credential.bearer.expose())
            .map_err(|_| NativeError::invalid_response())?;
        let record_id = Uuid::new_v4().to_string();
        Ok(Self {
            installation_id: credential.installation_id.clone(),
            encoded: Zeroizing::new(
                serde_json::to_vec(&CredentialWireRef {
                    version: 2,
                    installation_id: &credential.installation_id,
                    authority_fingerprint: &credential.authority_fingerprint,
                    bearer,
                    record_id: Some(&record_id),
                })
                .map_err(|_| operation_error(StoreOperation::Write))?,
            ),
            delete_target: CredentialDeleteTarget::new_record(
                credential.installation_id.clone(),
                record_id,
            ),
        })
    }

    fn encoded(&self) -> &[u8] {
        self.encoded.as_slice()
    }

    pub fn delete_target(&self) -> CredentialDeleteTarget {
        self.delete_target.clone()
    }

    fn from_encoded_for_helper(encoded: Vec<u8>) -> Result<Self, NativeError> {
        if encoded.len() > MAX_CREDENTIAL_RECORD_BYTES {
            return Err(NativeError::invalid_response());
        }
        let raw = ZeroizingBuffer::new(encoded);
        let wire = serde_json::from_slice::<CredentialWire>(raw.as_slice())
            .map_err(|_| NativeError::invalid_response())?;
        if wire.version != 2
            || validate_installation_id(&wire.installation_id).is_err()
            || validate_authority_fingerprint(&wire.authority_fingerprint).is_err()
            || wire
                .record_id
                .as_deref()
                .is_none_or(|record_id| validate_record_id(record_id).is_err())
        {
            return Err(NativeError::invalid_response());
        }
        let delete_target = CredentialDeleteTarget::from_wire(&wire, raw.as_slice())?;
        if SecretValue::bearer(wire.bearer.into_bytes()).is_err() {
            return Err(NativeError::invalid_response());
        }
        let installation_id = wire.installation_id;
        Ok(Self {
            installation_id,
            encoded: Zeroizing::new(raw.into_inner()),
            delete_target,
        })
    }

    #[cfg(test)]
    pub(crate) fn exact_value(&self) -> &[u8] {
        self.encoded()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialDeleteResult {
    Absent,
    Changed,
    Deleted,
}

pub enum CredentialLookup {
    Missing,
    Present {
        credential: CredentialRecord,
        delete_target: CredentialDeleteTarget,
    },
    Invalid,
}

pub trait CredentialCustody: Send + Sync {
    fn availability(&self) -> CredentialStoreAvailability;
    fn installation_id(&self) -> Result<String, NativeError>;
    fn read_credential(&self, installation_id: &str) -> Result<CredentialLookup, NativeError>;
    fn write_credential(&self, credential: &PreparedCredential) -> Result<(), NativeError>;
    fn compare_delete_credential(
        &self,
        expected: &CredentialDeleteTarget,
    ) -> Result<CredentialDeleteResult, NativeError>;
}

pub struct UnavailableCredentialCustody {
    error: NativeError,
}

impl UnavailableCredentialCustody {
    pub fn secure_store() -> Self {
        Self {
            error: NativeError::secure_store_unavailable(),
        }
    }

    pub fn platform() -> Self {
        Self {
            error: NativeError::platform_security_unavailable(),
        }
    }

    pub fn installation_id(&self) -> Result<String, NativeError> {
        Err(self.error.clone())
    }
}

impl CredentialCustody for UnavailableCredentialCustody {
    fn availability(&self) -> CredentialStoreAvailability {
        if self.error.code == DiagnosticCode::PlatformSecurityUnavailable {
            CredentialStoreAvailability::PlatformUnavailable
        } else {
            CredentialStoreAvailability::Unavailable
        }
    }

    fn installation_id(&self) -> Result<String, NativeError> {
        self.installation_id()
    }

    fn read_credential(&self, _installation_id: &str) -> Result<CredentialLookup, NativeError> {
        Err(self.error.clone())
    }

    fn write_credential(&self, _credential: &PreparedCredential) -> Result<(), NativeError> {
        Err(self.error.clone())
    }

    fn compare_delete_credential(
        &self,
        _expected: &CredentialDeleteTarget,
    ) -> Result<CredentialDeleteResult, NativeError> {
        Err(self.error.clone())
    }
}

pub struct KeyringCredentialCustody {
    service: &'static str,
}

pub struct ProcessCredentialCustody {
    service: &'static str,
}

impl ProcessCredentialCustody {
    pub const fn new(service: &'static str) -> Self {
        Self { service }
    }

    fn invoke(
        &self,
        request: ZeroizingBuffer,
        operation: StoreOperation,
    ) -> Result<ZeroizingBuffer, NativeError> {
        if self.service != crate::metadata::APP_IDENTIFIER {
            return Err(NativeError::secure_store_unavailable());
        }
        let executable = std::env::current_exe().map_err(|_| operation_error(operation))?;
        let mut child = Command::new(executable)
            .arg("--opencoven-credential-helper")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| operation_error(operation))?;
        supervise_helper(&mut child, request, operation, CREDENTIAL_HELPER_DEADLINE)
    }
}

fn supervise_helper(
    child: &mut Child,
    request: ZeroizingBuffer,
    operation: StoreOperation,
    deadline: Duration,
) -> Result<ZeroizingBuffer, NativeError> {
    let Some(mut stdin) = child.stdin.take() else {
        terminate_helper(child);
        return Err(operation_error(operation));
    };
    let Some(stdout) = child.stdout.take() else {
        terminate_helper(child);
        return Err(operation_error(operation));
    };
    let (write_sender, write_receiver) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let result = stdin
            .write_all(request.as_slice())
            .and_then(|()| stdin.flush())
            .map_err(|_| ());
        drop(stdin);
        drop(request);
        let _ = write_sender.send(result);
    });
    let (read_sender, read_receiver) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let _ = read_sender.send(read_helper_response(stdout));
    });

    let started = Instant::now();
    let mut write_complete = false;
    loop {
        if !write_complete {
            match write_receiver.try_recv() {
                Ok(Ok(())) => write_complete = true,
                Ok(Err(())) | Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    terminate_helper(child);
                    return Err(operation_error(operation));
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
            }
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                if !write_complete {
                    match write_receiver.recv_timeout(deadline.saturating_sub(started.elapsed())) {
                        Ok(Ok(())) => {}
                        _ => return Err(operation_error(operation)),
                    }
                }
                return match read_receiver.recv_timeout(deadline.saturating_sub(started.elapsed()))
                {
                    Ok(Ok(response)) => Ok(response),
                    Ok(Err(())) | Err(_) => Err(operation_error(operation)),
                };
            }
            Ok(Some(_)) => return Err(operation_timeout(operation)),
            Ok(None) => {}
            Err(_) => {
                terminate_helper(child);
                return Err(operation_error(operation));
            }
        }
        if started.elapsed() >= deadline {
            terminate_helper(child);
            return Err(operation_timeout(operation));
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn read_helper_response(mut stdout: ChildStdout) -> Result<ZeroizingBuffer, ()> {
    let mut response = Vec::new();
    if stdout
        .by_ref()
        .take((MAX_HELPER_MESSAGE_BYTES + 1) as u64)
        .read_to_end(&mut response)
        .is_err()
        || response.len() > MAX_HELPER_MESSAGE_BYTES
    {
        drop(ZeroizingBuffer::new(response));
        return Err(());
    }
    Ok(ZeroizingBuffer::new(response))
}

#[cfg(test)]
fn wait_for_helper_until(
    child: &mut Child,
    operation: StoreOperation,
    deadline: Duration,
) -> Result<(), NativeError> {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => return Err(operation_timeout(operation)),
            Ok(None) => {}
            Err(_) => {
                terminate_helper(child);
                return Err(operation_error(operation));
            }
        }
        if started.elapsed() >= deadline {
            terminate_helper(child);
            return Err(operation_timeout(operation));
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn terminate_helper(child: &mut Child) {
    let _ = child.kill();
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Ok(None) => return,
        }
    }
}

const HELPER_INSTALLATION: u8 = 1;
const HELPER_READ: u8 = 2;
const HELPER_WRITE: u8 = 3;
const HELPER_DELETE: u8 = 4;

fn push_limited_text(output: &mut Vec<u8>, value: &str) -> Result<(), NativeError> {
    let bytes = value.as_bytes();
    if bytes.len() > u8::MAX as usize {
        return Err(NativeError::invalid_request());
    }
    output.push(bytes.len() as u8);
    output.extend_from_slice(bytes);
    Ok(())
}

fn read_limited_text(input: &[u8], cursor: &mut usize) -> Result<String, NativeError> {
    let length = *input
        .get(*cursor)
        .ok_or_else(NativeError::invalid_request)? as usize;
    *cursor = cursor.saturating_add(1);
    let bytes = input
        .get(*cursor..cursor.saturating_add(length))
        .ok_or_else(NativeError::invalid_request)?;
    *cursor = cursor.saturating_add(length);
    let value = std::str::from_utf8(bytes).map_err(|_| NativeError::invalid_request())?;
    if value.chars().any(char::is_control) {
        return Err(NativeError::invalid_request());
    }
    Ok(value.into())
}

fn push_limited_bytes(output: &mut Vec<u8>, value: &[u8]) -> Result<(), NativeError> {
    if value.len() > MAX_CREDENTIAL_RECORD_BYTES {
        return Err(NativeError::invalid_request());
    }
    let length = u16::try_from(value.len()).map_err(|_| NativeError::invalid_request())?;
    output.extend_from_slice(&length.to_be_bytes());
    output.extend_from_slice(value);
    Ok(())
}

fn read_limited_bytes(input: &[u8], cursor: &mut usize) -> Result<Vec<u8>, NativeError> {
    let length = input
        .get(*cursor..cursor.saturating_add(2))
        .and_then(|bytes| bytes.try_into().ok())
        .map(u16::from_be_bytes)
        .ok_or_else(NativeError::invalid_request)? as usize;
    *cursor = cursor.saturating_add(2);
    let bytes = input
        .get(*cursor..cursor.saturating_add(length))
        .ok_or_else(NativeError::invalid_request)?;
    *cursor = cursor.saturating_add(length);
    if length > MAX_CREDENTIAL_RECORD_BYTES {
        return Err(NativeError::invalid_request());
    }
    Ok(bytes.to_vec())
}

static STORE_AVAILABILITY: OnceLock<CredentialStoreAvailability> = OnceLock::new();

#[cfg(any(windows, test))]
enum WindowsPersistenceValue<'a> {
    Password(&'a str),
    Binary(&'a [u8]),
}

#[cfg(any(windows, test))]
trait WindowsPersistenceEntry {
    fn persistence(&self) -> Result<Option<String>, NativeError>;
    fn set_password_value(&self, value: &str) -> Result<(), NativeError>;
    fn set_binary_value(&self, value: &[u8]) -> Result<(), NativeError>;
}

#[cfg(any(windows, test))]
fn ensure_windows_local_persistence_for(
    entry: &impl WindowsPersistenceEntry,
    value: WindowsPersistenceValue<'_>,
) -> Result<(), NativeError> {
    match windows_persistence_action(entry.persistence()?.as_deref()) {
        WindowsPersistenceAction::Accept => Ok(()),
        WindowsPersistenceAction::Migrate => {
            match value {
                WindowsPersistenceValue::Password(value) => entry.set_password_value(value)?,
                WindowsPersistenceValue::Binary(value) => entry.set_binary_value(value)?,
            }
            if windows_persistence_action(entry.persistence()?.as_deref())
                == WindowsPersistenceAction::Accept
            {
                Ok(())
            } else {
                Err(NativeError::platform_security_unavailable())
            }
        }
        WindowsPersistenceAction::Reject => Err(NativeError::platform_security_unavailable()),
    }
}

#[cfg(windows)]
struct KeyringWindowsPersistenceEntry<'a> {
    entry: &'a Entry,
    operation: StoreOperation,
}

#[cfg(windows)]
impl WindowsPersistenceEntry for KeyringWindowsPersistenceEntry<'_> {
    fn persistence(&self) -> Result<Option<String>, NativeError> {
        Ok(self
            .entry
            .get_attributes()
            .map_err(|error| map_keyring_error(&error, self.operation))?
            .get("persistence")
            .cloned())
    }

    fn set_password_value(&self, value: &str) -> Result<(), NativeError> {
        self.entry
            .set_password(value)
            .map_err(|error| map_keyring_error(&error, StoreOperation::Write))
    }

    fn set_binary_value(&self, value: &[u8]) -> Result<(), NativeError> {
        self.entry
            .set_secret(value)
            .map_err(|error| map_keyring_error(&error, StoreOperation::Write))
    }
}

impl KeyringCredentialCustody {
    pub const fn new(service: &'static str) -> Self {
        Self { service }
    }

    fn entry(&self, account: &str, operation: StoreOperation) -> Result<Entry, NativeError> {
        match store_availability() {
            CredentialStoreAvailability::Available => {}
            CredentialStoreAvailability::PlatformUnavailable => {
                return Err(NativeError::platform_security_unavailable());
            }
            CredentialStoreAvailability::Unavailable => {
                return Err(NativeError::secure_store_unavailable());
            }
        }
        #[cfg(windows)]
        {
            return Entry::new_with_modifiers(
                self.service,
                account,
                &std::collections::HashMap::from([("persistence", "Local")]),
            )
            .map_err(|error| map_keyring_error(&error, operation));
        }
        #[cfg(not(windows))]
        {
            Entry::new(self.service, account).map_err(|error| map_keyring_error(&error, operation))
        }
    }

    #[cfg(windows)]
    fn ensure_windows_local_password_persistence(
        entry: &Entry,
        password: &str,
        operation: StoreOperation,
    ) -> Result<(), NativeError> {
        ensure_windows_local_persistence_for(
            &KeyringWindowsPersistenceEntry { entry, operation },
            WindowsPersistenceValue::Password(password),
        )
    }

    #[cfg(not(windows))]
    fn ensure_windows_local_password_persistence(
        _entry: &Entry,
        _password: &str,
        _operation: StoreOperation,
    ) -> Result<(), NativeError> {
        Ok(())
    }

    #[cfg(windows)]
    fn ensure_windows_local_binary_persistence(
        entry: &Entry,
        secret: &[u8],
        operation: StoreOperation,
    ) -> Result<(), NativeError> {
        ensure_windows_local_persistence_for(
            &KeyringWindowsPersistenceEntry { entry, operation },
            WindowsPersistenceValue::Binary(secret),
        )
    }

    #[cfg(not(windows))]
    fn ensure_windows_local_binary_persistence(
        _entry: &Entry,
        _secret: &[u8],
        _operation: StoreOperation,
    ) -> Result<(), NativeError> {
        Ok(())
    }

    fn credential_account(installation_id: &str) -> Result<String, NativeError> {
        validate_installation_id(installation_id)?;
        Ok(format!("{CREDENTIAL_ACCOUNT_PREFIX}{installation_id}"))
    }
}

#[derive(Clone, Copy)]
enum StoreOperation {
    Read,
    Write,
    Delete,
}

fn operation_error(operation: StoreOperation) -> NativeError {
    NativeError::new(
        match operation {
            StoreOperation::Read => DiagnosticCode::SecretStoreReadFailed,
            StoreOperation::Write => DiagnosticCode::SecretStoreWriteFailed,
            StoreOperation::Delete => DiagnosticCode::SecretStoreDeleteFailed,
        },
        false,
    )
}

fn operation_timeout(operation: StoreOperation) -> NativeError {
    NativeError::new(
        DiagnosticCode::Timeout,
        matches!(operation, StoreOperation::Read),
    )
}

fn map_keyring_error(error: &KeyringError, operation: StoreOperation) -> NativeError {
    match error {
        KeyringError::Invalid(attribute, _) if attribute == "platform" => {
            NativeError::platform_security_unavailable()
        }
        KeyringError::NoDefaultStore => NativeError::platform_security_unavailable(),
        KeyringError::NoStorageAccess(_) | KeyringError::PlatformFailure(_) => {
            NativeError::secure_store_unavailable()
        }
        _ => operation_error(operation),
    }
}

fn store_availability() -> CredentialStoreAvailability {
    *STORE_AVAILABILITY.get_or_init(initialize_store)
}

fn initialize_store() -> CredentialStoreAvailability {
    #[cfg(target_os = "macos")]
    {
        return match apple_native_keyring_store::keychain::Store::new() {
            Ok(store) => {
                keyring_core::set_default_store(store);
                CredentialStoreAvailability::Available
            }
            Err(_) => CredentialStoreAvailability::Unavailable,
        };
    }

    #[cfg(target_os = "linux")]
    {
        return match zbus_secret_service_keyring_store::Store::new() {
            Ok(store) => {
                keyring_core::set_default_store(store);
                CredentialStoreAvailability::Available
            }
            Err(_) => CredentialStoreAvailability::Unavailable,
        };
    }

    #[cfg(target_os = "windows")]
    {
        return match windows_native_keyring_store::Store::new() {
            Ok(store) => {
                keyring_core::set_default_store(store);
                CredentialStoreAvailability::Available
            }
            Err(_) => CredentialStoreAvailability::Unavailable,
        };
    }

    #[allow(unreachable_code)]
    CredentialStoreAvailability::PlatformUnavailable
}

fn validate_installation_id(value: &str) -> Result<(), NativeError> {
    let parsed = Uuid::parse_str(value).map_err(|_| NativeError::invalid_response())?;
    if parsed.get_version() != Some(Version::Random) || parsed.to_string() != value {
        return Err(NativeError::invalid_response());
    }
    Ok(())
}

fn validate_authority_fingerprint(value: &str) -> Result<(), NativeError> {
    let Some(digest) = value.strip_prefix("sha256:") else {
        return Err(NativeError::invalid_response());
    };
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(NativeError::invalid_response());
    }
    Ok(())
}

fn validate_record_id(value: &str) -> Result<(), NativeError> {
    let parsed = Uuid::parse_str(value).map_err(|_| NativeError::invalid_response())?;
    if parsed.get_version() != Some(Version::Random) || parsed.to_string() != value {
        return Err(NativeError::invalid_response());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialWireRef<'a> {
    version: u8,
    installation_id: &'a str,
    authority_fingerprint: &'a str,
    bearer: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    record_id: Option<&'a str>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CredentialWire {
    version: u8,
    installation_id: String,
    authority_fingerprint: String,
    bearer: ZeroizingText,
    record_id: Option<String>,
}

#[cfg(test)]
fn decode_credential_bytes(bytes: Vec<u8>, installation_id: &str) -> CredentialLookup {
    let bytes = ZeroizingBuffer::new(bytes);
    decode_owned_credential_bytes(bytes, installation_id)
}

fn decode_owned_credential_bytes(
    bytes: ZeroizingBuffer,
    installation_id: &str,
) -> CredentialLookup {
    if bytes.as_slice().len() > MAX_CREDENTIAL_RECORD_BYTES {
        return CredentialLookup::Invalid;
    }
    let wire = match serde_json::from_slice::<CredentialWire>(bytes.as_slice()) {
        Ok(wire) => wire,
        Err(_) => return CredentialLookup::Invalid,
    };
    if !matches!(wire.version, 1 | 2)
        || wire.installation_id != installation_id
        || validate_installation_id(&wire.installation_id).is_err()
        || validate_authority_fingerprint(&wire.authority_fingerprint).is_err()
        || (wire.version == 1 && wire.record_id.is_some())
        || (wire.version == 2
            && wire
                .record_id
                .as_deref()
                .is_none_or(|record_id| validate_record_id(record_id).is_err()))
    {
        return CredentialLookup::Invalid;
    }
    let delete_target = match CredentialDeleteTarget::from_wire(&wire, bytes.as_slice()) {
        Ok(target) => target,
        Err(_) => return CredentialLookup::Invalid,
    };
    let bearer = match SecretValue::bearer(wire.bearer.into_bytes()) {
        Ok(bearer) => bearer,
        Err(_) => return CredentialLookup::Invalid,
    };

    CredentialLookup::Present {
        credential: CredentialRecord {
            installation_id: wire.installation_id,
            authority_fingerprint: wire.authority_fingerprint,
            bearer,
        },
        delete_target,
    }
}

#[cfg(test)]
#[derive(Default)]
pub(crate) struct ZeroizeTestObserver {
    drops: std::sync::atomic::AtomicUsize,
    observed_nonzero: std::sync::atomic::AtomicBool,
}

#[cfg(test)]
impl ZeroizeTestObserver {
    fn observe(&self, value: &[u8]) {
        if value.iter().any(|byte| *byte != 0) {
            self.observed_nonzero
                .store(true, std::sync::atomic::Ordering::Relaxed);
        }
        self.drops
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }

    pub(crate) fn assert_zeroized(&self) {
        assert!(
            self.drops.load(std::sync::atomic::Ordering::Relaxed) > 0,
            "at least one secret owner must be dropped"
        );
        assert!(
            !self
                .observed_nonzero
                .load(std::sync::atomic::Ordering::Relaxed),
            "secret owners must zero their allocation before drop"
        );
    }
}

#[cfg(test)]
std::thread_local! {
    static ZEROIZE_TEST_OBSERVER: std::cell::RefCell<Option<std::sync::Arc<ZeroizeTestObserver>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn current_zeroize_test_observer() -> Option<std::sync::Arc<ZeroizeTestObserver>> {
    ZEROIZE_TEST_OBSERVER.with(|observer| observer.borrow().clone())
}

#[cfg(test)]
pub(crate) fn with_zeroize_test_observer<T>(
    observer: std::sync::Arc<ZeroizeTestObserver>,
    operation: impl FnOnce() -> T,
) -> T {
    struct RestoreObserver(Option<std::sync::Arc<ZeroizeTestObserver>>);

    impl Drop for RestoreObserver {
        fn drop(&mut self) {
            ZEROIZE_TEST_OBSERVER.with(|observer| {
                *observer.borrow_mut() = self.0.take();
            });
        }
    }

    let previous = ZEROIZE_TEST_OBSERVER.with(|current| current.borrow_mut().replace(observer));
    let _restore = RestoreObserver(previous);
    operation()
}

impl CredentialCustody for KeyringCredentialCustody {
    fn availability(&self) -> CredentialStoreAvailability {
        store_availability()
    }

    fn installation_id(&self) -> Result<String, NativeError> {
        let _lock = CredentialMutationLock::acquire(self.service, INSTALLATION_ACCOUNT)?;
        let entry = self.entry(INSTALLATION_ACCOUNT, StoreOperation::Read)?;
        match entry.get_password() {
            Ok(value) => {
                Self::ensure_windows_local_password_persistence(
                    &entry,
                    &value,
                    StoreOperation::Read,
                )?;
                validate_installation_id(&value)?;
                Ok(value)
            }
            Err(KeyringError::NoEntry) => {
                let candidate = Uuid::new_v4().to_string();
                entry
                    .set_password(&candidate)
                    .map_err(|error| map_keyring_error(&error, StoreOperation::Write))?;
                let stored = entry
                    .get_password()
                    .map_err(|error| map_keyring_error(&error, StoreOperation::Read))?;
                Self::ensure_windows_local_password_persistence(
                    &entry,
                    &stored,
                    StoreOperation::Read,
                )?;
                validate_installation_id(&stored)?;
                Ok(stored)
            }
            Err(KeyringError::BadEncoding(bytes) | KeyringError::BadDataFormat(bytes, _)) => {
                drop(ZeroizingBuffer::new(bytes));
                Err(operation_error(StoreOperation::Read))
            }
            Err(error) => Err(map_keyring_error(&error, StoreOperation::Read)),
        }
    }

    fn read_credential(&self, installation_id: &str) -> Result<CredentialLookup, NativeError> {
        let account = Self::credential_account(installation_id)?;
        let _lock = CredentialMutationLock::acquire(self.service, &account)?;
        let entry = self.entry(&account, StoreOperation::Read)?;
        let bytes = match entry.get_secret() {
            Ok(bytes) => {
                let bytes = ZeroizingBuffer::new(bytes);
                Self::ensure_windows_local_binary_persistence(
                    &entry,
                    bytes.as_slice(),
                    StoreOperation::Read,
                )?;
                bytes
            }
            Err(KeyringError::NoEntry) => return Ok(CredentialLookup::Missing),
            Err(KeyringError::BadEncoding(bytes) | KeyringError::BadDataFormat(bytes, _)) => {
                drop(ZeroizingBuffer::new(bytes));
                return Ok(CredentialLookup::Invalid);
            }
            Err(KeyringError::BadStoreFormat(_) | KeyringError::Ambiguous(_)) => {
                return Ok(CredentialLookup::Invalid);
            }
            Err(error) => return Err(map_keyring_error(&error, StoreOperation::Read)),
        };
        Ok(decode_owned_credential_bytes(bytes, installation_id))
    }

    fn write_credential(&self, credential: &PreparedCredential) -> Result<(), NativeError> {
        let account = Self::credential_account(&credential.installation_id)?;
        let _lock = CredentialMutationLock::acquire(self.service, &account)?;
        let entry = self.entry(&account, StoreOperation::Write)?;
        entry
            .set_secret(credential.encoded())
            .map_err(|error| map_keyring_error(&error, StoreOperation::Write))?;
        Self::ensure_windows_local_binary_persistence(
            &entry,
            credential.encoded(),
            StoreOperation::Write,
        )
    }

    fn compare_delete_credential(
        &self,
        expected: &CredentialDeleteTarget,
    ) -> Result<CredentialDeleteResult, NativeError> {
        let account = Self::credential_account(&expected.installation_id)?;
        let _lock = CredentialMutationLock::acquire(self.service, &account)?;
        let entry = self.entry(&account, StoreOperation::Delete)?;
        let current = match entry.get_secret() {
            Ok(current) => {
                let current = ZeroizingBuffer::new(current);
                Self::ensure_windows_local_binary_persistence(
                    &entry,
                    current.as_slice(),
                    StoreOperation::Read,
                )?;
                current
            }
            Err(KeyringError::NoEntry) => return Ok(CredentialDeleteResult::Absent),
            Err(KeyringError::BadEncoding(bytes) | KeyringError::BadDataFormat(bytes, _)) => {
                drop(ZeroizingBuffer::new(bytes));
                return Err(operation_error(StoreOperation::Read));
            }
            Err(error) => return Err(map_keyring_error(&error, StoreOperation::Read)),
        };
        if !expected.matches_encoded(current.as_slice()) {
            return Ok(CredentialDeleteResult::Changed);
        }
        entry
            .delete_credential()
            .map(|()| CredentialDeleteResult::Deleted)
            .or_else(|error| match error {
                KeyringError::NoEntry => Ok(CredentialDeleteResult::Absent),
                error => Err(map_keyring_error(&error, StoreOperation::Delete)),
            })
    }
}

impl CredentialCustody for ProcessCredentialCustody {
    fn availability(&self) -> CredentialStoreAvailability {
        if cfg!(any(target_os = "linux", target_os = "macos")) {
            CredentialStoreAvailability::Available
        } else {
            CredentialStoreAvailability::PlatformUnavailable
        }
    }

    fn installation_id(&self) -> Result<String, NativeError> {
        let response = self.invoke(
            ZeroizingBuffer::new(vec![HELPER_INSTALLATION]),
            StoreOperation::Read,
        )?;
        let payload = helper_success_payload(response, StoreOperation::Read)?;
        let mut cursor = 0;
        let installation_id = read_limited_text(payload.as_slice(), &mut cursor)?;
        if cursor != payload.as_slice().len() {
            return Err(operation_error(StoreOperation::Read));
        }
        validate_installation_id(&installation_id)?;
        Ok(installation_id)
    }

    fn read_credential(&self, installation_id: &str) -> Result<CredentialLookup, NativeError> {
        validate_installation_id(installation_id)?;
        let mut request = Vec::with_capacity(40);
        request.push(HELPER_READ);
        push_limited_text(&mut request, installation_id)?;
        let response = self.invoke(ZeroizingBuffer::new(request), StoreOperation::Read)?;
        let payload = helper_success_payload(response, StoreOperation::Read)?;
        let mut cursor = 0;
        let kind = *payload
            .as_slice()
            .get(cursor)
            .ok_or_else(|| operation_error(StoreOperation::Read))?;
        cursor += 1;
        match kind {
            0 if cursor == payload.as_slice().len() => Ok(CredentialLookup::Missing),
            1 if cursor == payload.as_slice().len() => Ok(CredentialLookup::Invalid),
            2 => {
                let target_bytes = read_limited_bytes(payload.as_slice(), &mut cursor)?;
                let target = CredentialDeleteTarget::read_protocol(&target_bytes)?;
                drop(ZeroizingBuffer::new(target_bytes));
                let encoded = read_limited_bytes(payload.as_slice(), &mut cursor)?;
                if cursor != payload.as_slice().len() {
                    drop(ZeroizingBuffer::new(encoded));
                    return Err(operation_error(StoreOperation::Read));
                }
                match decode_owned_credential_bytes(ZeroizingBuffer::new(encoded), installation_id)
                {
                    CredentialLookup::Present { credential, .. } => Ok(CredentialLookup::Present {
                        credential,
                        delete_target: target,
                    }),
                    CredentialLookup::Missing => Err(operation_error(StoreOperation::Read)),
                    CredentialLookup::Invalid => Ok(CredentialLookup::Invalid),
                }
            }
            _ => Err(operation_error(StoreOperation::Read)),
        }
    }

    fn write_credential(&self, credential: &PreparedCredential) -> Result<(), NativeError> {
        let mut request = Vec::with_capacity(credential.encoded().len() + 3);
        request.push(HELPER_WRITE);
        push_limited_bytes(&mut request, credential.encoded())?;
        let response = self.invoke(ZeroizingBuffer::new(request), StoreOperation::Write)?;
        helper_success_payload(response, StoreOperation::Write).and_then(|payload| {
            if payload.as_slice().is_empty() {
                Ok(())
            } else {
                Err(operation_error(StoreOperation::Write))
            }
        })
    }

    fn compare_delete_credential(
        &self,
        expected: &CredentialDeleteTarget,
    ) -> Result<CredentialDeleteResult, NativeError> {
        let mut request = Vec::with_capacity(80);
        request.push(HELPER_DELETE);
        expected.write_protocol(&mut request)?;
        let response = self.invoke(ZeroizingBuffer::new(request), StoreOperation::Delete)?;
        let payload = helper_success_payload(response, StoreOperation::Delete)?;
        match payload.as_slice() {
            [0] => Ok(CredentialDeleteResult::Absent),
            [1] => Ok(CredentialDeleteResult::Changed),
            [2] => Ok(CredentialDeleteResult::Deleted),
            _ => Err(operation_error(StoreOperation::Delete)),
        }
    }
}

fn helper_success_payload(
    mut response: ZeroizingBuffer,
    operation: StoreOperation,
) -> Result<ZeroizingBuffer, NativeError> {
    let response_bytes = response.value.take().unwrap_or_default();
    let response = ZeroizingBuffer::new(response_bytes);
    match response.as_slice() {
        [0, payload @ ..] => Ok(ZeroizingBuffer::new(payload.to_vec())),
        [1, code, retryable] => match decode_helper_diagnostic(*code) {
            Some(code) if matches!(*retryable, 0 | 1) => {
                Err(NativeError::new(code, *retryable == 1))
            }
            _ => Err(operation_error(operation)),
        },
        _ => Err(operation_error(operation)),
    }
}

fn helper_error_response(error: NativeError) -> ZeroizingBuffer {
    ZeroizingBuffer::new(vec![
        1,
        encode_helper_diagnostic(error.code),
        u8::from(error.retryable),
    ])
}

fn encode_helper_diagnostic(code: DiagnosticCode) -> u8 {
    match code {
        DiagnosticCode::BodyLimit => 1,
        DiagnosticCode::Conflict => 2,
        DiagnosticCode::CredentialUpdateInProgress => 3,
        DiagnosticCode::InvalidRequest => 4,
        DiagnosticCode::InvalidResponse => 5,
        DiagnosticCode::OperationInProgress => 6,
        DiagnosticCode::OwnerMismatch => 7,
        DiagnosticCode::PairingExpired => 8,
        DiagnosticCode::PlatformSecurityUnavailable => 9,
        DiagnosticCode::ReconcileRequired => 10,
        DiagnosticCode::SecretStoreDeleteFailed => 11,
        DiagnosticCode::SecretStoreReadFailed => 12,
        DiagnosticCode::SecretStoreRollbackFailed => 13,
        DiagnosticCode::SecretStoreWriteFailed => 14,
        DiagnosticCode::SecureStoreUnavailable => 15,
        DiagnosticCode::ServiceUnavailable => 16,
        DiagnosticCode::StaleRecord => 17,
        DiagnosticCode::Timeout => 18,
        DiagnosticCode::UnsafeEndpoint => 19,
        DiagnosticCode::UnsupportedOperation => 20,
    }
}

fn decode_helper_diagnostic(code: u8) -> Option<DiagnosticCode> {
    Some(match code {
        1 => DiagnosticCode::BodyLimit,
        2 => DiagnosticCode::Conflict,
        3 => DiagnosticCode::CredentialUpdateInProgress,
        4 => DiagnosticCode::InvalidRequest,
        5 => DiagnosticCode::InvalidResponse,
        6 => DiagnosticCode::OperationInProgress,
        7 => DiagnosticCode::OwnerMismatch,
        8 => DiagnosticCode::PairingExpired,
        9 => DiagnosticCode::PlatformSecurityUnavailable,
        10 => DiagnosticCode::ReconcileRequired,
        11 => DiagnosticCode::SecretStoreDeleteFailed,
        12 => DiagnosticCode::SecretStoreReadFailed,
        13 => DiagnosticCode::SecretStoreRollbackFailed,
        14 => DiagnosticCode::SecretStoreWriteFailed,
        15 => DiagnosticCode::SecureStoreUnavailable,
        16 => DiagnosticCode::ServiceUnavailable,
        17 => DiagnosticCode::StaleRecord,
        18 => DiagnosticCode::Timeout,
        19 => DiagnosticCode::UnsafeEndpoint,
        20 => DiagnosticCode::UnsupportedOperation,
        _ => return None,
    })
}

pub fn run_credential_helper_if_requested() -> bool {
    let mut arguments = std::env::args().skip(1);
    if arguments.next().as_deref() != Some("--opencoven-credential-helper")
        || arguments.next().is_some()
    {
        return false;
    }
    if !trusted_helper_parent() {
        let response = helper_error_response(NativeError::platform_security_unavailable());
        let mut stdout = std::io::stdout().lock();
        let _ = stdout.write_all(response.as_slice());
        let _ = stdout.flush();
        return true;
    }
    let _watchdog = std::thread::spawn(|| {
        std::thread::sleep(CREDENTIAL_HELPER_DEADLINE);
        std::process::exit(124);
    });
    let response = helper_execute();
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(response.as_slice());
    let _ = stdout.flush();
    true
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn trusted_helper_parent() -> bool {
    // SAFETY: getppid has no preconditions.
    let parent_pid = unsafe { libc::getppid() };
    if parent_pid <= 1 {
        return false;
    }
    let Some(parent_executable) = parent_executable(parent_pid) else {
        return false;
    };
    std::env::current_exe()
        .ok()
        .is_some_and(|current| same_executable_identity(&parent_executable, &current))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn trusted_helper_parent() -> bool {
    false
}

#[cfg(target_os = "linux")]
fn parent_executable(parent_pid: libc::pid_t) -> Option<std::path::PathBuf> {
    std::fs::read_link(format!("/proc/{parent_pid}/exe")).ok()
}

#[cfg(target_os = "macos")]
fn parent_executable(parent_pid: libc::pid_t) -> Option<std::path::PathBuf> {
    use std::os::unix::ffi::OsStringExt;

    unsafe extern "C" {
        fn proc_pidpath(
            pid: libc::c_int,
            buffer: *mut libc::c_void,
            buffer_size: u32,
        ) -> libc::c_int;
    }

    let mut buffer = vec![0_u8; 4 * 1024];
    // SAFETY: the writable buffer is valid for the supplied byte length.
    let length = unsafe {
        proc_pidpath(
            parent_pid,
            buffer.as_mut_ptr().cast(),
            u32::try_from(buffer.len()).ok()?,
        )
    };
    let length = usize::try_from(length).ok().filter(|length| *length > 0)?;
    buffer.truncate(length);
    while buffer.last() == Some(&0) {
        buffer.pop();
    }
    Some(std::path::PathBuf::from(std::ffi::OsString::from_vec(
        buffer,
    )))
}

#[cfg(unix)]
fn same_executable_identity(left: &Path, right: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;

    match (std::fs::metadata(left), std::fs::metadata(right)) {
        (Ok(left), Ok(right)) => left.dev() == right.dev() && left.ino() == right.ino(),
        _ => false,
    }
}

fn helper_execute() -> ZeroizingBuffer {
    let mut input = Vec::new();
    let result = std::io::stdin()
        .take((MAX_HELPER_MESSAGE_BYTES + 1) as u64)
        .read_to_end(&mut input);
    if result.is_err() || input.len() > MAX_HELPER_MESSAGE_BYTES {
        drop(ZeroizingBuffer::new(input));
        return ZeroizingBuffer::new(vec![1]);
    }
    let input = ZeroizingBuffer::new(input);
    let result = (|| -> Result<Vec<u8>, NativeError> {
        let (operation, payload) = input
            .as_slice()
            .split_first()
            .ok_or_else(NativeError::invalid_request)?;
        let keyring = KeyringCredentialCustody::new(crate::metadata::APP_IDENTIFIER);
        match *operation {
            HELPER_INSTALLATION if payload.is_empty() => {
                let installation_id = keyring.installation_id()?;
                let mut response = Vec::new();
                push_limited_text(&mut response, &installation_id)?;
                Ok(response)
            }
            HELPER_READ => {
                let mut cursor = 0;
                let installation_id = read_limited_text(payload, &mut cursor)?;
                if cursor != payload.len() {
                    return Err(NativeError::invalid_request());
                }
                match keyring.read_credential(&installation_id)? {
                    CredentialLookup::Missing => Ok(vec![0]),
                    CredentialLookup::Invalid => Ok(vec![1]),
                    CredentialLookup::Present {
                        credential,
                        delete_target,
                    } => {
                        let prepared = PreparedCredential::from_record(&credential)?;
                        let encoded = ZeroizingBuffer::new(prepared.encoded().to_vec());
                        let mut response = vec![2];
                        let mut target = Vec::new();
                        delete_target.write_protocol(&mut target)?;
                        push_limited_bytes(&mut response, &target)?;
                        drop(ZeroizingBuffer::new(target));
                        push_limited_bytes(&mut response, encoded.as_slice())?;
                        Ok(response)
                    }
                }
            }
            HELPER_WRITE => {
                let mut cursor = 0;
                let encoded = read_limited_bytes(payload, &mut cursor)?;
                if cursor != payload.len() {
                    drop(ZeroizingBuffer::new(encoded));
                    return Err(NativeError::invalid_request());
                }
                let credential = PreparedCredential::from_encoded_for_helper(encoded)?;
                keyring.write_credential(&credential)?;
                Ok(Vec::new())
            }
            HELPER_DELETE => {
                let expected = CredentialDeleteTarget::read_protocol(payload)?;
                let result = keyring.compare_delete_credential(&expected)?;
                Ok(vec![match result {
                    CredentialDeleteResult::Absent => 0,
                    CredentialDeleteResult::Changed => 1,
                    CredentialDeleteResult::Deleted => 2,
                }])
            }
            _ => Err(NativeError::invalid_request()),
        }
    })();
    match result {
        Ok(mut payload) => {
            let mut response = Vec::with_capacity(payload.len() + 1);
            response.push(0);
            response.append(&mut payload);
            ZeroizingBuffer::new(response)
        }
        Err(error) => helper_error_response(error),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    };

    use super::{
        decode_credential_bytes, validate_authority_fingerprint, validate_installation_id,
        with_zeroize_test_observer, CredentialLookup, CredentialRecord, PreparedCredential,
        SecretValue, WindowsPersistenceEntry, WindowsPersistenceValue, ZeroizeTestObserver,
        MAX_CREDENTIAL_RECORD_BYTES,
    };

    struct FakeWindowsPersistenceEntry {
        persistence: Mutex<String>,
        password: Mutex<Option<String>>,
        binary_writes: AtomicUsize,
    }

    impl WindowsPersistenceEntry for FakeWindowsPersistenceEntry {
        fn persistence(&self) -> Result<Option<String>, crate::NativeError> {
            Ok(Some(
                self.persistence.lock().expect("persistence lock").clone(),
            ))
        }

        fn set_password_value(&self, value: &str) -> Result<(), crate::NativeError> {
            *self.password.lock().expect("password lock") = Some(value.into());
            *self.persistence.lock().expect("persistence lock") = "Local".into();
            Ok(())
        }

        fn set_binary_value(&self, _value: &[u8]) -> Result<(), crate::NativeError> {
            self.binary_writes.fetch_add(1, Ordering::Relaxed);
            *self.persistence.lock().expect("persistence lock") = "Local".into();
            Ok(())
        }
    }

    #[test]
    fn rejects_non_v4_or_noncanonical_installation_ids() {
        assert!(validate_installation_id("00000000-0000-0000-0000-000000000000").is_err());
        assert!(validate_installation_id("00000000-0000-4000-8000-000000000001").is_ok());
        assert!(validate_installation_id("00000000-0000-4000-8000-000000000001\n").is_err());
    }

    #[test]
    fn bounds_authority_fingerprints() {
        assert!(validate_authority_fingerprint(&format!("sha256:{}", "a".repeat(64))).is_ok());
        assert!(validate_authority_fingerprint(&format!("sha256:{}", "a".repeat(65))).is_err());
    }

    #[test]
    fn credential_decode_zeroizes_invalid_metadata_bearer_ownership() {
        let observer = Arc::new(ZeroizeTestObserver::default());
        let result = with_zeroize_test_observer(observer.clone(), || {
            decode_credential_bytes(
                br#"{"version":1,"installationId":"invalid","authorityFingerprint":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bearer":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}"#.to_vec(),
                "00000000-0000-4000-8000-000000000010",
            )
        });
        assert!(matches!(result, CredentialLookup::Invalid));
        observer.assert_zeroized();
    }

    #[test]
    fn credential_decode_zeroizes_invalid_json_after_bearer() {
        let observer = Arc::new(ZeroizeTestObserver::default());
        let result = with_zeroize_test_observer(observer.clone(), || {
            decode_credential_bytes(
                br#"{"version":1,"installationId":"00000000-0000-4000-8000-000000000010","authorityFingerprint":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bearer":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"} trailing"#.to_vec(),
                "00000000-0000-4000-8000-000000000010",
            )
        });
        assert!(matches!(result, CredentialLookup::Invalid));
        observer.assert_zeroized();
    }

    #[test]
    fn credential_decode_zeroizes_oversized_raw_records() {
        let observer = Arc::new(ZeroizeTestObserver::default());
        let result = with_zeroize_test_observer(observer.clone(), || {
            decode_credential_bytes(
                vec![b'x'; MAX_CREDENTIAL_RECORD_BYTES + 1],
                "00000000-0000-4000-8000-000000000010",
            )
        });
        assert!(matches!(result, CredentialLookup::Invalid));
        observer.assert_zeroized();
    }

    #[test]
    fn enterprise_installation_migration_round_trips_as_password() {
        let installation_id = "00000000-0000-4000-8000-000000000010";
        let entry = FakeWindowsPersistenceEntry {
            persistence: Mutex::new("Enterprise".into()),
            password: Mutex::new(None),
            binary_writes: AtomicUsize::new(0),
        };
        super::ensure_windows_local_persistence_for(
            &entry,
            WindowsPersistenceValue::Password(installation_id),
        )
        .expect("enterprise password should migrate");
        assert_eq!(
            entry.password.lock().expect("password lock").as_deref(),
            Some(installation_id)
        );
        assert_eq!(entry.binary_writes.load(Ordering::Relaxed), 0);
        assert_eq!(
            entry.persistence().expect("persistence read").as_deref(),
            Some("Local")
        );
    }

    #[test]
    fn enterprise_credential_migration_uses_binary_storage() {
        let entry = FakeWindowsPersistenceEntry {
            persistence: Mutex::new("Enterprise".into()),
            password: Mutex::new(None),
            binary_writes: AtomicUsize::new(0),
        };
        super::ensure_windows_local_persistence_for(
            &entry,
            WindowsPersistenceValue::Binary(b"binary-credential-record"),
        )
        .expect("enterprise binary credential should migrate");
        assert!(entry.password.lock().expect("password lock").is_none());
        assert_eq!(entry.binary_writes.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn version_two_record_ids_enable_exact_non_secret_compare_delete_targets() {
        let record = CredentialRecord {
            installation_id: "00000000-0000-4000-8000-000000000010".into(),
            authority_fingerprint: format!("sha256:{}", "a".repeat(64)),
            bearer: SecretValue::bearer(b"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB".to_vec())
                .expect("test bearer"),
        };
        let prepared = PreparedCredential::from_record(&record).expect("prepare credential");
        assert!(std::str::from_utf8(prepared.exact_value())
            .expect("credential wire is json")
            .contains(r#""version":2"#));
        let target = prepared.delete_target();
        assert!(target.matches_encoded(prepared.exact_value()));

        let replacement =
            PreparedCredential::from_record(&record).expect("prepare replacement credential");
        assert!(
            !target.matches_encoded(replacement.exact_value()),
            "cleanup for record A must never match a replacement record B"
        );
    }

    #[test]
    fn legacy_version_one_records_use_an_exact_digest_delete_target() {
        let encoded = br#"{"version":1,"installationId":"00000000-0000-4000-8000-000000000010","authorityFingerprint":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bearer":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}"#;
        let target =
            super::CredentialDeleteTarget::from_encoded_for_test(encoded).expect("legacy target");
        assert!(target.matches_encoded(encoded));
        let mut replacement = encoded.to_vec();
        let last = replacement.len() - 2;
        replacement[last] = b'C';
        assert!(
            !target.matches_encoded(&replacement),
            "legacy fallback must compare the entire stored record exactly"
        );
    }

    #[test]
    fn helper_parent_watchdog_kills_and_reaps_a_hung_process() {
        let mut child = std::process::Command::new("sh")
            .args(["-c", "exec sleep 60"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("sleep helper should start");
        let started = std::time::Instant::now();
        assert_eq!(
            super::wait_for_helper_until(
                &mut child,
                super::StoreOperation::Write,
                std::time::Duration::from_millis(20),
            )
            .expect_err("parent deadline must kill a hung helper")
            .code,
            crate::DiagnosticCode::Timeout
        );
        assert!(
            started.elapsed() < std::time::Duration::from_secs(1),
            "parent watchdog must not wait for an unreleased helper"
        );
        assert!(
            child.try_wait().expect("reaped child status").is_some(),
            "timed out helper must be reaped"
        );
    }

    #[test]
    fn helper_supervisor_bounds_unread_pipes_without_joining_forever() {
        let mut child = std::process::Command::new("sh")
            .args(["-c", "exec sleep 60"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("sleep helper should start");
        let started = std::time::Instant::now();
        let error = match super::supervise_helper(
            &mut child,
            super::ZeroizingBuffer::new(vec![b'x'; super::MAX_HELPER_MESSAGE_BYTES]),
            super::StoreOperation::Write,
            std::time::Duration::from_millis(20),
        ) {
            Ok(_) => panic!("unread helper pipes must time out"),
            Err(error) => error,
        };

        assert_eq!(error.code, crate::DiagnosticCode::Timeout);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(1),
            "pipe supervision must have a wall-clock bound"
        );
    }

    #[test]
    fn helper_error_protocol_preserves_retryable_store_contention() {
        let response =
            super::helper_error_response(crate::NativeError::credential_update_in_progress());
        let error = match super::helper_success_payload(response, super::StoreOperation::Write) {
            Ok(_) => panic!("helper error must remain an error"),
            Err(error) => error,
        };

        assert_eq!(
            error.code,
            crate::DiagnosticCode::CredentialUpdateInProgress
        );
        assert!(error.retryable);
    }

    #[cfg(unix)]
    #[test]
    fn helper_parent_identity_requires_the_same_executable_file() {
        let executable = std::env::current_exe().expect("test executable path");
        assert!(super::same_executable_identity(&executable, &executable));
        assert!(!super::same_executable_identity(
            &executable,
            &std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"),
        ));
    }
}
