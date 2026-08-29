use std::time::Duration;

use async_trait::async_trait;
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    cave::{NativeDiagnostic, NativeResult, PinnedCaveAuthority},
    hpke_bound::{canonical_route, create_bound_request, CaveHpkeAuthorization},
};

const MAX_JSON_BODY_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeHttpResponse {
    pub status_code: u16,
    pub payload: Value,
}

pub(crate) struct NativePairingCreated {
    pub secret: String,
    pub response: Value,
}

pub(crate) struct NativePairingExchange {
    pub bearer: String,
    pub credential_id: String,
    pub response: Value,
}

#[async_trait]
pub(crate) trait NativeCaveTransport: Send + Sync {
    async fn health(&self, authority: &PinnedCaveAuthority) -> NativeResult<NativeHttpResponse>;
    async fn pairing_create(
        &self,
        authority: &PinnedCaveAuthority,
        request: Value,
    ) -> NativeResult<NativePairingCreated>;
    async fn pairing_poll(
        &self,
        authority: &PinnedCaveAuthority,
        request_id: &str,
        secret: &str,
    ) -> NativeResult<Value>;
    async fn pairing_exchange(
        &self,
        authority: &PinnedCaveAuthority,
        request_id: &str,
        secret: &str,
    ) -> NativeResult<NativePairingExchange>;
    async fn authenticated_read(
        &self,
        authority: &PinnedCaveAuthority,
        bearer: &str,
        path: CaveReadPath,
    ) -> NativeResult<NativeHttpResponse>;
}

#[derive(Clone)]
pub(crate) struct ConstrainedTransport;

#[derive(Clone)]
pub(crate) enum CaveReadPath {
    Familiars {
        page: NativePage,
    },
    Projects {
        page: NativePage,
    },
    Conversations {
        page: NativePage,
    },
    Conversation {
        conversation_id: String,
    },
    ConversationMessages {
        conversation_id: String,
        page: NativePage,
    },
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePage {
    pub limit: Option<u16>,
    pub cursor: Option<String>,
}

pub(crate) fn validate_pairing_request(value: &Value) -> NativeResult<()> {
    let request = value
        .as_object()
        .filter(|request| {
            request.len() == 3
                && ["appName", "installationId", "scopes"]
                    .iter()
                    .all(|key| request.contains_key(*key))
        })
        .ok_or_else(|| NativeDiagnostic::new("invalid_native_input", false))?;
    let app_name = request
        .get("appName")
        .and_then(Value::as_str)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 128
                && *value == value.trim()
                && !value.chars().any(char::is_control)
        })
        .ok_or_else(|| NativeDiagnostic::new("invalid_native_input", false))?;
    let installation_id = request
        .get("installationId")
        .and_then(Value::as_str)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 128
                && value.bytes().enumerate().all(|(index, byte)| {
                    if index == 0 {
                        byte.is_ascii_alphanumeric()
                    } else {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
                    }
                })
        })
        .ok_or_else(|| NativeDiagnostic::new("invalid_native_input", false))?;
    let scopes = request
        .get("scopes")
        .and_then(Value::as_array)
        .filter(|scopes| scopes.len() == 1 && scopes[0].as_str() == Some("chat:read"))
        .ok_or_else(|| NativeDiagnostic::new("invalid_native_input", false))?;
    let _ = (app_name, installation_id, scopes);
    Ok(())
}

impl NativePage {
    pub(crate) fn validate(&self) -> NativeResult<()> {
        if !matches!(self.limit, Some(1..=100))
            || self
                .cursor
                .as_deref()
                .is_some_and(|cursor| !is_canonical_cursor(cursor))
        {
            return Err(NativeDiagnostic::new("invalid_page_input", false));
        }
        Ok(())
    }
}

impl CaveReadPath {
    pub(crate) fn validate(&self) -> NativeResult<()> {
        match self {
            Self::Familiars { page } | Self::Projects { page } | Self::Conversations { page } => {
                page.validate()
            }
            Self::Conversation { conversation_id } => {
                validate_canonical_conversation_id(conversation_id)
            }
            Self::ConversationMessages {
                conversation_id,
                page,
            } => {
                validate_canonical_conversation_id(conversation_id)?;
                page.validate()
            }
        }
    }
}

