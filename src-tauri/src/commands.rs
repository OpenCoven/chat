use tauri::State;

use crate::{
    connection::{ConnectionStateDto, PairingStateDto},
    metadata::AppIdentity,
    transport::{ConversationStartDto, StartConversationInput},
    NativeConnectionState,
};

pub const REGISTERED_COMMANDS: &[&str] = &[
    "app_identity",
    "get_connection_state",
    "refresh_connection",
    "launch_cave",
    "submit_manual_discovery",
    "start_pairing",
    "cancel_pairing",
    "retry_connection",
    "start_conversation",
];

#[tauri::command]
pub fn app_identity() -> AppIdentity {
    AppIdentity::current()
}

#[tauri::command]
pub fn get_connection_state(
    state: State<'_, NativeConnectionState>,
) -> Result<ConnectionStateDto, crate::cave::NativeDiagnostic> {
    state.connection_state()
}

#[tauri::command]
pub async fn refresh_connection(
    state: State<'_, NativeConnectionState>,
) -> Result<ConnectionStateDto, crate::cave::NativeDiagnostic> {
    state.refresh_connection().await
}

#[tauri::command]
pub async fn launch_cave(
    state: State<'_, NativeConnectionState>,
) -> Result<ConnectionStateDto, crate::cave::NativeDiagnostic> {
    state.launch_cave().await
}

#[tauri::command]
pub async fn submit_manual_discovery(
    discovery_url: String,
    state: State<'_, NativeConnectionState>,
) -> Result<crate::cave::DiscoverySnapshot, crate::cave::NativeDiagnostic> {
    state.submit_manual_discovery(discovery_url).await
}

#[tauri::command]
pub async fn start_pairing(
    state: State<'_, NativeConnectionState>,
) -> Result<PairingStateDto, crate::cave::NativeDiagnostic> {
    state.start_pairing().await
}

#[tauri::command]
pub fn cancel_pairing(
    request_id: String,
    state: State<'_, NativeConnectionState>,
) -> Result<ConnectionStateDto, crate::cave::NativeDiagnostic> {
    state.cancel_pairing(request_id)
}

#[tauri::command]
pub fn retry_connection(
    state: State<'_, NativeConnectionState>,
) -> Result<ConnectionStateDto, crate::cave::NativeDiagnostic> {
    state.retry_connection()
}

#[tauri::command]
pub async fn start_conversation(
    input: StartConversationInput,
    state: State<'_, NativeConnectionState>,
) -> Result<ConversationStartDto, crate::cave::NativeDiagnostic> {
    state.start_conversation(input).await
}

pub fn registered_command_names() -> &'static [&'static str] {
    REGISTERED_COMMANDS
}
