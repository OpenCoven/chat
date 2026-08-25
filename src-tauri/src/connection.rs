use std::time::Duration;

use async_trait::async_trait;
use serde::Serialize;

use crate::{
    cave::{
        launch_installed_cave, CaveIdentity, DiscoverySnapshot, NativeDiagnostic, NativeResult,
        ValidatedCaveAuthority,
    },
    keyring::{Credential, CredentialMetadata, KeyringError, NativeKeyring},
    transport::{
        ConstrainedTransport, ConversationStartDto, PairingIssued, PairingStatus,
        StartConversationInput,
    },
    NativeConnectionState,
};

#[async_trait]
pub(crate) trait ConnectionTransport: Send + Sync {
    async fn discover(&self, discovery_url: url::Url) -> NativeResult<ValidatedCaveAuthority>;
    async fn health(&self, authority: &ValidatedCaveAuthority, bearer: &str) -> NativeResult<()>;
    async fn create_pairing(
        &self,
        authority: &ValidatedCaveAuthority,
        installation_id: &str,
    ) -> NativeResult<PairingIssued>;
    async fn poll_pairing(
        &self,
        authority: &ValidatedCaveAuthority,
        request_id: &str,
        secret: &str,
    ) -> NativeResult<PairingStatus>;
    async fn exchange_pairing(
        &self,
        authority: &ValidatedCaveAuthority,
        request_id: &str,
        secret: &str,
    ) -> NativeResult<crate::transport::PairingGrant>;
    async fn start_conversation(
        &self,
        authority: &ValidatedCaveAuthority,
        bearer: &str,
        input: StartConversationInput,
    ) -> NativeResult<ConversationStartDto>;
}

pub(crate) trait ConnectionKeyring: Send + Sync {
    fn installation_id(&self) -> Result<String, KeyringError>;
    fn read_credential(&self, instance_id: &str) -> Result<Credential, KeyringError>;
    fn store_credential(
        &self,
        instance_id: &str,
        bearer: &str,
        credential_id: &str,
    ) -> Result<CredentialMetadata, KeyringError>;
    fn delete_credential(&self, instance_id: &str) -> Result<(), KeyringError>;
}

pub(crate) struct NativeConnectionTransport;

#[async_trait]
impl ConnectionTransport for NativeConnectionTransport {
    async fn discover(&self, discovery_url: url::Url) -> NativeResult<ValidatedCaveAuthority> {
        ConstrainedTransport::discover(discovery_url).await
    }

    async fn health(&self, authority: &ValidatedCaveAuthority, bearer: &str) -> NativeResult<()> {
        ConstrainedTransport::new(authority.clone())?
            .health(Some(bearer))
            .await
    }

    async fn create_pairing(
        &self,
        authority: &ValidatedCaveAuthority,
        installation_id: &str,
    ) -> NativeResult<PairingIssued> {
        ConstrainedTransport::new(authority.clone())?
            .create_pairing(installation_id)
            .await
    }

    async fn poll_pairing(
        &self,
        authority: &ValidatedCaveAuthority,
        request_id: &str,
        secret: &str,
    ) -> NativeResult<PairingStatus> {
        ConstrainedTransport::new(authority.clone())?
            .poll_pairing(request_id, secret)
            .await
    }

    async fn exchange_pairing(
        &self,
        authority: &ValidatedCaveAuthority,
        request_id: &str,
        secret: &str,
    ) -> NativeResult<crate::transport::PairingGrant> {
        ConstrainedTransport::new(authority.clone())?
            .exchange_pairing(request_id, secret)
            .await
    }

    async fn start_conversation(
        &self,
        authority: &ValidatedCaveAuthority,
        bearer: &str,
        input: StartConversationInput,
    ) -> NativeResult<ConversationStartDto> {
        ConstrainedTransport::new(authority.clone())?
            .start_conversation(bearer, input)
            .await
    }
}

impl ConnectionKeyring for NativeKeyring {
    fn installation_id(&self) -> Result<String, KeyringError> {
        NativeKeyring::installation_id(self)
    }

    fn read_credential(&self, instance_id: &str) -> Result<Credential, KeyringError> {
        NativeKeyring::read_credential(self, instance_id)
    }

    fn store_credential(
        &self,
        instance_id: &str,
        bearer: &str,
        credential_id: &str,
    ) -> Result<CredentialMetadata, KeyringError> {
        NativeKeyring::store_credential(self, instance_id, bearer, credential_id)
    }