fn is_canonical_cursor(value: &str) -> bool {
    if value.is_empty()
        || value.len() > 512
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return false;
    }
    let remainder = value.len() % 4;
    if remainder == 1 {
        return false;
    }
    if remainder == 0 {
        return true;
    }
    let trailing = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        .iter()
        .position(|candidate| *candidate == value.as_bytes()[value.len() - 1])
        .unwrap_or(usize::MAX);
    trailing != usize::MAX && trailing % (if remainder == 2 { 16 } else { 4 }) == 0
}

fn validate_canonical_conversation_id(value: &str) -> NativeResult<()> {
    if value.trim().is_empty()
        || matches!(value, "." | "..")
        || value.len() > 2_048
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~'))
    {
        return Err(NativeDiagnostic::new("invalid_native_input", false));
    }
    Ok(())
}

impl ConstrainedTransport {
    fn client() -> NativeResult<Client> {
        Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|_| NativeDiagnostic::new("service_unavailable", true))
    }

    async fn request(
        authority: &PinnedCaveAuthority,
        method: Method,
        path: &str,
        bearer: Option<&str>,
        pairing_secret: Option<&str>,
        body: Option<Value>,
    ) -> NativeResult<NativeHttpResponse> {
        let endpoint = authority.endpoint(path)?;
        if bearer.is_some() && pairing_secret.is_some() {
            return Err(NativeDiagnostic::new("invalid_native_input", false));
        }
        if let Some(authorization) = bearer
            .map(CaveHpkeAuthorization::Bearer)
            .or_else(|| pairing_secret.map(CaveHpkeAuthorization::PairingSecret))
        {
            let body = body
                .as_ref()
                .map(serde_json::to_vec)
                .transpose()
                .map_err(|_| NativeDiagnostic::new("invalid_native_input", false))?
                .unwrap_or_default();
            let route = canonical_route(&endpoint)?;
            let bound =
                create_bound_request(authority, method.as_str(), &route, &body, authorization)?;
            let declares_empty_body = method == Method::POST && body.is_empty();
            let mut request = Self::client()?.request(method, endpoint);
            for (name, value) in &bound.headers {
                request = request.header(*name, value);
            }
            if declares_empty_body {
                request = request.header(reqwest::header::CONTENT_LENGTH, 0);
            } else if !body.is_empty() {
                request = request
                    .header(reqwest::header::CONTENT_TYPE, "application/json")
                    .body(body);
            }
            let response = request.send().await.map_err(request_error)?;
            let opened = bound.open(response, MAX_JSON_BODY_BYTES).await?;
            let payload: Value = serde_json::from_slice(&opened.body)
                .map_err(|_| NativeDiagnostic::new("invalid_response", false))?;
            return Ok(NativeHttpResponse {
                status_code: opened.status_code,
                payload,
            });
        }
        let mut request = Self::client()?.request(method, endpoint);
        if let Some(value) = body {
            request = request.json(&value);
        }

        let response = request.send().await.map_err(request_error)?;
        read_response(response).await
    }
}

fn request_error(error: reqwest::Error) -> NativeDiagnostic {
    if error.is_timeout() {
        NativeDiagnostic::new("timeout", true)
    } else {
        NativeDiagnostic::new("service_unavailable", true)
    }
}

#[async_trait]
impl NativeCaveTransport for ConstrainedTransport {
    async fn health(&self, authority: &PinnedCaveAuthority) -> NativeResult<NativeHttpResponse> {
        Self::request(
            authority,
            Method::GET,
            "api/client/v1/health",
            None,
            None,
            None,
        )
        .await
    }

    async fn pairing_create(
        &self,
        authority: &PinnedCaveAuthority,
        request: Value,
    ) -> NativeResult<NativePairingCreated> {
        let response = Self::request(
            authority,
            Method::POST,
            "api/client/v1/pairing/requests",
            None,
            None,
            Some(request),
        )
        .await?;
        if !(200..300).contains(&response.status_code) {
            return Err(response_diagnostic(&response));
        }
        let (secret, response) = managed_pairing_created(response.payload)?;
        Ok(NativePairingCreated { secret, response })
    }

