mod cave_credentials;
mod commands;
mod coven_peer_identity;
mod coven_pipe_identity;
mod credential_lock;
mod metadata;
mod sdk_connection;
mod sdk_diagnostics;

pub use cave_credentials::{SecretValue, UnavailableCredentialCustody};
pub use commands::app_identity;
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub use coven_peer_identity::inspect_connected_unix_peer;
pub use coven_peer_identity::{validate_unix_peer_identity, UnixPeerIdentity};
pub use coven_pipe_identity::{
    validate_windows_pipe_identity, SystemWindowsPipeIdentityProvider, WindowsPipeIdentity,
    WindowsPipeIdentityProvider,
};
pub use metadata::{AppIdentity, APP_IDENTIFIER, APP_NAME, APP_PHASE};
pub use sdk_connection::{
    cave_credential_state, cave_forget_credential, cave_get_conversation, cave_health,
    cave_list_conversation_messages, cave_list_conversations, cave_list_familiars,
    cave_list_projects, cave_managed_pairing_create, cave_managed_pairing_exchange,
    cave_managed_pairing_poll, sdk_authority_close, sdk_authority_establish, sdk_discovery_read,
    sdk_installation_identity, sdk_native_diagnostics, AuthorityDescriptor, AuthorityLifecycle,
    CanonicalPageCommandInput, CanonicalPageOptions, DiscoveryHandleInput, HealthCommandInput,
    ManagedNativeAuthorityProvider, ManagedPairingCommandInput, NativeSdkBoundary, NativeSdkState,
    PairingRequest, ProviderFuture, ProviderPairingCreated, ProviderPairingExchange,
};
pub use sdk_diagnostics::{DiagnosticCode, NativeError, NativeResponse};

const REGISTERED_COMMANDS: &[&str] = &[
    "app_identity",
    "sdk_installation_identity",
    "sdk_discovery_read",
    "sdk_authority_establish",
    "sdk_authority_close",
    "cave_health",
    "cave_managed_pairing_create",
    "cave_managed_pairing_poll",
    "cave_managed_pairing_exchange",
    "cave_credential_state",
    "cave_forget_credential",
    "cave_list_familiars",
    "cave_list_projects",
    "cave_list_conversations",
    "cave_get_conversation",
    "cave_list_conversation_messages",
    "sdk_native_diagnostics",
];

pub fn registered_command_names() -> &'static [&'static str] {
    REGISTERED_COMMANDS
}

fn builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .manage(NativeSdkState::production())
        .invoke_handler(tauri::generate_handler![
            app_identity,
            sdk_installation_identity,
            sdk_discovery_read,
            sdk_authority_establish,
            sdk_authority_close,
            cave_health,
            cave_managed_pairing_create,
            cave_managed_pairing_poll,
            cave_managed_pairing_exchange,
            cave_credential_state,
            cave_forget_credential,
            cave_list_familiars,
            cave_list_projects,
            cave_list_conversations,
            cave_get_conversation,
            cave_list_conversation_messages,
            sdk_native_diagnostics,
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
    fn registers_the_initial_command_table() {
        assert_eq!(
            registered_command_names(),
            &[
                "app_identity",
                "sdk_installation_identity",
                "sdk_discovery_read",
                "sdk_authority_establish",
                "sdk_authority_close",
                "cave_health",
                "cave_managed_pairing_create",
                "cave_managed_pairing_poll",
                "cave_managed_pairing_exchange",
                "cave_credential_state",
                "cave_forget_credential",
                "cave_list_familiars",
                "cave_list_projects",
                "cave_list_conversations",
                "cave_get_conversation",
                "cave_list_conversation_messages",
                "sdk_native_diagnostics",
            ]
        );
    }
}
