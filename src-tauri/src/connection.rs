use std::{
    future::Future,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde_json::{json, Value};

use crate::{
    cave::{
        pin_owner_discovery_record, CaveChild, CaveClock, CaveSleeper, CaveTaskRunner,
        NativeDiagnostic, NativeResult, OwnerDiscoveryRecord, PinnedCaveAuthority,
    },
    keyring::{Credential, CredentialSlot, KeyringError},
    transport::{
        response_diagnostic, validate_pairing_request, CaveReadPath, NativeHttpResponse,
        NativePage, NativePairingExchange,
    },
    NativeConnectionState,
};

const LAUNCH_READINESS_DEADLINE: Duration = Duration::from_secs(30);

#[derive(Clone)]
struct LaunchDeadline {
    clock: Arc<dyn CaveClock>,
    expires_at: Duration,
}

impl LaunchDeadline {
    fn start(clock: Arc<dyn CaveClock>) -> Self {
        Self {
            expires_at: clock.now() + LAUNCH_READINESS_DEADLINE,
            clock,
        }
    }

    fn remaining(&self) -> NativeResult<Duration> {
        let remaining = self.expires_at.saturating_sub(self.clock.now());
        if remaining.is_zero() {
            return Err(launch_deadline_expired());
        }
        Ok(remaining)
    }

    fn check(&self) -> NativeResult<()> {
        self.remaining().map(|_| ())
    }
}

fn launch_deadline_expired() -> NativeDiagnostic {
    NativeDiagnostic::new("service_unavailable", true)
}

#[derive(Clone)]
struct PendingPairing {
    request_id: String,
    secret: String,
    authority: PinnedCaveAuthority,
    instance_id: String,
    generation: u64,
    exchange_committed: bool,
    poll_in_flight: bool,
}

struct ManagedLaunch {
    child: Option<Box<dyn CaveChild>>,
    generation: u64,
    cleanup_requested: bool,
    cleanup_started: bool,
}

#[derive(Default)]
struct UnauthorizedTracker {
    identity: Option<UnauthorizedIdentity>,
}

struct UnauthorizedIdentity {
    instance_id: String,
    origin: String,
    credential_id: String,
    first_unauthorized_at: Instant,
    rediscovery_healthy: bool,
}

enum UnauthorizedAction {
    RefreshDiscovery,
    AwaitRediscovery,
    ConfirmRevocation,
}

enum CredentialCurrentState {
    Missing,
    Current,
    Changed,
}

struct PairingCreateReservation {
    runtime: Arc<Mutex<ConnectionRuntime>>,
    generation: u64,
    handle: String,
    authority: PinnedCaveAuthority,
}

impl Drop for PairingCreateReservation {
    fn drop(&mut self) {
        if let Ok(mut runtime) = self.runtime.lock() {
            if runtime.generation == self.generation
                && runtime.authority_handle.as_deref() == Some(&self.handle)
                && runtime
                    .authority
                    .as_ref()
                    .is_some_and(|current| current.is_same_pin(&self.authority))
            {
                runtime.pairing_in_flight = false;
            }
        }
    }
}

struct PairingPollReservation {
    runtime: Arc<Mutex<ConnectionRuntime>>,
    generation: u64,
    handle: String,
    authority: PinnedCaveAuthority,
    request_id: String,
}

impl Drop for PairingPollReservation {
    fn drop(&mut self) {
        if let Ok(mut runtime) = self.runtime.lock() {
            if runtime.generation == self.generation
                && runtime.authority_handle.as_deref() == Some(&self.handle)
                && runtime.pairing.as_ref().is_some_and(|pairing| {
                    pairing.request_id == self.request_id
                        && pairing.generation == self.generation
                        && pairing.authority.is_same_pin(&self.authority)
                })
            {
                if let Some(pairing) = runtime.pairing.as_mut() {
                    pairing.poll_in_flight = false;
                }
            }
        }
    }
}

struct RevocationReservation {
    runtime: Arc<Mutex<ConnectionRuntime>>,
    generation: u64,
    handle: String,
    authority: PinnedCaveAuthority,
    instance_id: String,
}

impl Drop for RevocationReservation {
    fn drop(&mut self) {
        if let Ok(mut runtime) = self.runtime.lock() {
            if runtime.generation == self.generation
                && runtime.authority_handle.as_deref() == Some(&self.handle)
                && runtime.instance_id.as_deref() == Some(&self.instance_id)
                && runtime
                    .authority
                    .as_ref()
                    .is_some_and(|current| current.is_same_pin(&self.authority))
            {
                runtime.revocation_in_flight = false;
            }
        }
    }
}

impl UnauthorizedTracker {
    fn reset(&mut self) {
        self.identity = None;
    }

    fn mark_rediscovery_healthy(&mut self, instance_id: &str, origin: &str) {
        if let Some(identity) = self.identity.as_mut() {
            if identity.instance_id == instance_id && identity.origin == origin {
                identity.rediscovery_healthy = true;
            }
        }
    }

    fn record(&mut self, instance_id: &str, credential: &Credential) -> UnauthorizedAction {
        let now = Instant::now();
        if let Some(previous) = self.identity.as_ref() {
            if previous.instance_id == instance_id
                && previous.origin == credential.origin
                && previous.credential_id == credential.credential_id
            {
                if !previous.rediscovery_healthy
                    || now.duration_since(previous.first_unauthorized_at)
                        < Duration::from_millis(500)
                {
                    return UnauthorizedAction::AwaitRediscovery;
                }
                return UnauthorizedAction::ConfirmRevocation;
            }
        }
        self.identity = Some(UnauthorizedIdentity {
            instance_id: instance_id.to_owned(),
            origin: credential.origin.clone(),
            credential_id: credential.credential_id.clone(),
            first_unauthorized_at: now,
            rediscovery_healthy: false,
        });
        UnauthorizedAction::RefreshDiscovery
    }
}

#[derive(Default)]
pub(crate) struct ConnectionRuntime {
    generation: u64,
    authority: Option<PinnedCaveAuthority>,
    authority_handle: Option<String>,
    instance_id: Option<String>,
    pairing: Option<PendingPairing>,
    pairing_in_flight: bool,
    launch: Option<ManagedLaunch>,
    launch_in_flight: bool,
    spawn_in_flight: Option<u64>,
    revocation_in_flight: bool,
    unauthorized: UnauthorizedTracker,
}

impl ConnectionRuntime {
    fn new_generation(&mut self) -> u64 {
        self.generation = self.generation.saturating_add(1);
        self.generation
    }

    fn clear_authority_state(&mut self) {
        self.authority = None;
        self.authority_handle = None;
        self.instance_id = None;
        self.pairing = None;
        self.pairing_in_flight = false;
        self.revocation_in_flight = false;
        self.unauthorized.reset();
    }

    fn require_authority(&self, handle: &str) -> NativeResult<(u64, PinnedCaveAuthority)> {
        if self.authority_handle.as_deref() != Some(handle) {
            return Err(NativeDiagnostic::new("invalid_discovery_handle", false));
        }
        self.authority
            .clone()
            .map(|authority| (self.generation, authority))
            .ok_or_else(|| NativeDiagnostic::new("cave_discovery_required", true))
    }

    fn require_authorized(&self, handle: &str) -> NativeResult<(u64, PinnedCaveAuthority, String)> {
        let (generation, authority) = self.require_authority(handle)?;
        self.instance_id
            .clone()
            .map(|instance_id| (generation, authority, instance_id))
            .ok_or_else(|| NativeDiagnostic::new("cave_health_required", true))
    }

    fn accept_discovery(
        &mut self,
        record: &mut OwnerDiscoveryRecord,
    ) -> NativeResult<PinnedCaveAuthority> {
        let generation = self.new_generation();
        let authority = pin_owner_discovery_record(record, generation)?;
        let changed = self
            .authority
            .as_ref()
            .is_none_or(|current| !current.is_same_pin(&authority));
        self.authority = Some(authority.clone());
        record.handle = uuid::Uuid::new_v4().to_string();
        self.authority_handle = Some(record.handle.clone());
        self.instance_id = None;
        self.pairing = None;
        self.pairing_in_flight = false;
        self.revocation_in_flight = false;
        if changed {
            self.unauthorized.reset();
        }
        Ok(authority)
    }

    fn require_current(
        &self,
        generation: u64,
        handle: &str,
        authority: &PinnedCaveAuthority,
    ) -> NativeResult<()> {
        if self.generation != generation
            || self.authority_handle.as_deref() != Some(handle)
            || self
                .authority
                .as_ref()
                .is_none_or(|current| !current.is_same_pin(authority))
        {
            return Err(NativeDiagnostic::new("stale_connection_attempt", true));
        }
        Ok(())
    }

    fn require_current_authorized(
        &self,
        generation: u64,
        handle: &str,
        authority: &PinnedCaveAuthority,
        instance_id: &str,
    ) -> NativeResult<()> {
        self.require_current(generation, handle, authority)?;
        if self.instance_id.as_deref() != Some(instance_id) {
            return Err(NativeDiagnostic::new("stale_connection_attempt", true));
        }
        Ok(())
    }

    fn reap_launch(&mut self) -> Option<u64> {
        let launch = self.launch.as_mut()?;
        if launch.cleanup_requested {
            return (!launch.cleanup_started && launch.child.is_some())
                .then_some(launch.generation);
        }
        match launch
            .child
            .as_mut()
            .map(|child| child.try_wait())
            .transpose()
        {
            Ok(Some(true)) => {
                self.launch = None;
                self.launch_in_flight = false;
                None
            }
            Ok(Some(false)) => None,
            Ok(None) | Err(_) => {
                launch.cleanup_requested = true;
                self.launch_in_flight = false;
                Some(launch.generation)
            }
        }
    }
}

async fn await_until_deadline<T>(
    deadline: &LaunchDeadline,
    sleeper: &dyn CaveSleeper,
    future: impl Future<Output = T>,
) -> NativeResult<T> {
    let remaining = deadline.remaining()?;
    tokio::select! {
        biased;
        output = future => Ok(output),
        _ = sleeper.sleep(remaining) => Err(launch_deadline_expired()),
    }
}

async fn run_blocking_until_deadline<T: Send + 'static>(
    deadline: &LaunchDeadline,
    sleeper: &dyn CaveSleeper,
    task_runner: &Arc<dyn CaveTaskRunner>,
    task: impl FnOnce() -> NativeResult<T> + Send + 'static,
) -> NativeResult<T> {
    deadline.check()?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    task_runner.execute(Box::new(move || {
        let _ = sender.send(task());
    }))?;
    await_until_deadline(deadline, sleeper, async move {
        receiver
            .await
            .unwrap_or_else(|_| Err(NativeDiagnostic::new("service_unavailable", true)))
    })
    .await?
}

fn schedule_child_cleanup(
    runtime: Arc<Mutex<ConnectionRuntime>>,
    task_runner: Arc<dyn CaveTaskRunner>,
    generation: u64,
) {
    let should_schedule = runtime
        .lock()
        .ok()
        .and_then(|mut runtime| {
            let launch = runtime
                .launch
                .as_mut()
                .filter(|launch| launch.generation == generation && launch.cleanup_requested)?;
            if launch.cleanup_started || launch.child.is_none() {
                return None;
            }
            launch.cleanup_started = true;
            Some(())
        })
        .is_some();
    if !should_schedule {
        return;
    }

    let cleanup_runtime = runtime.clone();
    if task_runner
        .execute(Box::new(move || {
            let child = cleanup_runtime.lock().ok().and_then(|mut runtime| {
                runtime.launch.as_mut().and_then(|launch| {
                    (launch.generation == generation && launch.cleanup_requested)
                        .then(|| launch.child.take())
                        .flatten()
                })
            });
            if let Some(mut child) = child {
                let _ = child.terminate();
                let cleaned = child.wait().is_ok();
                match cleanup_runtime.lock() {
                    Ok(mut runtime) if cleaned => {
                        if runtime.launch.as_ref().is_some_and(|launch| {
                            launch.generation == generation && launch.cleanup_requested
                        }) {
                            runtime.launch = None;
                        }
                    }
                    Ok(mut runtime) => {
                        if let Some(launch) = runtime.launch.as_mut().filter(|launch| {
                            launch.generation == generation && launch.cleanup_requested
                        }) {
                            launch.child = Some(child);
                            launch.cleanup_started = false;
                        } else {
                            retain_cleanup_child(child);
                        }
                    }
                    Err(_) if !cleaned => retain_cleanup_child(child),
                    Err(_) => {}
                }
            }
        }))
        .is_err()
    {
        if let Ok(mut runtime) = runtime.lock() {
            if let Some(launch) = runtime
                .launch
                .as_mut()
                .filter(|launch| launch.generation == generation && launch.cleanup_requested)
            {
                launch.cleanup_started = false;
            }
        }
    }
}

