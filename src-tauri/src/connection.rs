use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde::Serialize;

use crate::{
    cave::{
        canonical_discovery_url, CaveChild, CaveIdentity, DiscoverySnapshot, NativeDiagnostic,
        NativeResult, ValidatedCaveAuthority,
    },
    keyring::{Credential, CredentialMetadata, KeyringError, NativeKeyring},
    transport::{
        ConstrainedTransport, ConversationStartDto, HealthMetadata, PairingIssued, PairingStatus,
        StartConversationInput,
    },
    NativeConnectionState,
};

#[async_trait]
pub(crate) trait ConnectionTransport: Send + Sync {
    async fn discover(&self, discovery_url: url::Url) -> NativeResult<ValidatedCaveAuthority>;
    async fn health(
        &self,
        authority: &ValidatedCaveAuthority,
        bearer: Option<&str>,
    ) -> NativeResult<HealthMetadata>;
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
        authority: &ValidatedCaveAuthority,
        bearer: &str,
        credential_id: &str,
    ) -> Result<CredentialMetadata, KeyringError>;
    fn delete_credential_if_matches(
        &self,
        authority: &ValidatedCaveAuthority,
        credential_id: &str,
    ) -> Result<bool, KeyringError>;
}

pub(crate) struct NativeConnectionTransport;

#[async_trait]
impl ConnectionTransport for NativeConnectionTransport {
    async fn discover(&self, discovery_url: url::Url) -> NativeResult<ValidatedCaveAuthority> {
        ConstrainedTransport::discover(discovery_url).await
    }

    async fn health(
        &self,
        authority: &ValidatedCaveAuthority,
        bearer: Option<&str>,
    ) -> NativeResult<HealthMetadata> {
        ConstrainedTransport::new(authority.clone())?
            .health(bearer)
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
        authority: &ValidatedCaveAuthority,
        bearer: &str,
        credential_id: &str,
    ) -> Result<CredentialMetadata, KeyringError> {
        NativeKeyring::store_credential(self, authority, bearer, credential_id)
    }

    fn delete_credential_if_matches(
        &self,
        authority: &ValidatedCaveAuthority,
        credential_id: &str,
    ) -> Result<bool, KeyringError> {
        NativeKeyring::delete_credential_if_matches(self, authority, credential_id)
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
    AwaitRediscovery,
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
    rediscovery_completed: bool,
    first_unauthorized_at: Instant,
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
            rediscovery_completed: false,
            first_unauthorized_at: Instant::now(),
        };

        if let Some(previous) = self.last_unauthorized.as_ref() {
            if previous.cave == unauthorized.cave
                && previous.credential_id == unauthorized.credential_id
            {
                return if previous.rediscovery_completed {
                    UnauthorizedAction::ConfirmRevocation
                } else {
                    UnauthorizedAction::AwaitRediscovery
                };
            }
        }

