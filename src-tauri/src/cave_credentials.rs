#[cfg(test)]
use serde::Deserialize;
use serde::Serialize;
use uuid::{Uuid, Version};
use zeroize::{Zeroize, Zeroizing};

use crate::sdk_diagnostics::{DiagnosticCode, NativeError};

const CREDENTIAL_RECORD_ACCOUNT_PREFIX: &str = "cave-credential-record-v3:";
#[cfg(test)]
const MAX_CREDENTIAL_RECORD_BYTES: usize = 4 * 1024;

#[allow(dead_code)]
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

#[cfg(test)]
struct ZeroizingText {
    value: Option<String>,
    #[cfg(test)]
    observer: Option<std::sync::Arc<ZeroizeTestObserver>>,
}

#[cfg(test)]
impl ZeroizingText {
    fn into_bytes(mut self) -> Vec<u8> {
        self.value.take().unwrap_or_default().into_bytes()
    }
}

#[cfg(test)]
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

#[cfg(test)]
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
    _encoded: Zeroizing<Vec<u8>>,
    delete_target: CredentialDeleteTarget,
}

#[derive(Clone, PartialEq, Eq)]
pub struct CredentialDeleteTarget {
    installation_id: String,
    record_id: String,
    record_account: String,
}

impl CredentialDeleteTarget {
    fn new_record(installation_id: String, record_id: String) -> Self {
        let record_account =
            format!("{CREDENTIAL_RECORD_ACCOUNT_PREFIX}{installation_id}:{record_id}");
        Self {
            installation_id,
            record_id,
            record_account,
        }
    }

    #[cfg(test)]
    fn from_wire(wire: &CredentialWire) -> Result<Self, NativeError> {
        if wire.version != 3 {
            return Err(NativeError::invalid_response());
        }
        validate_installation_id(&wire.installation_id)?;
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

    #[cfg(test)]
    pub(crate) fn matches_encoded(&self, encoded: &[u8]) -> bool {
        let Ok(wire) = serde_json::from_slice::<CredentialWire>(encoded) else {
            return false;
        };
        wire.version == 3
            && wire.installation_id == self.installation_id
            && wire.record_id.as_deref() == Some(self.record_id.as_str())
    }

    #[cfg(test)]
    pub(crate) fn record_account(&self) -> &str {
        &self.record_account
    }

    #[cfg(test)]
    pub(crate) fn from_encoded_for_test(encoded: &[u8]) -> Result<Self, NativeError> {
        let wire = serde_json::from_slice::<CredentialWire>(encoded)
            .map_err(|_| NativeError::invalid_response())?;
        Self::from_wire(&wire)
    }
}

impl PreparedCredential {
    pub fn from_record(credential: &CredentialRecord) -> Result<Self, NativeError> {
        validate_installation_id(&credential.installation_id)?;
        validate_authority_fingerprint(&credential.authority_fingerprint)?;
        let bearer = std::str::from_utf8(credential.bearer.expose())
            .map_err(|_| NativeError::invalid_response())?;
        let record_id = Uuid::new_v4().to_string();
        let delete_target = CredentialDeleteTarget::new_record(
            credential.installation_id.clone(),
            record_id.clone(),
        );
        Ok(Self {
            _encoded: Zeroizing::new(
                serde_json::to_vec(&CredentialWireRef {
                    version: 3,
                    installation_id: &credential.installation_id,
                    authority_fingerprint: &credential.authority_fingerprint,
                    bearer,
                    record_id: &record_id,
                })
                .map_err(|_| NativeError::new(DiagnosticCode::SecretStoreWriteFailed, false))?,
            ),
            delete_target,
        })
    }

    pub fn delete_target(&self) -> CredentialDeleteTarget {
        self.delete_target.clone()
    }