    fn delete_credential(&self, instance_id: &str) -> Result<(), KeyringError> {
        NativeKeyring::delete_credential(self, instance_id)
    }
}

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
    last_unauthorized: Option<UnauthorizedIdentity>,
}

#[derive(Debug, PartialEq, Eq)]
struct UnauthorizedIdentity {
    cave: CaveIdentity,
    credential_id: String,
}

impl UnauthorizedTracker {
    pub(crate) fn record(
        &mut self,
        instance_id: &str,
        epoch: u64,
        credential_id: &str,
    ) -> UnauthorizedAction {
        let identity = CaveIdentity {
            instance_id: instance_id.to_owned(),
            epoch,
        };
        let unauthorized = UnauthorizedIdentity {
            cave: identity,
            credential_id: credential_id.to_owned(),
        };

        if self.last_unauthorized.as_ref() == Some(&unauthorized) {
            UnauthorizedAction::ConfirmRevocation
        } else {
            self.last_unauthorized = Some(unauthorized);
            UnauthorizedAction::RefreshDiscovery
        }
    }

    fn reset(&mut self) {
        self.last_unauthorized = None;
    }

    fn confirms(&self, identity: &CaveIdentity, credential_id: &str) -> bool {
        self.last_unauthorized.as_ref().is_some_and(|unauthorized| {
            unauthorized.cave == *identity && unauthorized.credential_id == credential_id
        })
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

    fn attempt_id(&self) -> u64 {
        self.attempt_id
    }

    fn require_attempt(&self, attempt_id: u64) -> NativeResult<()> {
        if self.attempt_id == attempt_id {
            Ok(())
        } else {
            Err(NativeDiagnostic::new("stale_connection_attempt", true))
        }
    }

    #[cfg(test)]
    fn set_authority(
        &mut self,
        authority: ValidatedCaveAuthority,
    ) -> NativeResult<DiscoverySnapshot> {
        self.set_authority_for_attempt(authority, self.attempt_id)
    }

    fn set_authority_for_attempt(
        &mut self,
        authority: ValidatedCaveAuthority,
        attempt_id: u64,
    ) -> NativeResult<DiscoverySnapshot> {
        self.require_attempt(attempt_id)?;
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

    fn current_authority(&self) -> NativeResult<ValidatedCaveAuthority> {
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
            self.fail_pairing(
                request_id,
                attempt_id,
                NativeDiagnostic::new("pairing_expired", false),
            );
        }

        expired
    }

    fn mark_pairing_status(&mut self, request_id: &str, attempt_id: u64, status: &str) {
        if !self.pairing_is_current(request_id, attempt_id) {
            return;
        }

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
        self.unauthorized.reset();
    }

    fn fail_pairing(&mut self, request_id: &str, attempt_id: u64, diagnostic: NativeDiagnostic) {
        if self.pairing_is_current(request_id, attempt_id) {
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
        let attempt_id = self.runtime()?.attempt_id();
        let authority = self.transport.discover(validated).await?;
        self.runtime()?
            .set_authority_for_attempt(authority, attempt_id)
    }

    pub(crate) async fn refresh_connection(&self) -> NativeResult<ConnectionStateDto> {
        let (attempt_id, authority) = {
            let runtime = self.runtime()?;
            (runtime.attempt_id(), runtime.current_authority()?)
        };
        let credential = self
            .keyring
            .read_credential(&authority.identity().instance_id);

        let credential = match credential {
            Ok(credential) => credential,
            Err(crate::keyring::KeyringError::NotFound) => {
                let mut runtime = self.runtime()?;
                runtime.require_attempt(attempt_id)?;
                runtime.state.status = "pairing_required".to_owned();
                runtime.state.diagnostic = None;
                runtime.unauthorized.reset();
                return Ok(runtime.snapshot());
            }
            Err(error) => {
                let mut runtime = self.runtime()?;
                runtime.require_attempt(attempt_id)?;
                runtime.unauthorized.reset();
                return Err(error.diagnostic());
            }
        };
        {
            let mut runtime = self.runtime()?;
            runtime.require_attempt(attempt_id)?;
            let credential_changed = runtime.authorized.as_ref().is_some_and(|authorized| {
                authorized.identity != *authority.identity()
                    || authorized.credential_id != credential.credential_id
            });
            if credential_changed {
                runtime.unauthorized.reset();
            }
            runtime.authorized = Some(AuthorizedCave {
                identity: authority.identity().clone(),
                credential_id: credential.credential_id.clone(),
            });
        }

        match self.transport.health(&authority, &credential.bearer).await {
            Ok(_) => {
                let mut runtime = self.runtime()?;
                runtime.require_attempt(attempt_id)?;
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
                    runtime.require_attempt(attempt_id)?;
                    runtime.unauthorized.record(
                        &authority.identity().instance_id,
                        authority.identity().epoch,
                        &credential.credential_id,
                    )
                };

                match action {
                    UnauthorizedAction::RefreshDiscovery => {
                        let refreshed = match self
                            .transport
                            .discover(authority.discovery_url().clone())
                            .await
                        {
                            Ok(refreshed) => refreshed,
                            Err(error) => {
                                let mut runtime = self.runtime()?;
                                runtime.require_attempt(attempt_id)?;
                                runtime.unauthorized.reset();
                                return Err(error);
                            }
                        };
                        let mut runtime = self.runtime()?;
                        runtime.set_authority_for_attempt(refreshed, attempt_id)?;
                        runtime.state.status = "refreshing_discovery".to_owned();
                        Ok(runtime.snapshot())
                    }
                    UnauthorizedAction::ConfirmRevocation => self.confirm_authoritative_revocation(
                        &authority.identity().clone(),
                        &credential.credential_id,
                    ),
                }
            }
            Err(error) => {
                let mut runtime = self.runtime()?;
                runtime.require_attempt(attempt_id)?;
                runtime.unauthorized.reset();
                Err(error)
            }
        }
    }

    pub(crate) async fn start_pairing(&self) -> NativeResult<PairingStateDto> {
        let (authority, attempt_id) = {
            let mut runtime = self.runtime()?;
            let authority = runtime.current_authority()?;
            let attempt_id = runtime.reserve_pairing()?;
            (authority, attempt_id)
        };

        let installation_id = match self.keyring.installation_id() {
            Ok(installation_id) => installation_id,
            Err(error) => {
                self.runtime()?.abort_pairing_reservation(attempt_id);
                return Err(error.diagnostic());
            }
        };
        let issued = match self
            .transport
            .create_pairing(&authority, &installation_id)
            .await
        {
            Ok(issued) => issued,
            Err(error) => {
                self.runtime()?.abort_pairing_reservation(attempt_id);
                return Err(error);
            }
        };

        let pairing = match self
            .runtime()?
            .register_pending_pairing(&issued, attempt_id)
        {
            Ok(pairing) => pairing,
            Err(error) => {
                self.runtime()?.abort_pairing_reservation(attempt_id);
                return Err(error);
            }
        };
        let state = self.clone();
        let transport = self.transport.clone();
        tauri::async_runtime::spawn(async move {
            state
                .complete_pending_pairing(transport, authority, issued, attempt_id)
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
        self.transport
            .start_conversation(&authority, &credential.bearer, input)
            .await
    }

    async fn complete_pending_pairing(
        self,
        transport: std::sync::Arc<dyn ConnectionTransport>,
        authority: ValidatedCaveAuthority,
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

            match transport
                .poll_pairing(&authority, &issued.request_id, &secret)
                .await
            {
                Ok(PairingStatus::Pending) => continue,
                Ok(PairingStatus::Approved) => {
                    let may_exchange = self
                        .runtime()
                        .map(|runtime| runtime.pairing_is_current(&issued.request_id, attempt_id))
                        .unwrap_or(false);
                    if !may_exchange {
                        return;
                    }
                    let grant = match transport
                        .exchange_pairing(&authority, &issued.request_id, &secret)
                        .await
                    {
                        Ok(grant) => grant,
                        Err(error) => {
                            if let Ok(mut runtime) = self.runtime() {
                                runtime.fail_pairing(&issued.request_id, attempt_id, error);
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
                        &authority.identity().instance_id,
                        &grant.bearer,
                        &grant.metadata.credential_id,
                    ) {
                        runtime.fail_pairing(&issued.request_id, attempt_id, error.diagnostic());
                        return;
                    }
                    runtime.complete_pairing(&issued.request_id, attempt_id, grant.metadata);
                    return;
                }
                Ok(PairingStatus::Denied) | Ok(PairingStatus::Expired) => {
                    if let Ok(mut runtime) = self.runtime() {
                        runtime.mark_pairing_status(&issued.request_id, attempt_id, "finished");
                        runtime.fail_pairing(
                            &issued.request_id,
                            attempt_id,
                            NativeDiagnostic::new("pairing_not_approved", false),
                        );
                    }
                    return;
                }
                Err(error) => {
                    if let Ok(mut runtime) = self.runtime() {
                        runtime.fail_pairing(&issued.request_id, attempt_id, error);
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

        if !matches_authorized || !runtime.unauthorized.confirms(identity, credential_id) {
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
    use std::{
        collections::VecDeque,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Mutex,
        },
    };

    use async_trait::async_trait;

    use super::{
        ConnectionKeyring, ConnectionStateDto, ConnectionTransport, UnauthorizedAction,
        UnauthorizedTracker,
    };
    use crate::{
        cave::{test_authority, NativeDiagnostic, NativeResult, ValidatedCaveAuthority},
        keyring::{Credential, CredentialMetadata, KeyringError},
        transport::{
            ConversationStartDto, PairingGrant, PairingIssued, PairingStatus,
            StartConversationInput,
        },
        NativeConnectionState,
    };

    struct FakeTransport {
        authority: ValidatedCaveAuthority,
        discovery: Mutex<VecDeque<NativeResult<ValidatedCaveAuthority>>>,
        health: Mutex<VecDeque<NativeResult<()>>>,
        retry_state: Mutex<Option<NativeConnectionState>>,
        retry_on_poll: Mutex<Option<NativeConnectionState>>,
        poll: Mutex<VecDeque<NativeResult<PairingStatus>>>,
        exchanges: AtomicUsize,
    }

    impl FakeTransport {
        fn new(health: impl IntoIterator<Item = NativeResult<()>>) -> Self {
            Self {
                authority: test_authority("instance-a", 7),
                discovery: Mutex::new(VecDeque::new()),
                health: Mutex::new(health.into_iter().collect()),
                retry_state: Mutex::new(None),
                retry_on_poll: Mutex::new(None),
                poll: Mutex::new(VecDeque::new()),
                exchanges: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait]
    impl ConnectionTransport for FakeTransport {
        async fn discover(&self, _discovery_url: url::Url) -> NativeResult<ValidatedCaveAuthority> {
            if let Some(state) = self.retry_state.lock().unwrap().take() {
                state.retry_connection()?;
            }
            self.discovery
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Ok(self.authority.clone()))
        }

        async fn health(
            &self,
            _authority: &ValidatedCaveAuthority,
            _bearer: &str,
        ) -> NativeResult<()> {
            self.health
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Ok(()))
        }

        async fn create_pairing(
            &self,
            _authority: &ValidatedCaveAuthority,
            _installation_id: &str,
        ) -> NativeResult<PairingIssued> {
            Err(NativeDiagnostic::new("not_used_in_test", false))
        }

        async fn poll_pairing(
            &self,
            _authority: &ValidatedCaveAuthority,
            _request_id: &str,
            _secret: &str,
        ) -> NativeResult<PairingStatus> {
            if let Some(state) = self.retry_on_poll.lock().unwrap().take() {
                state.retry_connection()?;
            }
            self.poll
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Err(NativeDiagnostic::new("not_used_in_test", false)))
        }

        async fn exchange_pairing(
            &self,
            _authority: &ValidatedCaveAuthority,
            _request_id: &str,
            _secret: &str,
        ) -> NativeResult<PairingGrant> {
            self.exchanges.fetch_add(1, Ordering::SeqCst);
            Err(NativeDiagnostic::new("not_used_in_test", false))
        }

        async fn start_conversation(
            &self,
            _authority: &ValidatedCaveAuthority,
            _bearer: &str,
            _input: StartConversationInput,
        ) -> NativeResult<ConversationStartDto> {
            Err(NativeDiagnostic::new("not_used_in_test", false))
        }
    }

    struct FakeKeyring {
        credential: Option<(String, String)>,
        fail_installation: bool,
        deletes: AtomicUsize,
    }

    impl FakeKeyring {
        fn unavailable() -> Self {
            Self {
                credential: None,
                fail_installation: true,
                deletes: AtomicUsize::new(0),
            }
        }

        fn credential(credential_id: &str) -> Self {
            Self {
                credential: Some(("stored-bearer".to_owned(), credential_id.to_owned())),
                fail_installation: false,
                deletes: AtomicUsize::new(0),
            }
        }
    }

    impl ConnectionKeyring for FakeKeyring {
        fn installation_id(&self) -> Result<String, KeyringError> {
            if self.fail_installation {
                Err(KeyringError::Unavailable)
            } else {
                Ok("installation-7".to_owned())
            }
        }

        fn read_credential(&self, _instance_id: &str) -> Result<Credential, KeyringError> {
            self.credential
                .as_ref()
                .map(|(bearer, credential_id)| Credential {
                    bearer: bearer.clone(),
                    credential_id: credential_id.clone(),
                })
                .ok_or(KeyringError::NotFound)
        }

        fn store_credential(
            &self,
            _instance_id: &str,
            _bearer: &str,
            credential_id: &str,
        ) -> Result<CredentialMetadata, KeyringError> {
            Ok(CredentialMetadata {
                credential_id: credential_id.to_owned(),
            })
        }

        fn delete_credential(&self, _instance_id: &str) -> Result<(), KeyringError> {
            self.deletes.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

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
            attempts.record("instance-a", 7, "credential-a"),
            UnauthorizedAction::RefreshDiscovery
        );
        assert_eq!(
            attempts.record("instance-a", 7, "credential-a"),
            UnauthorizedAction::ConfirmRevocation
        );
    }

    #[test]
    fn stale_discovery_from_a_fake_transport_cannot_replace_a_newer_attempt() {
        let transport = Arc::new(FakeTransport::new([]));
        let keyring = Arc::new(FakeKeyring::credential("credential-a"));
        let state = NativeConnectionState::with_collaborators(transport.clone(), keyring);
        *transport.retry_state.lock().unwrap() = Some(state.clone());

        let error = match tauri::async_runtime::block_on(
            state.submit_manual_discovery("http://127.0.0.1:4310/api/v1/discovery".to_owned()),
        ) {
            Err(error) => error,
            Ok(_) => panic!("stale discovery should not update the connection state"),
        };

        assert_eq!(error.code, "stale_connection_attempt");
        assert_eq!(state.connection_state().unwrap().status, "locating");
    }

    #[test]
    fn keyring_failure_releases_the_pairing_reservation_for_retry() {
        let transport = Arc::new(FakeTransport::new([]));
        let keyring = Arc::new(FakeKeyring::unavailable());
        let state = NativeConnectionState::with_collaborators(transport, keyring);
        tauri::async_runtime::block_on(
            state.submit_manual_discovery("http://127.0.0.1:4310/api/v1/discovery".to_owned()),
        )
        .unwrap();

        for _ in 0..2 {
            let error = match tauri::async_runtime::block_on(state.start_pairing()) {
                Err(error) => error,
                Ok(_) => panic!("the fake keyring should reject pairing"),
            };
            assert_eq!(error.code, "secure_store_unavailable");
        }
    }

    #[test]
    fn transport_failure_releases_the_pairing_reservation_for_retry() {
        let transport = Arc::new(FakeTransport::new([]));
        let keyring = Arc::new(FakeKeyring::credential("credential-a"));
        let state = NativeConnectionState::with_collaborators(transport, keyring);
        tauri::async_runtime::block_on(
            state.submit_manual_discovery("http://127.0.0.1:4310/api/v1/discovery".to_owned()),
        )
        .unwrap();

        for _ in 0..2 {
            let error = match tauri::async_runtime::block_on(state.start_pairing()) {
                Err(error) => error,
                Ok(_) => panic!("the fake transport should reject pairing"),
            };
            assert_eq!(error.code, "not_used_in_test");
        }
    }

    #[test]
    fn stale_pairing_completion_from_a_fake_transport_never_exchanges_a_grant() {
        let transport = Arc::new(FakeTransport::new([]));
        let keyring = Arc::new(FakeKeyring::credential("credential-a"));
        let state = NativeConnectionState::with_collaborators(transport.clone(), keyring);
        tauri::async_runtime::block_on(
            state.submit_manual_discovery("http://127.0.0.1:4310/api/v1/discovery".to_owned()),
        )
        .unwrap();
        let issued = PairingIssued {
            request_id: "request-a".to_owned(),
            secret: "pairing-secret".to_owned(),
            expires_at: u64::MAX,
        };
        let attempt_id = {
            let mut runtime = state.runtime().unwrap();
            let attempt_id = runtime.reserve_pairing().unwrap();
            runtime
                .register_pending_pairing(&issued, attempt_id)
                .unwrap();
            attempt_id
        };
        *transport.retry_on_poll.lock().unwrap() = Some(state.clone());
        transport
            .poll
            .lock()
            .unwrap()
            .push_back(Ok(PairingStatus::Approved));

        tauri::async_runtime::block_on(state.clone().complete_pending_pairing(
            transport.clone(),
            test_authority("instance-a", 7),
            issued,
            attempt_id,
        ));

        assert_eq!(transport.exchanges.load(Ordering::SeqCst), 0);
        assert_eq!(state.connection_state().unwrap().status, "locating");
    }

    #[test]
    fn fake_unauthorized_probe_preserves_a_new_credential_until_confirmation() {
        let transport = Arc::new(FakeTransport::new([
            Err(NativeDiagnostic::new("unauthorized", true)),
            Err(NativeDiagnostic::new("unauthorized", true)),
        ]));
        let keyring = Arc::new(FakeKeyring::credential("credential-new"));
        let state = NativeConnectionState::with_collaborators(transport, keyring.clone());
        tauri::async_runtime::block_on(
            state.submit_manual_discovery("http://127.0.0.1:4310/api/v1/discovery".to_owned()),
        )
        .unwrap();
        state
            .runtime()
            .unwrap()
            .unauthorized
            .record("instance-a", 7, "credential-old");

        let first = tauri::async_runtime::block_on(state.refresh_connection()).unwrap();
        assert_eq!(first.status, "refreshing_discovery");
        assert_eq!(keyring.deletes.load(Ordering::SeqCst), 0);

        let second = tauri::async_runtime::block_on(state.refresh_connection()).unwrap();
        assert_eq!(second.status, "pairing_required");
        assert_eq!(keyring.deletes.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn non_unauthorized_health_failures_reset_revocation_confirmation() {
        let transport = Arc::new(FakeTransport::new([
            Err(NativeDiagnostic::new("transport_unavailable", true)),
            Err(NativeDiagnostic::new("unauthorized", true)),
        ]));
        let keyring = Arc::new(FakeKeyring::credential("credential-a"));
        let state = NativeConnectionState::with_collaborators(transport, keyring.clone());
        tauri::async_runtime::block_on(
            state.submit_manual_discovery("http://127.0.0.1:4310/api/v1/discovery".to_owned()),
        )
        .unwrap();
        state
            .runtime()
            .unwrap()
            .unauthorized
            .record("instance-a", 7, "credential-a");

        let error = match tauri::async_runtime::block_on(state.refresh_connection()) {
            Err(error) => error,
            Ok(_) => panic!("the fake transport should fail the first health probe"),
        };
        assert_eq!(error.code, "transport_unavailable");
        let state_after_401 = tauri::async_runtime::block_on(state.refresh_connection()).unwrap();

        assert_eq!(state_after_401.status, "refreshing_discovery");
        assert_eq!(keyring.deletes.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn failed_discovery_refresh_resets_revocation_confirmation() {
        let transport = Arc::new(FakeTransport::new([
            Err(NativeDiagnostic::new("unauthorized", true)),
            Err(NativeDiagnostic::new("unauthorized", true)),
        ]));
        let keyring = Arc::new(FakeKeyring::credential("credential-a"));
        let state = NativeConnectionState::with_collaborators(transport.clone(), keyring.clone());
        tauri::async_runtime::block_on(
            state.submit_manual_discovery("http://127.0.0.1:4310/api/v1/discovery".to_owned()),
        )
        .unwrap();
        transport
            .discovery
            .lock()
            .unwrap()
            .push_back(Err(NativeDiagnostic::new("discovery_unavailable", true)));

        let first = match tauri::async_runtime::block_on(state.refresh_connection()) {
            Err(error) => error,
            Ok(_) => panic!("the fake discovery refresh should fail"),
        };
        assert_eq!(first.code, "discovery_unavailable");
        let second = tauri::async_runtime::block_on(state.refresh_connection()).unwrap();

        assert_eq!(second.status, "refreshing_discovery");
        assert_eq!(keyring.deletes.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn successful_pairing_resets_revocation_confirmation() {
        let mut runtime = super::ConnectionRuntime::default();
        runtime
            .set_authority(test_authority("instance-a", 7))
            .unwrap();
        let attempt_id = runtime.reserve_pairing().unwrap();
        runtime
            .register_pending_pairing(
                &PairingIssued {
                    request_id: "request-a".to_owned(),
                    secret: "pairing-secret".to_owned(),
                    expires_at: u64::MAX,
                },
                attempt_id,
            )
            .unwrap();
        runtime.unauthorized.record("instance-a", 7, "credential-a");

        runtime.complete_pairing(
            "request-a",
            attempt_id,
            CredentialMetadata {
                credential_id: "credential-a".to_owned(),
            },
        );

        assert_eq!(
            runtime.unauthorized.record("instance-a", 7, "credential-a"),
            UnauthorizedAction::RefreshDiscovery
        );
    }
}
