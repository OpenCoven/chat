mod cave;
#[cfg(feature = "phase1-conformance")]
mod cleanup_grant;
mod commands;
#[cfg(feature = "phase1-conformance")]
pub mod conformance;
mod connection;
mod coven;
mod hpke_bound;
mod keyring;
mod metadata;
mod operation;
mod transport;

use std::sync::{Arc, Mutex, MutexGuard};

use cave::{
    CaveClock, CaveDiscoveryReader, CaveLauncher, CaveSleeper, CaveTaskRunner, NativeCaveClock,
    NativeCaveDiscoveryReader, NativeCaveLauncher, NativeCaveSleeper, NativeCaveTaskRunner,
    NativeDiagnostic,
};
use connection::ConnectionRuntime;
use coven::{CovenHealth, NativeCovenHealth, NativeCovenHealthExecutor};
use keyring::{validate_installation_id, CredentialCustody, NativeKeyring};
use operation::{
    NativeMutationContext, NativeMutationQueue, NativeOperationLease, NativeOperationRegistry,
};
use transport::{ConstrainedTransport, NativeCaveTransport};

pub use commands::{
    app_identity, app_installation_id, cave_cancel_operation, cave_credential_status,
    cave_forget_credential, cave_get_conversation, cave_health, cave_launch,
    cave_list_conversation_messages, cave_list_conversations, cave_list_familiars,
    cave_list_projects, cave_pairing_create, cave_pairing_exchange, cave_pairing_poll,
    cave_read_discovery, cave_reset_pairing, coven_health, registered_command_names,
};
pub use coven::CovenHealthResult;
pub use metadata::{AppIdentity, APP_IDENTIFIER, APP_NAME, APP_PHASE};
pub use operation::{NativeCancelReason, NativeCancelResult, NativeOperationInput};

pub fn exit_if_internal_coven_health_probe_requested() {
    coven::exit_if_internal_coven_health_probe_requested();
}

#[derive(Clone)]
pub struct NativeConnectionState {
    runtime: Arc<Mutex<ConnectionRuntime>>,
    transport: Arc<dyn NativeCaveTransport>,
    keyring: Arc<dyn CredentialCustody>,
    discovery: Arc<dyn CaveDiscoveryReader>,
    launcher: Arc<dyn CaveLauncher>,
    clock: Arc<dyn CaveClock>,
    sleeper: Arc<dyn CaveSleeper>,
    task_runner: Arc<dyn CaveTaskRunner>,
    coven_health: Arc<dyn CovenHealth>,
    coven_health_executor: Arc<NativeCovenHealthExecutor>,
    operations: Arc<NativeOperationRegistry>,
    mutations: Arc<NativeMutationQueue>,
}

impl Default for NativeConnectionState {
    fn default() -> Self {
        Self {
            runtime: Arc::new(Mutex::new(ConnectionRuntime::default())),
            transport: Arc::new(ConstrainedTransport),
            keyring: Arc::new(NativeKeyring::default()),
            discovery: Arc::new(NativeCaveDiscoveryReader),
            launcher: Arc::new(NativeCaveLauncher),
            clock: Arc::new(NativeCaveClock::default()),
            sleeper: Arc::new(NativeCaveSleeper),
            task_runner: Arc::new(NativeCaveTaskRunner),
            coven_health: Arc::new(NativeCovenHealth::default()),
            coven_health_executor: Arc::new(NativeCovenHealthExecutor::default()),
            operations: Arc::new(NativeOperationRegistry::default()),
            mutations: Arc::new(NativeMutationQueue::default()),
        }
    }
}

impl NativeConnectionState {
    pub(crate) fn installation_id(&self) -> Result<String, NativeDiagnostic> {
        let installation_id = self
            .keyring
            .installation_id()
            .map_err(|error| error.diagnostic())?;
        validate_installation_id(&installation_id).map_err(|error| error.diagnostic())?;
        Ok(installation_id)
    }

