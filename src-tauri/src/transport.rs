use serde::{de::DeserializeOwned, Deserialize, Serialize};

use crate::cave::{
    parse_discovery_document, DiscoveryDocument, NativeDiagnostic, NativeResult,
    ValidatedCaveAuthority,
};

const MAX_JSON_BODY_BYTES: usize = 4 * 1024 * 1024;
#[allow(dead_code)]
pub const MAX_SSE_FRAME_BYTES: usize = 1024 * 1024;
const PAIRING_SCOPES: [&str; 6] = [
    "chat:read",
    "chat:write",
    "conversations:write",
    "attachments:write",
    "tasks:write",
    "github:write",
];

#[derive(Clone)]
pub(crate) struct ConstrainedTransport {
    client: reqwest::Client,
    authority: ValidatedCaveAuthority,
}

#[derive(Clone)]
pub(crate) struct PairingIssued {
    pub request_id: String,
    pub secret: String,
    pub expires_at: u64,
}

pub(crate) struct PairingGrant {
    pub bearer: String,
    pub metadata: crate::keyring::CredentialMetadata,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PairingStatus {
    Pending,
    Approved,
    Denied,
    Expired,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartConversationInput {
    pub title: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationStartDto {
    pub conversation_id: String,
}

impl ConstrainedTransport {
    pub(crate) fn new(authority: ValidatedCaveAuthority) -> NativeResult<Self> {
        Ok(Self {
            client: client()?,
            authority,
        })
    }

    pub(crate) fn authority(&self) -> &ValidatedCaveAuthority {
        &self.authority
    }

    pub(crate) async fn discover(discovery_url: url::Url) -> NativeResult<ValidatedCaveAuthority> {
        let response = client()?
            .get(discovery_url.clone())
            .send()
            .await
            .map_err(|_| NativeDiagnostic::new("discovery_unavailable", true))?;
        let document: DiscoveryDocument = read_client_data(response).await?;
        parse_discovery_document(discovery_url, document)
    }

    pub(crate) async fn health(&self, bearer: Option<&str>) -> NativeResult<()> {
        let request = self.client.get(self.endpoint("api/client/v1/health")?);
        let request = match bearer {
            Some(value) => {
                request.header(reqwest::header::AUTHORIZATION, format!("Bearer {value}"))
            }
            None => request,
        };
        let response = request
            .send()
            .await
            .map_err(|_| NativeDiagnostic::new("transport_unavailable", true))?;
        let _: serde_json::Value = read_client_data(response).await?;
        Ok(())
    }

    pub(crate) async fn create_pairing(
        &self,
        installation_id: &str,
    ) -> NativeResult<PairingIssued> {
        let response = self
            .client
            .post(self.endpoint("api/client/v1/pairing/requests")?)
            .json(&serde_json::json!({
                "installationId": installation_id,
                "app": {
                    "name": crate::APP_NAME,
                    "identifier": crate::APP_IDENTIFIER,
                },
                "scopes": PAIRING_SCOPES,
            }))
            .send()
            .await
            .map_err(|_| NativeDiagnostic::new("transport_unavailable", true))?;
        let response: PairingIssuedResponse = read_client_data(response).await?;

        if response.request_id.is_empty() || response.secret.is_empty() {
            return Err(NativeDiagnostic::new("invalid_pairing_response", false));
        }

        Ok(PairingIssued {
            request_id: response.request_id,
            secret: response.secret,
            expires_at: response.expires_at,
        })
    }

    pub(crate) async fn poll_pairing(
        &self,
        request_id: &str,
        secret: &str,
    ) -> NativeResult<PairingStatus> {
        let response = self
            .client
            .get(self.pairing_endpoint(request_id)?)
            .header("X-Coven-Pairing-Secret", secret)
            .send()
            .await
            .map_err(|_| NativeDiagnostic::new("transport_unavailable", true))?;
        let response: PairingStatusResponse = read_client_data(response).await?;

        match response.status.as_str() {
            "pending" => Ok(PairingStatus::Pending),
            "approved" => Ok(PairingStatus::Approved),
            "denied" => Ok(PairingStatus::Denied),
            "expired" => Ok(PairingStatus::Expired),
            _ => Err(NativeDiagnostic::new("invalid_pairing_response", false)),
        }
    }

    pub(crate) async fn exchange_pairing(
        &self,
        request_id: &str,
        secret: &str,
    ) -> NativeResult<PairingGrant> {
        Self::validate_pairing_request_id(request_id)?;
        let endpoint = self
            .endpoint("api/client/v1/pairing/requests/")?
            .join(&format!("{request_id}/exchange"))
            .map_err(|_| NativeDiagnostic::new("invalid_cave_destination", false))?;
        let response = self
            .client
            .post(endpoint)
            .header("X-Coven-Pairing-Secret", secret)
            .send()
            .await
            .map_err(|_| NativeDiagnostic::new("transport_unavailable", true))?;
        let response: PairingExchangeResponse = read_client_data(response).await?;

        if response.bearer.is_empty() || response.credential_id.is_empty() {
            return Err(NativeDiagnostic::new("invalid_pairing_response", false));
        }

        Ok(PairingGrant {
            bearer: response.bearer,
            metadata: crate::keyring::CredentialMetadata {
                credential_id: response.credential_id,
            },
        })
    }

    pub(crate) async fn start_conversation(
        &self,
        bearer: &str,
        input: StartConversationInput,
    ) -> NativeResult<ConversationStartDto> {
        let response = self
            .client
            .post(self.endpoint("api/client/v1/conversations")?)
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {bearer}"))
            .json(&input)
            .send()
            .await
            .map_err(|_| NativeDiagnostic::new("transport_unavailable", true))?;
        let response: ConversationStartDto = read_client_data(response).await?;

        if response.conversation_id.is_empty() {
            return Err(NativeDiagnostic::new(
                "invalid_conversation_response",
                false,
            ));
        }
        Ok(response)
    }

    fn endpoint(&self, path: &'static str) -> NativeResult<url::Url> {
        self.authority.client_url(path)
    }

    fn pairing_endpoint(&self, request_id: &str) -> NativeResult<url::Url> {
        Self::validate_pairing_request_id(request_id)?;

        self.endpoint("api/client/v1/pairing/requests/")?
            .join(request_id)
            .map_err(|_| NativeDiagnostic::new("invalid_cave_destination", false))
    }

    fn validate_pairing_request_id(request_id: &str) -> NativeResult<()> {
        if request_id.is_empty()
            || request_id.len() > 128
            || !request_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            Err(NativeDiagnostic::new("invalid_pairing_request", false))
        } else {
            Ok(())
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingIssuedResponse {
    request_id: String,
    secret: String,
    expires_at: u64,
}

#[derive(Deserialize)]
struct PairingStatusResponse {
    status: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingExchangeResponse {
    bearer: String,
    credential_id: String,
}

#[derive(Deserialize)]
struct ClientV1Envelope<T> {
    ok: bool,
    data: T,
}

fn client() -> NativeResult<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| NativeDiagnostic::new("transport_unavailable", true))
}

async fn read_json<T: DeserializeOwned>(mut response: reqwest::Response) -> NativeResult<T> {
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(NativeDiagnostic::new("unauthorized", true));
    }
    if response.status().is_redirection() {
        return Err(NativeDiagnostic::new("redirect_rejected", false));
    }
    if !response.status().is_success() {
        return Err(NativeDiagnostic::new("transport_rejected", true));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_JSON_BODY_BYTES as u64)
    {
        return Err(NativeDiagnostic::new("body_limit_exceeded", false));
    }

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

    serde_json::from_slice(&body).map_err(|_| NativeDiagnostic::new("invalid_cave_response", false))
}

async fn read_client_data<T: DeserializeOwned>(response: reqwest::Response) -> NativeResult<T> {
    let envelope: ClientV1Envelope<T> = read_json(response).await?;

    if envelope.ok {
        Ok(envelope.data)
    } else {
        Err(NativeDiagnostic::new("invalid_cave_response", false))
    }
}

#[allow(dead_code)]
pub fn validate_sse_frame_size(size: usize) -> NativeResult<()> {
    if size > MAX_SSE_FRAME_BYTES {
        Err(NativeDiagnostic::new("frame_limit_exceeded", false))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::validate_sse_frame_size;

    #[test]
    fn rejects_oversized_sse_frames() {
        assert_eq!(
            validate_sse_frame_size(1024 * 1024 + 1).unwrap_err().code,
            "frame_limit_exceeded"
        );
    }
}
