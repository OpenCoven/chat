mod cave;
mod commands;
mod connection;
mod keyring;
mod metadata;
mod transport;

use std::sync::{Arc, Mutex, MutexGuard};

use cave::{
    CaveDiscoveryReader, CaveLauncher, NativeCaveDiscoveryReader, NativeCaveLauncher,
    NativeDiagnostic,
};
use connection::ConnectionRuntime;
use keyring::{CredentialCustody, NativeKeyring};
use transport::{ConstrainedTransport, NativeCaveTransport};

pub use commands::{
    app_identity, cave_credential_status, cave_forget_credential, cave_get_conversation,
    cave_health, cave_launch, cave_list_conversation_messages, cave_list_conversations,
    cave_list_familiars, cave_list_projects, cave_pairing_create, cave_pairing_exchange,
    cave_pairing_poll, cave_read_discovery, registered_command_names,
};
pub use metadata::{AppIdentity, APP_IDENTIFIER, APP_NAME, APP_PHASE};

#[derive(Clone)]
pub struct NativeConnectionState {
    runtime: Arc<Mutex<ConnectionRuntime>>,
    transport: Arc<dyn NativeCaveTransport>,
    keyring: Arc<dyn CredentialCustody>,
    discovery: Arc<dyn CaveDiscoveryReader>,
    launcher: Arc<dyn CaveLauncher>,
}

impl Default for NativeConnectionState {
    fn default() -> Self {
        Self {
            runtime: Arc::new(Mutex::new(ConnectionRuntime::default())),
            transport: Arc::new(ConstrainedTransport),
            keyring: Arc::new(NativeKeyring),
            discovery: Arc::new(NativeCaveDiscoveryReader),
            launcher: Arc::new(NativeCaveLauncher),
        }
    }
}

impl NativeConnectionState {
    fn runtime(&self) -> Result<MutexGuard<'_, ConnectionRuntime>, NativeDiagnostic> {
        self.runtime
            .lock()
            .map_err(|_| NativeDiagnostic::new("connection_state_unavailable", true))
    }
}

#[cfg(test)]
impl NativeConnectionState {
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
        }
    }
}

fn builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .manage(NativeConnectionState::default())
        .invoke_handler(tauri::generate_handler![
            app_identity,
            cave_read_discovery,
            cave_launch,
            cave_health,
            cave_pairing_create,
            cave_pairing_poll,
            cave_pairing_exchange,
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
    use super::{app_identity, registered_command_names, APP_PHASE};
    use serde_json::json;

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
              "phase": "phase-0-scaffold"
            }),
        );
    }

    #[test]
    fn registers_only_the_managed_sdk_adapter_commands() {
        assert_eq!(
            registered_command_names(),
            &[
                "app_identity",
                "cave_read_discovery",
                "cave_launch",
                "cave_health",
                "cave_pairing_create",
                "cave_pairing_poll",
                "cave_pairing_exchange",
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
}
