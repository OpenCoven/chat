use serde_json::Value;
use tauri::State;

use crate::{
    cave::{NativeDiagnostic, OwnerDiscoveryRecord},
    metadata::AppIdentity,
    transport::CaveReadPath,
    NativeConnectionState,
};

pub const REGISTERED_COMMANDS: &[&str] = &[
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
];

#[tauri::command]
pub fn app_identity() -> AppIdentity {
    AppIdentity::current()
}

#[tauri::command]
pub fn cave_read_discovery(
    state: State<'_, NativeConnectionState>,
) -> Result<OwnerDiscoveryRecord, NativeDiagnostic> {
    state.cave_read_discovery()
}

#[tauri::command]
pub async fn cave_launch(state: State<'_, NativeConnectionState>) -> Result<(), NativeDiagnostic> {
    state.cave_launch().await
}

#[tauri::command]
pub async fn cave_health(
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    state.cave_health().await
}

#[tauri::command]
pub async fn cave_pairing_create(
    request: Value,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    state.cave_pairing_create(request).await
}

#[tauri::command]
pub async fn cave_pairing_poll(
    request_id: String,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    state.cave_pairing_poll(request_id).await
}

#[tauri::command]
pub async fn cave_pairing_exchange(
    request_id: String,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    state.cave_pairing_exchange(request_id).await
}

#[tauri::command]
pub async fn cave_credential_status(
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    state.cave_credential_status().await
}

#[tauri::command]
pub fn cave_forget_credential(
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    state.cave_forget_credential()
}

#[tauri::command]
pub async fn cave_list_familiars(
    page: crate::transport::NativePage,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    state.cave_read(CaveReadPath::Familiars { page }).await
}

#[tauri::command]
pub async fn cave_list_projects(
    page: crate::transport::NativePage,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    state.cave_read(CaveReadPath::Projects { page }).await
}

#[tauri::command]
pub async fn cave_list_conversations(
    page: crate::transport::NativePage,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    state.cave_read(CaveReadPath::Conversations { page }).await
}

#[tauri::command]
pub async fn cave_get_conversation(
    conversation_id: String,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    state
        .cave_read(CaveReadPath::Conversation { conversation_id })
        .await
}

#[tauri::command]
pub async fn cave_list_conversation_messages(
    conversation_id: String,
    page: crate::transport::NativePage,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    state
        .cave_read(CaveReadPath::ConversationMessages {
            conversation_id,
            page,
        })
        .await
}

pub fn registered_command_names() -> &'static [&'static str] {
    REGISTERED_COMMANDS
}
