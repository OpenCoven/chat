use std::time::Duration;

use serde::Serialize;

use crate::{
    cave::{
        launch_installed_cave, CaveIdentity, DiscoverySnapshot, NativeDiagnostic, NativeResult,
    },
    keyring::CredentialMetadata,
    transport::{
        ConstrainedTransport, ConversationStartDto, PairingIssued, PairingStatus,
        StartConversationInput,
    },
    NativeConnectionState,
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStateDto {
    pub status: String,
    pub instance_id: Option<String>,
    pub epoch: Option<u64>,
    pub pairing: Option<PairingStateDto>,
    pub diagnostic: Option<NativeDiagnostic>,
}

impl ConnectionStateDto {
    pub(crate) fn from_runtime(status: &str, _secret: Option<&str>) -> Self {
        Self {
            status: status.to_owned(),
            instance_id: None,
            epoch: None,
            pairing: None,
            diagnostic: None,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingStateDto {
    pub request_id: String,
    pub expires_at: u64,
    pub status: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UnauthorizedAction {
    RefreshDiscovery,
    ConfirmRevocation,
}

#[derive(Debug, Default)]
pub(crate) struct UnauthorizedTracker {
    last_unauthorized: Option<CaveIdentity>,
}

impl UnauthorizedTracker {
    pub(crate) fn record(&mut self, instance_id: &str, epoch: u64) -> UnauthorizedAction {
        let identity = CaveIdentity {
            instance_id: instance_id.to_owned(),
            epoch,
        };

        if self.last_unauthorized.as_ref() == Some(&identity) {
            UnauthorizedAction::ConfirmRevocation
        } else {
            self.last_unauthorized = Some(identity);
            UnauthorizedAction::RefreshDiscovery
        }
    }

    fn reset(&mut self) {
        self.last_unauthorized = None;
    }

    fn confirms(&self, identity: &CaveIdentity) -> bool {
        self.last_unauthorized.as_ref() == Some(identity)
    }
}

struct PendingPairing {
    request_id: String,
    secret: String,
    expires_at: u64,
    attempt_id: u64,
}

pub(crate) struct ConnectionRuntime {
    state: ConnectionStateDto,
    authority: Option<crate::cave::ValidatedCaveAuthority>,
    authorized: Option<AuthorizedCave>,
    pending_pairing: Option<PendingPairing>,
    pairing_in_flight: bool,
    attempt_id: u64,
    unauthorized: UnauthorizedTracker,
}

#[derive(Debug)]
struct AuthorizedCave {
    identity: CaveIdentity,
    credential_id: String,
}

impl Default for ConnectionRuntime {
    fn default() -> Self {
        Self {
            state: ConnectionStateDto::from_runtime("disconnected", None),
            authority: None,
            authorized: None,
            pending_pairing: None,
            pairing_in_flight: false,
            attempt_id: 0,
            unauthorized: UnauthorizedTracker::default(),
        }
    }
}

impl ConnectionRuntime {
    fn snapshot(&self) -> ConnectionStateDto {
        self.state.clone()
    }

    fn begin_attempt(&mut self) -> ConnectionStateDto {
        self.attempt_id = self.attempt_id.saturating_add(1);
        self.pending_pairing = None;
        self.pairing_in_flight = false;
        self.state = ConnectionStateDto::from_runtime("locating", None);
        self.state.instance_id = self
            .authority
            .as_ref()
            .map(|authority| authority.identity().instance_id.clone());
        self.state.epoch = self
            .authority
            .as_ref()
            .map(|authority| authority.identity().epoch);
        self.unauthorized.reset();
        self.snapshot()
    }

    fn set_authority(
        &mut self,
        authority: crate::cave::ValidatedCaveAuthority,
    ) -> NativeResult<DiscoverySnapshot> {
        let identity_changed = self
            .authority
            .as_ref()
            .map(|current| current.identity() != authority.identity())
            .unwrap_or(true);

        if identity_changed {
            self.pending_pairing = None;
            self.pairing_in_flight = false;
            self.authorized = None;
            self.unauthorized.reset();
        }

        let snapshot = DiscoverySnapshot::from(&authority);
        self.state = ConnectionStateDto {
            status: "discovered".to_owned(),
            instance_id: Some(snapshot.instance_id.clone()),
            epoch: Some(snapshot.epoch),
            pairing: None,
            diagnostic: None,
        };
        self.authority = Some(authority);
        Ok(snapshot)
    }

    fn current_authority(&self) -> NativeResult<crate::cave::ValidatedCaveAuthority> {
        self.authority
            .clone()
            .ok_or_else(|| NativeDiagnostic::new("discovery_missing", true))
    }

    fn reserve_pairing(&mut self) -> NativeResult<u64> {
        if self.pairing_in_flight || self.pending_pairing.is_some() {
            return Err(NativeDiagnostic::new("pairing_in_progress", true));
        }

        self.pairing_in_flight = true;
        Ok(self.attempt_id)
    }

    fn cancel_pairing(&mut self, request_id: &str) -> NativeResult<ConnectionStateDto> {
        let Some(pending) = &self.pending_pairing else {
            return Err(NativeDiagnostic::new("pairing_not_found", false));
        };

        if pending.request_id != request_id {
            return Err(NativeDiagnostic::new("pairing_not_found", false));
        }

        self.pending_pairing = None;
        self.pairing_in_flight = false;
        self.state.pairing = None;
        self.state.status = "pairing_cancelled".to_owned();
        Ok(self.snapshot())
    }

    fn abort_pairing_reservation(&mut self, attempt_id: u64) {
        if self.attempt_id == attempt_id {
            self.pairing_in_flight = false;
        }
    }

    fn register_pending_pairing(
        &mut self,
        issued: &PairingIssued,
        attempt_id: u64,
    ) -> NativeResult<PairingStateDto> {
        if !self.pairing_in_flight || self.attempt_id != attempt_id {
            return Err(NativeDiagnostic::new("stale_connection_attempt", true));
        }

        self.pairing_in_flight = false;
        self.pending_pairing = Some(PendingPairing {
            request_id: issued.request_id.clone(),
            secret: issued.secret.clone(),
            expires_at: issued.expires_at,
            attempt_id,
        });
        let pairing = PairingStateDto {
            request_id: issued.request_id.clone(),
            expires_at: issued.expires_at,
            status: "pending".to_owned(),
        };
        self.state.status = "pairing".to_owned();
        self.state.pairing = Some(pairing.clone());
        self.state.diagnostic = None;
        Ok(pairing)
    }

    fn pairing_is_current(&self, request_id: &str, attempt_id: u64) -> bool {
        self.pending_pairing.as_ref().is_some_and(|pending| {
            pending.request_id == request_id && pending.attempt_id == attempt_id
        })
    }

    fn pairing_secret(&self, request_id: &str, attempt_id: u64) -> Option<String> {
        self.pending_pairing.as_ref().and_then(|pending| {
            (pending.request_id == request_id && pending.attempt_id == attempt_id)
                .then(|| pending.secret.clone())
        })
    }

    fn expire_pairing_if_needed(&mut self, request_id: &str, attempt_id: u64) -> bool {
        let expired = self.pending_pairing.as_ref().is_some_and(|pending| {
            pending.request_id == request_id
                && pending.attempt_id == attempt_id
                && pending.expires_at <= unix_time_millis()
        });

        if expired {
            self.fail_pairing(request_id, NativeDiagnostic::new("pairing_expired", false));
        }

        expired
    }

    fn mark_pairing_status(&mut self, request_id: &str, status: &str) {
        if let Some(pairing) = self
            .state
            .pairing
            .as_mut()
            .filter(|pairing| pairing.request_id == request_id)
        {
            pairing.status = status.to_owned();
        }
    }

    fn complete_pairing(
        &mut self,
        request_id: &str,
        attempt_id: u64,
        credential: CredentialMetadata,
    ) {
        if !self.pairing_is_current(request_id, attempt_id) {
            return;
        }

        let Some(authority) = self.authority.as_ref() else {
            return;
        };
        self.authorized = Some(AuthorizedCave {
            identity: authority.identity().clone(),
            credential_id: credential.credential_id,
        });
        self.pending_pairing = None;
        self.state.status = "paired".to_owned();
        self.state.pairing = None;
        self.state.diagnostic = None;
    }

    fn fail_pairing(&mut self, request_id: &str, diagnostic: NativeDiagnostic) {
        if self
            .pending_pairing
            .as_ref()
            .is_some_and(|pending| pending.request_id == request_id)
        {
            self.pending_pairing = None;
            self.state.status = "pairing_failed".to_owned();
            self.state.pairing = None;
            self.state.diagnostic = Some(diagnostic);
        }
    }
}

impl NativeConnectionState {
    pub(crate) fn connection_state(&self) -> NativeResult<ConnectionStateDto> {
        Ok(self.runtime()?.snapshot())
    }

    pub(crate) fn retry_connection(&self) -> NativeResult<ConnectionStateDto> {
        Ok(self.runtime()?.begin_attempt())
    }

    pub(crate) fn launch_cave(&self) -> NativeResult<ConnectionStateDto> {
        launch_installed_cave()?;
        let mut runtime = self.runtime()?;
        runtime.state.status = "starting".to_owned();
        runtime.state.diagnostic = None;
        Ok(runtime.snapshot())
    }

    pub(crate) async fn submit_manual_discovery(
        &self,
        discovery_url: String,
    ) -> NativeResult<DiscoverySnapshot> {
        let validated = crate::cave::validate_discovery_url(&discovery_url)?;
        let authority = ConstrainedTransport::discover(validated).await?;
        self.runtime()?.set_authority(authority)
    }

    pub(crate) async fn refresh_connection(&self) -> NativeResult<ConnectionStateDto> {
        let authority = self.runtime()?.current_authority()?;
        let credential = self
            .keyring
            .read_credential(&authority.identity().instance_id);

        let credential = match credential {
            Ok(credential) => credential,
            Err(crate::keyring::KeyringError::NotFound) => {
                let mut runtime = self.runtime()?;
                runtime.state.status = "pairing_required".to_owned();
                runtime.state.diagnostic = None;
                return Ok(runtime.snapshot());
            }
            Err(error) => return Err(error.diagnostic()),
        };
        {
            let mut runtime = self.runtime()?;
            runtime.authorized = Some(AuthorizedCave {
                identity: authority.identity().clone(),
                credential_id: credential.credential_id.clone(),
            });
        }

        let transport = ConstrainedTransport::new(authority.clone())?;
        match transport.health(Some(&credential.bearer)).await {
            Ok(_) => {
                let mut runtime = self.runtime()?;
                runtime.authorized = Some(AuthorizedCave {
                    identity: authority.identity().clone(),
                    credential_id: credential.credential_id,
                });
                runtime.state.status = "connected".to_owned();
                runtime.state.diagnostic = None;
                runtime.unauthorized.reset();
                Ok(runtime.snapshot())
            }
            Err(error) if error.code == "unauthorized" => {
                let action = {
                    let mut runtime = self.runtime()?;
                    runtime.unauthorized.record(
                        &authority.identity().instance_id,
                        authority.identity().epoch,
                    )
                };

                match action {
                    UnauthorizedAction::RefreshDiscovery => {
                        let refreshed =
                            ConstrainedTransport::discover(authority.discovery_url().clone())
                                .await?;
                        let mut runtime = self.runtime()?;
                        runtime.set_authority(refreshed)?;
                        runtime.state.status = "refreshing_discovery".to_owned();
                        Ok(runtime.snapshot())
                    }
                    UnauthorizedAction::ConfirmRevocation => self.confirm_authoritative_revocation(
                        &authority.identity().clone(),
                        &credential.credential_id,
                    ),
                }
            }
            Err(error) => Err(error),
        }
    }

    pub(crate) async fn start_pairing(&self) -> NativeResult<PairingStateDto> {
        let (authority, attempt_id) = {
            let mut runtime = self.runtime()?;
            let authority = runtime.current_authority()?;
            let attempt_id = runtime.reserve_pairing()?;
            (authority, attempt_id)
        };

        let installation_id = self
            .keyring
            .installation_id()
            .map_err(|error| error.diagnostic())?;
        let transport = ConstrainedTransport::new(authority)?;
        let issued = match transport.create_pairing(&installation_id).await {
            Ok(issued) => issued,
            Err(error) => {
                self.runtime()?.abort_pairing_reservation(attempt_id);
                return Err(error);
            }
        };

        let pairing = self
            .runtime()?
            .register_pending_pairing(&issued, attempt_id)?;
        let state = self.clone();
        tauri::async_runtime::spawn(async move {
            state
                .complete_pending_pairing(transport, issued, attempt_id)
                .await;
        });
        Ok(pairing)
    }

    pub(crate) fn cancel_pairing(&self, request_id: String) -> NativeResult<ConnectionStateDto> {
        self.runtime()?.cancel_pairing(&request_id)
    }

    pub(crate) async fn start_conversation(
        &self,
        input: StartConversationInput,
    ) -> NativeResult<ConversationStartDto> {
        let authority = self.runtime()?.current_authority()?;
        let credential = self
            .keyring
            .read_credential(&authority.identity().instance_id)
            .map_err(|error| error.diagnostic())?;
        ConstrainedTransport::new(authority)?
            .start_conversation(&credential.bearer, input)
            .await
    }

    async fn complete_pending_pairing(
        self,
        transport: ConstrainedTransport,
        issued: PairingIssued,
        attempt_id: u64,
    ) {
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;

            let secret = match self.runtime() {
                Ok(mut runtime) => {
                    if runtime.expire_pairing_if_needed(&issued.request_id, attempt_id) {
                        return;
                    }
                    runtime.pairing_secret(&issued.request_id, attempt_id)
                }
                Err(_) => None,
            };
            let Some(secret) = secret else {
                return;
            };

            match transport.poll_pairing(&issued.request_id, &secret).await {
                Ok(PairingStatus::Pending) => continue,
                Ok(PairingStatus::Approved) => {
                    let grant = match transport
                        .exchange_pairing(&issued.request_id, &secret)
                        .await
                    {
                        Ok(grant) => grant,
                        Err(error) => {
                            if let Ok(mut runtime) = self.runtime() {
                                runtime.fail_pairing(&issued.request_id, error);
                            }
                            return;
                        }
                    };

                    let mut runtime = match self.runtime() {
                        Ok(runtime) => runtime,
                        Err(_) => return,
                    };
                    if !runtime.pairing_is_current(&issued.request_id, attempt_id) {
                        return;
                    }
                    if let Err(error) = self.keyring.store_credential(
                        &transport.authority().identity().instance_id,
                        &grant.bearer,
                        &grant.metadata.credential_id,
                    ) {
                        runtime.fail_pairing(&issued.request_id, error.diagnostic());
                        return;
                    }
                    runtime.complete_pairing(&issued.request_id, attempt_id, grant.metadata);
                    return;
                }
                Ok(PairingStatus::Denied) | Ok(PairingStatus::Expired) => {
                    if let Ok(mut runtime) = self.runtime() {
                        runtime.mark_pairing_status(&issued.request_id, "finished");
                        runtime.fail_pairing(
                            &issued.request_id,
                            NativeDiagnostic::new("pairing_not_approved", false),
                        );
                    }
                    return;
                }
                Err(error) => {
                    if let Ok(mut runtime) = self.runtime() {
                        runtime.fail_pairing(&issued.request_id, error);
                    }
                    return;
                }
            }
        }
    }

    fn confirm_authoritative_revocation(
        &self,
        identity: &CaveIdentity,
        credential_id: &str,
    ) -> NativeResult<ConnectionStateDto> {
        let mut runtime = self.runtime()?;
        let matches_authorized = runtime.authorized.as_ref().is_some_and(|authorized| {
            authorized.identity == *identity && authorized.credential_id == credential_id
        });

        if !matches_authorized || !runtime.unauthorized.confirms(identity) {
            return Err(NativeDiagnostic::new("revocation_not_confirmed", true));
        }

        self.keyring
            .delete_credential(&identity.instance_id)
            .map_err(|error| error.diagnostic())?;
        runtime.authorized = None;
        runtime.pending_pairing = None;
        runtime.pairing_in_flight = false;
        runtime.unauthorized.reset();
        runtime.state = ConnectionStateDto {
            status: "pairing_required".to_owned(),
            instance_id: Some(identity.instance_id.clone()),
            epoch: Some(identity.epoch),
            pairing: None,
            diagnostic: Some(NativeDiagnostic::new("credential_revoked", true)),
        };
        Ok(runtime.snapshot())
    }
}

fn unix_time_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::{ConnectionStateDto, UnauthorizedAction, UnauthorizedTracker};

    #[test]
    fn secret_values_are_not_serialized_into_connection_state() {
        let state = ConnectionStateDto::from_runtime("connected", Some("secret-token"));
        let json = serde_json::to_string(&state).unwrap();

        assert!(!json.contains("secret-token"));
    }

    #[test]
    fn repeated_unauthorized_requires_authoritative_revocation_confirmation() {
        let mut attempts = UnauthorizedTracker::default();

        assert_eq!(
            attempts.record("instance-a", 7),
            UnauthorizedAction::RefreshDiscovery
        );
        assert_eq!(
            attempts.record("instance-a", 7),
            UnauthorizedAction::ConfirmRevocation
        );
    }
}