    async fn pairing_poll(
        &self,
        authority: &PinnedCaveAuthority,
        request_id: &str,
        secret: &str,
    ) -> NativeResult<Value> {
        validate_pairing_request_id(request_id)?;
        Self::request(
            authority,
            Method::GET,
            &format!("api/client/v1/pairing/requests/{request_id}"),
            None,
            Some(secret),
            None,
        )
        .await
        .and_then(|response| {
            if (200..300).contains(&response.status_code) {
                response_data(response.payload).map(Value::Object)
            } else {
                Err(response_diagnostic(&response))
            }
        })
    }

    async fn pairing_exchange(
        &self,
        authority: &PinnedCaveAuthority,
        request_id: &str,
        secret: &str,
    ) -> NativeResult<NativePairingExchange> {
        validate_pairing_request_id(request_id)?;
        let response = Self::request(
            authority,
            Method::POST,
            &format!("api/client/v1/pairing/requests/{request_id}/exchange"),
            None,
            Some(secret),
            None,
        )
        .await?;
        if !(200..300).contains(&response.status_code) {
            return Err(response_diagnostic(&response));
        }
        let (bearer, credential_id, response) = managed_pairing_exchange(response.payload)?;
        Ok(NativePairingExchange {
            bearer,
            credential_id,
            response,
        })
    }

    async fn authenticated_read(
        &self,
        authority: &PinnedCaveAuthority,
        bearer: &str,
        path: CaveReadPath,
    ) -> NativeResult<NativeHttpResponse> {
        path.validate()?;
        let (path, page) = match path {
            CaveReadPath::Familiars { page } => ("api/client/v1/familiars".to_owned(), Some(page)),
            CaveReadPath::Projects { page } => ("api/client/v1/projects".to_owned(), Some(page)),
            CaveReadPath::Conversations { page } => {
                ("api/client/v1/conversations".to_owned(), Some(page))
            }
            CaveReadPath::Conversation { conversation_id } => (
                format!(
                    "api/client/v1/conversations/{}",
                    encoded_cave_path_segment(&conversation_id)
                ),
                None,
            ),
            CaveReadPath::ConversationMessages {
                conversation_id,
                page,
            } => (
                {
                    format!(
                        "api/client/v1/conversations/{}/messages",
                        encoded_cave_path_segment(&conversation_id)
                    )
                },
                Some(page),
            ),
        };
        let path = with_page(path, page)?;
        Self::request(authority, Method::GET, &path, Some(bearer), None, None).await
    }
}

pub(crate) fn response_diagnostic(response: &NativeHttpResponse) -> NativeDiagnostic {
    let error = response.payload.get("error").and_then(Value::as_object);
    let retryable = error
        .and_then(|error| error.get("retryable"))
        .and_then(Value::as_bool)
        .unwrap_or(response.status_code >= 500 || response.status_code == 429);
    match error
        .and_then(|error| error.get("code"))
        .and_then(Value::as_str)
    {
        Some("invalid_request") => NativeDiagnostic::new("invalid_request", retryable),
        Some("unauthorized") => NativeDiagnostic::new("unauthorized", retryable),
        Some("scope_denied") => NativeDiagnostic::new("scope_denied", retryable),
        Some("not_found") => NativeDiagnostic::new("not_found", retryable),
        Some("conflict") => NativeDiagnostic::new("conflict", retryable),
        Some("rate_limited") => NativeDiagnostic::new("rate_limited", retryable),
        Some("pairing_pending") => NativeDiagnostic::new("pairing_pending", retryable),
        Some("pairing_denied") => NativeDiagnostic::new("pairing_denied", retryable),
        Some("pairing_expired") => NativeDiagnostic::new("pairing_expired", retryable),
        Some("incompatible_version") => NativeDiagnostic::new("incompatible_version", retryable),
        Some("service_unavailable") => NativeDiagnostic::new("service_unavailable", retryable),
        Some("reconcile_required") => NativeDiagnostic::new("reconcile_required", retryable),
        Some("internal_error") => NativeDiagnostic::new("internal_error", retryable),
        _ => match response.status_code {
            401 => NativeDiagnostic::new("unauthorized", false),
            403 => NativeDiagnostic::new("scope_denied", false),
            404 => NativeDiagnostic::new("not_found", false),
            409 => NativeDiagnostic::new("conflict", false),
            429 => NativeDiagnostic::new("rate_limited", true),
            500..=599 => NativeDiagnostic::new("service_unavailable", true),
            _ => NativeDiagnostic::new("invalid_response", false),
        },
    }
}