fn retain_cleanup_child(mut child: Box<dyn CaveChild>) {
    loop {
        let _ = child.terminate();
        if child.wait().is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn abandon_launch(
    runtime: Arc<Mutex<ConnectionRuntime>>,
    task_runner: Arc<dyn CaveTaskRunner>,
    generation: u64,
) {
    let cleanup_required = runtime
        .lock()
        .ok()
        .map(|mut runtime| {
            if runtime.generation == generation {
                runtime.clear_authority_state();
                runtime.new_generation();
                runtime.launch_in_flight = false;
            }
            let launch_matches = runtime
                .launch
                .as_ref()
                .is_some_and(|launch| launch.generation == generation);
            let spawn_matches = runtime.spawn_in_flight == Some(generation);
            if launch_matches || spawn_matches {
                runtime.launch_in_flight = false;
            }
            if let Some(launch) = runtime
                .launch
                .as_mut()
                .filter(|launch| launch.generation == generation)
            {
                launch.cleanup_requested = true;
                return launch.child.is_some() && !launch.cleanup_started;
            }
            false
        })
        .unwrap_or(false);
    if cleanup_required {
        schedule_child_cleanup(runtime, task_runner, generation);
    }
}

struct LaunchAttempt {
    runtime: Arc<Mutex<ConnectionRuntime>>,
    task_runner: Arc<dyn CaveTaskRunner>,
    generation: u64,
    completed: bool,
}

impl LaunchAttempt {
    fn complete(&mut self) {
        self.completed = true;
    }
}

impl Drop for LaunchAttempt {
    fn drop(&mut self) {
        if !self.completed {
            abandon_launch(
                self.runtime.clone(),
                self.task_runner.clone(),
                self.generation,
            );
        }
    }
}

fn start_launch_worker(
    runtime: Arc<Mutex<ConnectionRuntime>>,
    task_runner: Arc<dyn CaveTaskRunner>,
    launcher: Arc<dyn crate::cave::CaveLauncher>,
    deadline: LaunchDeadline,
    generation: u64,
) -> NativeResult<tokio::sync::oneshot::Receiver<NativeResult<()>>> {
    {
        let mut runtime = runtime
            .lock()
            .map_err(|_| NativeDiagnostic::new("connection_state_unavailable", true))?;
        runtime.spawn_in_flight = Some(generation);
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let worker_runtime = runtime.clone();
    if let Err(error) = task_runner.execute(Box::new(move || {
        let result = deadline.check().and_then(|_| launcher.launch());
        let mut child_to_cleanup = None;
        let outcome = match result {
            Ok(child) => match worker_runtime.lock() {
                Ok(mut runtime)
                    if runtime.generation == generation
                        && runtime.launch_in_flight
                        && runtime.spawn_in_flight == Some(generation) =>
                {
                    runtime.launch = Some(ManagedLaunch {
                        child: Some(child),
                        generation,
                        cleanup_requested: false,
                        cleanup_started: false,
                    });
                    runtime.spawn_in_flight = None;
                    Ok(())
                }
                Ok(mut runtime) => {
                    if runtime.spawn_in_flight == Some(generation) {
                        runtime.spawn_in_flight = None;
                    }
                    child_to_cleanup = Some(child);
                    Err(NativeDiagnostic::new("stale_connection_attempt", true))
                }
                Err(_) => {
                    child_to_cleanup = Some(child);
                    Err(NativeDiagnostic::new("connection_state_unavailable", true))
                }
            },
            Err(error) => {
                if let Ok(mut runtime) = worker_runtime.lock() {
                    if runtime.spawn_in_flight == Some(generation) {
                        runtime.spawn_in_flight = None;
                    }
                }
                Err(error)
            }
        };
        let _ = sender.send(outcome);
        if let Some(mut child) = child_to_cleanup {
            let _ = child.terminate();
            let _ = child.wait();
        }
    })) {
        if let Ok(mut runtime) = runtime.lock() {
            if runtime.spawn_in_flight == Some(generation) {
                runtime.spawn_in_flight = None;
            }
        }
        return Err(error);
    }
    Ok(receiver)
}

impl NativeConnectionState {
    pub(crate) fn cave_read_discovery(&self) -> NativeResult<OwnerDiscoveryRecord> {
        let mut record = self.discovery.read()?;
        self.runtime()?.accept_discovery(&mut record)?;
        Ok(record)
    }

    fn capture_handle(&self, handle: &str) -> NativeResult<(u64, PinnedCaveAuthority)> {
        let record = self.discovery.read()?;
        let mut runtime = self.runtime()?;
        let (generation, authority) = runtime.require_authority(handle)?;
        if !authority.matches_owner_record(&record) {
            runtime.clear_authority_state();
            runtime.new_generation();
            return Err(NativeDiagnostic::new("stale_discovery_handle", true));
        }
        Ok((generation, authority))
    }

    fn revalidate_authorized(
        &self,
        generation: u64,
        handle: &str,
        authority: &PinnedCaveAuthority,
        instance_id: &str,
    ) -> NativeResult<()> {
        let (current_generation, current_authority) = self.capture_handle(handle)?;
        if current_generation != generation || !current_authority.is_same_pin(authority) {
            return Err(NativeDiagnostic::new("stale_connection_attempt", true));
        }
        self.runtime()?
            .require_current_authorized(generation, handle, authority, instance_id)
    }

    fn credential_current_state(
        &self,
        generation: u64,
        handle: &str,
        authority: &PinnedCaveAuthority,
        instance_id: &str,
        expected: &Credential,
    ) -> NativeResult<CredentialCurrentState> {
        self.revalidate_authorized(generation, handle, authority, instance_id)?;
        let state = match self.keyring.read(instance_id, authority.origin().as_str()) {
            Ok(current) if current.is_same_identity(expected) => CredentialCurrentState::Current,
            Ok(_) => CredentialCurrentState::Changed,
            Err(KeyringError::NotFound) => CredentialCurrentState::Missing,
            Err(error) => return Err(error.diagnostic()),
        };
        self.revalidate_authorized(generation, handle, authority, instance_id)?;
        Ok(state)
    }

    fn commit_pairing_exchange(
        &self,
        handle: &str,
        attempt: &PendingPairing,
        expected_credential: &CredentialSlot,
        exchanged: &NativePairingExchange,
    ) -> NativeResult<bool> {
        let record = self.discovery.read()?;
        let mut runtime = self.runtime()?;
        runtime.require_current_authorized(
            attempt.generation,
            handle,
            &attempt.authority,
            &attempt.instance_id,
        )?;
        if !attempt.authority.matches_owner_record(&record) {
            runtime.clear_authority_state();
            runtime.new_generation();
            return Err(NativeDiagnostic::new("stale_discovery_handle", true));
        }
        if runtime.pairing.as_ref().is_none_or(|current| {
            current.request_id != attempt.request_id
                || current.generation != attempt.generation
                || !current.authority.is_same_pin(&attempt.authority)
                || current.instance_id != attempt.instance_id
                || !current.exchange_committed
        }) {
            return Err(NativeDiagnostic::new("stale_connection_attempt", true));
        }
        let persisted = match expected_credential {
            CredentialSlot::Current(expected_credential) => self
                .keyring
                .store_if_current(
                    &attempt.instance_id,
                    attempt.authority.origin().as_str(),
                    Some(expected_credential),
                    &exchanged.bearer,
                    &exchanged.credential_id,
                )
                .map_err(|error| error.diagnostic())?,
            CredentialSlot::Missing => self
                .keyring
                .store_if_current(
                    &attempt.instance_id,
                    attempt.authority.origin().as_str(),
                    None,
                    &exchanged.bearer,
                    &exchanged.credential_id,
                )
                .map_err(|error| error.diagnostic())?,
            CredentialSlot::Stale(expected_stale_credential) => self
                .keyring
                .replace_stale_if_current(
                    &attempt.instance_id,
                    attempt.authority.origin().as_str(),
                    expected_stale_credential,
                    &exchanged.bearer,
                    &exchanged.credential_id,
                )
                .map_err(|error| error.diagnostic())?,
        };
        if persisted {
            runtime.pairing = None;
            let post_commit_record = self.discovery.read()?;
            runtime.require_current_authorized(
                attempt.generation,
                handle,
                &attempt.authority,
                &attempt.instance_id,
            )?;
            if !attempt.authority.matches_owner_record(&post_commit_record) {
                runtime.clear_authority_state();
                runtime.new_generation();
                return Err(NativeDiagnostic::new("stale_discovery_handle", true));
            }
            runtime.unauthorized.reset();
        }
        Ok(persisted)
    }

    fn revalidate_authenticated_read(
        &self,
        generation: u64,
        handle: &str,
        authority: &PinnedCaveAuthority,
        instance_id: &str,
        expected_credential: &Credential,
        reset_unauthorized: bool,
    ) -> NativeResult<()> {
        let record = self.discovery.read()?;
        let mut runtime = self.runtime()?;
        runtime.require_current_authorized(generation, handle, authority, instance_id)?;
        if !authority.matches_owner_record(&record) {
            runtime.clear_authority_state();
            runtime.new_generation();
            return Err(NativeDiagnostic::new("stale_discovery_handle", true));
        }
        let current = self
            .keyring
            .read(instance_id, authority.origin().as_str())
            .map_err(|error| error.diagnostic())?;
        if !current.is_same_identity(expected_credential) {
            return Err(NativeDiagnostic::new("stale_connection_attempt", true));
        }
        if reset_unauthorized {
            runtime.unauthorized.reset();
        }
        Ok(())
    }

    pub(crate) async fn cave_health(&self, handle: String) -> NativeResult<Value> {
        let (generation, authority) = self.capture_handle(&handle)?;
        let response = self.transport.health(&authority).await?;
        require_success(&response)?;
        let instance_id = health_instance_id(&response.payload)?;
        let mut runtime = self.runtime()?;
        runtime.require_current(generation, &handle, &authority)?;
        authority.bind_instance_id(&instance_id)?;
        runtime.instance_id = Some(instance_id.clone());
        runtime
            .unauthorized
            .mark_rediscovery_healthy(&instance_id, authority.origin().as_str());
        Ok(response.payload)
    }

    pub(crate) async fn cave_pairing_create(
        &self,
        handle: String,
        request: Value,
    ) -> NativeResult<Value> {
        validate_pairing_request(&request)?;
        self.capture_handle(&handle)?;
        let (generation, authority, instance_id) = {
            let mut runtime = self.runtime()?;
            let captured = runtime.require_authorized(&handle)?;
            if runtime.pairing_in_flight || runtime.pairing.is_some() {
                return Err(NativeDiagnostic::new("pairing_in_progress", true));
            }
            runtime.pairing_in_flight = true;
            captured
        };
        let _reservation = PairingCreateReservation {
            runtime: Arc::clone(&self.runtime),
            generation,
            handle: handle.clone(),
            authority: authority.clone(),
        };
        let result = self.transport.pairing_create(&authority, request).await;
        let mut runtime = self.runtime()?;
        let created = result?;
        runtime.require_current(generation, &handle, &authority)?;
        runtime.pairing = Some(PendingPairing {
            request_id: pairing_request_id(&created.response)?,
            secret: created.secret,
            authority,
            instance_id,
            generation,
            exchange_committed: false,
            poll_in_flight: false,
        });
        Ok(created.response)
    }

    pub(crate) async fn cave_pairing_poll(
        &self,
        handle: String,
        request_id: String,
    ) -> NativeResult<Value> {
        self.capture_handle(&handle)?;
        let (generation, authority, secret) = {
            let mut runtime = self.runtime()?;
            let pairing = runtime
                .pairing
                .as_ref()
                .filter(|pairing| pairing.request_id == request_id && !pairing.exchange_committed)
                .ok_or_else(|| NativeDiagnostic::new("pairing_not_found", true))?;
            let generation = pairing.generation;
            let authority = pairing.authority.clone();
            let secret = pairing.secret.clone();
            runtime.require_current(generation, &handle, &authority)?;
            if pairing.poll_in_flight {
                return Err(NativeDiagnostic::new("pairing_in_progress", true));
            }
            runtime.pairing.as_mut().unwrap().poll_in_flight = true;
            (generation, authority, secret)
        };
        let _reservation = PairingPollReservation {
            runtime: Arc::clone(&self.runtime),
            generation,
            handle: handle.clone(),
            authority: authority.clone(),
            request_id: request_id.clone(),
        };
        let result = self
            .transport
            .pairing_poll(&authority, &request_id, &secret)
            .await;
        let runtime = self.runtime()?;
        let is_current = runtime.generation == generation
            && runtime.authority_handle.as_deref() == Some(&handle)
            && runtime.pairing.as_ref().is_some_and(|pairing| {
                pairing.request_id == request_id
                    && pairing.generation == generation
                    && pairing.authority.is_same_pin(&authority)
            });
        if !is_current {
            return Err(NativeDiagnostic::new("stale_connection_attempt", true));
        }
        runtime.require_current(generation, &handle, &authority)?;
        result
    }

    pub(crate) async fn cave_pairing_exchange(
        &self,
        handle: String,
        request_id: String,
    ) -> NativeResult<Value> {
        self.capture_handle(&handle)?;
        let pairing = {
            let mut runtime = self.runtime()?;
            let Some(pairing) = runtime.pairing.as_mut() else {
                return Err(NativeDiagnostic::new("pairing_not_found", true));
            };
            if pairing.request_id != request_id
                || pairing.exchange_committed
                || pairing.poll_in_flight
            {
                return Err(NativeDiagnostic::new("pairing_not_found", true));
            }
            pairing.exchange_committed = true;
            pairing.clone()
        };
        let expected_credential = match self
            .keyring
            .read_for_pairing_update(&pairing.instance_id, pairing.authority.origin().as_str())
        {
            Ok(credential) => credential,
            Err(error) => {
                let mut runtime = self.runtime()?;
                if runtime.generation == pairing.generation
                    && runtime.authority_handle.as_deref() == Some(&handle)
                    && runtime
                        .pairing
                        .as_mut()
                        .is_some_and(|pairing| pairing.request_id == request_id)
                {
                    runtime.pairing.as_mut().unwrap().exchange_committed = false;
                }
                return Err(error.diagnostic());
            }
        };
        let exchanged = self
            .transport
            .pairing_exchange(&pairing.authority, &request_id, &pairing.secret)
            .await?;
        let persisted =
            self.commit_pairing_exchange(&handle, &pairing, &expected_credential, &exchanged)?;
        if !persisted {
            return Err(NativeDiagnostic::new("credential_update_in_progress", true));
        }
        Ok(exchanged.response)
    }

    pub(crate) fn cave_reset_pairing(&self, handle: String) -> NativeResult<Value> {
        self.capture_handle(&handle)?;
        let mut runtime = self.runtime()?;
        let (generation, authority) = runtime.require_authority(&handle)?;
        runtime.require_current(generation, &handle, &authority)?;
        runtime.clear_authority_state();
        runtime.new_generation();
        Ok(json!({ "status": "invalidated" }))
    }

    pub(crate) async fn cave_credential_status(&self, handle: String) -> NativeResult<Value> {
        let (generation, authority) = self.capture_handle(&handle)?;
        let (_, _, instance_id) = self.runtime()?.require_authorized(&handle)?;
        let credential = match self.keyring.read(&instance_id, authority.origin().as_str()) {
            Ok(credential) => credential,
            Err(KeyringError::NotFound) => {
                self.revalidate_authorized(generation, &handle, &authority, &instance_id)?;
                return Ok(json!({ "status": "missing" }));
            }
            Err(error) => return Err(error.diagnostic()),
        };
        self.revalidate_authorized(generation, &handle, &authority, &instance_id)?;
        {
            let mut runtime = self.runtime()?;
            runtime.require_current_authorized(generation, &handle, &authority, &instance_id)?;
            if runtime.revocation_in_flight {
                return Ok(json!({
                    "status": "disconnected",
                    "reason": "credential_update_in_progress",
                }));
            }
            runtime.revocation_in_flight = true;
        }
        let _reservation = RevocationReservation {
            runtime: Arc::clone(&self.runtime),
            generation,
            handle: handle.clone(),
            authority: authority.clone(),
            instance_id: instance_id.clone(),
        };
        let response = match self
            .transport
            .authenticated_read(
                &authority,
                &credential.bearer,
                CaveReadPath::Familiars {
                    page: NativePage {
                        limit: Some(1),
                        cursor: None,
                    },
                },
            )
            .await
        {
            Ok(response) => response,
            Err(error) => {
                self.revalidate_authorized(generation, &handle, &authority, &instance_id)?;
                let runtime = self.runtime()?;
                runtime.require_current_authorized(
                    generation,
                    &handle,
                    &authority,
                    &instance_id,
                )?;
                return Err(error);
            }
        };
        self.revalidate_authorized(generation, &handle, &authority, &instance_id)?;
        let action = {
            let mut runtime = self.runtime()?;
            runtime.require_current_authorized(generation, &handle, &authority, &instance_id)?;
            if response.status_code == 401 {
                Some(runtime.unauthorized.record(&instance_id, &credential))
            } else {
                runtime.unauthorized.reset();
                None
            }
        };
        if let Some(action) = action {
            if !matches!(action, UnauthorizedAction::ConfirmRevocation) {
                return Ok(json!({
                    "status": "disconnected",
                    "reason": "reconcile_required",
                }));
            }
            match self.credential_current_state(
                generation,
                &handle,
                &authority,
                &instance_id,
                &credential,
            )? {
                CredentialCurrentState::Missing => return Ok(json!({ "status": "missing" })),
                CredentialCurrentState::Changed => {
                    return Ok(json!({
                        "status": "disconnected",
                        "reason": "credential_update_in_progress",
                    }));
                }
                CredentialCurrentState::Current => {}
            }

            let deleted = self
                .keyring
                .delete_if_matches(&instance_id, authority.origin().as_str(), &credential)
                .map_err(|error| error.diagnostic())?;
            match self.credential_current_state(
                generation,
                &handle,
                &authority,
                &instance_id,
                &credential,
            )? {
                CredentialCurrentState::Missing if deleted => {}
                CredentialCurrentState::Missing => return Ok(json!({ "status": "missing" })),
                CredentialCurrentState::Current | CredentialCurrentState::Changed => {
                    return Ok(json!({
                        "status": "disconnected",
                        "reason": "credential_update_in_progress",
                    }));
                }
            }
            {
                let mut runtime = self.runtime()?;
                runtime.require_current_authorized(
                    generation,
                    &handle,
                    &authority,
                    &instance_id,
                )?;
                runtime.unauthorized.reset();
            }

            let health = self.transport.health(&authority).await?;
            require_success(&health)?;
            self.revalidate_authorized(generation, &handle, &authority, &instance_id)?;
            match self.credential_current_state(
                generation,
                &handle,
                &authority,
                &instance_id,
                &credential,
            )? {
                CredentialCurrentState::Missing => {}
                CredentialCurrentState::Current | CredentialCurrentState::Changed => {
                    return Ok(json!({
                        "status": "disconnected",
                        "reason": "credential_update_in_progress",
                    }));
                }
            }
            return Ok(json!({
                "status": "revoked",
                "health": health.payload,
            }));
        }

        let health = self.transport.health(&authority).await?;
        require_success(&health)?;
        self.revalidate_authorized(generation, &handle, &authority, &instance_id)?;
        match self.credential_current_state(
            generation,
            &handle,
            &authority,
            &instance_id,
            &credential,
        )? {
            CredentialCurrentState::Missing => return Ok(json!({ "status": "missing" })),
            CredentialCurrentState::Changed => {
                return Ok(json!({
                    "status": "disconnected",
                    "reason": "credential_update_in_progress",
                }));
            }
            CredentialCurrentState::Current => {}
        }
        let access = match response.status_code {
            200..=299 => "chat:read",
            403 => "scope_denied",
            429 => "rate_limited",
            _ => "service_unavailable",
        };
        Ok(json!({
            "status": "valid",
            "access": access,
            "health": health.payload,
        }))
    }

    pub(crate) fn cave_forget_credential(&self, handle: String) -> NativeResult<Value> {
        let (generation, authority) = self.capture_handle(&handle)?;
        let (_, _, instance_id) = self.runtime()?.require_authorized(&handle)?;
        let credential = match self.keyring.read(&instance_id, authority.origin().as_str()) {
            Ok(credential) => credential,
            Err(KeyringError::NotFound) => {
                self.revalidate_authorized(generation, &handle, &authority, &instance_id)?;
                return Ok(json!({ "status": "missing" }));
            }
            Err(error) => return Err(error.diagnostic()),
        };
        match self.credential_current_state(
            generation,
            &handle,
            &authority,
            &instance_id,
            &credential,
        )? {
            CredentialCurrentState::Missing => return Ok(json!({ "status": "missing" })),
            CredentialCurrentState::Changed => {
                return Ok(json!({
                    "status": "credential_update_in_progress",
                }));
            }
            CredentialCurrentState::Current => {}
        }
        let deleted = self
            .keyring
            .delete_if_matches(&instance_id, authority.origin().as_str(), &credential)
            .map_err(|error| error.diagnostic())?;
        match self.credential_current_state(
            generation,
            &handle,
            &authority,
            &instance_id,
            &credential,
        )? {
            CredentialCurrentState::Missing if deleted => Ok(json!({ "status": "deleted" })),
            CredentialCurrentState::Missing => Ok(json!({ "status": "missing" })),
            CredentialCurrentState::Current | CredentialCurrentState::Changed => {
                Ok(json!({ "status": "credential_update_in_progress" }))
            }
        }
    }

    pub(crate) async fn cave_read(
        &self,
        handle: String,
        path: CaveReadPath,
    ) -> NativeResult<Value> {
        path.validate()?;
        let (generation, authority) = self.capture_handle(&handle)?;
        let (_, _, instance_id) = self.runtime()?.require_authorized(&handle)?;
        let credential = self
            .keyring
            .read(&instance_id, authority.origin().as_str())
            .map_err(|error| error.diagnostic())?;
        let response = self
            .transport
            .authenticated_read(&authority, &credential.bearer, path)
            .await?;
        self.revalidate_authenticated_read(
            generation,
            &handle,
            &authority,
            &instance_id,
            &credential,
            response.status_code != 401,
        )?;
        Ok(response.payload)
    }

    pub(crate) async fn cave_launch(&self) -> NativeResult<()> {
        let deadline = LaunchDeadline::start(self.clock.clone());
        deadline.check()?;
        let reservation = {
            let mut runtime = self.runtime()?;
            let pending_cleanup = runtime.reap_launch();
            if runtime.launch_in_flight
                || runtime.launch.is_some()
                || runtime.spawn_in_flight.is_some()
            {
                Err(pending_cleanup)
            } else {
                deadline.check()?;
                runtime.clear_authority_state();
                runtime.launch_in_flight = true;
                Ok(runtime.new_generation())
            }
        };
        let generation = match reservation {
            Ok(generation) => generation,
            Err(pending_cleanup) => {
                if let Some(generation) = pending_cleanup {
                    schedule_child_cleanup(
                        self.runtime.clone(),
                        self.task_runner.clone(),
                        generation,
                    );
                }
                return Err(NativeDiagnostic::new("cave_launch_in_progress", true));
            }
        };
        let mut attempt = LaunchAttempt {
            runtime: self.runtime.clone(),
            task_runner: self.task_runner.clone(),
            generation,
            completed: false,
        };
        let launch_complete = start_launch_worker(
            self.runtime.clone(),
            self.task_runner.clone(),
            self.launcher.clone(),
            deadline.clone(),
            generation,
        )?;
        await_until_deadline(&deadline, self.sleeper.as_ref(), async move {
            launch_complete
                .await
                .unwrap_or_else(|_| Err(NativeDiagnostic::new("service_unavailable", true)))
        })
        .await??;
        deadline.check()?;

        let mut backoff = Duration::from_millis(100);
        loop {
            deadline.check()?;
            {
                let mut runtime = self.runtime()?;
                if runtime.generation != generation
                    || runtime.launch.as_ref().is_none_or(|launch| {
                        launch.generation != generation || launch.cleanup_requested
                    })
                {
                    return Err(NativeDiagnostic::new("stale_connection_attempt", true));
                }
                if runtime.launch.as_mut().is_some_and(|launch| {
                    launch
                        .child
                        .as_mut()
                        .is_none_or(|child| child.try_wait().unwrap_or(true))
                }) {
                    runtime.launch = None;
                    runtime.launch_in_flight = false;
                    return Err(NativeDiagnostic::new("cave_exited", true));
                }
            }
            let record =
                run_blocking_until_deadline(&deadline, self.sleeper.as_ref(), &self.task_runner, {
                    let discovery = self.discovery.clone();
                    move || discovery.read()
                })
                .await;
            match record {
                Ok(record) => {
                    if let Ok(authority) = pin_owner_discovery_record(&record, generation) {
                        let health = await_until_deadline(
                            &deadline,
                            self.sleeper.as_ref(),
                            self.transport.health(&authority),
                        )
                        .await;
                        if let Ok(Ok(response)) = health {
                            if require_success(&response).is_ok() {
                                let instance_id = health_instance_id(&response.payload)?;
                                let revalidated = run_blocking_until_deadline(
                                    &deadline,
                                    self.sleeper.as_ref(),
                                    &self.task_runner,
                                    {
                                        let discovery = self.discovery.clone();
                                        move || discovery.read()
                                    },
                                )
                                .await;
                                match revalidated {
                                    Ok(record) if authority.matches_owner_record(&record) => {}
                                    Err(error) if error.code == "service_unavailable" => {
                                        return Err(error);
                                    }
                                    _ => continue,
                                }
                                deadline.check()?;
                                let mut runtime = self.runtime()?;
                                if runtime.launch.as_ref().is_some_and(|launch| {
                                    launch.generation == generation
                                        && !launch.cleanup_requested
                                        && launch.child.is_some()
                                }) && runtime.generation == generation
                                {
                                    authority.bind_instance_id(&instance_id)?;
                                    runtime.authority = Some(authority.clone());
                                    runtime.instance_id = Some(instance_id);
                                    runtime.launch_in_flight = false;
                                    attempt.complete();
                                    return Ok(());
                                }
                                return Err(NativeDiagnostic::new(
                                    "stale_connection_attempt",
                                    true,
                                ));
                            }
                        } else if health.is_err() {
                            return Err(launch_deadline_expired());
                        }
                    }
                }
                Err(error) if error.code == "service_unavailable" => return Err(error),
                Err(_) => {}
            }
            let remaining = deadline.remaining()?;
            self.sleeper.sleep(backoff.min(remaining)).await;
            backoff = (backoff * 2).min(Duration::from_secs(2));
        }
    }
}

fn require_success(response: &NativeHttpResponse) -> NativeResult<()> {
    if (200..300).contains(&response.status_code) {
        Ok(())
    } else {
        Err(response_diagnostic(response))
    }
}

fn health_instance_id(value: &Value) -> NativeResult<String> {
    value
        .get("data")
        .and_then(Value::as_object)
        .and_then(|data| data.get("instanceId"))
        .and_then(Value::as_str)
        .filter(|instance_id| {
            !instance_id.is_empty()
                && instance_id.len() <= 256
                && !instance_id.chars().any(char::is_control)
        })
        .map(str::to_owned)
        .ok_or_else(|| NativeDiagnostic::new("invalid_native_response", false))
}

fn pairing_request_id(value: &Value) -> NativeResult<String> {
    value
        .get("requestId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| NativeDiagnostic::new("invalid_native_response", false))
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Barrier, Mutex,
        },
        time::Duration,
    };

    use async_trait::async_trait;
    use serde_json::json;

    use super::*;
    use crate::{
        cave::{
            test_discovery_bytes, CaveClock, CaveDiscoveryReader, CaveLauncher, CaveSleeper,
            CaveTaskRunner, NativeDiagnostic, OwnerDiscoveryRecordMetadata,
        },
        keyring::CredentialCustody,
        operation::{NativeCancelReason, NativeOperationInput},
        transport::{NativeCaveTransport, NativePairingCreated, NativePairingExchange},
    };
    use tokio::sync::Notify;

    struct FakeTransport {
        health_started: Option<Arc<std::sync::Barrier>>,
        health_release: Option<Arc<std::sync::Barrier>>,
        read_status: u16,
    }

    impl Default for FakeTransport {
        fn default() -> Self {
            Self {
                health_started: None,
                health_release: None,
                read_status: 401,
            }
        }
    }

    struct StaticDiscovery {
        record: OwnerDiscoveryRecord,
    }

    impl CaveDiscoveryReader for StaticDiscovery {
        fn read(&self) -> NativeResult<OwnerDiscoveryRecord> {
            Ok(self.record.clone())
        }
    }

    struct MutableDiscovery {
        record: Mutex<OwnerDiscoveryRecord>,
    }

    impl CaveDiscoveryReader for MutableDiscovery {
        fn read(&self) -> NativeResult<OwnerDiscoveryRecord> {
            Ok(self.record.lock().unwrap().clone())
        }
    }

    #[async_trait]
    impl NativeCaveTransport for FakeTransport {
        async fn health(
            &self,
            _authority: &PinnedCaveAuthority,
        ) -> NativeResult<NativeHttpResponse> {
            if let Some(started) = self.health_started.as_ref() {
                started.wait();
                self.health_release.as_ref().unwrap().wait();
            }
            Ok(NativeHttpResponse {
                status_code: 200,
                payload: client_v1_health_envelope(),
            })
        }

        async fn pairing_create(
            &self,
            _authority: &PinnedCaveAuthority,
            _request: Value,
        ) -> NativeResult<NativePairingCreated> {
            Err(NativeDiagnostic::new("unused", false))
        }

        async fn pairing_poll(
            &self,
            _authority: &PinnedCaveAuthority,
            _request_id: &str,
            _secret: &str,
        ) -> NativeResult<Value> {
            Err(NativeDiagnostic::new("unused", false))
        }

        async fn pairing_exchange(
            &self,
            _authority: &PinnedCaveAuthority,
            _request_id: &str,
            _secret: &str,
        ) -> NativeResult<NativePairingExchange> {
            Err(NativeDiagnostic::new("unused", false))
        }

        async fn authenticated_read(
            &self,
            _authority: &PinnedCaveAuthority,
            _bearer: &str,
            _path: CaveReadPath,
        ) -> NativeResult<NativeHttpResponse> {
            Ok(NativeHttpResponse {
                status_code: self.read_status,
                payload: json!({}),
            })
        }
    }

    struct StatusRaceTransport {
        health_calls: AtomicUsize,
        final_health_started: Option<Arc<Barrier>>,
        final_health_release: Option<Arc<Barrier>>,
        read_started: Option<Arc<Barrier>>,
        read_release: Option<Arc<Barrier>>,
        read_status: u16,
    }

    fn client_v1_health_envelope() -> Value {
        json!({
            "apiVersion": "1.0",
            "minimumClientVersion": "0.1.0",
            "capabilities": [
                "health",
                "pairing",
                "credentials",
                "familiars",
                "projects",
                "conversations",
                "conversation-messages",
                "cursors",
            ],
            "operations": [
                "health.read",
                "pairing.create",
                "pairing.poll",
                "pairing.exchange",
                "pairing.admin.list",
                "pairing.admin.decide",
                "credentials.admin.list",
                "credentials.admin.revoke",
                "familiars.list",
                "projects.list",
                "conversations.list",
                "conversations.read",
                "messages.list",
            ],
            "data": {
                "instanceId": "00000000-0000-4000-8000-000000000000",
                "pairingRequired": true,
                "releaseVersion": "0.0.0",
            },
        })
    }

    fn pairing_request() -> Value {
        json!({
            "appName": "OpenCoven Chat",
            "installationId": "00000000-0000-4000-8000-000000000001",
            "scopes": ["chat:read"],
        })
    }

    #[async_trait]
    impl NativeCaveTransport for StatusRaceTransport {
        async fn health(
            &self,
            _authority: &PinnedCaveAuthority,
        ) -> NativeResult<NativeHttpResponse> {
            if self.health_calls.fetch_add(1, Ordering::SeqCst) > 0 {
                if let Some(started) = self.final_health_started.as_ref() {
                    started.wait();
                    self.final_health_release.as_ref().unwrap().wait();
                }
            }
            Ok(NativeHttpResponse {
                status_code: 200,
                payload: client_v1_health_envelope(),
            })
        }

        async fn pairing_create(
            &self,
            _authority: &PinnedCaveAuthority,
            _request: Value,
        ) -> NativeResult<NativePairingCreated> {
            Err(NativeDiagnostic::new("unused", false))
        }

        async fn pairing_poll(
            &self,
            _authority: &PinnedCaveAuthority,
            _request_id: &str,
            _secret: &str,
        ) -> NativeResult<Value> {
            Err(NativeDiagnostic::new("unused", false))
        }

        async fn pairing_exchange(
            &self,
            _authority: &PinnedCaveAuthority,
            _request_id: &str,
            _secret: &str,
        ) -> NativeResult<NativePairingExchange> {
            Err(NativeDiagnostic::new("unused", false))
        }

        async fn authenticated_read(
            &self,
            _authority: &PinnedCaveAuthority,
            _bearer: &str,
            _path: CaveReadPath,
        ) -> NativeResult<NativeHttpResponse> {
            if let Some(started) = self.read_started.as_ref() {
                started.wait();
                self.read_release.as_ref().unwrap().wait();
            }
            Ok(NativeHttpResponse {
                status_code: self.read_status,
                payload: json!({
                    "apiVersion": "1.0",
                    "minimumClientVersion": "0.1.0",
                    "capabilities": ["familiars", "cursors"],
                    "operations": ["familiars.list"],
                    "data": { "familiars": [] },
                }),
            })
        }
    }

    struct ExchangeRaceTransport {
        old_exchange_started: Arc<Barrier>,
        old_exchange_release: Arc<Barrier>,
    }

    #[async_trait]
    impl NativeCaveTransport for ExchangeRaceTransport {
        async fn health(
            &self,
            _authority: &PinnedCaveAuthority,
        ) -> NativeResult<NativeHttpResponse> {
            Ok(NativeHttpResponse {
                status_code: 200,
                payload: client_v1_health_envelope(),
            })
        }

        async fn pairing_create(
            &self,
            _authority: &PinnedCaveAuthority,
            _request: Value,
        ) -> NativeResult<NativePairingCreated> {
            Err(NativeDiagnostic::new("unused", false))
        }

        async fn pairing_poll(
            &self,
            _authority: &PinnedCaveAuthority,
            _request_id: &str,
            _secret: &str,
        ) -> NativeResult<Value> {
            Err(NativeDiagnostic::new("unused", false))
        }

        async fn pairing_exchange(
            &self,
            _authority: &PinnedCaveAuthority,
            request_id: &str,
            _secret: &str,
        ) -> NativeResult<NativePairingExchange> {
            if request_id == "old-request" {
                self.old_exchange_started.wait();
                self.old_exchange_release.wait();
            }
            let (bearer, credential_id) = match request_id {
                "old-request" => ("old-bearer", "credential-old"),
                "new-request" => ("new-bearer", "credential-new"),
                _ => return Err(NativeDiagnostic::new("unused", false)),
            };
            Ok(NativePairingExchange {
                response: json!({ "status": "paired" }),
                bearer: bearer.to_owned(),
                credential_id: credential_id.to_owned(),
            })
        }

        async fn authenticated_read(
            &self,
            _authority: &PinnedCaveAuthority,
            _bearer: &str,
            _path: CaveReadPath,
        ) -> NativeResult<NativeHttpResponse> {
            Err(NativeDiagnostic::new("unused", false))
        }
    }

    struct CancellationPollRaceTransport {
        creates: AtomicUsize,
        poll_started: Arc<Barrier>,
        poll_release: Arc<Barrier>,
    }

    #[async_trait]
    impl NativeCaveTransport for CancellationPollRaceTransport {
        async fn health(
            &self,
            _authority: &PinnedCaveAuthority,
        ) -> NativeResult<NativeHttpResponse> {
            Ok(NativeHttpResponse {
                status_code: 200,
                payload: client_v1_health_envelope(),
            })
        }

        async fn pairing_create(
            &self,
            _authority: &PinnedCaveAuthority,
            _request: Value,
        ) -> NativeResult<NativePairingCreated> {
            let create_number = self.creates.fetch_add(1, Ordering::SeqCst) + 1;
            Ok(NativePairingCreated {
                secret: format!("pairing-secret-{create_number}"),
                response: json!({ "requestId": format!("request-{create_number}") }),
            })
        }

        async fn pairing_poll(
            &self,
            _authority: &PinnedCaveAuthority,
            _request_id: &str,
            _secret: &str,
        ) -> NativeResult<Value> {
            self.poll_started.wait();
            self.poll_release.wait();
            Ok(json!({ "status": "pending" }))
        }

        async fn pairing_exchange(
            &self,
            _authority: &PinnedCaveAuthority,
            _request_id: &str,
            _secret: &str,
        ) -> NativeResult<NativePairingExchange> {
            Err(NativeDiagnostic::new("unused", false))
        }

        async fn authenticated_read(
            &self,
            _authority: &PinnedCaveAuthority,
            _bearer: &str,
            _path: CaveReadPath,
        ) -> NativeResult<NativeHttpResponse> {
            Err(NativeDiagnostic::new("unused", false))
        }
    }

    struct ResetCreateRaceTransport {
        creates: AtomicUsize,
        create_started: Arc<Barrier>,
        create_release: Arc<Barrier>,
    }

    struct CancellationCreateTransport {
        creates: AtomicUsize,
        started: Arc<Notify>,
    }

    #[async_trait]
    impl NativeCaveTransport for CancellationCreateTransport {
        async fn health(
            &self,
            _authority: &PinnedCaveAuthority,
        ) -> NativeResult<NativeHttpResponse> {
            Ok(NativeHttpResponse {
                status_code: 200,
                payload: client_v1_health_envelope(),
            })
        }

        async fn pairing_create(
            &self,
            _authority: &PinnedCaveAuthority,
            _request: Value,
        ) -> NativeResult<NativePairingCreated> {
            if self.creates.fetch_add(1, Ordering::SeqCst) == 0 {
                self.started.notify_one();
                return std::future::pending().await;
            }
            Ok(NativePairingCreated {
                secret: "pairing-secret".to_owned(),
                response: json!({
                    "requestId": "11111111-1111-4111-8111-111111111111",
                }),
            })
        }

        async fn pairing_poll(
            &self,
            _authority: &PinnedCaveAuthority,
            _request_id: &str,
            _secret: &str,
        ) -> NativeResult<Value> {
            Err(NativeDiagnostic::new("unused", false))
        }

        async fn pairing_exchange(
            &self,
            _authority: &PinnedCaveAuthority,
            _request_id: &str,
            _secret: &str,
        ) -> NativeResult<NativePairingExchange> {
            Err(NativeDiagnostic::new("unused", false))
        }

        async fn authenticated_read(
            &self,
            _authority: &PinnedCaveAuthority,
            _bearer: &str,
            _path: CaveReadPath,
        ) -> NativeResult<NativeHttpResponse> {
            Err(NativeDiagnostic::new("unused", false))
        }
    }

    struct CancellationPollTransport {
        polls: AtomicUsize,
        started: Arc<Notify>,
    }

    #[async_trait]
    impl NativeCaveTransport for CancellationPollTransport {
        async fn health(
            &self,
            _authority: &PinnedCaveAuthority,
        ) -> NativeResult<NativeHttpResponse> {
            Ok(NativeHttpResponse {
                status_code: 200,
                payload: client_v1_health_envelope(),
            })
        }

        async fn pairing_create(
            &self,
            _authority: &PinnedCaveAuthority,
            _request: Value,
        ) -> NativeResult<NativePairingCreated> {
            Err(NativeDiagnostic::new("unused", false))
        }

        async fn pairing_poll(
            &self,
            _authority: &PinnedCaveAuthority,
            request_id: &str,
            _secret: &str,
        ) -> NativeResult<Value> {
            if self.polls.fetch_add(1, Ordering::SeqCst) == 0 {
                self.started.notify_one();
                return std::future::pending().await;
            }
            Ok(json!({
                "id": request_id,
                "status": "pending",
                "expiresAt": 42,
            }))
        }

        async fn pairing_exchange(
            &self,
            _authority: &PinnedCaveAuthority,
            _request_id: &str,
            _secret: &str,
        ) -> NativeResult<NativePairingExchange> {
            Err(NativeDiagnostic::new("unused", false))
        }

        async fn authenticated_read(
            &self,
            _authority: &PinnedCaveAuthority,
            _bearer: &str,
            _path: CaveReadPath,
        ) -> NativeResult<NativeHttpResponse> {
            Err(NativeDiagnostic::new("unused", false))
        }
    }

    struct CancellationStatusTransport {
        reads: AtomicUsize,
        started: Arc<Notify>,
    }

    #[async_trait]
    impl NativeCaveTransport for CancellationStatusTransport {
        async fn health(
            &self,
            _authority: &PinnedCaveAuthority,
        ) -> NativeResult<NativeHttpResponse> {
            Ok(NativeHttpResponse {
                status_code: 200,
                payload: client_v1_health_envelope(),
            })
        }

        async fn pairing_create(
            &self,
            _authority: &PinnedCaveAuthority,
            _request: Value,
        ) -> NativeResult<NativePairingCreated> {
            Err(NativeDiagnostic::new("unused", false))
        }

        async fn pairing_poll(
            &self,
            _authority: &PinnedCaveAuthority,
            _request_id: &str,
            _secret: &str,
        ) -> NativeResult<Value> {
            Err(NativeDiagnostic::new("unused", false))
        }

        async fn pairing_exchange(
            &self,
            _authority: &PinnedCaveAuthority,
            _request_id: &str,
            _secret: &str,
        ) -> NativeResult<NativePairingExchange> {
            Err(NativeDiagnostic::new("unused", false))
        }

        async fn authenticated_read(
            &self,
            _authority: &PinnedCaveAuthority,
            _bearer: &str,
            _path: CaveReadPath,
        ) -> NativeResult<NativeHttpResponse> {
            if self.reads.fetch_add(1, Ordering::SeqCst) == 0 {
                self.started.notify_one();
                return std::future::pending().await;
            }
            Ok(NativeHttpResponse {
                status_code: 200,
                payload: json!({
                    "apiVersion": "1.0",
                    "minimumClientVersion": "0.1.0",
                    "capabilities": ["familiars", "cursors"],
                    "operations": ["familiars.list"],
                    "data": { "familiars": [] },
                }),
            })
        }
    }

    #[async_trait]
    impl NativeCaveTransport for ResetCreateRaceTransport {
        async fn health(
            &self,
            _authority: &PinnedCaveAuthority,
        ) -> NativeResult<NativeHttpResponse> {
            Ok(NativeHttpResponse {
                status_code: 200,
                payload: client_v1_health_envelope(),
            })
        }

        async fn pairing_create(
            &self,
            _authority: &PinnedCaveAuthority,
            _request: Value,
        ) -> NativeResult<NativePairingCreated> {
            let create_number = self.creates.fetch_add(1, Ordering::SeqCst) + 1;
            if create_number == 1 {
                self.create_started.wait();
                self.create_release.wait();
            }
            Ok(NativePairingCreated {
                secret: format!("pairing-secret-{create_number}"),
                response: json!({ "requestId": format!("request-{create_number}") }),
            })
        }

        async fn pairing_poll(
            &self,
            _authority: &PinnedCaveAuthority,
            _request_id: &str,
            _secret: &str,
        ) -> NativeResult<Value> {
            Err(NativeDiagnostic::new("unused", false))
        }

        async fn pairing_exchange(
            &self,
            _authority: &PinnedCaveAuthority,
            _request_id: &str,
            _secret: &str,
        ) -> NativeResult<NativePairingExchange> {
            Err(NativeDiagnostic::new("unused", false))
        }

        async fn authenticated_read(
            &self,
            _authority: &PinnedCaveAuthority,
            _bearer: &str,
            _path: CaveReadPath,
        ) -> NativeResult<NativeHttpResponse> {
            Err(NativeDiagnostic::new("unused", false))
        }
    }

    struct FakeKeyring {
        credential: Mutex<Option<Credential>>,
        deletes: AtomicUsize,
    }

    impl CredentialCustody for FakeKeyring {
        fn read(&self, _instance_id: &str, origin: &str) -> Result<Credential, KeyringError> {
            self.credential
                .lock()
                .unwrap()
                .clone()
                .filter(|credential| credential.origin == origin)
                .ok_or(KeyringError::NotFound)
        }

        fn read_for_pairing_update(
            &self,
            _instance_id: &str,
            origin: &str,
        ) -> Result<CredentialSlot, KeyringError> {
            match self.credential.lock().unwrap().clone() {
                None => Ok(CredentialSlot::Missing),
                Some(credential) if credential.origin == origin => {
                    Ok(CredentialSlot::Current(credential))
                }
                Some(credential) => Ok(CredentialSlot::Stale(credential)),
            }
        }

        fn store_if_current(
            &self,
            _instance_id: &str,
            origin: &str,
            expected_credential: Option<&Credential>,
            bearer: &str,
            credential_id: &str,
        ) -> Result<bool, KeyringError> {
            let mut stored = self.credential.lock().unwrap();
            let matches_expected = match (stored.as_ref(), expected_credential) {
                (None, None) => true,
                (Some(current), Some(expected)) => {
                    current.origin == origin && current.is_same_identity(expected)
                }
                _ => false,
            };
            if !matches_expected {
                return Ok(false);
            }
            *stored = Some(Credential {
                bearer: bearer.to_owned(),
                credential_id: credential_id.to_owned(),
                origin: origin.to_owned(),
            });
            Ok(true)
        }

        fn replace_stale_if_current(
            &self,
            _instance_id: &str,
            origin: &str,
            expected_stale_credential: &Credential,
            bearer: &str,
            credential_id: &str,
        ) -> Result<bool, KeyringError> {
            let mut stored = self.credential.lock().unwrap();
            let matches_expected_stale = stored.as_ref().is_some_and(|current| {
                current.origin != origin && current.is_same_identity(expected_stale_credential)
            });
            if !matches_expected_stale {
                return Ok(false);
            }
            *stored = Some(Credential {
                bearer: bearer.to_owned(),
                credential_id: credential_id.to_owned(),
                origin: origin.to_owned(),
            });
            Ok(true)
        }

        fn delete_if_matches(
            &self,
            _instance_id: &str,
            origin: &str,
            expected_credential: &Credential,
        ) -> Result<bool, KeyringError> {
            self.deletes.fetch_add(1, Ordering::SeqCst);
            let mut stored = self.credential.lock().unwrap();
            let matches = stored.as_ref().is_some_and(|current| {
                current.origin == origin && current.is_same_identity(expected_credential)
            });
            if matches {
                *stored = None;
            }
            Ok(matches)
        }
    }

    fn install_pending_pairing(state: &NativeConnectionState, handle: &str, request_id: &str) {
        let mut runtime = state.runtime().unwrap();
        let (generation, authority, instance_id) = runtime.require_authorized(handle).unwrap();
        runtime.pairing = Some(PendingPairing {
            request_id: request_id.to_owned(),
            secret: "pairing-secret".to_owned(),
            authority,
            instance_id,
            generation,
            exchange_committed: false,
            poll_in_flight: false,
        });
    }

    struct FakeLauncher;

    impl CaveLauncher for FakeLauncher {
        fn launch(&self) -> NativeResult<Box<dyn CaveChild>> {
            Err(NativeDiagnostic::new("unused", false))
        }
    }

    struct ReadyChild;

    impl CaveChild for ReadyChild {
        fn try_wait(&mut self) -> NativeResult<bool> {
            Ok(false)
        }

        fn terminate(&mut self) -> NativeResult<()> {
            Ok(())
        }

        fn wait(&mut self) -> NativeResult<()> {
            Ok(())
        }
    }

    struct ReadyLauncher {
        launches: AtomicUsize,
    }

    impl CaveLauncher for ReadyLauncher {
        fn launch(&self) -> NativeResult<Box<dyn CaveChild>> {
            self.launches.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(ReadyChild))
        }
    }

    #[derive(Default)]
    struct TestLaunchClock(Mutex<Duration>);

    impl TestLaunchClock {
        fn advance(&self, duration: Duration) {
            *self.0.lock().unwrap() += duration;
        }
    }

    impl CaveClock for TestLaunchClock {
        fn now(&self) -> Duration {
            *self.0.lock().unwrap()
        }
    }

    struct TestSleeper {
        clock: Arc<TestLaunchClock>,
    }

    #[async_trait]
    impl CaveSleeper for TestSleeper {
        async fn sleep(&self, duration: Duration) {
            self.clock.advance(duration);
        }
    }

    struct InlineTaskRunner;

    impl CaveTaskRunner for InlineTaskRunner {
        fn execute(&self, task: Box<dyn FnOnce() + Send>) -> NativeResult<()> {
            task();
            Ok(())
        }
    }

    struct TestChild;

    impl CaveChild for TestChild {
        fn try_wait(&mut self) -> NativeResult<bool> {
            Ok(false)
        }

        fn terminate(&mut self) -> NativeResult<()> {
            Ok(())
        }

        fn wait(&mut self) -> NativeResult<()> {
            Ok(())
        }
    }

    struct DeadlineLauncher {
        clock: Arc<TestLaunchClock>,
        launch_duration: Duration,
        child: Mutex<Option<Box<dyn CaveChild>>>,
    }

    impl DeadlineLauncher {
        fn new(
            clock: Arc<TestLaunchClock>,
            launch_duration: Duration,
            child: Box<dyn CaveChild>,
        ) -> Self {
            Self {
                clock,
                launch_duration,
                child: Mutex::new(Some(child)),
            }
        }
    }

    impl CaveLauncher for DeadlineLauncher {
        fn launch(&self) -> NativeResult<Box<dyn CaveChild>> {
            self.clock.advance(self.launch_duration);
            self.child
                .lock()
                .unwrap()
                .take()
                .ok_or_else(|| NativeDiagnostic::new("cave_launch_failed", true))
        }
    }

    struct ImmediateHealth;

    #[async_trait]
    impl NativeCaveTransport for ImmediateHealth {
        async fn health(
            &self,
            _authority: &PinnedCaveAuthority,
        ) -> NativeResult<NativeHttpResponse> {
            Ok(NativeHttpResponse {
                status_code: 200,
                payload: client_v1_health_envelope(),
            })
        }

        async fn pairing_create(
            &self,
            _authority: &PinnedCaveAuthority,
            _request: Value,
        ) -> NativeResult<NativePairingCreated> {
            Err(NativeDiagnostic::new("unused", false))
        }

        async fn pairing_poll(
            &self,
            _authority: &PinnedCaveAuthority,
            _request_id: &str,
            _secret: &str,
        ) -> NativeResult<Value> {
            Err(NativeDiagnostic::new("unused", false))
        }

        async fn pairing_exchange(
            &self,
            _authority: &PinnedCaveAuthority,
            _request_id: &str,
            _secret: &str,
        ) -> NativeResult<NativePairingExchange> {
            Err(NativeDiagnostic::new("unused", false))
        }

        async fn authenticated_read(
            &self,
            _authority: &PinnedCaveAuthority,
            _bearer: &str,
            _path: CaveReadPath,
        ) -> NativeResult<NativeHttpResponse> {
            Err(NativeDiagnostic::new("unused", false))
        }
    }

    fn deadline_record() -> OwnerDiscoveryRecord {
        OwnerDiscoveryRecord {
            handle: String::new(),
            bytes: test_discovery_bytes("http://127.0.0.1:4310"),
            record: OwnerDiscoveryRecordMetadata {
                identity: "owner-local-discovery-record".to_owned(),
                device: 1,
                inode: 2,
                process_alive: true,
            },
        }
    }

    fn deadline_state(
        clock: Arc<TestLaunchClock>,
        transport: Arc<dyn NativeCaveTransport>,
        launcher: Arc<dyn CaveLauncher>,
        task_runner: Arc<dyn CaveTaskRunner>,
    ) -> NativeConnectionState {
        deadline_state_with_discovery(
            clock,
            transport,
            launcher,
            Arc::new(StaticDiscovery {
                record: deadline_record(),
            }),
            task_runner,
        )
    }

    fn deadline_state_with_discovery(
        clock: Arc<TestLaunchClock>,
        transport: Arc<dyn NativeCaveTransport>,
        launcher: Arc<dyn CaveLauncher>,
        discovery: Arc<dyn CaveDiscoveryReader>,
        task_runner: Arc<dyn CaveTaskRunner>,
    ) -> NativeConnectionState {
        NativeConnectionState::with_test_launch_collaborators(
            transport,
            Arc::new(FakeKeyring {
                credential: Mutex::new(None),
                deletes: AtomicUsize::new(0),
            }),
            discovery,
            launcher,
            clock.clone(),
            Arc::new(TestSleeper { clock }),
            task_runner,
        )
    }

    struct PollingDiscovery {
        clock: Arc<TestLaunchClock>,
        reads: AtomicUsize,
        read_duration: Duration,
    }

    impl CaveDiscoveryReader for PollingDiscovery {
        fn read(&self) -> NativeResult<OwnerDiscoveryRecord> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            self.clock.advance(self.read_duration);
            Err(NativeDiagnostic::new("cave_discovery_not_found", true))
        }
    }

    struct AdvancingDiscovery {
        clock: Arc<TestLaunchClock>,
        record: OwnerDiscoveryRecord,
        read_duration: Duration,
    }

    impl CaveDiscoveryReader for AdvancingDiscovery {
        fn read(&self) -> NativeResult<OwnerDiscoveryRecord> {
            self.clock.advance(self.read_duration);
            Ok(self.record.clone())
        }
    }

    struct PendingHealth;

    #[async_trait]
    impl NativeCaveTransport for PendingHealth {
        async fn health(
            &self,
            _authority: &PinnedCaveAuthority,
        ) -> NativeResult<NativeHttpResponse> {
            std::future::pending().await
        }

        async fn pairing_create(
            &self,
            _authority: &PinnedCaveAuthority,
            _request: Value,
        ) -> NativeResult<NativePairingCreated> {
            Err(NativeDiagnostic::new("unused", false))
        }

        async fn pairing_poll(
            &self,
            _authority: &PinnedCaveAuthority,
            _request_id: &str,
            _secret: &str,
        ) -> NativeResult<Value> {
            Err(NativeDiagnostic::new("unused", false))
        }

        async fn pairing_exchange(
            &self,
            _authority: &PinnedCaveAuthority,
            _request_id: &str,
            _secret: &str,
        ) -> NativeResult<NativePairingExchange> {
            Err(NativeDiagnostic::new("unused", false))
        }

        async fn authenticated_read(
            &self,
            _authority: &PinnedCaveAuthority,
            _bearer: &str,
            _path: CaveReadPath,
        ) -> NativeResult<NativeHttpResponse> {
            Err(NativeDiagnostic::new("unused", false))
        }
    }

    struct InlineThenThreadTaskRunner {
        inline_tasks: AtomicUsize,
    }

    impl CaveTaskRunner for InlineThenThreadTaskRunner {
        fn execute(&self, task: Box<dyn FnOnce() + Send>) -> NativeResult<()> {
            if self.inline_tasks.fetch_add(1, Ordering::SeqCst) < 2 {
                task();
                return Ok(());
            }
            std::thread::Builder::new()
                .spawn(task)
                .map(|_| ())
                .map_err(|_| NativeDiagnostic::new("service_unavailable", true))
        }
    }

    #[derive(Default)]
    struct BlockingChildState {
        terminated: AtomicUsize,
        reaped: AtomicUsize,
    }

    struct BlockingChild {
        state: Arc<BlockingChildState>,
        cleanup_started: Arc<Barrier>,
        cleanup_release: Arc<Barrier>,
    }

    impl CaveChild for BlockingChild {
        fn try_wait(&mut self) -> NativeResult<bool> {
            Ok(false)
        }

        fn terminate(&mut self) -> NativeResult<()> {
            self.state.terminated.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn wait(&mut self) -> NativeResult<()> {
            self.cleanup_started.wait();
            self.cleanup_release.wait();
            self.state.reaped.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    struct OneChildLauncher {
        child: Mutex<Option<Box<dyn CaveChild>>>,
    }

    impl CaveLauncher for OneChildLauncher {
        fn launch(&self) -> NativeResult<Box<dyn CaveChild>> {
            self.child
                .lock()
                .unwrap()
                .take()
                .ok_or_else(|| NativeDiagnostic::new("cave_launch_failed", true))
        }
    }

    #[test]
    fn launch_deadline_begins_before_reservation_and_spawn() {
        let clock = Arc::new(TestLaunchClock::default());
        let launcher = Arc::new(DeadlineLauncher::new(
            clock.clone(),
            Duration::from_secs(30),
            Box::new(TestChild),
        ));
        let state = deadline_state(
            clock.clone(),
            Arc::new(ImmediateHealth),
            launcher,
            Arc::new(InlineTaskRunner),
        );

        let error = tauri::async_runtime::block_on(state.cave_launch()).unwrap_err();

        assert_eq!(error.code, "service_unavailable");
        assert_eq!(clock.now(), Duration::from_secs(30));
    }

    #[test]
    fn readiness_polling_and_backoff_stop_at_the_absolute_deadline() {
        let clock = Arc::new(TestLaunchClock::default());
        let discovery = Arc::new(PollingDiscovery {
            clock: clock.clone(),
            reads: AtomicUsize::new(0),
            read_duration: Duration::ZERO,
        });
        let state = deadline_state_with_discovery(
            clock.clone(),
            Arc::new(ImmediateHealth),
            Arc::new(ReadyLauncher {
                launches: AtomicUsize::new(0),
            }),
            discovery.clone(),
            Arc::new(InlineTaskRunner),
        );

        let error = tauri::async_runtime::block_on(state.cave_launch()).unwrap_err();

        assert_eq!(error.code, "service_unavailable");
        assert_eq!(clock.now(), Duration::from_secs(30));
        assert!(discovery.reads.load(Ordering::SeqCst) > 1);
    }

    #[test]
    fn hanging_health_cannot_extend_the_launch_attempt() {
        let clock = Arc::new(TestLaunchClock::default());
        let state = deadline_state(
            clock.clone(),
            Arc::new(PendingHealth),
            Arc::new(ReadyLauncher {
                launches: AtomicUsize::new(0),
            }),
            Arc::new(InlineTaskRunner),
        );
        let prelaunch_handle = state.cave_read_discovery().unwrap().handle;

        let error = tauri::async_runtime::block_on(state.cave_launch()).unwrap_err();

        assert_eq!(error.code, "service_unavailable");
        assert_eq!(clock.now(), Duration::from_secs(30));
        assert_eq!(
            tauri::async_runtime::block_on(state.cave_health(prelaunch_handle))
                .unwrap_err()
                .code,
            "invalid_discovery_handle"
        );
    }

    #[test]
    fn blocking_child_cleanup_is_transferred_without_extending_the_deadline() {
        let clock = Arc::new(TestLaunchClock::default());
        let cleanup_started = Arc::new(Barrier::new(2));
        let cleanup_release = Arc::new(Barrier::new(2));
        let child_state = Arc::new(BlockingChildState::default());
        let state = deadline_state(
            clock.clone(),
            Arc::new(PendingHealth),
            Arc::new(OneChildLauncher {
                child: Mutex::new(Some(Box::new(BlockingChild {
                    state: child_state.clone(),
                    cleanup_started: cleanup_started.clone(),
                    cleanup_release: cleanup_release.clone(),
                }))),
            }),
            Arc::new(InlineThenThreadTaskRunner {
                inline_tasks: AtomicUsize::new(0),
            }),
        );

        let error = tauri::async_runtime::block_on(state.cave_launch()).unwrap_err();

        assert_eq!(error.code, "service_unavailable");
        assert_eq!(clock.now(), Duration::from_secs(30));
        cleanup_started.wait();
        assert_eq!(child_state.terminated.load(Ordering::SeqCst), 1);
        cleanup_release.wait();
        for _ in 0..1_000 {
            if child_state.reaped.load(Ordering::SeqCst) == 1 {
                break;
            }
            std::thread::yield_now();
        }
        assert_eq!(child_state.reaped.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn launch_succeeds_just_inside_the_absolute_deadline() {
        let clock = Arc::new(TestLaunchClock::default());
        let state = deadline_state(
            clock.clone(),
            Arc::new(ImmediateHealth),
            Arc::new(DeadlineLauncher::new(
                clock.clone(),
                Duration::from_secs(29),
                Box::new(TestChild),
            )),
            Arc::new(InlineTaskRunner),
        );

        tauri::async_runtime::block_on(state.cave_launch()).unwrap();

        assert_eq!(clock.now(), Duration::from_secs(29));
    }

    #[test]
    fn synthetic_elapsed_time_stays_within_one_budget_across_launch_phases() {
        let clock = Arc::new(TestLaunchClock::default());
        let state = deadline_state_with_discovery(
            clock.clone(),
            Arc::new(ImmediateHealth),
            Arc::new(DeadlineLauncher::new(
                clock.clone(),
                Duration::from_secs(10),
                Box::new(TestChild),
            )),
            Arc::new(AdvancingDiscovery {
                clock: clock.clone(),
                record: deadline_record(),
                read_duration: Duration::from_secs(5),
            }),
            Arc::new(InlineTaskRunner),
        );

        tauri::async_runtime::block_on(state.cave_launch()).unwrap();

        assert_eq!(clock.now(), Duration::from_secs(20));
        assert!(clock.now() <= LAUNCH_READINESS_DEADLINE);
    }

    #[test]
    fn superseded_launch_cannot_publish_readiness() {
        let record = deadline_record();
        let health_started = Arc::new(Barrier::new(2));
        let health_release = Arc::new(Barrier::new(2));
        let state = NativeConnectionState::with_test_collaborators(
            Arc::new(FakeTransport {
                health_started: Some(health_started.clone()),
                health_release: Some(health_release.clone()),
                ..FakeTransport::default()
            }),
            Arc::new(FakeKeyring {
                credential: Mutex::new(None),
                deletes: AtomicUsize::new(0),
            }),
            Arc::new(StaticDiscovery { record }),
            Arc::new(ReadyLauncher {
                launches: AtomicUsize::new(0),
            }),
        );
        let launch_state = state.clone();
        let completion =
            std::thread::spawn(move || tauri::async_runtime::block_on(launch_state.cave_launch()));

        health_started.wait();
        let replacement_handle = state.cave_read_discovery().unwrap().handle;
        health_release.wait();

        assert_eq!(
            completion.join().unwrap().unwrap_err().code,
            "stale_connection_attempt"
        );
        let runtime = state.runtime().unwrap();
        assert_eq!(
            runtime.authority_handle.as_deref(),
            Some(replacement_handle.as_str())
        );
        assert!(runtime.instance_id.is_none());
    }

    #[test]
    fn first_and_unrediscovered_repeat_401_preserve_the_stored_credential() {
        let keyring = Arc::new(FakeKeyring {
            credential: Mutex::new(Some(Credential {
                bearer: "native-only-bearer".to_owned(),
                credential_id: "credential-a".to_owned(),
                origin: "http://127.0.0.1:4310/".to_owned(),
            })),
            deletes: AtomicUsize::new(0),
        });
        let record = OwnerDiscoveryRecord {
            handle: String::new(),
            bytes: test_discovery_bytes("http://127.0.0.1:4310"),
            record: OwnerDiscoveryRecordMetadata {
                identity: "owner-local-discovery-record".to_owned(),
                device: 1,
                inode: 2,
                process_alive: true,
            },
        };
        let state = NativeConnectionState::with_test_collaborators(
            Arc::new(FakeTransport::default()),
            keyring.clone(),
            Arc::new(StaticDiscovery { record }),
            Arc::new(FakeLauncher),
        );
        let handle = state.cave_read_discovery().unwrap().handle;
        tauri::async_runtime::block_on(state.cave_health(handle.clone())).unwrap();

        let first =
            tauri::async_runtime::block_on(state.cave_credential_status(handle.clone())).unwrap();
        let repeated =
            tauri::async_runtime::block_on(state.cave_credential_status(handle)).unwrap();

        assert_eq!(first["status"], "disconnected");
        assert_eq!(repeated["status"], "disconnected");
        assert_eq!(keyring.deletes.load(Ordering::SeqCst), 0);
        assert!(keyring.credential.lock().unwrap().is_some());
    }

    #[test]
    fn confirmed_rediscovery_allows_only_the_matching_credential_to_be_deleted() {
        let keyring = Arc::new(FakeKeyring {
            credential: Mutex::new(Some(Credential {
                bearer: "native-only-bearer".to_owned(),
                credential_id: "credential-a".to_owned(),
                origin: "http://127.0.0.1:4310/".to_owned(),
            })),
            deletes: AtomicUsize::new(0),
        });
        let record = OwnerDiscoveryRecord {
            handle: String::new(),
            bytes: test_discovery_bytes("http://127.0.0.1:4310"),
            record: OwnerDiscoveryRecordMetadata {
                identity: "owner-local-discovery-record".to_owned(),
                device: 1,
                inode: 2,
                process_alive: true,
            },
        };
        let state = NativeConnectionState::with_test_collaborators(
            Arc::new(FakeTransport::default()),
            keyring.clone(),
            Arc::new(StaticDiscovery { record }),
            Arc::new(FakeLauncher),
        );

        let handle = state.cave_read_discovery().unwrap().handle;
        tauri::async_runtime::block_on(state.cave_health(handle.clone())).unwrap();
        tauri::async_runtime::block_on(state.cave_credential_status(handle)).unwrap();
        state
            .runtime()
            .unwrap()
            .unauthorized
            .identity
            .as_mut()
            .unwrap()
            .first_unauthorized_at = Instant::now() - Duration::from_millis(500);

        let handle = state.cave_read_discovery().unwrap().handle;
        tauri::async_runtime::block_on(state.cave_health(handle.clone())).unwrap();
        let confirmed =
            tauri::async_runtime::block_on(state.cave_credential_status(handle)).unwrap();

        assert_eq!(
            confirmed,
            json!({
                "status": "revoked",
                "health": client_v1_health_envelope(),
            })
        );
        assert_eq!(keyring.deletes.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn managed_credential_status_uses_only_sdk_discriminated_shapes() {
        let record = OwnerDiscoveryRecord {
            handle: String::new(),
            bytes: test_discovery_bytes("http://127.0.0.1:4310"),
            record: OwnerDiscoveryRecordMetadata {
                identity: "owner-local-discovery-record".to_owned(),
                device: 1,
                inode: 2,
                process_alive: true,
            },
        };

        let missing = NativeConnectionState::with_test_collaborators(
            Arc::new(FakeTransport::default()),
            Arc::new(FakeKeyring {
                credential: Mutex::new(None),
                deletes: AtomicUsize::new(0),
            }),
            Arc::new(StaticDiscovery {
                record: record.clone(),
            }),
            Arc::new(FakeLauncher),
        );
        let missing_handle = missing.cave_read_discovery().unwrap().handle;
        tauri::async_runtime::block_on(missing.cave_health(missing_handle.clone())).unwrap();
        assert_eq!(
            tauri::async_runtime::block_on(missing.cave_credential_status(missing_handle)).unwrap(),
            json!({ "status": "missing" })
        );

        for (read_status, access) in [
            (200, "chat:read"),
            (403, "scope_denied"),
            (429, "rate_limited"),
            (500, "service_unavailable"),
        ] {
            let state = NativeConnectionState::with_test_collaborators(
                Arc::new(FakeTransport {
                    read_status,
                    ..FakeTransport::default()
                }),
                Arc::new(FakeKeyring {
                    credential: Mutex::new(Some(Credential {
                        bearer: "native-only-bearer".to_owned(),
                        credential_id: "credential-a".to_owned(),
                        origin: "http://127.0.0.1:4310/".to_owned(),
                    })),
                    deletes: AtomicUsize::new(0),
                }),
                Arc::new(StaticDiscovery {
                    record: record.clone(),
                }),
                Arc::new(FakeLauncher),
            );
            let handle = state.cave_read_discovery().unwrap().handle;
            tauri::async_runtime::block_on(state.cave_health(handle.clone())).unwrap();

            assert_eq!(
                tauri::async_runtime::block_on(state.cave_credential_status(handle)).unwrap(),
                json!({
                    "status": "valid",
                    "access": access,
                    "health": client_v1_health_envelope(),
                })
            );
        }
    }

    #[test]
    fn stale_status_health_cannot_publish_after_discovery_record_replacement() {
        let record = OwnerDiscoveryRecord {
            handle: String::new(),
            bytes: test_discovery_bytes("http://127.0.0.1:4310"),
            record: OwnerDiscoveryRecordMetadata {
                identity: "owner-local-discovery-record".to_owned(),
                device: 1,
                inode: 2,
                process_alive: true,
            },
        };
        let discovery = Arc::new(MutableDiscovery {
            record: Mutex::new(record),
        });
        let final_health_started = Arc::new(Barrier::new(2));
        let final_health_release = Arc::new(Barrier::new(2));
        let state = NativeConnectionState::with_test_collaborators(
            Arc::new(StatusRaceTransport {
                health_calls: AtomicUsize::new(0),
                final_health_started: Some(final_health_started.clone()),
                final_health_release: Some(final_health_release.clone()),
                read_started: None,
                read_release: None,
                read_status: 200,
            }),
            Arc::new(FakeKeyring {
                credential: Mutex::new(Some(Credential {
                    bearer: "native-only-bearer".to_owned(),
                    credential_id: "credential-a".to_owned(),
                    origin: "http://127.0.0.1:4310/".to_owned(),
                })),
                deletes: AtomicUsize::new(0),
            }),
            discovery.clone(),
            Arc::new(FakeLauncher),
        );
        let handle = state.cave_read_discovery().unwrap().handle;
        tauri::async_runtime::block_on(state.cave_health(handle.clone())).unwrap();

        let status_state = state.clone();
        let status_handle = handle.clone();
        let completion = std::thread::spawn(move || {
            tauri::async_runtime::block_on(status_state.cave_credential_status(status_handle))
        });
        final_health_started.wait();
        let mut replacement = discovery.record.lock().unwrap();
        replacement.bytes = test_discovery_bytes("http://127.0.0.1:4311");
        replacement.record.inode = 3;
        drop(replacement);
        final_health_release.wait();

        assert_eq!(
            completion.join().unwrap().unwrap_err().code,
            "stale_discovery_handle"
        );
    }

    #[test]
    fn stale_status_health_cannot_publish_after_credential_replacement() {
        let record = OwnerDiscoveryRecord {
            handle: String::new(),
            bytes: test_discovery_bytes("http://127.0.0.1:4310"),
            record: OwnerDiscoveryRecordMetadata {
                identity: "owner-local-discovery-record".to_owned(),
                device: 1,
                inode: 2,
                process_alive: true,
            },
        };
        let keyring = Arc::new(FakeKeyring {
            credential: Mutex::new(Some(Credential {
                bearer: "native-only-bearer".to_owned(),
                credential_id: "credential-a".to_owned(),
                origin: "http://127.0.0.1:4310/".to_owned(),
            })),
            deletes: AtomicUsize::new(0),
        });
        let final_health_started = Arc::new(Barrier::new(2));
        let final_health_release = Arc::new(Barrier::new(2));
        let state = NativeConnectionState::with_test_collaborators(
            Arc::new(StatusRaceTransport {
                health_calls: AtomicUsize::new(0),
                final_health_started: Some(final_health_started.clone()),
                final_health_release: Some(final_health_release.clone()),
                read_started: None,
                read_release: None,
                read_status: 200,
            }),
            keyring.clone(),
            Arc::new(StaticDiscovery { record }),
            Arc::new(FakeLauncher),
        );
        let handle = state.cave_read_discovery().unwrap().handle;
        tauri::async_runtime::block_on(state.cave_health(handle.clone())).unwrap();

        let status_state = state.clone();
        let completion = std::thread::spawn(move || {
            tauri::async_runtime::block_on(status_state.cave_credential_status(handle))
        });
        final_health_started.wait();
        *keyring.credential.lock().unwrap() = Some(Credential {
            bearer: "newer-native-only-bearer".to_owned(),
            credential_id: "credential-b".to_owned(),
            origin: "http://127.0.0.1:4310/".to_owned(),
        });
        final_health_release.wait();

        assert_eq!(
            completion.join().unwrap().unwrap(),
            json!({
                "status": "disconnected",
                "reason": "credential_update_in_progress",
            })
        );
    }

    #[test]
    fn stale_pairing_exchange_cannot_publish_over_a_newer_generation_credential() {
        let keyring = Arc::new(FakeKeyring {
            credential: Mutex::new(None),
            deletes: AtomicUsize::new(0),
        });
        let old_exchange_started = Arc::new(Barrier::new(2));
        let old_exchange_release = Arc::new(Barrier::new(2));
        let discovery = Arc::new(MutableDiscovery {
            record: Mutex::new(deadline_record()),
        });
        let state = NativeConnectionState::with_test_collaborators(
            Arc::new(ExchangeRaceTransport {
                old_exchange_started: old_exchange_started.clone(),
                old_exchange_release: old_exchange_release.clone(),
            }),
            keyring.clone(),
            discovery.clone(),
            Arc::new(FakeLauncher),
        );
        let old_handle = state.cave_read_discovery().unwrap().handle;
        tauri::async_runtime::block_on(state.cave_health(old_handle.clone())).unwrap();
        install_pending_pairing(&state, &old_handle, "old-request");

        let old_state = state.clone();
        let old_completion = std::thread::spawn(move || {
            tauri::async_runtime::block_on(
                old_state.cave_pairing_exchange(old_handle, "old-request".to_owned()),
            )
        });
        old_exchange_started.wait();

        let mut replacement = discovery.record.lock().unwrap();
        replacement.bytes = test_discovery_bytes("http://127.0.0.1:4311");
        replacement.record.inode = 3;
        drop(replacement);
        let new_handle = state.cave_read_discovery().unwrap().handle;
        tauri::async_runtime::block_on(state.cave_health(new_handle.clone())).unwrap();
        install_pending_pairing(&state, &new_handle, "new-request");
        assert_eq!(
            tauri::async_runtime::block_on(
                state.cave_pairing_exchange(new_handle, "new-request".to_owned())
            )
            .unwrap(),
            json!({ "status": "paired" })
        );

        old_exchange_release.wait();

        assert_eq!(
            old_completion.join().unwrap().unwrap_err().code,
            "stale_connection_attempt"
        );
        let stored = keyring.credential.lock().unwrap();
        let stored = stored.as_ref().unwrap();
        assert_eq!(stored.credential_id, "credential-new");
        assert_eq!(stored.bearer, "new-bearer");
        assert_eq!(stored.origin, "http://127.0.0.1:4311/");
    }

    #[test]
    fn reset_invalidates_the_current_handle_and_fails_closed_when_repeated_or_stale() {
        let state = NativeConnectionState::with_test_collaborators(
            Arc::new(FakeTransport::default()),
            Arc::new(FakeKeyring {
                credential: Mutex::new(None),
                deletes: AtomicUsize::new(0),
            }),
            Arc::new(StaticDiscovery {
                record: deadline_record(),
            }),
            Arc::new(FakeLauncher),
        );
        let handle = state.cave_read_discovery().unwrap().handle;
        tauri::async_runtime::block_on(state.cave_health(handle.clone())).unwrap();
        install_pending_pairing(&state, &handle, "old-request");

        assert_eq!(
            state.cave_reset_pairing(handle.clone()).unwrap(),
            json!({ "status": "invalidated" })
        );
        assert_eq!(
            state.cave_reset_pairing(handle.clone()).unwrap_err().code,
            "invalid_discovery_handle"
        );
        let new_handle = state.cave_read_discovery().unwrap().handle;
        tauri::async_runtime::block_on(state.cave_health(new_handle.clone())).unwrap();
        install_pending_pairing(&state, &new_handle, "new-request");
        assert_eq!(
            state.cave_reset_pairing(handle).unwrap_err().code,
            "invalid_discovery_handle"
        );
        assert_eq!(
            state
                .runtime()
                .unwrap()
                .pairing
                .as_ref()
                .unwrap()
                .request_id,
            "new-request"
        );
    }

    #[test]
    fn cancelling_pairing_create_releases_only_its_own_in_flight_reservation() {
        let started = Arc::new(Notify::new());
        let state = NativeConnectionState::with_test_collaborators(
            Arc::new(CancellationCreateTransport {
                creates: AtomicUsize::new(0),
                started: Arc::clone(&started),
            }),
            Arc::new(FakeKeyring {
                credential: Mutex::new(None),
                deletes: AtomicUsize::new(0),
            }),
            Arc::new(StaticDiscovery {
                record: deadline_record(),
            }),
            Arc::new(FakeLauncher),
        );
        let handle = state.cave_read_discovery().unwrap().handle;
        tauri::async_runtime::block_on(state.cave_health(handle.clone())).unwrap();
        let runner = state.clone();
        let operation_state = runner.clone();
        let operation_handle = handle.clone();
        let operation = std::thread::spawn(move || {
            tauri::async_runtime::block_on(
                runner.run_operation(
                    NativeOperationInput::new(
                        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_owned(),
                        1_000,
                    )
                    .unwrap(),
                    async move {
                        operation_state
                            .cave_pairing_create(operation_handle, pairing_request())
                            .await
                    },
                ),
            )
        });
        tauri::async_runtime::block_on(started.notified());

        assert_eq!(
            state
                .cancel_operation(
                    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_owned(),
                    NativeCancelReason::Aborted,
                )
                .unwrap()
                .status,
            "cancelled"
        );
        assert_eq!(
            operation.join().unwrap(),
            Err(NativeDiagnostic::new("aborted", false))
        );
        assert!(tauri::async_runtime::block_on(
            state.cave_pairing_create(handle, pairing_request())
        )
        .is_ok());
    }

    #[test]
    fn cancelling_pairing_poll_releases_only_its_own_poll_reservation() {
        let started = Arc::new(Notify::new());
        let state = NativeConnectionState::with_test_collaborators(
            Arc::new(CancellationPollTransport {
                polls: AtomicUsize::new(0),
                started: Arc::clone(&started),
            }),
            Arc::new(FakeKeyring {
                credential: Mutex::new(None),
                deletes: AtomicUsize::new(0),
            }),
            Arc::new(StaticDiscovery {
                record: deadline_record(),
            }),
            Arc::new(FakeLauncher),
        );
        let handle = state.cave_read_discovery().unwrap().handle;
        tauri::async_runtime::block_on(state.cave_health(handle.clone())).unwrap();
        let request_id = "11111111-1111-4111-8111-111111111111";
        install_pending_pairing(&state, &handle, request_id);
        let runner = state.clone();
        let operation_state = runner.clone();
        let operation_handle = handle.clone();
        let operation = std::thread::spawn(move || {
            tauri::async_runtime::block_on(
                runner.run_operation(
                    NativeOperationInput::new(
                        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_owned(),
                        1_000,
                    )
                    .unwrap(),
                    async move {
                        operation_state
                            .cave_pairing_poll(operation_handle, request_id.to_owned())
                            .await
                    },
                ),
            )
        });
        tauri::async_runtime::block_on(started.notified());

        state
            .cancel_operation(
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_owned(),
                NativeCancelReason::Aborted,
            )
            .unwrap();
        assert_eq!(
            operation.join().unwrap(),
            Err(NativeDiagnostic::new("aborted", false))
        );
        assert!(tauri::async_runtime::block_on(
            state.cave_pairing_poll(handle, request_id.to_owned())
        )
        .is_ok());
    }

    #[test]
    fn cancelling_credential_status_releases_only_its_own_revocation_reservation() {
        let started = Arc::new(Notify::new());
        let state = NativeConnectionState::with_test_collaborators(
            Arc::new(CancellationStatusTransport {
                reads: AtomicUsize::new(0),
                started: Arc::clone(&started),
            }),
            Arc::new(FakeKeyring {
                credential: Mutex::new(Some(Credential {
                    bearer: "native-only-bearer".to_owned(),
                    credential_id: "credential-a".to_owned(),
                    origin: "http://127.0.0.1:4310/".to_owned(),
                })),
                deletes: AtomicUsize::new(0),
            }),
            Arc::new(StaticDiscovery {
                record: deadline_record(),
            }),
            Arc::new(FakeLauncher),
        );
        let handle = state.cave_read_discovery().unwrap().handle;
        tauri::async_runtime::block_on(state.cave_health(handle.clone())).unwrap();
        let runner = state.clone();
        let operation_state = runner.clone();
        let operation_handle = handle.clone();
        let operation = std::thread::spawn(move || {
            tauri::async_runtime::block_on(
                runner.run_operation(
                    NativeOperationInput::new(
                        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_owned(),
                        1_000,
                    )
                    .unwrap(),
                    async move {
                        operation_state
                            .cave_credential_status(operation_handle)
                            .await
                    },
                ),
            )
        });
        tauri::async_runtime::block_on(started.notified());

        state
            .cancel_operation(
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_owned(),
                NativeCancelReason::Aborted,
            )
            .unwrap();
        assert_eq!(
            operation.join().unwrap(),
            Err(NativeDiagnostic::new("aborted", false))
        );
        assert_eq!(
            tauri::async_runtime::block_on(state.cave_credential_status(handle)).unwrap()["status"],
            "valid"
        );
    }

    #[test]
    fn reset_during_create_prevents_late_creation_and_allows_a_fresh_pairing() {
        let create_started = Arc::new(Barrier::new(2));
        let create_release = Arc::new(Barrier::new(2));
        let state = NativeConnectionState::with_test_collaborators(
            Arc::new(ResetCreateRaceTransport {
                creates: AtomicUsize::new(0),
                create_started: create_started.clone(),
                create_release: create_release.clone(),
            }),
            Arc::new(FakeKeyring {
                credential: Mutex::new(None),
                deletes: AtomicUsize::new(0),
            }),
            Arc::new(StaticDiscovery {
                record: deadline_record(),
            }),
            Arc::new(FakeLauncher),
        );
        let handle = state.cave_read_discovery().unwrap().handle;
        tauri::async_runtime::block_on(state.cave_health(handle.clone())).unwrap();

        let create_state = state.clone();
        let create_handle = handle.clone();
        let create = std::thread::spawn(move || {
            tauri::async_runtime::block_on(
                create_state.cave_pairing_create(create_handle, pairing_request()),
            )
        });
        create_started.wait();

        assert_eq!(
            state.cave_reset_pairing(handle).unwrap(),
            json!({ "status": "invalidated" })
        );
        create_release.wait();
        assert_eq!(
            create.join().unwrap().unwrap_err().code,
            "stale_connection_attempt"
        );

        let fresh_handle = state.cave_read_discovery().unwrap().handle;
        tauri::async_runtime::block_on(state.cave_health(fresh_handle.clone())).unwrap();
        assert_eq!(
            tauri::async_runtime::block_on(
                state.cave_pairing_create(fresh_handle, pairing_request()),
            )
            .unwrap(),
            json!({ "requestId": "request-2" })
        );
    }

    #[test]
    fn reset_unblocks_a_new_pairing_while_the_old_poll_is_in_flight() {
        let poll_started = Arc::new(Barrier::new(2));
        let poll_release = Arc::new(Barrier::new(2));
        let state = NativeConnectionState::with_test_collaborators(
            Arc::new(CancellationPollRaceTransport {
                creates: AtomicUsize::new(0),
                poll_started: poll_started.clone(),
                poll_release: poll_release.clone(),
            }),
            Arc::new(FakeKeyring {
                credential: Mutex::new(None),
                deletes: AtomicUsize::new(0),
            }),
            Arc::new(StaticDiscovery {
                record: deadline_record(),
            }),
            Arc::new(FakeLauncher),
        );
        let handle = state.cave_read_discovery().unwrap().handle;
        tauri::async_runtime::block_on(state.cave_health(handle.clone())).unwrap();
        assert_eq!(
            tauri::async_runtime::block_on(
                state.cave_pairing_create(handle.clone(), pairing_request()),
            )
            .unwrap(),
            json!({ "requestId": "request-1" })
        );

        let poll_state = state.clone();
        let poll_handle = handle.clone();
        let poll = std::thread::spawn(move || {
            tauri::async_runtime::block_on(
                poll_state.cave_pairing_poll(poll_handle, "request-1".to_owned()),
            )
        });
        poll_started.wait();

        assert_eq!(
            state.cave_reset_pairing(handle.clone()).unwrap(),
            json!({ "status": "invalidated" })
        );
        let new_handle = state.cave_read_discovery().unwrap().handle;
        tauri::async_runtime::block_on(state.cave_health(new_handle.clone())).unwrap();
        assert_eq!(
            tauri::async_runtime::block_on(
                state.cave_pairing_create(new_handle, pairing_request()),
            )
            .unwrap(),
            json!({ "requestId": "request-2" })
        );

        poll_release.wait();
        assert_eq!(
            poll.join().unwrap().unwrap_err().code,
            "stale_connection_attempt"
        );
        assert_eq!(
            state
                .runtime()
                .unwrap()
                .pairing
                .as_ref()
                .unwrap()
                .request_id,
            "request-2"
        );
    }

    #[test]
    fn reset_prevents_an_in_flight_exchange_from_persisting() {
        let keyring = Arc::new(FakeKeyring {
            credential: Mutex::new(None),
            deletes: AtomicUsize::new(0),
        });
        let exchange_started = Arc::new(Barrier::new(2));
        let exchange_release = Arc::new(Barrier::new(2));
        let state = NativeConnectionState::with_test_collaborators(
            Arc::new(ExchangeRaceTransport {
                old_exchange_started: exchange_started.clone(),
                old_exchange_release: exchange_release.clone(),
            }),
            keyring.clone(),
            Arc::new(StaticDiscovery {
                record: deadline_record(),
            }),
            Arc::new(FakeLauncher),
        );
        let handle = state.cave_read_discovery().unwrap().handle;
        tauri::async_runtime::block_on(state.cave_health(handle.clone())).unwrap();
        install_pending_pairing(&state, &handle, "old-request");

        let exchange_state = state.clone();
        let exchange = std::thread::spawn(move || {
            tauri::async_runtime::block_on(
                exchange_state.cave_pairing_exchange(handle.clone(), "old-request".to_owned()),
            )
        });
        exchange_started.wait();
        let reset_handle = state.runtime().unwrap().authority_handle.clone().unwrap();
        assert_eq!(
            state.cave_reset_pairing(reset_handle).unwrap(),
            json!({ "status": "invalidated" })
        );
        exchange_release.wait();

        assert_eq!(
            exchange.join().unwrap().unwrap_err().code,
            "stale_connection_attempt"
        );
        assert!(keyring.credential.lock().unwrap().is_none());
    }

    #[test]
    fn pairing_relocates_an_old_origin_credential_after_revalidating_current_authority() {
        let keyring = Arc::new(FakeKeyring {
            credential: Mutex::new(Some(Credential {
                bearer: "old-bearer".to_owned(),
                credential_id: "credential-old".to_owned(),
                origin: "http://127.0.0.1:4310/".to_owned(),
            })),
            deletes: AtomicUsize::new(0),
        });
        let mut record = deadline_record();
        record.bytes = test_discovery_bytes("http://127.0.0.1:4311");
        record.record.inode = 3;
        let state = NativeConnectionState::with_test_collaborators(
            Arc::new(ExchangeRaceTransport {
                old_exchange_started: Arc::new(Barrier::new(1)),
                old_exchange_release: Arc::new(Barrier::new(1)),
            }),
            keyring.clone(),
            Arc::new(StaticDiscovery { record }),
            Arc::new(FakeLauncher),
        );
        let handle = state.cave_read_discovery().unwrap().handle;
        tauri::async_runtime::block_on(state.cave_health(handle.clone())).unwrap();
        install_pending_pairing(&state, &handle, "new-request");

        assert_eq!(
            tauri::async_runtime::block_on(
                state.cave_pairing_exchange(handle, "new-request".to_owned())
            )
            .unwrap(),
            json!({ "status": "paired" })
        );
        let stored = keyring.credential.lock().unwrap();
        let stored = stored.as_ref().unwrap();
        assert_eq!(stored.origin, "http://127.0.0.1:4311/");
        assert_eq!(stored.credential_id, "credential-new");
    }

    #[test]
    fn stale_origin_pairing_cannot_replace_a_newer_different_origin_credential() {
        let keyring = Arc::new(FakeKeyring {
            credential: Mutex::new(Some(Credential {
                bearer: "stale-bearer".to_owned(),
                credential_id: "credential-stale".to_owned(),
                origin: "http://127.0.0.1:4310/".to_owned(),
            })),
            deletes: AtomicUsize::new(0),
        });
        let mut record = deadline_record();
        record.bytes = test_discovery_bytes("http://127.0.0.1:4311");
        record.record.inode = 3;
        let exchange_started = Arc::new(Barrier::new(2));
        let exchange_release = Arc::new(Barrier::new(2));
        let state = NativeConnectionState::with_test_collaborators(
            Arc::new(ExchangeRaceTransport {
                old_exchange_started: exchange_started.clone(),
                old_exchange_release: exchange_release.clone(),
            }),
            keyring.clone(),
            Arc::new(StaticDiscovery { record }),
            Arc::new(FakeLauncher),
        );
        let handle = state.cave_read_discovery().unwrap().handle;
        tauri::async_runtime::block_on(state.cave_health(handle.clone())).unwrap();
        install_pending_pairing(&state, &handle, "old-request");

        let o1_state = state.clone();
        let o1 = std::thread::spawn(move || {
            tauri::async_runtime::block_on(
                o1_state.cave_pairing_exchange(handle, "old-request".to_owned()),
            )
        });
        exchange_started.wait();
        *keyring.credential.lock().unwrap() = Some(Credential {
            bearer: "o2-bearer".to_owned(),
            credential_id: "credential-o2".to_owned(),
            origin: "http://127.0.0.1:4312/".to_owned(),
        });
        exchange_release.wait();

        assert_eq!(
            o1.join().unwrap().unwrap_err().code,
            "credential_update_in_progress"
        );
        let stored = keyring.credential.lock().unwrap();
        let stored = stored.as_ref().unwrap();
        assert_eq!(stored.origin, "http://127.0.0.1:4312/");
        assert_eq!(stored.credential_id, "credential-o2");
        assert_eq!(stored.bearer, "o2-bearer");
    }

    #[test]
    fn pairing_does_not_overwrite_an_unexpected_current_origin_credential() {
        let keyring = Arc::new(FakeKeyring {
            credential: Mutex::new(Some(Credential {
                bearer: "old-bearer".to_owned(),
                credential_id: "credential-old".to_owned(),
                origin: "http://127.0.0.1:4310/".to_owned(),
            })),
            deletes: AtomicUsize::new(0),
        });
        let exchange_started = Arc::new(Barrier::new(2));
        let exchange_release = Arc::new(Barrier::new(2));
        let state = NativeConnectionState::with_test_collaborators(
            Arc::new(ExchangeRaceTransport {
                old_exchange_started: exchange_started.clone(),
                old_exchange_release: exchange_release.clone(),
            }),
            keyring.clone(),
            Arc::new(StaticDiscovery {
                record: deadline_record(),
            }),
            Arc::new(FakeLauncher),
        );
        let handle = state.cave_read_discovery().unwrap().handle;
        tauri::async_runtime::block_on(state.cave_health(handle.clone())).unwrap();
        install_pending_pairing(&state, &handle, "old-request");

        let pairing_state = state.clone();
        let pairing = std::thread::spawn(move || {
            tauri::async_runtime::block_on(
                pairing_state.cave_pairing_exchange(handle, "old-request".to_owned()),
            )
        });
        exchange_started.wait();
        *keyring.credential.lock().unwrap() = Some(Credential {
            bearer: "newer-bearer".to_owned(),
            credential_id: "credential-newer".to_owned(),
            origin: "http://127.0.0.1:4310/".to_owned(),
        });
        exchange_release.wait();
        assert_eq!(
            pairing.join().unwrap().unwrap_err().code,
            "credential_update_in_progress"
        );
        let stored = keyring.credential.lock().unwrap();
        let stored = stored.as_ref().unwrap();
        assert_eq!(stored.credential_id, "credential-newer");
        assert_eq!(stored.bearer, "newer-bearer");
    }

    #[test]
    fn stale_relocation_never_replaces_a_current_origin_credential() {
        let keyring = FakeKeyring {
            credential: Mutex::new(Some(Credential {
                bearer: "newer-bearer".to_owned(),
                credential_id: "credential-newer".to_owned(),
                origin: "http://127.0.0.1:4311/".to_owned(),
            })),
            deletes: AtomicUsize::new(0),
        };

        let expected_stale = Credential {
            bearer: "stale-bearer".to_owned(),
            credential_id: "credential-stale".to_owned(),
            origin: "http://127.0.0.1:4310/".to_owned(),
        };
        assert!(!keyring
            .replace_stale_if_current(
                "owner-record",
                "http://127.0.0.1:4311/",
                &expected_stale,
                "late-bearer",
                "credential-late",
            )
            .unwrap());
        let stored = keyring.credential.lock().unwrap();
        let stored = stored.as_ref().unwrap();
        assert_eq!(stored.credential_id, "credential-newer");
        assert_eq!(stored.bearer, "newer-bearer");
    }

    #[test]
    fn authenticated_read_cannot_publish_after_its_credential_is_deleted() {
        let keyring = Arc::new(FakeKeyring {
            credential: Mutex::new(Some(Credential {
                bearer: "old-bearer".to_owned(),
                credential_id: "credential-old".to_owned(),
                origin: "http://127.0.0.1:4310/".to_owned(),
            })),
            deletes: AtomicUsize::new(0),
        });
        let read_started = Arc::new(Barrier::new(2));
        let read_release = Arc::new(Barrier::new(2));
        let state = NativeConnectionState::with_test_collaborators(
            Arc::new(StatusRaceTransport {
                health_calls: AtomicUsize::new(0),
                final_health_started: None,
                final_health_release: None,
                read_started: Some(read_started.clone()),
                read_release: Some(read_release.clone()),
                read_status: 200,
            }),
            keyring.clone(),
            Arc::new(StaticDiscovery {
                record: deadline_record(),
            }),
            Arc::new(FakeLauncher),
        );
        let handle = state.cave_read_discovery().unwrap().handle;
        tauri::async_runtime::block_on(state.cave_health(handle.clone())).unwrap();

        let read_state = state.clone();
        let completion = std::thread::spawn(move || {
            tauri::async_runtime::block_on(read_state.cave_read(
                handle,
                CaveReadPath::Familiars {
                    page: NativePage {
                        limit: Some(1),
                        cursor: None,
                    },
                },
            ))
        });
        read_started.wait();
        *keyring.credential.lock().unwrap() = None;
        read_release.wait();

        assert_eq!(
            completion.join().unwrap().unwrap_err().code,
            "credential_missing"
        );
        assert!(keyring.credential.lock().unwrap().is_none());
    }

    #[test]
    fn authenticated_read_cannot_publish_after_its_credential_is_replaced() {
        let keyring = Arc::new(FakeKeyring {
            credential: Mutex::new(Some(Credential {
                bearer: "old-bearer".to_owned(),
                credential_id: "credential-shared".to_owned(),
                origin: "http://127.0.0.1:4310/".to_owned(),
            })),
            deletes: AtomicUsize::new(0),
        });
        let read_started = Arc::new(Barrier::new(2));
        let read_release = Arc::new(Barrier::new(2));
        let state = NativeConnectionState::with_test_collaborators(
            Arc::new(StatusRaceTransport {
                health_calls: AtomicUsize::new(0),
                final_health_started: None,
                final_health_release: None,
                read_started: Some(read_started.clone()),
                read_release: Some(read_release.clone()),
                read_status: 200,
            }),
            keyring.clone(),
            Arc::new(StaticDiscovery {
                record: deadline_record(),
            }),
            Arc::new(FakeLauncher),
        );
        let handle = state.cave_read_discovery().unwrap().handle;
        tauri::async_runtime::block_on(state.cave_health(handle.clone())).unwrap();

        let read_state = state.clone();
        let completion = std::thread::spawn(move || {
            tauri::async_runtime::block_on(read_state.cave_read(
                handle,
                CaveReadPath::Familiars {
                    page: NativePage {
                        limit: Some(1),
                        cursor: None,
                    },
                },
            ))
        });
        read_started.wait();
        *keyring.credential.lock().unwrap() = Some(Credential {
            bearer: "new-bearer".to_owned(),
            credential_id: "credential-shared".to_owned(),
            origin: "http://127.0.0.1:4310/".to_owned(),
        });
        read_release.wait();

        assert_eq!(
            completion.join().unwrap().unwrap_err().code,
            "stale_connection_attempt"
        );
        let stored = keyring.credential.lock().unwrap();
        let stored = stored.as_ref().unwrap();
        assert_eq!(stored.credential_id, "credential-shared");
        assert_eq!(stored.bearer, "new-bearer");
    }

    #[test]
    fn stale_revocation_read_cannot_delete_a_replacement_credential() {
        let record = OwnerDiscoveryRecord {
            handle: String::new(),
            bytes: test_discovery_bytes("http://127.0.0.1:4310"),
            record: OwnerDiscoveryRecordMetadata {
                identity: "owner-local-discovery-record".to_owned(),
                device: 1,
                inode: 2,
                process_alive: true,
            },
        };
        let keyring = Arc::new(FakeKeyring {
            credential: Mutex::new(Some(Credential {
                bearer: "native-only-bearer".to_owned(),
                credential_id: "credential-a".to_owned(),
                origin: "http://127.0.0.1:4310/".to_owned(),
            })),
            deletes: AtomicUsize::new(0),
        });
        let read_started = Arc::new(Barrier::new(2));
        let read_release = Arc::new(Barrier::new(2));
        let state = NativeConnectionState::with_test_collaborators(
            Arc::new(StatusRaceTransport {
                health_calls: AtomicUsize::new(0),
                final_health_started: None,
                final_health_release: None,
                read_started: Some(read_started.clone()),
                read_release: Some(read_release.clone()),
                read_status: 401,
            }),
            keyring.clone(),
            Arc::new(StaticDiscovery { record }),
            Arc::new(FakeLauncher),
        );
        let handle = state.cave_read_discovery().unwrap().handle;
        tauri::async_runtime::block_on(state.cave_health(handle.clone())).unwrap();
        state.runtime().unwrap().unauthorized.identity = Some(UnauthorizedIdentity {
            instance_id: "00000000-0000-4000-8000-000000000000".to_owned(),
            origin: "http://127.0.0.1:4310/".to_owned(),
            credential_id: "credential-a".to_owned(),
            first_unauthorized_at: Instant::now() - Duration::from_millis(500),
            rediscovery_healthy: true,
        });

        let status_state = state.clone();
        let completion = std::thread::spawn(move || {
            tauri::async_runtime::block_on(status_state.cave_credential_status(handle))
        });
        read_started.wait();
        *keyring.credential.lock().unwrap() = Some(Credential {
            bearer: "newer-native-only-bearer".to_owned(),
            credential_id: "credential-b".to_owned(),
            origin: "http://127.0.0.1:4310/".to_owned(),
        });
        read_release.wait();

        assert_eq!(
            completion.join().unwrap().unwrap(),
            json!({
                "status": "disconnected",
                "reason": "credential_update_in_progress",
            })
        );
        assert_eq!(keyring.deletes.load(Ordering::SeqCst), 0);
        assert_eq!(
            keyring
                .credential
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .credential_id,
            "credential-b"
        );
    }

    #[test]
    fn launch_keeps_one_child_reservation_after_owner_checked_readiness() {
        let record = OwnerDiscoveryRecord {
            handle: String::new(),
            bytes: test_discovery_bytes("http://127.0.0.1:4310"),
            record: OwnerDiscoveryRecordMetadata {
                identity: "owner-local-discovery-record".to_owned(),
                device: 1,
                inode: 2,
                process_alive: true,
            },
        };
        let launcher = Arc::new(ReadyLauncher {
            launches: AtomicUsize::new(0),
        });
        let state = NativeConnectionState::with_test_collaborators(
            Arc::new(FakeTransport::default()),
            Arc::new(FakeKeyring {
                credential: Mutex::new(None),
                deletes: AtomicUsize::new(0),
            }),
            Arc::new(StaticDiscovery { record }),
            launcher.clone(),
        );

        tauri::async_runtime::block_on(state.cave_launch()).unwrap();
        let duplicate = tauri::async_runtime::block_on(state.cave_launch()).unwrap_err();

        assert_eq!(duplicate.code, "cave_launch_in_progress");
        assert_eq!(launcher.launches.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn launch_invalidates_the_prelaunch_authority_handle() {
        let record = OwnerDiscoveryRecord {
            handle: String::new(),
            bytes: test_discovery_bytes("http://127.0.0.1:4310"),
            record: OwnerDiscoveryRecordMetadata {
                identity: "owner-local-discovery-record".to_owned(),
                device: 1,
                inode: 2,
                process_alive: true,
            },
        };
        let state = NativeConnectionState::with_test_collaborators(
            Arc::new(FakeTransport::default()),
            Arc::new(FakeKeyring {
                credential: Mutex::new(None),
                deletes: AtomicUsize::new(0),
            }),
            Arc::new(StaticDiscovery { record }),
            Arc::new(ReadyLauncher {
                launches: AtomicUsize::new(0),
            }),
        );
        let old_handle = state.cave_read_discovery().unwrap().handle;

        tauri::async_runtime::block_on(state.cave_launch()).unwrap();

        assert_eq!(
            tauri::async_runtime::block_on(state.cave_health(old_handle))
                .unwrap_err()
                .code,
            "invalid_discovery_handle"
        );
    }

    #[test]
    fn stale_health_completion_cannot_replace_a_new_discovery_generation() {
        let record_a = OwnerDiscoveryRecord {
            handle: String::new(),
            bytes: test_discovery_bytes("http://127.0.0.1:4310"),
            record: OwnerDiscoveryRecordMetadata {
                identity: "owner-local-discovery-record".to_owned(),
                device: 1,
                inode: 2,
                process_alive: true,
            },
        };
        let record_b = OwnerDiscoveryRecord {
            handle: String::new(),
            bytes: test_discovery_bytes("http://127.0.0.1:4311"),
            record: OwnerDiscoveryRecordMetadata {
                identity: "owner-local-discovery-record".to_owned(),
                device: 1,
                inode: 3,
                process_alive: true,
            },
        };
        let started = Arc::new(std::sync::Barrier::new(2));
        let release = Arc::new(std::sync::Barrier::new(2));
        let state = NativeConnectionState::with_test_collaborators(
            Arc::new(FakeTransport {
                health_started: Some(started.clone()),
                health_release: Some(release.clone()),
                ..FakeTransport::default()
            }),
            Arc::new(FakeKeyring {
                credential: Mutex::new(None),
                deletes: AtomicUsize::new(0),
            }),
            Arc::new(StaticDiscovery { record: record_a }),
            Arc::new(FakeLauncher),
        );
        let handle = state.cave_read_discovery().unwrap().handle;

        let stale_state = state.clone();
        let completion = std::thread::spawn(move || {
            tauri::async_runtime::block_on(stale_state.cave_health(handle))
        });
        started.wait();
        let mut record_b = record_b;
        state
            .runtime()
            .unwrap()
            .accept_discovery(&mut record_b)
            .unwrap();
        release.wait();

        assert_eq!(
            completion.join().unwrap().unwrap_err().code,
            "stale_connection_attempt"
        );
    }

    #[test]
    fn forged_or_replaced_discovery_handles_cannot_reach_the_transport() {
        let record = OwnerDiscoveryRecord {
            handle: String::new(),
            bytes: test_discovery_bytes("http://127.0.0.1:4310"),
            record: OwnerDiscoveryRecordMetadata {
                identity: "owner-local-discovery-record".to_owned(),
                device: 1,
                inode: 2,
                process_alive: true,
            },
        };
        let discovery = Arc::new(MutableDiscovery {
            record: Mutex::new(record),
        });
        let state = NativeConnectionState::with_test_collaborators(
            Arc::new(FakeTransport::default()),
            Arc::new(FakeKeyring {
                credential: Mutex::new(None),
                deletes: AtomicUsize::new(0),
            }),
            discovery.clone(),
            Arc::new(FakeLauncher),
        );
        let handle = state.cave_read_discovery().unwrap().handle;

        assert_eq!(
            tauri::async_runtime::block_on(state.cave_health("forged-handle".to_owned()))
                .unwrap_err()
                .code,
            "invalid_discovery_handle"
        );

        discovery.record.lock().unwrap().bytes = test_discovery_bytes("http://127.0.0.1:4311");
        assert_eq!(
            tauri::async_runtime::block_on(state.cave_health(handle))
                .unwrap_err()
                .code,
            "stale_discovery_handle"
        );
    }

    #[test]
    fn discovery_ipc_snapshot_does_not_serialize_the_native_origin() {
        let record = OwnerDiscoveryRecord {
            handle: "opaque-native-handle".to_owned(),
            bytes: test_discovery_bytes("http://127.0.0.1:4310"),
            record: OwnerDiscoveryRecordMetadata {
                identity: "owner-local-discovery-record".to_owned(),
                device: 1,
                inode: 2,
                process_alive: true,
            },
        };

        let serialized = serde_json::to_string(&record).unwrap();

        assert!(!serialized.contains("http://127.0.0.1:4310"));
        assert!(serialized.contains("opaque-native-handle"));
    }

    #[test]
    fn late_exchange_cas_cannot_replace_a_newer_credential() {
        let keyring = FakeKeyring {
            credential: Mutex::new(Some(Credential {
                bearer: "newer-bearer".to_owned(),
                credential_id: "credential-new".to_owned(),
                origin: "http://127.0.0.1:4310/".to_owned(),
            })),
            deletes: AtomicUsize::new(0),
        };
        let expected = Credential {
            bearer: "old-bearer".to_owned(),
            credential_id: "credential-old".to_owned(),
            origin: "http://127.0.0.1:4310/".to_owned(),
        };

        let persisted = keyring
            .store_if_current(
                "owner-record",
                "http://127.0.0.1:4310/",
                Some(&expected),
                "late-bearer",
                "credential-old",
            )
            .unwrap();

        assert!(!persisted);
        assert_eq!(
            keyring
                .credential
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .credential_id,
            "credential-new"
        );
    }
}