        self.last_unauthorized = Some(unauthorized);
        UnauthorizedAction::RefreshDiscovery
    }

    fn mark_rediscovered(&mut self, identity: &CaveIdentity) {
        if let Some(previous) = self.last_unauthorized.as_mut() {
            if previous.cave == *identity {
                previous.rediscovery_completed = true;
            }
        }
    }

    fn delay_before_probe(&self, identity: &CaveIdentity, credential_id: &str) -> Option<Duration> {
        self.last_unauthorized.as_ref().and_then(|previous| {
            (previous.cave == *identity
                && previous.credential_id == credential_id
                && previous.rediscovery_completed)
                .then(|| {
                    Duration::from_millis(500)
                        .saturating_sub(previous.first_unauthorized_at.elapsed())
                })
        })
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
    generation: u64,
    authority: ValidatedCaveAuthority,
    exchange_committed: bool,
    publication_cancelled: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AuthoritySource {
    Canonical,
    Manual,
}

#[derive(Clone)]
struct NegotiatedAuthority {
    identity: CaveIdentity,
    generation: u64,
    metadata: HealthMetadata,
}

#[derive(Clone)]
struct AuthorityCapture {
    attempt_id: u64,
    generation: u64,
    authority: ValidatedCaveAuthority,
}

struct ManagedLaunch {
    child: Box<dyn CaveChild>,
    generation: u64,
}

pub(crate) struct ConnectionRuntime {
    state: ConnectionStateDto,
    authority: Option<crate::cave::ValidatedCaveAuthority>,
    authorized: Option<AuthorizedCave>,
    pending_pairing: Option<PendingPairing>,
    pairing_in_flight: bool,
    attempt_id: u64,
    generation: u64,
    authority_source: Option<AuthoritySource>,
    negotiated: Option<NegotiatedAuthority>,
    unauthorized: UnauthorizedTracker,
    launch: Option<ManagedLaunch>,
    launch_in_flight: bool,
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
            generation: 0,
            authority_source: None,
            negotiated: None,
            unauthorized: UnauthorizedTracker::default(),
            launch: None,
            launch_in_flight: false,
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

    fn begin_generation(&mut self) -> u64 {
        self.generation = self.generation.saturating_add(1);
        self.negotiated = None;
        self.generation
    }

    fn require_attempt(&self, attempt_id: u64) -> NativeResult<()> {
        if self.attempt_id == attempt_id {
            Ok(())
        } else {
            Err(NativeDiagnostic::new("stale_connection_attempt", true))
        }
    }

    fn require_generation(&self, generation: u64) -> NativeResult<()> {
        if self.generation == generation {
            Ok(())
        } else {
            Err(NativeDiagnostic::new("stale_connection_attempt", true))
        }
    }

    fn capture_authority(&self) -> NativeResult<AuthorityCapture> {
        Ok(AuthorityCapture {
            attempt_id: self.attempt_id,
            generation: self.generation,
            authority: self.current_authority()?,
        })
    }

    fn require_capture(&self, capture: &AuthorityCapture) -> NativeResult<()> {
        self.require_attempt(capture.attempt_id)?;
        self.require_generation(capture.generation)?;
        let current = self.current_authority()?;
        if current.is_same_pin(&capture.authority) {
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
        let generation = self.begin_generation();
        let identity = authority.identity().clone();
        let snapshot = self.set_authority_for_attempt(authority, self.attempt_id)?;
        self.negotiated = Some(NegotiatedAuthority {
            identity,
            generation,
            metadata: crate::transport::test_health_metadata(),
        });
        Ok(snapshot)
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
        self.authority_source = Some(AuthoritySource::Canonical);
        self.negotiated = None;
        Ok(snapshot)
    }

    fn set_manual_authority_for_attempt(
        &mut self,
        authority: ValidatedCaveAuthority,
        metadata: HealthMetadata,
        attempt_id: u64,
        generation: u64,
    ) -> NativeResult<DiscoverySnapshot> {
        self.require_attempt(attempt_id)?;
        self.require_generation(generation)?;
        if !metadata.supports_pairing() {
            return Err(NativeDiagnostic::new("incompatible_version", false));
        }

        let snapshot = self.set_authority_for_attempt(authority.clone(), attempt_id)?;
        self.authority_source = Some(AuthoritySource::Manual);
        self.negotiated = Some(NegotiatedAuthority {
            identity: authority.identity().clone(),
            generation,
            metadata,
        });
        self.state.status = "candidate".to_owned();
        Ok(snapshot)
    }

    fn set_canonical_authority_for_attempt(
        &mut self,
        authority: ValidatedCaveAuthority,
        metadata: HealthMetadata,
        attempt_id: u64,
        generation: u64,
    ) -> NativeResult<DiscoverySnapshot> {
        self.require_attempt(attempt_id)?;
        self.require_generation(generation)?;
        if !metadata.supports_pairing() {
            return Err(NativeDiagnostic::new("incompatible_version", false));
        }

        let identity = authority.identity().clone();
        let snapshot = self.set_authority_for_attempt(authority, attempt_id)?;
        self.negotiated = Some(NegotiatedAuthority {
            identity,
            generation,
            metadata,
        });
        self.state.status = "candidate".to_owned();
        Ok(snapshot)
    }

    fn reap_launch(&mut self) -> NativeResult<()> {
        let exited = match self.launch.as_mut() {
            Some(launch) => launch.child.try_wait()?,
            None => false,
        };
        if exited {
            self.launch = None;
            self.launch_in_flight = false;
            self.state.status = "disconnected".to_owned();
            self.state.diagnostic = Some(NativeDiagnostic::new("cave_exited", true));
        }
        Ok(())
    }

    fn reserve_launch(&mut self) -> NativeResult<(u64, u64)> {
        self.reap_launch()?;
        if self.launch_in_flight || self.launch.is_some() {
            return Err(NativeDiagnostic::new("cave_launch_in_progress", true));
        }
        let generation = self.begin_generation();
        self.launch_in_flight = true;
        self.state.status = "starting".to_owned();
        self.state.diagnostic = None;
        Ok((self.attempt_id, generation))
    }

    fn install_launch(
        &mut self,
        mut child: Box<dyn CaveChild>,
        attempt_id: u64,
        generation: u64,
    ) -> NativeResult<()> {
        if let Err(error) = self
            .require_attempt(attempt_id)
            .and_then(|_| self.require_generation(generation))
        {
            let _ = child.terminate();
            return Err(error);
        }
        if !self.launch_in_flight {
            let _ = child.terminate();
            return Err(NativeDiagnostic::new("stale_connection_attempt", true));
        }
        self.launch = Some(ManagedLaunch { child, generation });
        self.launch_in_flight = false;
        Ok(())
    }

    fn require_live_launch(&mut self, attempt_id: u64, generation: u64) -> NativeResult<()> {
        self.require_attempt(attempt_id)?;
        self.require_generation(generation)?;
        let Some(launch) = self.launch.as_mut() else {
            return Err(NativeDiagnostic::new("stale_connection_attempt", true));
        };
        if launch.generation != generation || launch.child.try_wait()? {
            self.launch = None;
            self.launch_in_flight = false;
            self.state.status = "disconnected".to_owned();
            self.state.diagnostic = Some(NativeDiagnostic::new("cave_exited", true));
            return Err(NativeDiagnostic::new("cave_exited", true));
        }
        Ok(())
    }

    fn fail_launch(&mut self, attempt_id: u64, generation: u64, error: NativeDiagnostic) {
        if self.attempt_id == attempt_id && self.generation == generation {
            if let Some(mut launch) = self.launch.take() {
                let _ = launch.child.terminate();
            }
            self.launch_in_flight = false;
            self.state.status = "disconnected".to_owned();
            self.state.diagnostic = Some(error);
        }
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
        let authority = self.current_authority()?;
        let is_negotiated = self.negotiated.as_ref().is_some_and(|negotiated| {
            negotiated.generation == self.generation
                && negotiated.identity == *authority.identity()
                && negotiated.metadata.supports_pairing()
        });
        if !is_negotiated {
            return Err(NativeDiagnostic::new("health_not_negotiated", true));
        }

        self.pairing_in_flight = true;
        Ok(self.attempt_id)
    }

    fn cancel_pairing(&mut self, request_id: &str) -> NativeResult<ConnectionStateDto> {
        let Some(pending) = &mut self.pending_pairing else {
            return Err(NativeDiagnostic::new("pairing_not_found", false));
        };

        if pending.request_id != request_id {
            return Err(NativeDiagnostic::new("pairing_not_found", false));
        }

        if pending.exchange_committed {
            pending.publication_cancelled = true;
        } else {
            self.pending_pairing = None;
        }
        self.pairing_in_flight = false;
        self.state.pairing = None;
        self.state.status = "pairing_cancelled".to_owned();
        Ok(self.snapshot())
    }

    fn abort_pairing_reservation(&mut self, capture: &AuthorityCapture) {
        if self.require_capture(capture).is_ok() {
            self.pairing_in_flight = false;
        }
    }

    fn register_pending_pairing(
        &mut self,
        issued: &PairingIssued,
        capture: &AuthorityCapture,
    ) -> NativeResult<PairingStateDto> {
        if !self.pairing_in_flight || self.require_capture(capture).is_err() {
            return Err(NativeDiagnostic::new("stale_connection_attempt", true));
        }

        self.pairing_in_flight = false;
        self.pending_pairing = Some(PendingPairing {
            request_id: issued.request_id.clone(),
            secret: issued.secret.clone(),
            expires_at: issued.expires_at,
            attempt_id: capture.attempt_id,
            generation: capture.generation,
            authority: capture.authority.clone(),
            exchange_committed: false,
            publication_cancelled: false,
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

    fn pairing_is_current(&self, request_id: &str, capture: &AuthorityCapture) -> bool {
        self.pending_pairing.as_ref().is_some_and(|pending| {
            pending.request_id == request_id
                && pending.attempt_id == capture.attempt_id
                && pending.generation == capture.generation
                && pending.authority.is_same_pin(&capture.authority)
                && !pending.publication_cancelled
                && self.require_capture(capture).is_ok()
        })
    }

    fn pairing_secret(&self, request_id: &str, capture: &AuthorityCapture) -> Option<String> {
        self.pending_pairing.as_ref().and_then(|pending| {
            (pending.request_id == request_id
                && pending.attempt_id == capture.attempt_id
                && pending.generation == capture.generation
                && pending.authority.is_same_pin(&capture.authority)
                && self.require_capture(capture).is_ok())
            .then(|| pending.secret.clone())
        })
    }

    fn expire_pairing_if_needed(&mut self, request_id: &str, capture: &AuthorityCapture) -> bool {
        let expired = self.pending_pairing.as_ref().is_some_and(|pending| {
            pending.request_id == request_id
                && pending.attempt_id == capture.attempt_id
                && pending.generation == capture.generation
                && pending.expires_at <= unix_time_millis()
        });

        if expired {
            self.fail_pairing(
                request_id,
                capture,
                NativeDiagnostic::new("pairing_expired", false),
            );
        }

        expired
    }

    fn mark_pairing_status(&mut self, request_id: &str, capture: &AuthorityCapture, status: &str) {
        if !self.pairing_is_current(request_id, capture) {
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
        capture: &AuthorityCapture,
        credential: CredentialMetadata,
    ) {
        if !self.pairing_is_current(request_id, capture) {
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

    fn fail_pairing(
        &mut self,
        request_id: &str,
        capture: &AuthorityCapture,
        diagnostic: NativeDiagnostic,
    ) {
        if self.pairing_is_current(request_id, capture) {
            self.pending_pairing = None;
            self.state.status = "pairing_failed".to_owned();
            self.state.pairing = None;
            self.state.diagnostic = Some(diagnostic);
        }
    }

    fn commit_pairing_exchange(
        &mut self,
        request_id: &str,
        capture: &AuthorityCapture,
    ) -> Option<String> {
        if !self.pairing_is_current(request_id, capture) {
            return None;
        }
        let pending = self.pending_pairing.as_mut()?;
        if pending.exchange_committed {
            return None;
        }
        pending.exchange_committed = true;
        Some(pending.secret.clone())
    }

    #[cfg(test)]
    fn pairing_exchange_committed(&self, request_id: &str, capture: &AuthorityCapture) -> bool {
        self.pending_pairing.as_ref().is_some_and(|pending| {
            pending.request_id == request_id
                && pending.attempt_id == capture.attempt_id
                && pending.generation == capture.generation
                && pending.exchange_committed
        })
    }

    fn finalize_persisted_pairing(&mut self, request_id: &str, capture: &AuthorityCapture) {
        if self.pending_pairing.as_ref().is_some_and(|pending| {
            pending.request_id == request_id
                && pending.attempt_id == capture.attempt_id
                && pending.generation == capture.generation
                && pending.exchange_committed
                && pending.publication_cancelled
        }) {
            self.pending_pairing = None;
        }
    }
}

impl NativeConnectionState {
    pub(crate) fn connection_state(&self) -> NativeResult<ConnectionStateDto> {
        let mut runtime = self.runtime()?;
        runtime.reap_launch()?;
        Ok(runtime.snapshot())
    }

    pub(crate) fn retry_connection(&self) -> NativeResult<ConnectionStateDto> {
        Ok(self.runtime()?.begin_attempt())
    }

    pub(crate) async fn launch_cave(&self) -> NativeResult<ConnectionStateDto> {
        let (attempt_id, generation) = self.runtime()?.reserve_launch()?;
        let child = match self.launcher.launch() {
            Ok(child) => child,
            Err(error) => {
                self.runtime()?
                    .fail_launch(attempt_id, generation, error.clone());
                return Err(error);
            }
        };
        if let Err(error) = self
            .runtime()?
            .install_launch(child, attempt_id, generation)
        {
            self.runtime()?
                .fail_launch(attempt_id, generation, error.clone());
            return Err(error);
        }

        let discovery_url = canonical_discovery_url()?;
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut backoff = Duration::from_millis(250);
        let mut last_error = NativeDiagnostic::new("cave_readiness_timeout", true);

        while Instant::now() < deadline {
            self.runtime()?
                .require_live_launch(attempt_id, generation)?;
            match self.transport.discover(discovery_url.clone()).await {
                Ok(authority) => {
                    self.runtime()?
                        .require_live_launch(attempt_id, generation)?;
                    match self.transport.health(&authority, None).await {
                        Ok(metadata) => {
                            let mut runtime = self.runtime()?;
                            runtime.require_live_launch(attempt_id, generation)?;
                            runtime.set_canonical_authority_for_attempt(
                                authority, metadata, attempt_id, generation,
                            )?;
                            return Ok(runtime.snapshot());
                        }
                        Err(error) => last_error = error,
                    }
                }
                Err(error) => last_error = error,
            }

            self.runtime()?
                .require_live_launch(attempt_id, generation)?;
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            tokio::time::sleep(backoff.min(remaining)).await;
            backoff = (backoff * 2).min(Duration::from_secs(5));
        }

        let mut runtime = self.runtime()?;
        runtime.fail_launch(attempt_id, generation, last_error.clone());
        Err(last_error)
    }

    pub(crate) async fn submit_manual_discovery(
        &self,
        discovery_url: String,
    ) -> NativeResult<DiscoverySnapshot> {
        let validated = crate::cave::validate_discovery_url(&discovery_url)?;
        let (attempt_id, generation) = {
            let mut runtime = self.runtime()?;
            let generation = runtime.begin_generation();
            (runtime.attempt_id(), generation)
        };
        let authority = self.transport.discover(validated).await?;
        {
            let runtime = self.runtime()?;
            runtime.require_attempt(attempt_id)?;
            runtime.require_generation(generation)?;
        }
        let metadata = self.transport.health(&authority, None).await?;
        self.runtime()?
            .set_manual_authority_for_attempt(authority, metadata, attempt_id, generation)
    }

    pub(crate) async fn refresh_connection(&self) -> NativeResult<ConnectionStateDto> {
        let capture = {
            let runtime = self.runtime()?;
            runtime.capture_authority()?
        };
        let attempt_id = capture.attempt_id;
        let authority = capture.authority.clone();
        if self.runtime()?.authority_source == Some(AuthoritySource::Manual) {
            let mut runtime = self.runtime()?;
            runtime.require_capture(&capture)?;
            runtime.state.status = "pairing_required".to_owned();
            runtime.state.diagnostic = None;
            return Ok(runtime.snapshot());
        }
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
        if credential.origin_binding != authority.origin_binding()
            || credential.epoch != authority.identity().epoch
        {
            let mut runtime = self.runtime()?;
            runtime.require_attempt(attempt_id)?;
            runtime.authorized = None;
            runtime.unauthorized.reset();
            runtime.state.status = "pairing_required".to_owned();
            runtime.state.diagnostic =
                Some(NativeDiagnostic::new("credential_binding_mismatch", false));
            return Ok(runtime.snapshot());
        }
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

        let delay = self
            .runtime()?
            .unauthorized
            .delay_before_probe(authority.identity(), &credential.credential_id);
        if let Some(delay) = delay.filter(|delay| !delay.is_zero()) {
            tokio::time::sleep(delay).await;
            self.runtime()?.require_capture(&capture)?;
        }

        match self
            .transport
            .health(&authority, Some(&credential.bearer))
            .await
        {
            Ok(_) => {
                let mut runtime = self.runtime()?;
                runtime.require_capture(&capture)?;
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
                    runtime.require_capture(&capture)?;
                    runtime.unauthorized.record(
                        &authority.identity().instance_id,
                        authority.identity().epoch,
                        &credential.credential_id,
                    )
                };

                match action {
                    UnauthorizedAction::RefreshDiscovery => {
                        let discovery_capture = {
                            let mut runtime = self.runtime()?;
                            runtime.require_capture(&capture)?;
                            runtime.begin_generation();
                            runtime.capture_authority()?
                        };
                        let refreshed = match self
                            .transport
                            .discover(authority.discovery_url().clone())
                            .await
                        {
                            Ok(refreshed) => refreshed,
                            Err(error) => {
                                let mut runtime = self.runtime()?;
                                runtime.require_capture(&discovery_capture)?;
                                runtime.unauthorized.reset();
                                return Err(error);
                            }
                        };
                        let mut runtime = self.runtime()?;
                        runtime.require_capture(&discovery_capture)?;
                        runtime.set_authority_for_attempt(refreshed, attempt_id)?;
                        if runtime
                            .authority
                            .as_ref()
                            .is_some_and(|current| current.is_same_pin(&authority))
                        {
                            runtime.unauthorized.mark_rediscovered(authority.identity());
                        } else {
                            runtime.unauthorized.reset();
                        }
                        runtime.state.status = "refreshing_discovery".to_owned();
                        Ok(runtime.snapshot())
                    }
                    UnauthorizedAction::AwaitRediscovery => {
                        let mut runtime = self.runtime()?;
                        runtime.require_capture(&capture)?;
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
                runtime.require_capture(&capture)?;
                runtime.unauthorized.reset();
                Err(error)
            }
        }
    }

    pub(crate) async fn start_pairing(&self) -> NativeResult<PairingStateDto> {
        let capture = {
            let mut runtime = self.runtime()?;
            let capture = runtime.capture_authority()?;
            runtime.reserve_pairing()?;
            capture
        };

        let installation_id = match self.keyring.installation_id() {
            Ok(installation_id) => installation_id,
            Err(error) => {
                self.runtime()?.abort_pairing_reservation(&capture);
                return Err(error.diagnostic());
            }
        };
        let issued = match self
            .transport
            .create_pairing(&capture.authority, &installation_id)
            .await
        {
            Ok(issued) => issued,
            Err(error) => {
                self.runtime()?.abort_pairing_reservation(&capture);
                return Err(error);
            }
        };

        let pairing = match self.runtime()?.register_pending_pairing(&issued, &capture) {
            Ok(pairing) => pairing,
            Err(error) => {
                self.runtime()?.abort_pairing_reservation(&capture);
                return Err(error);
            }
        };
        let state = self.clone();
        let transport = self.transport.clone();
        tauri::async_runtime::spawn(async move {
            state
                .complete_pending_pairing(transport, issued, capture)
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
        let capture = {
            let runtime = self.runtime()?;
            if runtime.authority_source != Some(AuthoritySource::Canonical) {
                return Err(NativeDiagnostic::new("credential_reuse_blocked", false));
            }
            runtime.capture_authority()?
        };
        let credential = self
            .keyring
            .read_credential(&capture.authority.identity().instance_id)
            .map_err(|error| error.diagnostic())?;
        let conversation = self
            .transport
            .start_conversation(&capture.authority, &credential.bearer, input)
            .await?;
        self.runtime()?.require_capture(&capture)?;
        Ok(conversation)
    }

    async fn complete_pending_pairing(
        self,
        transport: std::sync::Arc<dyn ConnectionTransport>,
        issued: PairingIssued,
        capture: AuthorityCapture,
    ) {
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;

            let secret = match self.runtime() {
                Ok(mut runtime) => {
                    if runtime.expire_pairing_if_needed(&issued.request_id, &capture) {
                        return;
                    }
                    runtime.pairing_secret(&issued.request_id, &capture)
                }
                Err(_) => None,
            };
            let Some(secret) = secret else {
                return;
            };

            match transport
                .poll_pairing(&capture.authority, &issued.request_id, &secret)
                .await
            {
                Ok(PairingStatus::Pending) => continue,
                Ok(PairingStatus::Approved) => {
                    let exchange_secret = match self.runtime() {
                        Ok(mut runtime) => {
                            runtime.commit_pairing_exchange(&issued.request_id, &capture)
                        }
                        Err(_) => None,
                    };
                    let Some(exchange_secret) = exchange_secret else {
                        return;
                    };
                    let grant = match transport
                        .exchange_pairing(&capture.authority, &issued.request_id, &exchange_secret)
                        .await
                    {
                        Ok(grant) => grant,
                        Err(error) => {
                            if let Ok(mut runtime) = self.runtime() {
                                runtime.fail_pairing(&issued.request_id, &capture, error);
                            }
                            return;
                        }
                    };

                    if let Err(error) = self.keyring.store_credential(
                        &capture.authority,
                        &grant.bearer,
                        &grant.metadata.credential_id,
                    ) {
                        if let Ok(mut runtime) = self.runtime() {
                            runtime.fail_pairing(&issued.request_id, &capture, error.diagnostic());
                        }
                        return;
                    }
                    if let Ok(mut runtime) = self.runtime() {
                        if runtime.pairing_is_current(&issued.request_id, &capture) {
                            runtime.complete_pairing(&issued.request_id, &capture, grant.metadata);
                        } else {
                            runtime.finalize_persisted_pairing(&issued.request_id, &capture);
                        }
                    }
                    return;
                }
                Ok(PairingStatus::Denied) | Ok(PairingStatus::Expired) => {
                    if let Ok(mut runtime) = self.runtime() {
                        runtime.mark_pairing_status(&issued.request_id, &capture, "finished");
                        runtime.fail_pairing(
                            &issued.request_id,
                            &capture,
                            NativeDiagnostic::new("pairing_not_approved", false),
                        );
                    }
                    return;
                }
                Err(error) => {
                    if let Ok(mut runtime) = self.runtime() {
                        runtime.fail_pairing(&issued.request_id, &capture, error);
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

        let authority = runtime.current_authority()?;
        if authority.identity() != identity {
            return Err(NativeDiagnostic::new("revocation_not_confirmed", true));
        }
        let deleted = self
            .keyring
            .delete_credential_if_matches(&authority, credential_id)
            .map_err(|error| error.diagnostic())?;
        if !deleted {
            runtime.unauthorized.reset();
            return Err(NativeDiagnostic::new("revocation_not_confirmed", true));
        }
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
        cave::{
            test_authority, CaveChild, CaveLauncher, NativeDiagnostic, NativeResult,
            ValidatedCaveAuthority,
        },
        keyring::{Credential, CredentialMetadata, KeyringError},
        transport::{
            test_health_metadata, ConversationStartDto, HealthMetadata, PairingGrant,
            PairingIssued, PairingStatus, StartConversationInput,
        },
        NativeConnectionState,
    };

    struct FakeTransport {
        authority: ValidatedCaveAuthority,
        discovery: Mutex<VecDeque<NativeResult<ValidatedCaveAuthority>>>,
        health: Mutex<VecDeque<NativeResult<HealthMetadata>>>,
        retry_state: Mutex<Option<NativeConnectionState>>,
        retry_on_poll: Mutex<Option<NativeConnectionState>>,
        poll: Mutex<VecDeque<NativeResult<PairingStatus>>>,
        exchange_grant: Mutex<Option<NativeResult<PairingGrant>>>,
        cancel_on_exchange: Mutex<Option<NativeConnectionState>>,
        exchanges: AtomicUsize,
    }

    impl FakeTransport {
        fn new(health: impl IntoIterator<Item = NativeResult<HealthMetadata>>) -> Self {
            Self {
                authority: test_authority("instance-a", 7),
                discovery: Mutex::new(VecDeque::new()),
                health: Mutex::new(health.into_iter().collect()),
                retry_state: Mutex::new(None),
                retry_on_poll: Mutex::new(None),
                poll: Mutex::new(VecDeque::new()),
                exchange_grant: Mutex::new(None),
                cancel_on_exchange: Mutex::new(None),
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
            _bearer: Option<&str>,
        ) -> NativeResult<HealthMetadata> {
            self.health
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Ok(test_health_metadata()))
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
            request_id: &str,
            _secret: &str,
        ) -> NativeResult<PairingGrant> {
            self.exchanges.fetch_add(1, Ordering::SeqCst);
            if let Some(state) = self.cancel_on_exchange.lock().unwrap().take() {
                state.cancel_pairing(request_id.to_owned())?;
            }
            self.exchange_grant
                .lock()
                .unwrap()
                .take()
                .unwrap_or_else(|| Err(NativeDiagnostic::new("not_used_in_test", false)))
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
        credential: Mutex<Option<(String, String)>>,
        fail_installation: bool,
        reads: AtomicUsize,
        deletes: AtomicUsize,
        stores: AtomicUsize,
    }

    struct FakeChild {
        exited: Arc<std::sync::atomic::AtomicBool>,
    }

    impl CaveChild for FakeChild {
        fn try_wait(&mut self) -> NativeResult<bool> {
            Ok(self.exited.load(Ordering::SeqCst))
        }

        fn terminate(&mut self) -> NativeResult<()> {
            self.exited.store(true, Ordering::SeqCst);
            Ok(())
        }
    }

    struct FakeLauncher {
        launches: AtomicUsize,
        exited: Arc<std::sync::atomic::AtomicBool>,
    }

    impl CaveLauncher for FakeLauncher {
        fn launch(&self) -> NativeResult<Box<dyn CaveChild>> {
            self.launches.fetch_add(1, Ordering::SeqCst);
            self.exited.store(false, Ordering::SeqCst);
            Ok(Box::new(FakeChild {
                exited: self.exited.clone(),
            }))
        }
    }

    impl FakeKeyring {
        fn unavailable() -> Self {
            Self {
                credential: Mutex::new(None),
                fail_installation: true,
                reads: AtomicUsize::new(0),
                deletes: AtomicUsize::new(0),
                stores: AtomicUsize::new(0),
            }
        }

        fn credential(credential_id: &str) -> Self {
            Self {
                credential: Mutex::new(Some((
                    "stored-bearer".to_owned(),
                    credential_id.to_owned(),
                ))),
                fail_installation: false,
                reads: AtomicUsize::new(0),
                deletes: AtomicUsize::new(0),
                stores: AtomicUsize::new(0),
            }
        }

        fn replace_credential(&self, credential_id: &str) {
            *self.credential.lock().unwrap() =
                Some(("replacement-bearer".to_owned(), credential_id.to_owned()));
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
            self.reads.fetch_add(1, Ordering::SeqCst);
            self.credential
                .lock()
                .unwrap()
                .as_ref()
                .map(|(bearer, credential_id)| Credential {
                    bearer: bearer.clone(),
                    credential_id: credential_id.clone(),
                    origin_binding: test_authority("instance-a", 7).origin_binding(),
                    epoch: 7,
                })
                .ok_or(KeyringError::NotFound)
        }

        fn store_credential(
            &self,
            _authority: &ValidatedCaveAuthority,
            _bearer: &str,
            credential_id: &str,
        ) -> Result<CredentialMetadata, KeyringError> {
            self.stores.fetch_add(1, Ordering::SeqCst);
            *self.credential.lock().unwrap() =
                Some(("stored-after-pairing".to_owned(), credential_id.to_owned()));
            Ok(CredentialMetadata {
                credential_id: credential_id.to_owned(),
            })
        }

        fn delete_credential_if_matches(
            &self,
            _authority: &ValidatedCaveAuthority,
            credential_id: &str,
        ) -> Result<bool, KeyringError> {
            let mut credential = self.credential.lock().unwrap();
            if credential
                .as_ref()
                .is_some_and(|(_, stored_id)| stored_id == credential_id)
            {
                *credential = None;
                self.deletes.fetch_add(1, Ordering::SeqCst);
                Ok(true)
            } else {
                Ok(false)
            }
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
            UnauthorizedAction::AwaitRediscovery
        );
        attempts.mark_rediscovered(&test_authority("instance-a", 7).identity().clone());
        assert_eq!(
            attempts.record("instance-a", 7, "credential-a"),
            UnauthorizedAction::ConfirmRevocation
        );
    }

    #[test]
    fn revocation_confirmation_requires_the_same_credential_after_rediscovery() {
        let mut attempts = UnauthorizedTracker::default();

        attempts.record("instance-a", 7, "credential-a");
        attempts.mark_rediscovered(&test_authority("instance-a", 7).identity().clone());

        assert_eq!(
            attempts.record("instance-a", 7, "credential-b"),
            UnauthorizedAction::RefreshDiscovery
        );
    }

    #[test]
    fn stale_discovery_from_a_fake_transport_cannot_replace_a_newer_attempt() {
        let transport = Arc::new(FakeTransport::new([Ok(test_health_metadata())]));
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
    fn a_new_discovery_generation_rejects_a_stale_pinned_authority() {
        let mut runtime = super::ConnectionRuntime::default();
        runtime
            .set_authority(test_authority("instance-a", 7))
            .unwrap();
        let capture = runtime.capture_authority().unwrap();

        runtime.begin_generation();

        assert_eq!(
            runtime.require_capture(&capture).unwrap_err().code,
            "stale_connection_attempt"
        );
    }

    #[test]
    fn committed_pairing_exchange_survives_a_late_ui_cancel() {
        let mut runtime = super::ConnectionRuntime::default();
        runtime
            .set_authority(test_authority("instance-a", 7))
            .unwrap();
        let capture = runtime.capture_authority().unwrap();
        runtime.reserve_pairing().unwrap();
        runtime
            .register_pending_pairing(
                &PairingIssued {
                    request_id: "request-a".to_owned(),
                    secret: "pairing-secret".to_owned(),
                    expires_at: u64::MAX,
                },
                &capture,
            )
            .unwrap();

        assert_eq!(
            runtime.commit_pairing_exchange("request-a", &capture),
            Some("pairing-secret".to_owned())
        );
        runtime.cancel_pairing("request-a").unwrap();

        assert!(runtime.pairing_exchange_committed("request-a", &capture));
    }

    #[test]
    fn committed_exchange_persists_the_grant_after_a_cancelled_ui_attempt() {
        let transport = Arc::new(FakeTransport::new([]));
        let keyring = Arc::new(FakeKeyring::credential("credential-a"));
        let state = NativeConnectionState::with_collaborators(transport.clone(), keyring.clone());
        establish_canonical(&state);
        let issued = PairingIssued {
            request_id: "request-a".to_owned(),
            secret: "pairing-secret".to_owned(),
            expires_at: u64::MAX,
        };
        let capture = {
            let mut runtime = state.runtime().unwrap();
            let capture = runtime.capture_authority().unwrap();
            runtime.reserve_pairing().unwrap();
            runtime.register_pending_pairing(&issued, &capture).unwrap();
            capture
        };
        transport
            .poll
            .lock()
            .unwrap()
            .push_back(Ok(PairingStatus::Approved));
        *transport.exchange_grant.lock().unwrap() = Some(Ok(PairingGrant {
            bearer: "new-bearer".to_owned(),
            metadata: CredentialMetadata {
                credential_id: "credential-new".to_owned(),
            },
        }));
        *transport.cancel_on_exchange.lock().unwrap() = Some(state.clone());

        tauri::async_runtime::block_on(
            state
                .clone()
                .complete_pending_pairing(transport, issued, capture),
        );

        assert_eq!(keyring.stores.load(Ordering::SeqCst), 1);
        assert_eq!(
            state.connection_state().unwrap().status,
            "pairing_cancelled"
        );
    }

    #[test]
    fn launch_reservation_starts_cave_once_after_owner_controlled_readiness() {
        let transport = Arc::new(FakeTransport::new([Ok(test_health_metadata())]));
        let keyring = Arc::new(FakeKeyring::credential("credential-a"));
        let launcher = Arc::new(FakeLauncher {
            launches: AtomicUsize::new(0),
            exited: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        });
        let state = NativeConnectionState::with_collaborators_and_launcher(
            transport,
            keyring,
            launcher.clone(),
        );

        let connected = tauri::async_runtime::block_on(state.launch_cave()).unwrap();
        let duplicate = match tauri::async_runtime::block_on(state.launch_cave()) {
            Err(error) => error,
            Ok(_) => panic!("an active Cave child must keep its launch reservation"),
        };

        assert_eq!(connected.status, "candidate");
        assert_eq!(duplicate.code, "cave_launch_in_progress");
        assert_eq!(launcher.launches.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn exited_cave_child_is_reaped_before_a_new_launch_reservation() {
        let transport = Arc::new(FakeTransport::new([
            Ok(test_health_metadata()),
            Ok(test_health_metadata()),
        ]));
        let keyring = Arc::new(FakeKeyring::credential("credential-a"));
        let launcher = Arc::new(FakeLauncher {
            launches: AtomicUsize::new(0),
            exited: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        });
        let state = NativeConnectionState::with_collaborators_and_launcher(
            transport,
            keyring,
            launcher.clone(),
        );

        tauri::async_runtime::block_on(state.launch_cave()).unwrap();
        launcher.exited.store(true, Ordering::SeqCst);
        assert_eq!(state.connection_state().unwrap().status, "disconnected");
        tauri::async_runtime::block_on(state.launch_cave()).unwrap();

        assert_eq!(launcher.launches.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn keyring_failure_releases_the_pairing_reservation_for_retry() {
        let transport = Arc::new(FakeTransport::new([]));
        let keyring = Arc::new(FakeKeyring::unavailable());
        let state = NativeConnectionState::with_collaborators(transport, keyring);
        establish_canonical(&state);

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
        establish_canonical(&state);

        for _ in 0..2 {
            let error = match tauri::async_runtime::block_on(state.start_pairing()) {
                Err(error) => error,
                Ok(_) => panic!("the fake transport should reject pairing"),
            };
            assert_eq!(error.code, "not_used_in_test");
        }
    }

    #[test]
    fn manual_loopback_discovery_claiming_a_known_instance_cannot_load_a_credential() {
        let transport = Arc::new(FakeTransport::new([Ok(test_health_metadata())]));
        let keyring = Arc::new(FakeKeyring::credential("credential-a"));
        let state = NativeConnectionState::with_collaborators(transport, keyring.clone());
        tauri::async_runtime::block_on(
            state.submit_manual_discovery("http://127.0.0.1:4310/api/v1/discovery".to_owned()),
        )
        .unwrap();

        let snapshot = tauri::async_runtime::block_on(state.refresh_connection()).unwrap();

        assert_eq!(snapshot.status, "pairing_required");
        assert_eq!(keyring.reads.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn manual_authority_cannot_reuse_a_credential_for_conversations() {
        let transport = Arc::new(FakeTransport::new([Ok(test_health_metadata())]));
        let keyring = Arc::new(FakeKeyring::credential("credential-a"));
        let state = NativeConnectionState::with_collaborators(transport, keyring.clone());
        tauri::async_runtime::block_on(
            state.submit_manual_discovery("http://127.0.0.1:4310/api/v1/discovery".to_owned()),
        )
        .unwrap();

        let error =
            match tauri::async_runtime::block_on(state.start_conversation(StartConversationInput {
                familiar_id: "astra".to_owned(),
                project_root: None,
            })) {
                Err(error) => error,
                Ok(_) => panic!("manual discovery must not receive an existing credential"),
            };

        assert_eq!(error.code, "credential_reuse_blocked");
        assert_eq!(keyring.reads.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn credential_reuse_requires_the_canonical_instance_epoch_binding() {
        let transport = Arc::new(FakeTransport::new([]));
        let keyring = Arc::new(FakeKeyring::credential("credential-a"));
        let state = NativeConnectionState::with_collaborators(transport, keyring);
        state
            .runtime()
            .unwrap()
            .set_authority(test_authority("instance-a", 8))
            .unwrap();

        let snapshot = tauri::async_runtime::block_on(state.refresh_connection()).unwrap();

        assert_eq!(snapshot.status, "pairing_required");
        assert_eq!(
            snapshot.diagnostic.unwrap().code,
            "credential_binding_mismatch"
        );
    }

    #[test]
    fn stale_pairing_completion_from_a_fake_transport_never_exchanges_a_grant() {
        let transport = Arc::new(FakeTransport::new([]));
        let keyring = Arc::new(FakeKeyring::credential("credential-a"));
        let state = NativeConnectionState::with_collaborators(transport.clone(), keyring);
        establish_canonical(&state);
        let issued = PairingIssued {
            request_id: "request-a".to_owned(),
            secret: "pairing-secret".to_owned(),
            expires_at: u64::MAX,
        };
        let capture = {
            let mut runtime = state.runtime().unwrap();
            let capture = runtime.capture_authority().unwrap();
            runtime.reserve_pairing().unwrap();
            runtime.register_pending_pairing(&issued, &capture).unwrap();
            capture
        };
        *transport.retry_on_poll.lock().unwrap() = Some(state.clone());
        transport
            .poll
            .lock()
            .unwrap()
            .push_back(Ok(PairingStatus::Approved));

        tauri::async_runtime::block_on(state.clone().complete_pending_pairing(
            transport.clone(),
            issued,
            capture,
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
        establish_canonical(&state);
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
    fn replacing_a_credential_between_unauthorized_probes_prevents_deletion() {
        let transport = Arc::new(FakeTransport::new([
            Err(NativeDiagnostic::new("unauthorized", true)),
            Err(NativeDiagnostic::new("unauthorized", true)),
        ]));
        let keyring = Arc::new(FakeKeyring::credential("credential-a"));
        let state = NativeConnectionState::with_collaborators(transport, keyring.clone());
        establish_canonical(&state);

        tauri::async_runtime::block_on(state.refresh_connection()).unwrap();
        keyring.replace_credential("credential-b");
        let second = tauri::async_runtime::block_on(state.refresh_connection()).unwrap();

        assert_eq!(second.status, "refreshing_discovery");
        assert_eq!(keyring.deletes.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn non_unauthorized_health_failures_reset_revocation_confirmation() {
        let transport = Arc::new(FakeTransport::new([
            Err(NativeDiagnostic::new("transport_unavailable", true)),
            Err(NativeDiagnostic::new("unauthorized", true)),
        ]));
        let keyring = Arc::new(FakeKeyring::credential("credential-a"));
        let state = NativeConnectionState::with_collaborators(transport, keyring.clone());
        establish_canonical(&state);
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
        establish_canonical(&state);
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
        let capture = runtime.capture_authority().unwrap();
        runtime.reserve_pairing().unwrap();
        runtime
            .register_pending_pairing(
                &PairingIssued {
                    request_id: "request-a".to_owned(),
                    secret: "pairing-secret".to_owned(),
                    expires_at: u64::MAX,
                },
                &capture,
            )
            .unwrap();
        runtime.unauthorized.record("instance-a", 7, "credential-a");

        runtime.complete_pairing(
            "request-a",
            &capture,
            CredentialMetadata {
                credential_id: "credential-a".to_owned(),
            },
        );

        assert_eq!(
            runtime.unauthorized.record("instance-a", 7, "credential-a"),
            UnauthorizedAction::RefreshDiscovery
        );
    }

    fn establish_canonical(state: &NativeConnectionState) {
        state
            .runtime()
            .unwrap()
            .set_authority(test_authority("instance-a", 7))
            .unwrap();
    }
}