fn validate_pairing_request_id(value: &str) -> NativeResult<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(NativeDiagnostic::new("invalid_native_input", false));
    }
    Ok(())
}

pub(crate) fn encoded_cave_path_segment(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                char::from(byte).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

fn with_page(mut path: String, page: Option<NativePage>) -> NativeResult<String> {
    let Some(page) = page else {
        return Ok(path);
    };
    page.validate()?;
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    if let Some(limit) = page.limit {
        serializer.append_pair("limit", &limit.to_string());
    }
    if let Some(cursor) = page.cursor {
        if cursor.len() > 512 || cursor.chars().any(char::is_control) {
            return Err(NativeDiagnostic::new("invalid_page_input", false));
        }
        serializer.append_pair("cursor", &cursor);
    }
    path.push('?');
    path.push_str(&serializer.finish());
    Ok(path)
}

async fn read_response(mut response: reqwest::Response) -> NativeResult<NativeHttpResponse> {
    if response.status().is_redirection() {
        return Err(NativeDiagnostic::new("redirect_rejected", false));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_JSON_BODY_BYTES as u64)
    {
        return Err(NativeDiagnostic::new("body_limit", false));
    }
    let status_code = response.status().as_u16();
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(request_error)? {
        if body.len().saturating_add(chunk.len()) > MAX_JSON_BODY_BYTES {
            return Err(NativeDiagnostic::new("body_limit", false));
        }
        body.extend_from_slice(&chunk);
    }
    let payload = serde_json::from_slice(&body)
        .map_err(|_| NativeDiagnostic::new("invalid_native_response", false))?;
    Ok(NativeHttpResponse {
        status_code,
        payload,
    })
}

fn response_data(value: Value) -> NativeResult<serde_json::Map<String, Value>> {
    let candidate = value
        .as_object()
        .and_then(|root| root.get("data"))
        .cloned()
        .unwrap_or(value);
    candidate
        .as_object()
        .cloned()
        .ok_or_else(|| NativeDiagnostic::new("invalid_native_response", false))
}

pub(crate) fn managed_pairing_created(value: Value) -> NativeResult<(String, Value)> {
    let mut data = response_data(value)?;
    let secret = data
        .remove("secret")
        .and_then(|value| value.as_str().map(str::to_owned))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| NativeDiagnostic::new("invalid_native_response", false))?;
    Ok((secret, Value::Object(data)))
}

