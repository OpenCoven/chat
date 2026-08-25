mod cave;
mod commands;
mod connection;
mod keyring;
mod metadata;
mod transport;

use std::sync::{Arc, Mutex, MutexGuard};

use cave::NativeDiagnostic;
use cave::{CaveLauncher, NativeCaveLauncher};
use connection::{
    ConnectionKeyring, ConnectionRuntime, ConnectionTransport, NativeConnectionTransport,
};
use keyring::NativeKeyring;

pub use commands::{
    app_identity, cancel_pairing, get_connection_state, launch_cave, refresh_connection,
    registered_command_names, retry_connection, start_conversation, start_pairing,
    submit_manual_discovery,
};
pub use metadata::{AppIdentity, APP_IDENTIFIER, APP_NAME, APP_PHASE};

#[derive(Clone)]
pub struct NativeConnectionState {
    connection: Arc<Mutex<ConnectionRuntime>>,
    transport: Arc<dyn ConnectionTransport>,
    keyring: Arc<dyn ConnectionKeyring>,
    launcher: Arc<dyn CaveLauncher>,
}

impl Default for NativeConnectionState {
    fn default() -> Self {
        Self {
            connection: Arc::new(Mutex::new(ConnectionRuntime::default())),
            transport: Arc::new(NativeConnectionTransport),
            keyring: Arc::new(NativeKeyring),
            launcher: Arc::new(NativeCaveLauncher),
        }
    }
}

#[cfg(test)]
impl NativeConnectionState {
    pub(crate) fn with_collaborators(
        transport: Arc<dyn ConnectionTransport>,
        keyring: Arc<dyn ConnectionKeyring>,
    ) -> Self {
        Self {
            connection: Arc::new(Mutex::new(ConnectionRuntime::default())),
            transport,
            keyring,
            launcher: Arc::new(NativeCaveLauncher),
        }
    }

    pub(crate) fn with_collaborators_and_launcher(
        transport: Arc<dyn ConnectionTransport>,
        keyring: Arc<dyn ConnectionKeyring>,
        launcher: Arc<dyn CaveLauncher>,
    ) -> Self {
        Self {
            connection: Arc::new(Mutex::new(ConnectionRuntime::default())),
            transport,
            keyring,
            launcher,
        }
    }
}

impl NativeConnectionState {
    fn runtime(&self) -> Result<MutexGuard<'_, ConnectionRuntime>, NativeDiagnostic> {
        self.connection
            .lock()
            .map_err(|_| NativeDiagnostic::new("connection_state_unavailable", true))
    }
}

fn builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .manage(NativeConnectionState::default())
        .invoke_handler(tauri::generate_handler![
            app_identity,
            get_connection_state,
            refresh_connection,
            launch_cave,
            submit_manual_discovery,
            start_pairing,
            cancel_pairing,
            retry_connection,
            start_conversation
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
    fn registers_the_reviewed_native_command_table() {
        assert_eq!(
            registered_command_names(),
            &[
                "app_identity",
                "get_connection_state",
                "refresh_connection",
                "launch_cave",
                "submit_manual_discovery",
                "start_pairing",
                "cancel_pairing",
                "retry_connection",
                "start_conversation",
            ]
        );
    }
}
