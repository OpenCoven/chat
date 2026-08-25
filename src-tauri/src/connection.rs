use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::{
    cave::{
        pin_owner_discovery_record, CaveChild, NativeDiagnostic, NativeResult,
        OwnerDiscoveryRecord, PinnedCaveAuthority,
    },
    keyring::{Credential, KeyringError},
    transport::{CaveReadPath, NativeHttpResponse, NativePage},
    NativeConnectionState,
};

const LAUNCH_READINESS_DEADLINE: Duration = Duration::from_secs(30);

struct PendingPairing {
    request_id: String,
    secret: String,
    authority: PinnedCaveAuthority,
    instance_id: String,
    generation: u64,
    exchange_committed: bool,
}

struct ManagedLaunch {
    child: Box<dyn CaveChild>,
    generation: u64,
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
    instance_id: Option<String>,
    pairing: Option<PendingPairing>,
    pairing_in_flight: bool,
    launch: Option<ManagedLaunch>,
    launch_in_flight: bool,
    revocation_in_flight: bool,
    unauthorized: UnauthorizedTracker,
}

impl ConnectionRuntime {
    fn new_generation(&mut self) -> u64 {
        self.generation = self.generation.saturating_add(1);
        self.generation
    }

    fn require_authority(&self) -> NativeResult<(u64, PinnedCaveAuthority)> {
        self.authority
            .clone()
            .map(|authority| (self.generation, authority))
            .ok_or_else(|| NativeDiagnostic::new("cave_discovery_required", true))
    }

    fn require_authorized(&self) -> NativeResult<(u64, PinnedCaveAuthority, String)> {
        let (generation, authority) = self.require_authority()?;
        self.instance_id
            .clone()
            .map(|instance_id| (generation, authority, instance_id))
            .ok_or_else(|| NativeDiagnostic::new("cave_health_required", true))
    }

    fn accept_discovery(
        &mut self,
        record: &OwnerDiscoveryRecord,
    ) -> NativeResult<PinnedCaveAuthority> {
        let generation = self.new_generation();
        let authority = pin_owner_discovery_record(record, generation)?;
        let changed = self
            .authority
            .as_ref()
            .is_none_or(|current| !current.is_same_pin(&authority));
        self.authority = Some(authority.clone());
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
        authority: &PinnedCaveAuthority,
    ) -> NativeResult<()> {
        if self.generation != generation
            || self
                .authority
                .as_ref()
                .is_none_or(|current| !current.is_same_pin(authority))
        {
            return Err(NativeDiagnostic::new("stale_connection_attempt", true));
        }
        Ok(())
    }

    fn reap_launch(&mut self) -> NativeResult<()> {
        if self
            .launch
            .as_mut()
            .is_some_and(|launch| launch.child.try_wait().unwrap_or(true))
        {
            self.launch = None;
            self.launch_in_flight = false;
        }
        Ok(())
    }
}

impl NativeConnectionState {
    pub(crate) fn cave_read_discovery(&self) -> NativeResult<OwnerDiscoveryRecord> {
        let record = self.discovery.read()?;
        self.runtime()?.accept_discovery(&record)?;
        Ok(record)
    }

    pub(crate) async fn cave_health(&self) -> NativeResult<Value> {
        let (generation, authority) = self.runtime()?.require_authority()?;
        let response = self.transport.health(&authority).await?;
        require_success(&response)?;
        let instance_id = extract_instance_id(&response.payload)?;
        let mut runtime = self.runtime()?;
        runtime.require_current(generation, &authority)?;
        runtime.instance_id = Some(instance_id.clone());
        runtime
            .unauthorized
            .mark_rediscovery_healthy(&instance_id, authority.origin().as_str());
        Ok(response.payload)
    }