    fn runtime(&self) -> Result<MutexGuard<'_, ConnectionRuntime>, NativeDiagnostic> {
        self.runtime
            .lock()
            .map_err(|_| NativeDiagnostic::new("connection_state_unavailable", true))
    }

    async fn run_operation<T>(
        &self,
        operation: NativeOperationInput,
        future: impl std::future::Future<Output = Result<T, NativeDiagnostic>>,
    ) -> Result<T, NativeDiagnostic> {
        self.operations.run(operation, future).await
    }

    async fn run_mutating_operation<T, Fut>(
        &self,
        operation: NativeOperationInput,
        executor: impl FnOnce(NativeMutationContext) -> Fut,
    ) -> Result<T, NativeDiagnostic>
    where
        Fut: std::future::Future<Output = Result<T, NativeDiagnostic>>,
    {
        self.operations.run_mutating(operation, executor).await
    }

    async fn run_controlled_operation<T, Fut>(
        &self,
        operation: NativeOperationInput,
        executor: impl FnOnce(NativeOperationLease) -> Fut,
    ) -> Result<T, NativeDiagnostic>
    where
        Fut: std::future::Future<Output = Result<T, NativeDiagnostic>>,
    {
        self.operations.run_controlled(operation, executor).await
    }

    async fn run_keyring_mutation<T: Send + 'static>(
        &self,
        context: NativeMutationContext,
        task: impl FnOnce() -> Result<T, NativeDiagnostic> + Send + 'static,
    ) -> Result<T, NativeDiagnostic> {
        self.mutations.execute(context, task).await
    }

    async fn coven_health(&self) -> Result<CovenHealthResult, NativeDiagnostic> {
        self.coven_health_executor
            .execute(Arc::clone(&self.coven_health))
            .await
    }

    fn cancel_operation(
        &self,
        attempt_id: String,
        reason: NativeCancelReason,
    ) -> Result<NativeCancelResult, NativeDiagnostic> {
        self.operations.cancel(attempt_id, reason)
    }

    fn cancel_all_operations(&self, reason: NativeCancelReason) {
        self.operations.cancel_all(reason);
    }

    fn operation_registry(&self) -> Arc<NativeOperationRegistry> {
        Arc::clone(&self.operations)
    }

    fn mutation_queue(&self) -> Arc<NativeMutationQueue> {
        Arc::clone(&self.mutations)
    }

    #[cfg(test)]
    fn hold_mutation_worker(&self) -> std::sync::MutexGuard<'_, ()> {
        self.mutations.hold_worker()
    }

    #[cfg(test)]
    fn mutation_is_busy(&self) -> bool {
        self.mutations.is_busy()
    }
}

