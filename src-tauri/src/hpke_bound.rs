use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hpke::{
    aead::AesGcm256, kdf::HkdfSha256, kem::X25519HkdfSha256, setup_receiver, setup_sender_with_rng,
    Deserializable, Kem as KemTrait, OpModeR, OpModeS, Serializable,
};
use rand_chacha::ChaCha20Rng;
use rand_core::{CryptoRng, SeedableRng};
use reqwest::Response;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

use crate::cave::{NativeDiagnostic, NativeResult, PinnedCaveAuthority};

type CaveKem = X25519HkdfSha256;
type CaveKdf = HkdfSha256;
type CaveAead = AesGcm256;
type CavePrivateKey = <CaveKem as KemTrait>::PrivateKey;
type CavePublicKey = <CaveKem as KemTrait>::PublicKey;
type CaveEncappedKey = <CaveKem as KemTrait>::EncappedKey;

const REQUEST_AAD_DOMAIN: &[u8] = b"OpenCoven/client-v1/hpke-bound-v1/aad/request\0";
const RESPONSE_AAD_DOMAIN: &[u8] = b"OpenCoven/client-v1/hpke-bound-v1/aad/response\0";
const REQUEST_INFO: &[u8] = b"OpenCoven/client-v1/hpke-bound-v1/request";
const RESPONSE_INFO: &[u8] = b"OpenCoven/client-v1/hpke-bound-v1/response";
const MECHANISM: &str = "hpke-bound-v1";
const RESPONSE_MEDIA_TYPE: &str = "application/vnd.opencoven.client-v1.hpke-bound-v1+json";
const RAW_KEY_BYTES: usize = 32;
const ENCODED_KEY_CHARACTERS: usize = 43;
const REQUEST_PLAINTEXT_BYTES: usize = 1_024;
const REQUEST_CIPHERTEXT_BYTES: usize = 2_048;
const REQUEST_BODY_BYTES: usize = 65_536;
const RESPONSE_PLAINTEXT_BYTES: usize = 8 * 1_024 * 1_024;
const RESPONSE_CIPHERTEXT_BYTES: usize = 8_388_624;
const RESPONSE_ENVELOPE_BYTES: usize = 11_185_056;
const CANONICAL_ROUTE_BYTES: usize = 2_048;
const INSTANCE_ID_BYTES: usize = 256;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const RESPONSE_AEAD_OVERHEAD_BYTES: usize = RESPONSE_CIPHERTEXT_BYTES - RESPONSE_PLAINTEXT_BYTES;

pub(crate) const HEADER_MECHANISM: &str = "x-coven-client-v1-authority";
pub(crate) const HEADER_KEY_ID: &str = "x-coven-client-v1-authority-key-id";
pub(crate) const HEADER_INSTANCE_ID: &str = "x-coven-client-v1-authority-instance";
pub(crate) const HEADER_RUNTIME_NONCE: &str = "x-coven-client-v1-authority-runtime-nonce";
pub(crate) const HEADER_REQUEST_NONCE: &str = "x-coven-client-v1-authority-request-nonce";
pub(crate) const HEADER_ISSUED_AT: &str = "x-coven-client-v1-authority-issued-at";
pub(crate) const HEADER_ENC: &str = "x-coven-client-v1-authority-enc";
pub(crate) const HEADER_CIPHERTEXT: &str = "x-coven-client-v1-authority-ciphertext";

