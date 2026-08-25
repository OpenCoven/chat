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
    keyring::{Credential, KeyringError},
    transport::{CaveReadPath, NativeHttpResponse, NativePage},
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

    pub(crate) async fn cave_health(&self, handle: String) -> NativeResult<Value> {
        let (generation, authority) = self.capture_handle(&handle)?;
        let response = self.transport.health(&authority).await?;
        require_success(&response)?;
        let mut runtime = self.runtime()?;
        runtime.require_current(generation, &handle, &authority)?;
        let instance_id = authority.credential_binding().to_owned();
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
        let result = self.transport.pairing_create(&authority, request).await;
        let mut runtime = self.runtime()?;
        runtime.pairing_in_flight = false;
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
        let result = self
            .transport
            .pairing_poll(&authority, &request_id, &secret)
            .await;
        let mut runtime = self.runtime()?;
        let is_current = runtime.generation == generation
            && runtime.authority_handle.as_deref() == Some(&handle)
            && runtime.pairing.as_mut().is_some_and(|pairing| {
                if pairing.request_id == request_id {
                    pairing.poll_in_flight = false;
                    true
                } else {
                    false
                }
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
        let (generation, authority, instance_id, secret) = {
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
            (
                pairing.generation,
                pairing.authority.clone(),
                pairing.instance_id.clone(),
                pairing.secret.clone(),
            )
        };
        let expected_credential_id =
            match self.keyring.read(&instance_id, authority.origin().as_str()) {
                Ok(credential) => Some(credential.credential_id),
                Err(KeyringError::NotFound) => None,
                Err(error) => {
                    let mut runtime = self.runtime()?;
                    if runtime.generation == generation
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
            .pairing_exchange(&authority, &request_id, &secret)
            .await?;
        self.capture_handle(&handle)?;
        self.runtime()?
            .require_current(generation, &handle, &authority)?;
        let persisted = match self.keyring.store_if_current(
            &instance_id,
            authority.origin().as_str(),
            expected_credential_id.as_deref(),
            &exchanged.bearer,
            &exchanged.credential_id,
        ) {
            Ok(persisted) => persisted,
            Err(error) => {
                let mut runtime = self.runtime()?;
                if runtime.generation == generation
                    && runtime
                        .pairing
                        .as_ref()
                        .is_some_and(|pairing| pairing.request_id == request_id)
                {
                    runtime.pairing = None;
                }
                return Err(error.diagnostic());
            }
        };
        if !persisted {
            return Err(NativeDiagnostic::new("credential_update_in_progress", true));
        }

        let mut runtime = self.runtime()?;
        if runtime.generation == generation
            && runtime
                .authority
                .as_ref()
                .is_some_and(|current| current.is_same_pin(&authority))
            && runtime.authority_handle.as_deref() == Some(&handle)
        {
            runtime.pairing = None;
            runtime.unauthorized.reset();
            return Ok(exchanged.response);
        }
        Err(NativeDiagnostic::new("stale_connection_attempt", true))
    }

    pub(crate) async fn cave_credential_status(&self, handle: String) -> NativeResult<Value> {
        let (generation, authority) = self.capture_handle(&handle)?;
        let (_, _, instance_id) = self.runtime()?.require_authorized(&handle)?;
        let credential = match self.keyring.read(&instance_id, authority.origin().as_str()) {
            Ok(credential) => credential,
            Err(KeyringError::NotFound) => return Ok(json!({ "status": "missing" })),
            Err(error) => return Err(error.diagnostic()),
        };
        {
            let mut runtime = self.runtime()?;
            runtime.require_current(generation, &handle, &authority)?;
            if runtime.revocation_in_flight {
                return Ok(json!({
                    "status": "disconnected",
                    "reason": "credential_update_in_progress",
                }));
            }
            runtime.revocation_in_flight = true;
        }
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
                let mut runtime = self.runtime()?;
                if runtime
                    .require_current(generation, &handle, &authority)
                    .is_ok()
                {
                    runtime.revocation_in_flight = false;
                }
                return Err(error);
            }
        };
        let revoked = {
            let mut runtime = self.runtime()?;
            runtime.require_current(generation, &handle, &authority)?;
            runtime.revocation_in_flight = false;
            if response.status_code == 401 {
                let action = runtime.unauthorized.record(&instance_id, &credential);
                if matches!(action, UnauthorizedAction::ConfirmRevocation) {
                    let deleted = self
                        .keyring
                        .delete_if_matches(
                            &instance_id,
                            authority.origin().as_str(),
                            &credential.credential_id,
                        )
                        .map_err(|error| error.diagnostic())?;
                    runtime.unauthorized.reset();
                    Some(deleted)
                } else {
                    return Ok(json!({
                        "status": "disconnected",
                        "reason": "reconcile_required",
                    }));
                }
            } else {
                runtime.unauthorized.reset();
                None
            }
        };
        if let Some(deleted) = revoked {
            let health = self.transport.health(&authority).await?;
            self.runtime()?
                .require_current(generation, &handle, &authority)?;
            return Ok(json!({
                "status": if deleted { "revoked" } else { "missing" },
                "health": health.payload,
            }));
        }
        let health = self.transport.health(&authority).await?;
        self.runtime()?
            .require_current(generation, &handle, &authority)?;
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
        self.capture_handle(&handle)?;
        let (_, authority, instance_id) = self.runtime()?.require_authorized(&handle)?;
        let credential = match self.keyring.read(&instance_id, authority.origin().as_str()) {
            Ok(credential) => credential,
            Err(KeyringError::NotFound) => return Ok(json!({ "status": "missing" })),
            Err(error) => return Err(error.diagnostic()),
        };
        let deleted = self
            .keyring
            .delete_if_matches(
                &instance_id,
                authority.origin().as_str(),
                &credential.credential_id,
            )
            .map_err(|error| error.diagnostic())?;
        Ok(json!({ "status": if deleted { "deleted" } else { "credential_update_in_progress" } }))
    }

    pub(crate) async fn cave_read(
        &self,
        handle: String,
        path: CaveReadPath,
    ) -> NativeResult<Value> {
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
        let mut runtime = self.runtime()?;
        runtime.require_current(generation, &handle, &authority)?;
        if response.status_code != 401 {
            runtime.unauthorized.reset();
        }
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
                                    runtime.authority = Some(authority.clone());
                                    runtime.instance_id =
                                        Some(authority.credential_binding().to_owned());
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
        Err(NativeDiagnostic::new(
            if response.status_code == 401 {
                "unauthorized"
            } else {
                "cave_request_failed"
            },
            response.status_code >= 500,
        ))
    }
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
            CaveClock, CaveDiscoveryReader, CaveLauncher, CaveSleeper, CaveTaskRunner,
            NativeDiagnostic, OwnerDiscoveryRecordMetadata,
        },
        keyring::CredentialCustody,
        transport::{NativeCaveTransport, NativePairingCreated, NativePairingExchange},
    };

    #[derive(Default)]
    struct FakeTransport {
        health_started: Option<Arc<std::sync::Barrier>>,
        health_release: Option<Arc<std::sync::Barrier>>,
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
                payload: json!({ "data": { "instanceId": "instance-a" } }),
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
                status_code: 401,
                payload: json!({ "error": { "code": "unauthorized" } }),
            })
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

        fn store_if_current(
            &self,
            _instance_id: &str,
            origin: &str,
            expected_credential_id: Option<&str>,
            bearer: &str,
            credential_id: &str,
        ) -> Result<bool, KeyringError> {
            let mut stored = self.credential.lock().unwrap();
            let matches_expected = match (stored.as_ref(), expected_credential_id) {
                (None, None) => true,
                (Some(current), Some(expected)) => {
                    current.origin == origin && current.credential_id == expected
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

        fn delete_if_matches(
            &self,
            _instance_id: &str,
            _origin: &str,
            _credential_id: &str,
        ) -> Result<bool, KeyringError> {
            self.deletes.fetch_add(1, Ordering::SeqCst);
            Ok(true)
        }
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
                payload: json!({}),
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
            bytes: serde_json::to_vec(&json!({
                "endpoint": "http://127.0.0.1:4310",
            }))
            .unwrap(),
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
            bytes: serde_json::to_vec(&json!({
                "endpoint": "http://127.0.0.1:4310",
            }))
            .unwrap(),
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
            bytes: serde_json::to_vec(&json!({
                "endpoint": "http://127.0.0.1:4310",
            }))
            .unwrap(),
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

        assert_eq!(confirmed["status"], "revoked");
        assert_eq!(keyring.deletes.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn launch_keeps_one_child_reservation_after_owner_checked_readiness() {
        let record = OwnerDiscoveryRecord {
            handle: String::new(),
            bytes: serde_json::to_vec(&json!({
                "endpoint": "http://127.0.0.1:4310",
            }))
            .unwrap(),
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
            bytes: serde_json::to_vec(&json!({
                "endpoint": "http://127.0.0.1:4310",
            }))
            .unwrap(),
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
            bytes: serde_json::to_vec(&json!({
                "endpoint": "http://127.0.0.1:4310",
            }))
            .unwrap(),
            record: OwnerDiscoveryRecordMetadata {
                identity: "owner-local-discovery-record".to_owned(),
                device: 1,
                inode: 2,
                process_alive: true,
            },
        };
        let record_b = OwnerDiscoveryRecord {
            handle: String::new(),
            bytes: serde_json::to_vec(&json!({
                "endpoint": "http://127.0.0.1:4311",
            }))
            .unwrap(),
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
            bytes: serde_json::to_vec(&json!({
                "endpoint": "http://127.0.0.1:4310",
            }))
            .unwrap(),
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

        discovery.record.lock().unwrap().bytes = serde_json::to_vec(&json!({
            "endpoint": "http://127.0.0.1:4311",
        }))
        .unwrap();
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
            bytes: serde_json::to_vec(&json!({
                "endpoint": "http://127.0.0.1:4310",
            }))
            .unwrap(),
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

        let persisted = keyring
            .store_if_current(
                "owner-record",
                "http://127.0.0.1:4310/",
                Some("credential-old"),
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