#[cfg(any(test, feature = "phase1-conformance"))]
impl NativeConnectionState {
    #[cfg(test)]
    pub(crate) fn with_test_collaborators(
        transport: Arc<dyn NativeCaveTransport>,
        keyring: Arc<dyn CredentialCustody>,
        discovery: Arc<dyn CaveDiscoveryReader>,
        launcher: Arc<dyn CaveLauncher>,
    ) -> Self {
        Self {
            runtime: Arc::new(Mutex::new(ConnectionRuntime::default())),
            transport,
            keyring,
            discovery,
            launcher,
            clock: Arc::new(NativeCaveClock::default()),
            sleeper: Arc::new(NativeCaveSleeper),
            task_runner: Arc::new(NativeCaveTaskRunner),
            coven_health: Arc::new(NativeCovenHealth::default()),
            coven_health_executor: Arc::new(NativeCovenHealthExecutor::default()),
            operations: Arc::new(NativeOperationRegistry::default()),
            mutations: Arc::new(NativeMutationQueue::default()),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_test_keyring(keyring: Arc<dyn CredentialCustody>) -> Self {
        Self {
            keyring,
            ..Self::default()
        }
    }

    #[cfg(test)]
    pub(crate) fn with_test_coven_health(coven_health: Arc<dyn CovenHealth>) -> Self {
        Self {
            coven_health,
            ..Self::default()
        }
    }

    pub(crate) fn with_test_launch_collaborators(
        transport: Arc<dyn NativeCaveTransport>,
        keyring: Arc<dyn CredentialCustody>,
        discovery: Arc<dyn CaveDiscoveryReader>,
        launcher: Arc<dyn CaveLauncher>,
        clock: Arc<dyn CaveClock>,
        sleeper: Arc<dyn CaveSleeper>,
        task_runner: Arc<dyn CaveTaskRunner>,
    ) -> Self {
        Self {
            runtime: Arc::new(Mutex::new(ConnectionRuntime::default())),
            transport,
            keyring,
            discovery,
            launcher,
            clock,
            sleeper,
            task_runner,
            coven_health: Arc::new(NativeCovenHealth::default()),
            coven_health_executor: Arc::new(NativeCovenHealthExecutor::default()),
            operations: Arc::new(NativeOperationRegistry::default()),
            mutations: Arc::new(NativeMutationQueue::default()),
        }
    }

    #[cfg(feature = "phase1-conformance")]
    pub(crate) fn using_runtime_guards(
        mut self,
        operations: Arc<NativeOperationRegistry>,
        mutations: Arc<NativeMutationQueue>,
    ) -> Self {
        self.operations = operations;
        self.mutations = mutations;
        self
    }
}

fn builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .manage(NativeConnectionState::default())
        .invoke_handler(tauri::generate_handler![
            app_identity,
            app_installation_id,
            cave_read_discovery,
            cave_cancel_operation,
            cave_launch,
            cave_health,
            coven_health,
            cave_pairing_create,
            cave_pairing_poll,
            cave_pairing_exchange,
            cave_reset_pairing,
            cave_credential_status,
            cave_forget_credential,
            cave_list_familiars,
            cave_list_projects,
            cave_list_conversations,
            cave_get_conversation,
            cave_list_conversation_messages
        ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    builder()
        .run(tauri::generate_context!())
        .expect("error while running OpenCoven Chat");
}

#[cfg(test)]
mod smoke_tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Condvar, Mutex,
    };
    use std::time::{Duration, Instant};

    use super::{
        app_identity,
        cave::NativeDiagnostic,
        coven::{CovenHealth, CovenHealthResult},
        keyring::{Credential, CredentialCustody, CredentialSlot, KeyringError},
        registered_command_names, NativeCancelReason, NativeConnectionState, NativeOperationInput,
        APP_PHASE,
    };
    use serde_json::json;

    struct FakeInstallationKeyring {
        installation_id: Option<&'static str>,
    }

    struct HealthyCoven;

    impl CovenHealth for HealthyCoven {
        fn health(&self) -> Result<CovenHealthResult, NativeDiagnostic> {
            Ok(CovenHealthResult { status: "ok" })
        }
    }

    struct SlowCoven;

    impl CovenHealth for SlowCoven {
        fn health(&self) -> Result<CovenHealthResult, NativeDiagnostic> {
            std::thread::sleep(std::time::Duration::from_millis(25));
            Ok(CovenHealthResult { status: "ok" })
        }
    }

    #[derive(Default)]
    struct BlockingCoven {
        calls: AtomicUsize,
        active: AtomicUsize,
        max_active: AtomicUsize,
        release: (Mutex<bool>, Condvar),
    }

    impl BlockingCoven {
        fn wait_for_calls(&self, minimum: usize) {
            let deadline = Instant::now() + Duration::from_secs(1);
            while self.calls.load(Ordering::SeqCst) < minimum {
                assert!(
                    Instant::now() < deadline,
                    "Coven health worker did not start in time"
                );
                std::thread::sleep(Duration::from_millis(1));
            }
        }

        fn release(&self) {
            *self.release.0.lock().unwrap() = true;
            self.release.1.notify_all();
        }

        fn wait_for_idle(&self) {
            let deadline = Instant::now() + Duration::from_secs(1);
            while self.active.load(Ordering::SeqCst) != 0 {
                assert!(
                    Instant::now() < deadline,
                    "Coven health worker did not finish in time"
                );
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    }

    impl CovenHealth for BlockingCoven {
        fn health(&self) -> Result<CovenHealthResult, NativeDiagnostic> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_active.fetch_max(active, Ordering::SeqCst);

            let mut released = self.release.0.lock().unwrap();
            while !*released {
                released = self.release.1.wait(released).unwrap();
            }
            self.active.fetch_sub(1, Ordering::SeqCst);
            Ok(CovenHealthResult { status: "ok" })
        }
    }

    impl CredentialCustody for FakeInstallationKeyring {
        fn installation_id(&self) -> Result<String, KeyringError> {
            self.installation_id
                .map(str::to_owned)
                .ok_or(KeyringError::Unavailable)
        }

        fn read(&self, _instance_id: &str, _origin: &str) -> Result<Credential, KeyringError> {
            Err(KeyringError::Unavailable)
        }

        fn read_for_pairing_update(
            &self,
            _instance_id: &str,
            _origin: &str,
        ) -> Result<CredentialSlot, KeyringError> {
            Err(KeyringError::Unavailable)
        }

        fn store_if_current(
            &self,
            _instance_id: &str,
            _origin: &str,
            _expected_credential: Option<&Credential>,
            _bearer: &str,
            _credential_id: &str,
        ) -> Result<bool, KeyringError> {
            Err(KeyringError::Unavailable)
        }

        fn replace_stale_if_current(
            &self,
            _instance_id: &str,
            _origin: &str,
            _expected_stale_credential: &Credential,
            _bearer: &str,
            _credential_id: &str,
        ) -> Result<bool, KeyringError> {
            Err(KeyringError::Unavailable)
        }

        fn delete_if_matches(
            &self,
            _instance_id: &str,
            _origin: &str,
            _expected_credential: &Credential,
        ) -> Result<bool, KeyringError> {
            Err(KeyringError::Unavailable)
        }
    }

    #[test]
    fn reports_the_application_identity() {
        let config = serde_json::from_str::<serde_json::Value>(include_str!("../tauri.conf.json"))
            .expect("tauri config should stay valid json");
        let identity = app_identity();

        assert_eq!(identity.name, config["productName"].as_str().unwrap());
        assert_eq!(identity.identifier, config["identifier"].as_str().unwrap());
        assert_eq!(identity.phase, APP_PHASE);
        assert_eq!(
            json!(identity),
            json!({
              "name": config["productName"].as_str().unwrap(),
              "identifier": config["identifier"].as_str().unwrap(),
              "phase": "phase-1-read-only-production"
            }),
        );
    }

    #[test]
    fn registers_only_the_managed_sdk_adapter_commands() {
        assert_eq!(
            registered_command_names(),
            &[
                "app_identity",
                "app_installation_id",
                "cave_read_discovery",
                "cave_cancel_operation",
                "cave_launch",
                "cave_health",
                "coven_health",
                "cave_pairing_create",
                "cave_pairing_poll",
                "cave_pairing_exchange",
                "cave_reset_pairing",
                "cave_credential_status",
                "cave_forget_credential",
                "cave_list_familiars",
                "cave_list_projects",
                "cave_list_conversations",
                "cave_get_conversation",
                "cave_list_conversation_messages",
            ]
        );
    }

    #[test]
    fn returns_only_the_minimal_coven_health_result() {
        let state = NativeConnectionState::with_test_coven_health(Arc::new(HealthyCoven));

        assert_eq!(
            tauri::async_runtime::block_on(state.coven_health()),
            Ok(CovenHealthResult { status: "ok" })
        );
        assert_eq!(
            serde_json::to_value(CovenHealthResult { status: "ok" }).unwrap(),
            json!({ "status": "ok" })
        );
    }

    #[test]
    fn bounds_coven_health_with_the_native_operation_registry() {
        let state = NativeConnectionState::with_test_coven_health(Arc::new(SlowCoven));
        let runner = state.clone();
        let operation_state = runner.clone();
        let operation = NativeOperationInput::new(
            "op1-1787900000000-1-00000000000000000000000000000000".to_owned(),
            1,
        )
        .unwrap();

        assert_eq!(
            tauri::async_runtime::block_on(runner.run_operation(operation, async move {
                operation_state.coven_health().await
            })),
            Err(NativeDiagnostic::new("timeout", true))
        );
    }

    #[test]
    fn repeated_coven_health_timeouts_keep_one_worker_until_real_completion() {
        let health = Arc::new(BlockingCoven::default());
        let state = NativeConnectionState::with_test_coven_health(health.clone());
        let mut results = Vec::new();

        for counter in 1..=4 {
            let runner = state.clone();
            let operation_state = runner.clone();
            let operation = NativeOperationInput::new(
                format!("op1-1787900000000-{counter}-00000000000000000000000000000000"),
                5,
            )
            .unwrap();
            results.push(tauri::async_runtime::block_on(
                runner.run_operation(
                    operation,
                    async move { operation_state.coven_health().await },
                ),
            ));
            if counter == 1 {
                health.wait_for_calls(1);
            }
        }

        health.release();
        health.wait_for_idle();

        assert_eq!(
            results,
            [
                Err(NativeDiagnostic::new("timeout", true)),
                Err(NativeDiagnostic::new("service_unavailable", true)),
                Err(NativeDiagnostic::new("service_unavailable", true)),
                Err(NativeDiagnostic::new("service_unavailable", true)),
            ]
        );
        assert_eq!(health.calls.load(Ordering::SeqCst), 1);
        assert_eq!(health.max_active.load(Ordering::SeqCst), 1);
        assert_eq!(
            tauri::async_runtime::block_on(state.coven_health()),
            Ok(CovenHealthResult { status: "ok" })
        );
        assert_eq!(health.calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn repeated_coven_health_cancellations_keep_one_worker_until_real_completion() {
        let health = Arc::new(BlockingCoven::default());
        let state = NativeConnectionState::with_test_coven_health(health.clone());
        let mut tasks = Vec::new();
        let mut attempt_ids = Vec::new();
        let completed_attempts = Arc::new(AtomicUsize::new(0));

        for counter in 1..=4 {
            let attempt_id =
                format!("op1-1787900000001-{counter}-00000000000000000000000000000000");
            let runner = state.clone();
            let operation_state = runner.clone();
            let completed_attempts = Arc::clone(&completed_attempts);
            let operation = NativeOperationInput::new(attempt_id.clone(), 1_000).unwrap();
            tasks.push(tauri::async_runtime::spawn(async move {
                runner
                    .run_operation(operation, async move {
                        let result = operation_state.coven_health().await;
                        completed_attempts.fetch_add(1, Ordering::SeqCst);
                        result
                    })
                    .await
            }));
            attempt_ids.push(attempt_id);
        }

        health.wait_for_calls(1);
        let deadline = Instant::now() + Duration::from_secs(1);
        while health.calls.load(Ordering::SeqCst) + completed_attempts.load(Ordering::SeqCst) < 4 {
            assert!(
                Instant::now() < deadline,
                "Coven health attempts did not reach the executor in time"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
        for attempt_id in attempt_ids {
            state
                .cancel_operation(attempt_id, NativeCancelReason::Aborted)
                .unwrap();
        }
        let results = tauri::async_runtime::block_on(async {
            let mut results = Vec::new();
            for task in tasks {
                results.push(task.await.unwrap());
            }
            results
        });

        health.release();
        health.wait_for_idle();

        assert_eq!(
            results
                .iter()
                .filter(|result| result == &&Err(NativeDiagnostic::new("aborted", false)))
                .count(),
            1
        );
        assert_eq!(
            results
                .iter()
                .filter(|result| {
                    result == &&Err(NativeDiagnostic::new("service_unavailable", true))
                })
                .count(),
            3
        );
        assert_eq!(health.calls.load(Ordering::SeqCst), 1);
        assert_eq!(health.max_active.load(Ordering::SeqCst), 1);
        assert_eq!(
            tauri::async_runtime::block_on(state.coven_health()),
            Ok(CovenHealthResult { status: "ok" })
        );
        assert_eq!(health.calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn reads_a_validated_installation_id_from_credential_custody() {
        let state = NativeConnectionState::with_test_keyring(Arc::new(FakeInstallationKeyring {
            installation_id: Some("0b59fec4-5d8e-4d5c-894d-39fcb5f3eef7"),
        }));

        assert_eq!(
            state.installation_id(),
            Ok("0b59fec4-5d8e-4d5c-894d-39fcb5f3eef7".to_owned())
        );
    }

    #[test]
    fn refuses_invalid_or_unavailable_custody_installation_ids() {
        let malformed =
            NativeConnectionState::with_test_keyring(Arc::new(FakeInstallationKeyring {
                installation_id: Some("not-a-uuid"),
            }));
        let unavailable =
            NativeConnectionState::with_test_keyring(Arc::new(FakeInstallationKeyring {
                installation_id: None,
            }));

        assert_eq!(
            malformed.installation_id().unwrap_err().code,
            "keychain_failure"
        );
        assert_eq!(
            unavailable.installation_id().unwrap_err().code,
            "secure_store_unavailable"
        );
    }
}