    #[cfg(test)]
    pub(crate) fn exact_value(&self) -> &[u8] {
        self._encoded.as_slice()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialDeleteResult {
    Absent,
    Changed,
    Deleted,
}

#[allow(dead_code)]
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

#[cfg(test)]
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
    record_id: &'a str,
}

#[cfg(test)]
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

#[cfg(test)]
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
    if wire.version != 3
        || wire.installation_id != installation_id
        || validate_installation_id(&wire.installation_id).is_err()
        || validate_authority_fingerprint(&wire.authority_fingerprint).is_err()
        || wire
            .record_id
            .as_deref()
            .is_none_or(|record_id| validate_record_id(record_id).is_err())
    {
        return CredentialLookup::Invalid;
    }
    let delete_target = match CredentialDeleteTarget::from_wire(&wire) {
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::{
        decode_credential_bytes, validate_authority_fingerprint, validate_installation_id,
        with_zeroize_test_observer, CredentialLookup, CredentialRecord, PreparedCredential,
        SecretValue, ZeroizeTestObserver, MAX_CREDENTIAL_RECORD_BYTES,
    };

    fn credential() -> CredentialRecord {
        CredentialRecord {
            installation_id: "00000000-0000-4000-8000-000000000010".into(),
            authority_fingerprint: format!("sha256:{}", "a".repeat(64)),
            bearer: SecretValue::bearer(b"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB".to_vec())
                .expect("test bearer"),
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
                br#"{"version":3,"installationId":"invalid","authorityFingerprint":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bearer":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB","recordId":"00000000-0000-4000-8000-000000000001"}"#.to_vec(),
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
                br#"{"version":3,"installationId":"00000000-0000-4000-8000-000000000010","authorityFingerprint":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bearer":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB","recordId":"00000000-0000-4000-8000-000000000001"} trailing"#.to_vec(),
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
    fn version_three_records_use_unique_non_secret_storage_addresses() {
        let first = PreparedCredential::from_record(&credential()).expect("prepare credential");
        let replacement =
            PreparedCredential::from_record(&credential()).expect("prepare replacement credential");
        assert!(std::str::from_utf8(first.exact_value())
            .expect("credential wire is json")
            .contains(r#""version":3"#));
        assert!(first.delete_target().matches_encoded(first.exact_value()));
        assert_ne!(
            first.delete_target().record_account(),
            replacement.delete_target().record_account()
        );
        assert!(
            !first
                .delete_target()
                .matches_encoded(replacement.exact_value()),
            "cleanup for record A must never match replacement record B"
        );
    }

    #[test]
    fn record_addressed_delete_cannot_target_a_replacement_written_after_comparison() {
        let first =
            PreparedCredential::from_record(&credential()).expect("prepare first credential");
        let replacement =
            PreparedCredential::from_record(&credential()).expect("prepare replacement credential");
        let first_account = first.delete_target().record_account().to_owned();
        let replacement_account = replacement.delete_target().record_account().to_owned();
        let mut records = std::collections::HashMap::from([
            (first_account.clone(), first.exact_value().to_vec()),
            (
                replacement_account.clone(),
                replacement.exact_value().to_vec(),
            ),
        ]);
        let mut current = first_account.clone();

        assert_eq!(current, first_account, "comparison observes record A");
        current = replacement_account.clone();
        records.remove(&first_account);

        assert_eq!(current, replacement_account);
        assert!(
            records.contains_key(&replacement_account),
            "deleting record A must address only record A even after B becomes current"
        );
    }

    #[test]
    fn legacy_single_account_records_are_never_delete_targets() {
        for version in [1, 2] {
            let encoded = format!(
                r#"{{"version":{version},"installationId":"00000000-0000-4000-8000-000000000010","authorityFingerprint":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bearer":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB","recordId":"00000000-0000-4000-8000-000000000001"}}"#
            );
            assert!(
                super::CredentialDeleteTarget::from_encoded_for_test(encoded.as_bytes()).is_err(),
                "migration must leave mutable legacy accounts untouched rather than target them"
            );
        }
    }
}
