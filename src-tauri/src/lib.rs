mod cave;
mod commands;
#[cfg(feature = "phase1-conformance")]
pub mod conformance;
mod connection;
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
use keyring::{validate_installation_id, CredentialCustody, NativeKeyring};
use operation::NativeOperationRegistry;
use transport::{ConstrainedTransport, NativeCaveTransport};

pub use commands::{
    app_identity, app_installation_id, cave_cancel_operation, cave_credential_status,
    cave_forget_credential, cave_get_conversation, cave_health, cave_launch,
    cave_list_conversation_messages, cave_list_conversations, cave_list_familiars,
    cave_list_projects, cave_pairing_create, cave_pairing_exchange, cave_pairing_poll,
    cave_read_discovery, cave_reset_pairing, registered_command_names,
};
pub use metadata::{AppIdentity, APP_IDENTIFIER, APP_NAME, APP_PHASE};
pub use operation::{NativeCancelReason, NativeCancelResult, NativeOperationInput};

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
    operations: Arc<NativeOperationRegistry>,
}

impl Default for NativeConnectionState {
    fn default() -> Self {
        Self {
            runtime: Arc::new(Mutex::new(ConnectionRuntime::default())),
            transport: Arc::new(ConstrainedTransport),
            keyring: Arc::new(NativeKeyring),
            discovery: Arc::new(NativeCaveDiscoveryReader),
            launcher: Arc::new(NativeCaveLauncher),
            clock: Arc::new(NativeCaveClock::default()),
            sleeper: Arc::new(NativeCaveSleeper),
            task_runner: Arc::new(NativeCaveTaskRunner),
            operations: Arc::new(NativeOperationRegistry::default()),
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
            operations: Arc::new(NativeOperationRegistry::default()),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_test_keyring(keyring: Arc<dyn CredentialCustody>) -> Self {
        Self {
            keyring,
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
            operations: Arc::new(NativeOperationRegistry::default()),
        }
    }

    #[cfg(feature = "phase1-conformance")]
    pub(crate) fn using_operation_registry(
        mut self,
        operations: Arc<NativeOperationRegistry>,
    ) -> Self {
        self.operations = operations;
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
    use std::sync::Arc;

    use super::{
        app_identity,
        keyring::{Credential, CredentialCustody, CredentialSlot, KeyringError},
        registered_command_names, NativeConnectionState, APP_PHASE,
    };
    use serde_json::json;

    struct FakeInstallationKeyring {
        installation_id: Option<&'static str>,
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