fn managed_pairing_exchange(value: Value) -> NativeResult<(String, String, Value)> {
    let mut data = response_data(value)?;
    let bearer = data
        .remove("bearer")
        .and_then(|value| value.as_str().map(str::to_owned))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| NativeDiagnostic::new("invalid_native_response", false))?;
    let credential_id = data
        .get("credential")
        .and_then(Value::as_object)
        .and_then(|credential| credential.get("id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| NativeDiagnostic::new("invalid_native_response", false))?;
    Ok((bearer, credential_id, Value::Object(data)))
}

#[cfg(test)]
mod tests {
    use std::{
        env,
        ffi::OsString,
        io::ErrorKind,
        io::{Read, Write},
        net::TcpListener,
        sync::{
            atomic::{AtomicBool, Ordering},
            mpsc, Arc, Mutex, OnceLock,
        },
        thread,
        time::{Duration, Instant},
    };

    use serde_json::json;

    use super::{
        encoded_cave_path_segment, managed_pairing_created, response_data, response_diagnostic,
        CaveReadPath, ConstrainedTransport, NativeCaveTransport, NativeHttpResponse, NativePage,
    };
    use crate::cave::{
        pin_owner_discovery_record, OwnerDiscoveryRecord, OwnerDiscoveryRecordMetadata,
    };
    use crate::operation::{NativeCancelReason, NativeOperationInput, NativeOperationRegistry};

    const PROXY_ENVIRONMENT_VARIABLES: [&str; 6] = [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ];
    const PROXY_BYPASS_ENVIRONMENT_VARIABLES: [&str; 2] = ["NO_PROXY", "no_proxy"];
    static PROXY_ENVIRONMENT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    const INSTANCE_ID: &str = "00000000-0000-4000-8000-000000000000";
    const HPKE_KEY_ID: &str = "Tq04GMSX5BPPPijzO9pHfQ1lAnna_RQKzL1ncDGl-4g";
    const HPKE_PUBLIC_KEY: &str = "sfG4QN56MkGwJ0jPmwW3TcjF6EUSmHOIF712qo6-jCs";
    const HPKE_RUNTIME_NONCE: &str = "gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp8";
    const FIRST_OPERATION_ATTEMPT: &str = "op1-1787900000000-1-00000000000000000000000000000000";
    const SECOND_OPERATION_ATTEMPT: &str = "op1-1787900000000-2-11111111111111111111111111111111";

    struct ScopedEnvironment {
        original: Vec<(&'static str, Option<OsString>)>,
    }

    impl ScopedEnvironment {
        fn proxy(proxy: &str) -> Self {
            let changes = PROXY_ENVIRONMENT_VARIABLES
                .into_iter()
                .map(|name| (name, Some(OsString::from(proxy))))
                .chain(
                    PROXY_BYPASS_ENVIRONMENT_VARIABLES
                        .into_iter()
                        .map(|name| (name, None)),
                )
                .collect::<Vec<_>>();
            let original = changes
                .iter()
                .map(|(name, _)| (*name, env::var_os(name)))
                .collect::<Vec<_>>();

            for (name, value) in changes {
                match value {
                    Some(value) => env::set_var(name, value),
                    None => env::remove_var(name),
                }
            }

            Self { original }
        }
    }

    impl Drop for ScopedEnvironment {
        fn drop(&mut self) {
            for (name, value) in self.original.drain(..) {
                match value {
                    Some(value) => env::set_var(name, value),
                    None => env::remove_var(name),
                }
            }
        }
    }

    fn owner_record(endpoint: String) -> OwnerDiscoveryRecord {
        OwnerDiscoveryRecord {
            handle: String::new(),
            bytes: serde_json::to_vec(&json!({
                "version": 2,
                "endpoint": endpoint,
                "pid": 1,
                "nonce": HPKE_RUNTIME_NONCE,
                "startedAt": "2026-01-01T00:00:00Z",
                "authority": {
                    "mechanism": "hpke-bound-v1",
                    "mode": "enforce",
                    "keyId": HPKE_KEY_ID,
                    "publicKey": HPKE_PUBLIC_KEY,
                    "suite": {
                        "kemId": 32,
                        "kdfId": 1,
                        "aeadId": 2,
                    },
                },
            }))
            .unwrap(),
            record: OwnerDiscoveryRecordMetadata {
                identity: "owner-record".to_owned(),
                device: 1,
                inode: 2,
                process_alive: true,
            },
        }
    }

    #[test]
    fn managed_pairing_creation_removes_the_secret_before_crossing_ipc() {
        let (secret, created) = managed_pairing_created(json!({
            "requestId": "request-1",
            "secret": "pairing-secret-canary",
            "expiresAt": 42,
        }))
        .unwrap();

        assert_eq!(secret, "pairing-secret-canary");
        assert_eq!(
            created,
            json!({
                "requestId": "request-1",
                "expiresAt": 42,
            }),
        );
        assert!(!created.to_string().contains("pairing-secret-canary"));
    }

    #[test]
    fn managed_pairing_status_unwraps_data_and_preserves_safe_protocol_errors() {
        assert_eq!(
            response_data(json!({
                "apiVersion": "1.0",
                "data": {
                    "id": "11111111-1111-4111-8111-111111111111",
                    "status": "pending",
                    "expiresAt": 42,
                },
            }))
            .unwrap(),
            json!({
                "id": "11111111-1111-4111-8111-111111111111",
                "status": "pending",
                "expiresAt": 42,
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        assert_eq!(
            response_diagnostic(&NativeHttpResponse {
                status_code: 410,
                payload: json!({
                    "error": {
                        "code": "pairing_expired",
                        "retryable": false,
                        "message": "must not cross native IPC",
                    },
                }),
            }),
            crate::cave::NativeDiagnostic::new("pairing_expired", false),
        );
    }

    #[test]
    fn canonical_conversation_ids_are_bounded_to_one_unescaped_path_segment() {
        assert_eq!(
            encoded_cave_path_segment("conversation-1.alpha_beta~gamma"),
            "conversation-1.alpha_beta~gamma"
        );
        for conversation_id in ["", ".", "..", "a/b", "space id", "雪", "percent%"] {
            assert!(CaveReadPath::Conversation {
                conversation_id: conversation_id.to_owned(),
            }
            .validate()
            .is_err());
        }
    }

    #[test]
    fn endpoint_takeover_receives_ciphertext_only_and_cannot_forge_a_response() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let bearer = "bearer-canary-must-remain-native";
        let (request_tx, request_rx) = mpsc::sync_channel(1);
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 16 * 1024];
            let length = stream.read(&mut request).unwrap();
            request_tx
                .send(String::from_utf8_lossy(&request[..length]).into_owned())
                .unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"data\":{}}",
                )
                .unwrap();
        });
        let record = owner_record(format!("http://{address}"));
        let authority = pin_owner_discovery_record(&record, 1).unwrap();
        authority.bind_instance_id(INSTANCE_ID).unwrap();

        let result = tauri::async_runtime::block_on(ConstrainedTransport.authenticated_read(
            &authority,
            bearer,
            CaveReadPath::Familiars {
                page: NativePage {
                    limit: Some(1),
                    cursor: None,
                },
            },
        ));
        let request = request_rx.recv().unwrap();

        assert_eq!(
            result.err(),
            Some(crate::cave::NativeDiagnostic::new(
                "reconcile_required",
                false,
            )),
        );
        assert!(!request.contains(bearer));
        assert!(!request.to_ascii_lowercase().contains("authorization:"));
        assert!(request
            .to_ascii_lowercase()
            .contains("x-coven-client-v1-authority-ciphertext:"));
        assert!(request
            .to_ascii_lowercase()
            .contains("x-coven-client-v1-authority-enc:"));
        server.join().unwrap();
    }

    #[test]
    fn pairing_secret_takeover_receives_only_ciphertext() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let pairing_secret = "wMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX2Nna29zd3t8";
        let (request_tx, request_rx) = mpsc::sync_channel(1);
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 16 * 1024];
            let length = stream.read(&mut request).unwrap();
            request_tx
                .send(String::from_utf8_lossy(&request[..length]).into_owned())
                .unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"data\":{}}",
                )
                .unwrap();
        });
        let authority =
            pin_owner_discovery_record(&owner_record(format!("http://{address}")), 1).unwrap();
        authority.bind_instance_id(INSTANCE_ID).unwrap();

        let result = tauri::async_runtime::block_on(ConstrainedTransport.pairing_poll(
            &authority,
            "11111111-1111-4111-8111-111111111111",
            pairing_secret,
        ));
        let request = request_rx.recv().unwrap();

        assert_eq!(
            result.err(),
            Some(crate::cave::NativeDiagnostic::new(
                "reconcile_required",
                false,
            )),
        );
        assert!(!request.contains(pairing_secret));
        assert!(!request
            .to_ascii_lowercase()
            .contains("x-coven-pairing-secret:"));
        assert!(request
            .to_ascii_lowercase()
            .contains("x-coven-client-v1-authority-ciphertext:"));
        server.join().unwrap();
    }

    #[test]
    fn pairing_exchange_empty_post_declares_zero_content_length() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let pairing_secret = "wMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX2Nna29zd3t8";
        let (request_tx, request_rx) = mpsc::sync_channel(1);
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 16 * 1024];
            let length = stream.read(&mut request).unwrap();
            request_tx
                .send(String::from_utf8_lossy(&request[..length]).into_owned())
                .unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"data\":{}}",
                )
                .unwrap();
        });
        let authority =
            pin_owner_discovery_record(&owner_record(format!("http://{address}")), 1).unwrap();
        authority.bind_instance_id(INSTANCE_ID).unwrap();

        let result = tauri::async_runtime::block_on(ConstrainedTransport.pairing_exchange(
            &authority,
            "11111111-1111-4111-8111-111111111111",
            pairing_secret,
        ));
        let request = request_rx.recv().unwrap().to_ascii_lowercase();

        assert_eq!(
            result.err(),
            Some(crate::cave::NativeDiagnostic::new(
                "reconcile_required",
                false,
            )),
        );
        assert!(request.contains("\r\ncontent-length: 0\r\n"));
        server.join().unwrap();
    }

    #[test]
    fn operation_abort_and_timeout_preempt_hpke_proof_classification() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (accepted_tx, accepted_rx) = mpsc::sync_channel(2);
        let server = thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = [0_u8; 16 * 1024];
                let length = stream.read(&mut request).unwrap();
                assert!(String::from_utf8_lossy(&request[..length])
                    .contains("x-coven-client-v1-authority-ciphertext:"));
                accepted_tx.send(()).unwrap();
                loop {
                    match stream.read(&mut request) {
                        Ok(0) => break,
                        Ok(_) => continue,
                        Err(error)
                            if matches!(
                                error.kind(),
                                ErrorKind::WouldBlock | ErrorKind::TimedOut
                            ) =>
                        {
                            panic!("bounded HPKE request did not close");
                        }
                        Err(_) => break,
                    }
                }
            }
        });
        let authority =
            pin_owner_discovery_record(&owner_record(format!("http://{address}")), 1).unwrap();
        authority.bind_instance_id(INSTANCE_ID).unwrap();
        let registry = Arc::new(NativeOperationRegistry::default());
        let abort_registry = Arc::clone(&registry);
        let abort_authority = authority.clone();
        let aborted = thread::spawn(move || {
            tauri::async_runtime::block_on(abort_registry.run(
                NativeOperationInput::new(FIRST_OPERATION_ATTEMPT.to_owned(), 1_000).unwrap(),
                ConstrainedTransport.authenticated_read(
                    &abort_authority,
                    "native-bearer",
                    CaveReadPath::Familiars {
                        page: NativePage {
                            limit: Some(1),
                            cursor: None,
                        },
                    },
                ),
            ))
        });
        accepted_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        registry
            .cancel(
                FIRST_OPERATION_ATTEMPT.to_owned(),
                NativeCancelReason::Aborted,
            )
            .unwrap();
        assert_eq!(
            aborted.join().unwrap().err(),
            Some(crate::cave::NativeDiagnostic::new("aborted", false))
        );

        let timed = tauri::async_runtime::block_on(registry.run(
            NativeOperationInput::new(SECOND_OPERATION_ATTEMPT.to_owned(), 25).unwrap(),
            ConstrainedTransport.authenticated_read(
                &authority,
                "native-bearer",
                CaveReadPath::Familiars {
                    page: NativePage {
                        limit: Some(1),
                        cursor: None,
                    },
                },
            ),
        ));
        accepted_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(
            timed.err(),
            Some(crate::cave::NativeDiagnostic::new("timeout", true))
        );
        server.join().unwrap();
    }

    #[test]
    fn constrained_transport_ignores_ambient_proxy_variables_for_loopback_requests() {
        let _environment_lock = PROXY_ENVIRONMENT_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let original_environment = PROXY_ENVIRONMENT_VARIABLES
            .into_iter()
            .chain(PROXY_BYPASS_ENVIRONMENT_VARIABLES)
            .map(|name| (name, env::var_os(name)))
            .collect::<Vec<_>>();

        let target_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let target_address = target_listener.local_addr().unwrap();
        let target = thread::spawn(move || {
            let (mut stream, _) = target_listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let length = stream.read(&mut request).unwrap();
            assert!(String::from_utf8_lossy(&request[..length])
                .starts_with("GET /api/client/v1/health "));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"data\":{}}",
                )
                .unwrap();
        });

        let proxy_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        proxy_listener.set_nonblocking(true).unwrap();
        let proxy_address = proxy_listener.local_addr().unwrap();
        let proxy_received = Arc::new(AtomicBool::new(false));
        let proxy_received_by_server = Arc::clone(&proxy_received);
        let proxy = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(1);
            while Instant::now() < deadline {
                match proxy_listener.accept() {
                    Ok((mut stream, _)) => {
                        proxy_received_by_server.store(true, Ordering::SeqCst);
                        let _ = stream.write_all(
                            b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        );
                        return;
                    }
                    Err(error) if error.kind() == ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => return,
                }
            }
        });

        let environment = ScopedEnvironment::proxy(&format!("http://{proxy_address}"));
        let record = owner_record(format!("http://{target_address}"));
        let authority = pin_owner_discovery_record(&record, 1).unwrap();

        let response =
            tauri::async_runtime::block_on(ConstrainedTransport.health(&authority)).unwrap();

        assert_eq!(response.status_code, 200);
        assert_eq!(response.payload, json!({"data": {}}));
        target.join().unwrap();
        proxy.join().unwrap();
        assert!(!proxy_received.load(Ordering::SeqCst));

        drop(environment);
        for (name, value) in original_environment {
            assert_eq!(env::var_os(name), value);
        }
    }
}
