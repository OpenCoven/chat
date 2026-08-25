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
    "cave_cancel_pairing",
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
    handle: String,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    state.cave_health(handle).await
}

#[tauri::command]
pub async fn cave_pairing_create(
    handle: String,
    request: Value,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    state.cave_pairing_create(handle, request).await
}

#[tauri::command]
pub async fn cave_pairing_poll(
    handle: String,
    request_id: String,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    state.cave_pairing_poll(handle, request_id).await
}

#[tauri::command]
pub async fn cave_pairing_exchange(
    handle: String,
    request_id: String,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    state.cave_pairing_exchange(handle, request_id).await
}

#[tauri::command]
pub fn cave_cancel_pairing(
    handle: String,
    request_id: String,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    state.cave_cancel_pairing(handle, request_id)
}

#[tauri::command]
pub async fn cave_credential_status(
    handle: String,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    state.cave_credential_status(handle).await
}

#[tauri::command]
pub fn cave_forget_credential(
    handle: String,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    state.cave_forget_credential(handle)
}

#[tauri::command]
pub async fn cave_list_familiars(
    handle: String,
    page: crate::transport::NativePage,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    state
        .cave_read(handle, CaveReadPath::Familiars { page })
        .await
}

#[tauri::command]
pub async fn cave_list_projects(
    handle: String,
    page: crate::transport::NativePage,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    state
        .cave_read(handle, CaveReadPath::Projects { page })
        .await
}

#[tauri::command]
pub async fn cave_list_conversations(
    handle: String,
    page: crate::transport::NativePage,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    state
        .cave_read(handle, CaveReadPath::Conversations { page })
        .await
}

#[tauri::command]
pub async fn cave_get_conversation(
    handle: String,
    conversation_id: String,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    state
        .cave_read(handle, CaveReadPath::Conversation { conversation_id })
        .await
}

#[tauri::command]
pub async fn cave_list_conversation_messages(
    handle: String,
    conversation_id: String,
    page: crate::transport::NativePage,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    state
        .cave_read(
            handle,
            CaveReadPath::ConversationMessages {
                conversation_id,
                page,
            },
        )
        .await
}

pub fn registered_command_names() -> &'static [&'static str] {
    REGISTERED_COMMANDS
}
