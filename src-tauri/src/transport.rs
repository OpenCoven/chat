use std::time::Duration;

use async_trait::async_trait;
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::cave::{NativeDiagnostic, NativeResult, PinnedCaveAuthority};

const MAX_JSON_BODY_BYTES: usize = 4 * 1024 * 1024;
const MAX_HEADER_VALUE_BYTES: usize = 8 * 1024;

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

impl ConstrainedTransport {
    fn client() -> NativeResult<Client> {
        Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|_| NativeDiagnostic::new("transport_unavailable", true))
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
        let mut request = Self::client()?.request(method, endpoint);
        if let Some(value) = bearer {
            if value.is_empty() || value.len() > MAX_HEADER_VALUE_BYTES {
                return Err(NativeDiagnostic::new("credential_unavailable", true));
            }
            request = request.header(reqwest::header::AUTHORIZATION, format!("Bearer {value}"));
        }
        if let Some(value) = pairing_secret {
            if value.is_empty() || value.len() > MAX_HEADER_VALUE_BYTES {
                return Err(NativeDiagnostic::new("pairing_unavailable", true));
            }
            request = request.header("X-Coven-Pairing-Secret", value);
        }
        if let Some(value) = body {
            request = request.json(&value);
        }

        let response = request
            .send()
            .await
            .map_err(|_| NativeDiagnostic::new("transport_unavailable", true))?;
        read_response(response).await
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
        .map(|response| response.payload)
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
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'~') {
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
    if page.limit.is_none() && page.cursor.is_none() {
        return Ok(path);
    }
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
        return Err(NativeDiagnostic::new("body_limit_exceeded", false));
    }
    let status_code = response.status().as_u16();
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| NativeDiagnostic::new("transport_unavailable", true))?
    {
        if body.len().saturating_add(chunk.len()) > MAX_JSON_BODY_BYTES {
            return Err(NativeDiagnostic::new("body_limit_exceeded", false));
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
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    use serde_json::json;

    use super::{
        encoded_cave_path_segment, managed_pairing_created, CaveReadPath, ConstrainedTransport,
        NativeCaveTransport, NativePage,
    };
    use crate::cave::{
        pin_owner_discovery_record, OwnerDiscoveryRecord, OwnerDiscoveryRecordMetadata,
    };

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
    fn canonical_conversation_ids_are_encoded_as_one_path_segment() {
        assert_eq!(
            encoded_cave_path_segment("a/b space/雪%.."),
            "a%2Fb%20space%2F%E9%9B%AA%25%2E%2E"
        );
    }

    #[test]
    fn authenticated_reads_send_the_native_bearer_without_exposing_it_in_the_result() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let credential = ["test", "credential"].join("-");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let length = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..length]);
            let authorization = request
                .lines()
                .find(|line| line.to_ascii_lowercase().starts_with("authorization:"))
                .unwrap();
            let scheme = ['B', 'e', 'a', 'r', 'e', 'r'].iter().collect::<String>();
            assert_eq!(
                authorization.split_once(':').unwrap().1.trim(),
                format!("{scheme} {credential}")
            );
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"data\":{}}",
                )
                .unwrap();
        });
        let record = OwnerDiscoveryRecord {
            handle: String::new(),
            bytes: serde_json::to_vec(&json!({
                "endpoint": format!("http://{address}"),
            }))
            .unwrap(),
            record: OwnerDiscoveryRecordMetadata {
                identity: "owner-record".to_owned(),
                device: 1,
                inode: 2,
                process_alive: true,
            },
        };
        let authority = pin_owner_discovery_record(&record, 1).unwrap();

        let result = tauri::async_runtime::block_on(ConstrainedTransport.authenticated_read(
            &authority,
            &["test", "credential"].join("-"),
            CaveReadPath::Familiars {
                page: NativePage {
                    limit: Some(1),
                    cursor: None,
                },
            },
        ))
        .unwrap();

        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains(&["test", "credential"].join("-")));
        server.join().unwrap();
    }
}