pub(crate) enum CaveHpkeAuthorization<'a> {
    PairingSecret(&'a str),
    Bearer(&'a str),
}

pub(crate) struct CaveHpkeBoundRequest {
    pub(crate) headers: Vec<(&'static str, String)>,
    opener: CaveHpkeResponseOpener,
}

pub(crate) struct CaveHpkeOpenedResponse {
    pub(crate) status_code: u16,
    pub(crate) body: Vec<u8>,
}

struct CaveHpkeResponseOpener {
    authority_public_key: CavePublicKey,
    response_private_key: CavePrivateKey,
    binding: CaveHpkeBinding,
}

struct CaveHpkeBinding {
    method: String,
    route: String,
    body_sha256: [u8; 32],
    instance_id: String,
    runtime_nonce: String,
    runtime_nonce_bytes: [u8; RAW_KEY_BYTES],
    key_id: String,
    key_id_bytes: [u8; RAW_KEY_BYTES],
    request_nonce: String,
    request_nonce_bytes: [u8; RAW_KEY_BYTES],
    issued_at: u64,
}

#[derive(Serialize)]
struct RequestAuthorization<'a> {
    kind: &'static str,
    value: &'a str,
}

#[derive(Serialize)]
struct RequestPlaintext<'a> {
    authorization: RequestAuthorization<'a>,
    #[serde(rename = "responsePublicKey")]
    response_public_key: String,
    version: u8,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResponseEnvelope {
    version: u8,
    mechanism: String,
    #[serde(rename = "keyId")]
    key_id: String,
    #[serde(rename = "requestNonce")]
    request_nonce: String,
    enc: String,
    ciphertext: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ResponsePlaintext {
    body: String,
    headers: ResponseHeaders,
    #[serde(rename = "requestNonce")]
    request_nonce: String,
    status: u16,
    version: u8,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ResponseHeaders {
    #[serde(rename = "contentType")]
    content_type: String,
    #[serde(
        rename = "retryAfter",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    retry_after: Option<String>,
}

fn proof_error() -> NativeDiagnostic {
    NativeDiagnostic::new("reconcile_required", false)
}

fn invalid_authority() -> NativeDiagnostic {
    NativeDiagnostic::new("invalid_response", false)
}

fn transport_error(error: &reqwest::Error) -> NativeDiagnostic {
    if error.is_timeout() {
        NativeDiagnostic::new("timeout", true)
    } else {
        NativeDiagnostic::new("service_unavailable", true)
    }
}

fn base64url_encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn base64url_decode(
    value: &str,
    minimum: usize,
    maximum: usize,
) -> Result<Vec<u8>, NativeDiagnostic> {
    if value.contains('=')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        || value.len() > maximum.saturating_mul(4).div_ceil(3)
    {
        return Err(proof_error());
    }
    let decoded = URL_SAFE_NO_PAD.decode(value).map_err(|_| proof_error())?;
    if decoded.len() < minimum || decoded.len() > maximum || base64url_encode(&decoded) != value {
        return Err(proof_error());
    }
    Ok(decoded)
}

fn validate_authorization(authorization: &CaveHpkeAuthorization<'_>) -> NativeResult<()> {
    match authorization {
        CaveHpkeAuthorization::PairingSecret(value) => {
            let decoded = base64url_decode(value, RAW_KEY_BYTES, RAW_KEY_BYTES)
                .map_err(|_| NativeDiagnostic::new("invalid_response", false))?;
            if decoded.len() != RAW_KEY_BYTES {
                return Err(invalid_authority());
            }
        }
        CaveHpkeAuthorization::Bearer(value)
            if value.is_empty()
                || value.len() > 512
                || !value.bytes().all(|byte| (0x21..=0x7e).contains(&byte)) =>
        {
            return Err(NativeDiagnostic::new("credential_unavailable", true));
        }
        CaveHpkeAuthorization::Bearer(_) => {}
    }
    Ok(())
}

fn frame(output: &mut Vec<u8>, value: &[u8]) -> NativeResult<()> {
    let length = u32::try_from(value.len()).map_err(|_| invalid_authority())?;
    output.extend_from_slice(&length.to_be_bytes());
    output.extend_from_slice(value);
    Ok(())
}

fn encode_aad(domain: &[u8], binding: &CaveHpkeBinding) -> NativeResult<Vec<u8>> {
    if binding.method.is_empty()
        || !binding.method.bytes().enumerate().all(|(index, byte)| {
            if index == 0 {
                byte.is_ascii_uppercase()
            } else {
                byte.is_ascii_uppercase()
                    || byte.is_ascii_digit()
                    || b"!#$%&'*+-.^_`|~".contains(&byte)
            }
        })
        || !binding.route.starts_with('/')
        || binding.route.len() > CANONICAL_ROUTE_BYTES
        || binding.instance_id.is_empty()
        || binding.instance_id.len() > INSTANCE_ID_BYTES
        || binding.runtime_nonce != base64url_encode(&binding.runtime_nonce_bytes)
        || binding.key_id != base64url_encode(&binding.key_id_bytes)
        || binding.request_nonce != base64url_encode(&binding.request_nonce_bytes)
        || binding.issued_at == 0
        || binding.issued_at > MAX_SAFE_INTEGER
        || binding.issued_at.to_string().len() > 16
    {
        return Err(invalid_authority());
    }
    let mut aad = Vec::with_capacity(domain.len() + binding.route.len() + 256);
    aad.extend_from_slice(domain);
    frame(&mut aad, binding.method.as_bytes())?;
    frame(&mut aad, binding.route.as_bytes())?;
    frame(&mut aad, &binding.body_sha256)?;
    frame(&mut aad, binding.instance_id.as_bytes())?;
    frame(&mut aad, &binding.runtime_nonce_bytes)?;
    frame(&mut aad, &binding.key_id_bytes)?;
    frame(&mut aad, &binding.request_nonce_bytes)?;
    frame(&mut aad, &binding.issued_at.to_be_bytes())?;
    Ok(aad)
}

fn validate_route(route: &str) -> NativeResult<()> {
    let path = route.split_once('?').map_or(route, |(path, _)| path);
    if !route.starts_with('/')
        || route.len() > CANONICAL_ROUTE_BYTES
        || path.contains('%')
        || path.contains('\\')
    {
        return Err(NativeDiagnostic::new("invalid_native_input", false));
    }
    Ok(())
}

pub(crate) fn canonical_route(url: &Url) -> NativeResult<String> {
    if url.path().contains('%') || url.path().contains('\\') {
        return Err(NativeDiagnostic::new("invalid_native_input", false));
    }
    let mut pairs = url
        .query_pairs()
        .map(|(name, value)| (rfc3986_component(&name), rfc3986_component(&value)))
        .collect::<Vec<_>>();
    pairs.sort_unstable();
    let query = pairs
        .into_iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("&");
    let route = if query.is_empty() {
        url.path().to_owned()
    } else {
        format!("{}?{query}", url.path())
    };
    validate_route(&route)?;
    Ok(route)
}

fn rfc3986_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(*byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn now_millis() -> NativeResult<u64> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| NativeDiagnostic::new("service_unavailable", true))?
        .as_millis();
    u64::try_from(millis).map_err(|_| NativeDiagnostic::new("service_unavailable", true))
}

fn random_key_material() -> NativeResult<[u8; RAW_KEY_BYTES]> {
    let mut bytes = [0_u8; RAW_KEY_BYTES];
    getrandom::fill(&mut bytes).map_err(|_| NativeDiagnostic::new("service_unavailable", true))?;
    Ok(bytes)
}

pub(crate) fn create_bound_request(
    authority: &PinnedCaveAuthority,
    method: &str,
    route: &str,
    body: &[u8],
    authorization: CaveHpkeAuthorization<'_>,
) -> NativeResult<CaveHpkeBoundRequest> {
    let response_ikm = random_key_material()?;
    let request_nonce = random_key_material()?;
    let issued_at = now_millis()?;
    let mut request_rng = ChaCha20Rng::from_seed(random_key_material()?);
    create_bound_request_with_material(
        authority,
        method,
        route,
        body,
        authorization,
        &response_ikm,
        request_nonce,
        issued_at,
        &mut request_rng,
    )
}

#[allow(clippy::too_many_arguments)]
fn create_bound_request_with_material(
    authority: &PinnedCaveAuthority,
    method: &str,
    route: &str,
    body: &[u8],
    authorization: CaveHpkeAuthorization<'_>,
    response_ikm: &[u8],
    request_nonce: [u8; RAW_KEY_BYTES],
    issued_at: u64,
    request_rng: &mut impl CryptoRng,
) -> NativeResult<CaveHpkeBoundRequest> {
    validate_route(route)?;
    validate_authorization(&authorization)?;
    if body.len() > REQUEST_BODY_BYTES {
        return Err(NativeDiagnostic::new("body_limit", false));
    }
    if response_ikm.len() != RAW_KEY_BYTES {
        return Err(invalid_authority());
    }

    let authority_public_key =
        CavePublicKey::from_bytes(&authority.hpke().public_key).map_err(|_| invalid_authority())?;
    let (response_private_key, response_public_key) = CaveKem::derive_keypair(response_ikm);
    let response_public_key = response_public_key.to_bytes();
    let request_nonce_encoded = base64url_encode(&request_nonce);
    let binding = CaveHpkeBinding {
        method: method.to_ascii_uppercase(),
        route: route.to_owned(),
        body_sha256: Sha256::digest(body).into(),
        instance_id: authority.instance_id()?,
        runtime_nonce: authority.freshness().nonce.clone(),
        runtime_nonce_bytes: authority.freshness().nonce_bytes,
        key_id: authority.hpke().key_id.clone(),
        key_id_bytes: authority.hpke().key_id_bytes,
        request_nonce: request_nonce_encoded,
        request_nonce_bytes: request_nonce,
        issued_at,
    };
    let request_aad = encode_aad(REQUEST_AAD_DOMAIN, &binding)?;
    let plaintext = serde_jcs::to_vec(&RequestPlaintext {
        authorization: match authorization {
            CaveHpkeAuthorization::PairingSecret(value) => RequestAuthorization {
                kind: "pairing-secret",
                value,
            },
            CaveHpkeAuthorization::Bearer(value) => RequestAuthorization {
                kind: "bearer",
                value,
            },
        },
        response_public_key: base64url_encode(&response_public_key),
        version: 1,
    })
    .map_err(|_| invalid_authority())?;
    if plaintext.len() > REQUEST_PLAINTEXT_BYTES {
        return Err(invalid_authority());
    }
    let (encapped, mut sender) = setup_sender_with_rng::<CaveAead, CaveKdf, CaveKem>(
        &OpModeS::Base,
        &authority_public_key,
        REQUEST_INFO,
        request_rng,
    )
    .map_err(|_| invalid_authority())?;
    let ciphertext = sender
        .seal(&plaintext, &request_aad)
        .map_err(|_| invalid_authority())?;
    if ciphertext.len() > REQUEST_CIPHERTEXT_BYTES {
        return Err(invalid_authority());
    }

    Ok(CaveHpkeBoundRequest {
        headers: vec![
            (HEADER_MECHANISM, MECHANISM.to_owned()),
            (HEADER_KEY_ID, binding.key_id.clone()),
            (
                HEADER_INSTANCE_ID,
                base64url_encode(binding.instance_id.as_bytes()),
            ),
            (HEADER_RUNTIME_NONCE, binding.runtime_nonce.clone()),
            (HEADER_REQUEST_NONCE, binding.request_nonce.clone()),
            (HEADER_ISSUED_AT, binding.issued_at.to_string()),
            (HEADER_ENC, base64url_encode(&encapped.to_bytes())),
            (HEADER_CIPHERTEXT, base64url_encode(&ciphertext)),
        ],
        opener: CaveHpkeResponseOpener {
            authority_public_key,
            response_private_key,
            binding,
        },
    })
}

impl CaveHpkeBoundRequest {
    pub(crate) async fn open(
        self,
        response: Response,
        maximum_body_bytes: usize,
    ) -> NativeResult<CaveHpkeOpenedResponse> {
        if response.status().as_u16() != 200
            || response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .is_none_or(|value| value.as_bytes() != RESPONSE_MEDIA_TYPE.as_bytes())
            || maximum_body_bytes == 0
        {
            return Err(proof_error());
        }
        let envelope_limit = response_envelope_limit(maximum_body_bytes)?;
        let envelope_bytes = read_bounded_envelope(response, envelope_limit).await?;
        let envelope: ResponseEnvelope =
            serde_json::from_slice(&envelope_bytes).map_err(|_| proof_error())?;
        if envelope.version != 1
            || envelope.mechanism != MECHANISM
            || envelope.key_id != self.opener.binding.key_id
            || envelope.request_nonce != self.opener.binding.request_nonce
        {
            return Err(proof_error());
        }
        let enc = base64url_decode(&envelope.enc, RAW_KEY_BYTES, RAW_KEY_BYTES)?;
        let encapped = CaveEncappedKey::from_bytes(&enc).map_err(|_| proof_error())?;
        let ciphertext = base64url_decode(&envelope.ciphertext, 16, RESPONSE_CIPHERTEXT_BYTES)?;
        let response_aad = encode_aad(RESPONSE_AAD_DOMAIN, &self.opener.binding)?;
        let mut recipient = setup_receiver::<CaveAead, CaveKdf, CaveKem>(
            &OpModeR::Auth(self.opener.authority_public_key),
            &self.opener.response_private_key,
            &encapped,
            RESPONSE_INFO,
        )
        .map_err(|_| proof_error())?;
        let plaintext = recipient
            .open(&ciphertext, &response_aad)
            .map_err(|_| proof_error())?;
        if plaintext.len() > RESPONSE_PLAINTEXT_BYTES {
            return Err(proof_error());
        }
        let parsed: ResponsePlaintext =
            serde_json::from_slice(&plaintext).map_err(|_| proof_error())?;
        if parsed.version != 1
            || parsed.request_nonce != self.opener.binding.request_nonce
            || !(100..=599).contains(&parsed.status)
            || parsed.headers.content_type != "application/json"
            || parsed
                .headers
                .retry_after
                .as_ref()
                .is_some_and(|value| value.len() > 256)
            || serde_jcs::to_vec(&parsed).map_err(|_| proof_error())? != plaintext
        {
            return Err(proof_error());
        }
        let maximum_body_bytes = maximum_body_bytes.min(RESPONSE_PLAINTEXT_BYTES);
        if parsed.body.len() > maximum_body_bytes.saturating_mul(4).div_ceil(3) {
            return Err(NativeDiagnostic::new("body_limit", false));
        }
        let body = base64url_decode(&parsed.body, 0, RESPONSE_PLAINTEXT_BYTES)?;
        if body.len() > maximum_body_bytes {
            return Err(NativeDiagnostic::new("body_limit", false));
        }
        Ok(CaveHpkeOpenedResponse {
            status_code: parsed.status,
            body,
        })
    }
}

async fn read_bounded_envelope(
    mut response: Response,
    maximum_bytes: usize,
) -> NativeResult<Vec<u8>> {
    if let Some(content_length) = response.headers().get(reqwest::header::CONTENT_LENGTH) {
        let bytes = content_length.as_bytes();
        if bytes.is_empty()
            || !bytes.iter().all(u8::is_ascii_digit)
            || (bytes.len() > 1 && bytes[0] == b'0')
            || std::str::from_utf8(bytes)
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .is_none_or(|length| length > maximum_bytes as u64)
        {
            return Err(proof_error());
        }
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| transport_error(&error))?
    {
        if body.len().saturating_add(chunk.len()) > maximum_bytes {
            return Err(proof_error());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn base64url_encoded_length(byte_length: usize) -> usize {
    byte_length.saturating_mul(4).div_ceil(3)
}

fn response_envelope_limit(maximum_body_bytes: usize) -> NativeResult<usize> {
    let bounded_body_bytes = maximum_body_bytes.min(RESPONSE_PLAINTEXT_BYTES);
    let fixed_plaintext_bytes = serde_jcs::to_vec(&ResponsePlaintext {
        body: String::new(),
        headers: ResponseHeaders {
            content_type: "application/json".to_owned(),
            retry_after: Some("\0".repeat(256)),
        },
        request_nonce: "A".repeat(ENCODED_KEY_CHARACTERS),
        status: 599,
        version: 1,
    })
    .map_err(|_| invalid_authority())?
    .len();
    let fixed_envelope_bytes = serde_jcs::to_vec(&ResponseEnvelopeLength {
        ciphertext: String::new(),
        enc: "A".repeat(ENCODED_KEY_CHARACTERS),
        key_id: "A".repeat(ENCODED_KEY_CHARACTERS),
        mechanism: MECHANISM,
        request_nonce: "A".repeat(ENCODED_KEY_CHARACTERS),
        version: 1,
    })
    .map_err(|_| invalid_authority())?
    .len();
    let plaintext_bytes = RESPONSE_PLAINTEXT_BYTES
        .min(fixed_plaintext_bytes.saturating_add(base64url_encoded_length(bounded_body_bytes)));
    let ciphertext_bytes =
        RESPONSE_CIPHERTEXT_BYTES.min(plaintext_bytes.saturating_add(RESPONSE_AEAD_OVERHEAD_BYTES));
    Ok(RESPONSE_ENVELOPE_BYTES
        .min(fixed_envelope_bytes.saturating_add(base64url_encoded_length(ciphertext_bytes))))
}

#[derive(Serialize)]
struct ResponseEnvelopeLength<'a> {
    ciphertext: String,
    enc: String,
    #[serde(rename = "keyId")]
    key_id: String,
    mechanism: &'a str,
    #[serde(rename = "requestNonce")]
    request_nonce: String,
    version: u8,
}

#[cfg(test)]
mod tests {
    use std::{
        convert::Infallible,
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    use rand_core::{TryCryptoRng, TryRng};
    use serde::Serialize;

    use super::*;
    use crate::cave::{
        pin_owner_discovery_record, test_discovery_bytes, OwnerDiscoveryRecord,
        OwnerDiscoveryRecordMetadata,
    };

    const INSTANCE_ID: &str = "00000000-0000-4000-8000-000000000000";

    struct FixedRng {
        bytes: Vec<u8>,
        offset: usize,
    }

    impl FixedRng {
        fn new(bytes: Vec<u8>) -> Self {
            Self { bytes, offset: 0 }
        }
    }

    impl TryRng for FixedRng {
        type Error = Infallible;

        fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
            let mut bytes = [0_u8; 4];
            self.try_fill_bytes(&mut bytes)?;
            Ok(u32::from_le_bytes(bytes))
        }

        fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
            let mut bytes = [0_u8; 8];
            self.try_fill_bytes(&mut bytes)?;
            Ok(u64::from_le_bytes(bytes))
        }

        fn try_fill_bytes(&mut self, destination: &mut [u8]) -> Result<(), Self::Error> {
            let end = self.offset + destination.len();
            destination.copy_from_slice(&self.bytes[self.offset..end]);
            self.offset = end;
            Ok(())
        }
    }

    impl TryCryptoRng for FixedRng {}

    #[derive(Serialize)]
    struct TestResponseEnvelope {
        ciphertext: String,
        enc: String,
        #[serde(rename = "keyId")]
        key_id: String,
        mechanism: &'static str,
        #[serde(rename = "requestNonce")]
        request_nonce: String,
        version: u8,
    }

    fn pinned_authority(endpoint: &str) -> PinnedCaveAuthority {
        let record = OwnerDiscoveryRecord {
            handle: String::new(),
            bytes: test_discovery_bytes(endpoint),
            record: OwnerDiscoveryRecordMetadata {
                identity: "owner-record".to_owned(),
                device: 1,
                inode: 2,
                process_alive: true,
            },
        };
        let authority = pin_owner_discovery_record(&record, 1).unwrap();
        authority.bind_instance_id(INSTANCE_ID).unwrap();
        authority
    }

    fn from_hex(value: &str) -> Vec<u8> {
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect()
    }

    fn header<'a>(request: &'a CaveHpkeBoundRequest, name: &str) -> &'a str {
        request
            .headers
            .iter()
            .find_map(|(candidate, value)| (*candidate == name).then_some(value.as_str()))
            .unwrap()
    }

    fn seal_response(request: &CaveHpkeBoundRequest, body: &[u8], authority_ikm: &[u8]) -> Vec<u8> {
        let (authority_private, authority_public) = CaveKem::derive_keypair(authority_ikm);
        let response_public = CaveKem::sk_to_pk(&request.opener.response_private_key);
        let mut response_rng = ChaCha20Rng::from_seed([9_u8; RAW_KEY_BYTES]);
        let (encapped, mut sender) = setup_sender_with_rng::<CaveAead, CaveKdf, CaveKem>(
            &OpModeS::Auth((authority_private, authority_public)),
            &response_public,
            RESPONSE_INFO,
            &mut response_rng,
        )
        .unwrap();
        let plaintext = serde_jcs::to_vec(&ResponsePlaintext {
            body: base64url_encode(body),
            headers: ResponseHeaders {
                content_type: "application/json".to_owned(),
                retry_after: None,
            },
            request_nonce: request.opener.binding.request_nonce.clone(),
            status: 200,
            version: 1,
        })
        .unwrap();
        let ciphertext = sender
            .seal(
                &plaintext,
                &encode_aad(RESPONSE_AAD_DOMAIN, &request.opener.binding).unwrap(),
            )
            .unwrap();
        serde_jcs::to_vec(&TestResponseEnvelope {
            ciphertext: base64url_encode(&ciphertext),
            enc: base64url_encode(&encapped.to_bytes()),
            key_id: request.opener.binding.key_id.clone(),
            mechanism: MECHANISM,
            request_nonce: request.opener.binding.request_nonce.clone(),
            version: 1,
        })
        .unwrap()
    }

    fn spawn_responder(listener: TcpListener, bodies: Vec<Vec<u8>>) -> thread::JoinHandle<()> {
        thread::spawn(move || {
            for body in bodies {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0_u8; 16 * 1024];
                let _ = stream.read(&mut request).unwrap();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: {RESPONSE_MEDIA_TYPE}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                stream.write_all(&body).unwrap();
            }
        })
    }

    async fn fetch(authority: &PinnedCaveAuthority, request: &CaveHpkeBoundRequest) -> Response {
        let mut builder = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
            .get(
                authority
                    .endpoint("api/client/v1/familiars?limit=1")
                    .unwrap(),
            );
        for (name, value) in &request.headers {
            builder = builder.header(*name, value);
        }
        builder.send().await.unwrap()
    }

    #[test]
    fn request_matches_the_reviewed_cave_producer_vector() {
        let authority = pinned_authority("http://127.0.0.1:3020");
        let response_ikm =
            from_hex("404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f");
        let request_nonce: [u8; RAW_KEY_BYTES] =
            base64url_decode("oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr8", 32, 32)
                .unwrap()
                .try_into()
                .unwrap();
        let mut request_rng = FixedRng::new(from_hex(
            "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f",
        ));
        let request = create_bound_request_with_material(
            &authority,
            "POST",
            "/api/client/v1/pairing/requests/11111111-1111-4111-8111-111111111111/exchange",
            &[],
            CaveHpkeAuthorization::PairingSecret("wMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX2Nna29zd3t8"),
            &response_ikm,
            request_nonce,
            1_787_672_578_109,
            &mut request_rng,
        )
        .unwrap();

        assert_eq!(
            base64url_encode(
                &encode_aad(REQUEST_AAD_DOMAIN, &request.opener.binding).unwrap()
            ),
            "T3BlbkNvdmVuL2NsaWVudC12MS9ocGtlLWJvdW5kLXYxL2FhZC9yZXF1ZXN0AAAAAARQT1NUAAAATS9hcGkvY2xpZW50L3YxL3BhaXJpbmcvcmVxdWVzdHMvMTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTExL2V4Y2hhbmdlAAAAIOOwxEKY_BwUmvv0yJlvuSQnrkHkZJuTTKSVmRt4UrhVAAAAJDAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMAAAACCAgYKDhIWGh4iJiouMjY6PkJGSk5SVlpeYmZqbnJ2enwAAACBOrTgYxJfkE88-KPM72kd9DWUCedr9FArMvWdwMaX7iAAAACCgoaKjpKWmp6ipqqusra6vsLGys7S1tre4ubq7vL2-vwAAAAgAAAGgOZbIPQ"
        );
        assert_eq!(
            header(&request, HEADER_ENC),
            "aTZYJUYw9zrY2nj7Mxv5ds1C-Q4OnJ6D9AxRBypvdBc"
        );
        assert_eq!(
            header(&request, HEADER_CIPHERTEXT),
            "Hx5Ux_qW9GaFJx2WVTVg-LlhpzWkFjRxKc4MMW56Fcd9_B_4_Cdsku6BtZQFMgN5aUsP7e73wD9jUUvp-dvKE7OiKhizxkTi7TPaTGIBUmXirSjuLc9d2pWnIjiy8VWfHH_FtlORecWPTSGV3tuz_DpFKnO2x0LphpuLkOTIuM0OuQYYQlEMocxTUIef3bmXgc3o8BK5X3av6IL6i1jl3c7zuyGIs3l4WCv2O99I1rzDjJ5dFvL2a41MPvZVSBs"
        );
    }

    #[test]
    fn authenticated_response_opens_once_and_replay_fails_closed() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let authority = pinned_authority(&format!("http://{}", listener.local_addr().unwrap()));
        let first = create_bound_request(
            &authority,
            "GET",
            "/api/client/v1/familiars?limit=1",
            &[],
            CaveHpkeAuthorization::Bearer("native-bearer"),
        )
        .unwrap();
        let replay = seal_response(
            &first,
            br#"{"data":{"familiars":[]}}"#,
            &(0_u8..32).collect::<Vec<_>>(),
        );
        let second = create_bound_request(
            &authority,
            "GET",
            "/api/client/v1/familiars?limit=1",
            &[],
            CaveHpkeAuthorization::Bearer("native-bearer"),
        )
        .unwrap();
        let server = spawn_responder(listener, vec![replay.clone(), replay]);

        let first_response = tauri::async_runtime::block_on(fetch(&authority, &first));
        let opened = tauri::async_runtime::block_on(first.open(first_response, 1_024)).unwrap();
        assert_eq!(opened.status_code, 200);
        assert_eq!(opened.body, br#"{"data":{"familiars":[]}}"#);

        let second_response = tauri::async_runtime::block_on(fetch(&authority, &second));
        assert_eq!(
            tauri::async_runtime::block_on(second.open(second_response, 1_024)).err(),
            Some(NativeDiagnostic::new("reconcile_required", false)),
        );
        server.join().unwrap();
    }

    #[test]
    fn authenticated_body_limit_and_wrong_authority_proof_remain_distinct() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let authority = pinned_authority(&format!("http://{}", listener.local_addr().unwrap()));
        let oversized = create_bound_request(
            &authority,
            "GET",
            "/api/client/v1/familiars?limit=1",
            &[],
            CaveHpkeAuthorization::Bearer("native-bearer"),
        )
        .unwrap();
        let oversized_response =
            seal_response(&oversized, &[b'x'; 33], &(0_u8..32).collect::<Vec<_>>());
        let wrong_authority = create_bound_request(
            &authority,
            "GET",
            "/api/client/v1/familiars?limit=1",
            &[],
            CaveHpkeAuthorization::Bearer("native-bearer"),
        )
        .unwrap();
        let wrong_response = seal_response(
            &wrong_authority,
            br#"{"data":{}}"#,
            &(32_u8..64).collect::<Vec<_>>(),
        );
        let server = spawn_responder(listener, vec![oversized_response, wrong_response]);

        let response = tauri::async_runtime::block_on(fetch(&authority, &oversized));
        assert_eq!(
            tauri::async_runtime::block_on(oversized.open(response, 32)).err(),
            Some(NativeDiagnostic::new("body_limit", false)),
        );
        let response = tauri::async_runtime::block_on(fetch(&authority, &wrong_authority));
        assert_eq!(
            tauri::async_runtime::block_on(wrong_authority.open(response, 1_024)).err(),
            Some(NativeDiagnostic::new("reconcile_required", false)),
        );
        server.join().unwrap();
    }

    #[test]
    fn oversized_response_envelope_fails_closed_before_body_read() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let authority = pinned_authority(&format!("http://{}", listener.local_addr().unwrap()));
        let request = create_bound_request(
            &authority,
            "GET",
            "/api/client/v1/familiars?limit=1",
            &[],
            CaveHpkeAuthorization::Bearer("native-bearer"),
        )
        .unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut received = [0_u8; 16 * 1024];
            let _ = stream.read(&mut received).unwrap();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: {RESPONSE_MEDIA_TYPE}\r\nContent-Length: 999999\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
        });

        let response = tauri::async_runtime::block_on(fetch(&authority, &request));
        assert_eq!(
            tauri::async_runtime::block_on(request.open(response, 32)).err(),
            Some(NativeDiagnostic::new("reconcile_required", false)),
        );
        server.join().unwrap();
    }
}