    pub(crate) async fn cave_pairing_create(&self, request: Value) -> NativeResult<Value> {
        let (generation, authority, instance_id) = {
            let mut runtime = self.runtime()?;
            let captured = runtime.require_authorized()?;
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
        runtime.require_current(generation, &authority)?;
        runtime.pairing = Some(PendingPairing {
            request_id: pairing_request_id(&created.response)?,
            secret: created.secret,
            authority,
            instance_id,
            generation,
            exchange_committed: false,
        });
        Ok(created.response)
    }

    pub(crate) async fn cave_pairing_poll(&self, request_id: String) -> NativeResult<Value> {
        let (generation, authority, secret) = self.pairing_capture(&request_id, false)?;
        let response = self
            .transport
            .pairing_poll(&authority, &request_id, &secret)
            .await?;
        self.runtime()?.require_current(generation, &authority)?;
        Ok(response)
    }

    pub(crate) async fn cave_pairing_exchange(&self, request_id: String) -> NativeResult<Value> {
        let (generation, authority, instance_id, secret) = {
            let mut runtime = self.runtime()?;
            let Some(pairing) = runtime.pairing.as_mut() else {
                return Err(NativeDiagnostic::new("pairing_not_found", true));
            };
            if pairing.request_id != request_id || pairing.exchange_committed {
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
        let exchanged = self
            .transport
            .pairing_exchange(&authority, &request_id, &secret)
            .await?;
        if let Err(error) = self.keyring.store(
            &instance_id,
            authority.origin().as_str(),
            &exchanged.bearer,
            &exchanged.credential_id,
        ) {
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

        let mut runtime = self.runtime()?;
        if runtime.generation == generation
            && runtime
                .authority
                .as_ref()
                .is_some_and(|current| current.is_same_pin(&authority))
        {
            runtime.pairing = None;
            runtime.unauthorized.reset();
        }
        Ok(exchanged.response)
    }

    pub(crate) async fn cave_credential_status(&self) -> NativeResult<Value> {
        let (generation, authority, instance_id) = self.runtime()?.require_authorized()?;
        let credential = match self.keyring.read(&instance_id, authority.origin().as_str()) {
            Ok(credential) => credential,
            Err(KeyringError::NotFound) => return Ok(json!({ "status": "missing" })),
            Err(error) => return Err(error.diagnostic()),
        };
        {
            let mut runtime = self.runtime()?;
            runtime.require_current(generation, &authority)?;
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
                if runtime.require_current(generation, &authority).is_ok() {
                    runtime.revocation_in_flight = false;
                }
                return Err(error);
            }
        };
        {
            let mut runtime = self.runtime()?;
            runtime.require_current(generation, &authority)?;
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
                    return Ok(json!({
                        "status": if deleted { "revoked" } else { "missing" },
                        "health": {},
                    }));
                }
                return Ok(json!({
                    "status": "disconnected",
                    "reason": "reconcile_required",
                }));
            }
            require_success(&response)?;
            runtime.unauthorized.reset();
        }
        let health = self.transport.health(&authority).await?;
        require_success(&health)?;
        Ok(json!({
            "status": "valid",
            "access": "chat:read",
            "health": health.payload,
        }))
    }

    pub(crate) fn cave_forget_credential(&self) -> NativeResult<Value> {
        let (_, authority, instance_id) = self.runtime()?.require_authorized()?;
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

    pub(crate) async fn cave_read(&self, path: CaveReadPath) -> NativeResult<Value> {
        let (generation, authority, instance_id) = self.runtime()?.require_authorized()?;
        let credential = self
            .keyring
            .read(&instance_id, authority.origin().as_str())
            .map_err(|error| error.diagnostic())?;
        let response = self
            .transport
            .authenticated_read(&authority, &credential.bearer, path)
            .await?;
        self.runtime()?.require_current(generation, &authority)?;
        require_success(&response)?;
        Ok(response.payload)
    }

    pub(crate) async fn cave_launch(&self) -> NativeResult<()> {
        let generation = {
            let mut runtime = self.runtime()?;
            runtime.reap_launch()?;
            if runtime.launch_in_flight || runtime.launch.is_some() {
                return Err(NativeDiagnostic::new("cave_launch_in_progress", true));
            }
            runtime.launch_in_flight = true;
            runtime.new_generation()
        };
        let child = match self.launcher.launch() {
            Ok(child) => child,
            Err(error) => {
                self.runtime()?.launch_in_flight = false;
                return Err(error);
            }
        };
        self.runtime()?.launch = Some(ManagedLaunch { child, generation });

        let deadline = Instant::now() + LAUNCH_READINESS_DEADLINE;
        let mut backoff = Duration::from_millis(100);
        while Instant::now() < deadline {
            {
                let mut runtime = self.runtime()?;
                if runtime.launch.as_mut().is_none_or(|launch| {
                    launch.generation != generation || launch.child.try_wait().unwrap_or(true)
                }) {
                    runtime.launch = None;
                    runtime.launch_in_flight = false;
                    return Err(NativeDiagnostic::new("cave_exited", true));
                }
            }
            if let Ok(record) = self.discovery.read() {
                if let Ok(authority) = pin_owner_discovery_record(&record, generation) {
                    if let Ok(response) = self.transport.health(&authority).await {
                        if require_success(&response).is_ok() {
                            let mut runtime = self.runtime()?;
                            if runtime
                                .launch
                                .as_ref()
                                .is_some_and(|launch| launch.generation == generation)
                            {
                                runtime.authority = Some(authority);
                                runtime.instance_id = extract_instance_id(&response.payload).ok();
                                runtime.launch_in_flight = false;
                                return Ok(());
                            }
                        }
                    }
                }
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(Duration::from_secs(2));
        }
        let mut runtime = self.runtime()?;
        if let Some(mut launch) = runtime.launch.take() {
            let _ = launch.child.terminate();
        }
        runtime.launch_in_flight = false;
        Err(NativeDiagnostic::new("cave_readiness_timeout", true))
    }

    fn pairing_capture(
        &self,
        request_id: &str,
        require_uncommitted: bool,
    ) -> NativeResult<(u64, PinnedCaveAuthority, String)> {
        let runtime = self.runtime()?;
        let pairing = runtime
            .pairing
            .as_ref()
            .filter(|pairing| {
                pairing.request_id == request_id
                    && (!require_uncommitted || !pairing.exchange_committed)
            })
            .ok_or_else(|| NativeDiagnostic::new("pairing_not_found", true))?;
        Ok((
            pairing.generation,
            pairing.authority.clone(),
            pairing.secret.clone(),
        ))
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

fn extract_instance_id(value: &Value) -> NativeResult<String> {
    value
        .get("data")
        .and_then(Value::as_object)
        .and_then(|data| data.get("instanceId"))
        .or_else(|| value.get("instanceId"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .map(str::to_owned)
        .ok_or_else(|| NativeDiagnostic::new("invalid_native_response", false))
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    };

    use async_trait::async_trait;
    use serde_json::json;

    use super::*;
    use crate::{
        cave::{CaveDiscoveryReader, CaveLauncher, NativeDiagnostic, OwnerDiscoveryRecordMetadata},
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

        fn store(
            &self,
            _instance_id: &str,
            _origin: &str,
            _bearer: &str,
            _credential_id: &str,
        ) -> Result<(), KeyringError> {
            Err(KeyringError::Failure)
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
        state.cave_read_discovery().unwrap();
        tauri::async_runtime::block_on(state.cave_health()).unwrap();

        let first = tauri::async_runtime::block_on(state.cave_credential_status()).unwrap();
        let repeated = tauri::async_runtime::block_on(state.cave_credential_status()).unwrap();

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

        state.cave_read_discovery().unwrap();
        tauri::async_runtime::block_on(state.cave_health()).unwrap();
        tauri::async_runtime::block_on(state.cave_credential_status()).unwrap();
        state
            .runtime()
            .unwrap()
            .unauthorized
            .identity
            .as_mut()
            .unwrap()
            .first_unauthorized_at = Instant::now() - Duration::from_millis(500);

        state.cave_read_discovery().unwrap();
        tauri::async_runtime::block_on(state.cave_health()).unwrap();
        let confirmed = tauri::async_runtime::block_on(state.cave_credential_status()).unwrap();

        assert_eq!(confirmed["status"], "revoked");
        assert_eq!(keyring.deletes.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn launch_keeps_one_child_reservation_after_owner_checked_readiness() {
        let record = OwnerDiscoveryRecord {
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
    fn stale_health_completion_cannot_replace_a_new_discovery_generation() {
        let record_a = OwnerDiscoveryRecord {
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
        state.cave_read_discovery().unwrap();

        let stale_state = state.clone();
        let completion =
            std::thread::spawn(move || tauri::async_runtime::block_on(stale_state.cave_health()));
        started.wait();
        state
            .runtime()
            .unwrap()
            .accept_discovery(&record_b)
            .unwrap();
        release.wait();

        assert_eq!(
            completion.join().unwrap().unwrap_err().code,
            "stale_connection_attempt"
        );
    }
}
