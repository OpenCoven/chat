use serde_json::Value;
use tauri::State;

use crate::{
    cave::{NativeDiagnostic, OwnerDiscoveryRecord},
    metadata::AppIdentity,
    operation::{NativeCancelReason, NativeCancelResult, NativeOperationInput},
    transport::CaveReadPath,
    NativeConnectionState,
};

pub const REGISTERED_COMMANDS: &[&str] = &[
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
    "cave_get_familiar_contract",
    "cave_get_familiar_analytics",
];

#[tauri::command]
pub fn app_identity() -> AppIdentity {
    AppIdentity::current()
}

#[tauri::command]
pub fn app_installation_id(
    state: State<'_, NativeConnectionState>,
) -> Result<String, NativeDiagnostic> {
    state.installation_id()
}

#[tauri::command]
pub async fn cave_read_discovery(
    operation: NativeOperationInput,
    state: State<'_, NativeConnectionState>,
) -> Result<OwnerDiscoveryRecord, NativeDiagnostic> {
    let runner = state.inner().clone();
    let operation_state = runner.clone();
    runner
        .run_controlled_operation(operation, move |lease| async move {
            operation_state.cave_read_discovery_managed(lease).await
        })
        .await
}

#[tauri::command]
pub fn cave_cancel_operation(
    attempt_id: String,
    reason: NativeCancelReason,
    state: State<'_, NativeConnectionState>,
) -> Result<NativeCancelResult, NativeDiagnostic> {
    state.cancel_operation(attempt_id, reason)
}

#[tauri::command]
pub async fn cave_launch(state: State<'_, NativeConnectionState>) -> Result<(), NativeDiagnostic> {
    state.cave_launch().await
}

#[tauri::command]
pub async fn cave_health(
    handle: String,
    operation: NativeOperationInput,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    let runner = state.inner().clone();
    let operation_state = runner.clone();
    runner
        .run_operation(operation, async move {
            operation_state.cave_health(handle).await
        })
        .await
}

#[tauri::command]
pub async fn coven_health(
    operation: NativeOperationInput,
    state: State<'_, NativeConnectionState>,
) -> Result<crate::CovenHealthResult, NativeDiagnostic> {
    let runner = state.inner().clone();
    let operation_state = runner.clone();
    runner
        .run_operation(
            operation,
            async move { operation_state.coven_health().await },
        )
        .await
}

#[tauri::command]
pub async fn cave_pairing_create(
    handle: String,
    request: Value,
    operation: NativeOperationInput,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    let runner = state.inner().clone();
    let operation_state = runner.clone();
    runner
        .run_operation(operation, async move {
            operation_state.cave_pairing_create(handle, request).await
        })
        .await
}

#[tauri::command]
pub async fn cave_pairing_poll(
    handle: String,
    request_id: String,
    operation: NativeOperationInput,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    let runner = state.inner().clone();
    let operation_state = runner.clone();
    runner
        .run_operation(operation, async move {
            operation_state.cave_pairing_poll(handle, request_id).await
        })
        .await
}

#[tauri::command]
pub async fn cave_pairing_exchange(
    handle: String,
    request_id: String,
    operation: NativeOperationInput,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    let runner = state.inner().clone();
    let operation_state = runner.clone();
    runner
        .run_mutating_operation(operation, move |mutation| async move {
            operation_state
                .cave_pairing_exchange_managed(handle, request_id, mutation)
                .await
        })
        .await
}

#[tauri::command]
pub fn cave_reset_pairing(
    handle: String,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    state.cave_reset_pairing(handle)
}

#[tauri::command]
pub async fn cave_credential_status(
    handle: String,
    operation: NativeOperationInput,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    let runner = state.inner().clone();
    let operation_state = runner.clone();
    runner
        .run_mutating_operation(operation, move |mutation| async move {
            operation_state
                .cave_credential_status_managed(handle, mutation)
                .await
        })
        .await
}

#[tauri::command]
pub async fn cave_forget_credential(
    handle: String,
    operation: NativeOperationInput,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    let runner = state.inner().clone();
    let operation_state = runner.clone();
    runner
        .run_mutating_operation(operation, move |mutation| async move {
            operation_state
                .cave_forget_credential_managed(handle, mutation)
                .await
        })
        .await
}

#[tauri::command]
pub async fn cave_list_familiars(
    handle: String,
    page: crate::transport::NativePage,
    operation: NativeOperationInput,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    let runner = state.inner().clone();
    let operation_state = runner.clone();
    runner
        .run_operation(operation, async move {
            operation_state
                .cave_read(handle, CaveReadPath::Familiars { page })
                .await
        })
        .await
}

#[tauri::command]
pub async fn cave_list_projects(
    handle: String,
    page: crate::transport::NativePage,
    operation: NativeOperationInput,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    let runner = state.inner().clone();
    let operation_state = runner.clone();
    runner
        .run_operation(operation, async move {
            operation_state
                .cave_read(handle, CaveReadPath::Projects { page })
                .await
        })
        .await
}

#[tauri::command]
pub async fn cave_list_conversations(
    handle: String,
    page: crate::transport::NativePage,
    operation: NativeOperationInput,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    let runner = state.inner().clone();
    let operation_state = runner.clone();
    runner
        .run_operation(operation, async move {
            operation_state
                .cave_read(handle, CaveReadPath::Conversations { page })
                .await
        })
        .await
}

#[tauri::command]
pub async fn cave_get_conversation(
    handle: String,
    conversation_id: String,
    operation: NativeOperationInput,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    let runner = state.inner().clone();
    let operation_state = runner.clone();
    runner
        .run_operation(operation, async move {
            operation_state
                .cave_read(handle, CaveReadPath::Conversation { conversation_id })
                .await
        })
        .await
}

#[tauri::command]
pub async fn cave_list_conversation_messages(
    handle: String,
    conversation_id: String,
    page: crate::transport::NativePage,
    operation: NativeOperationInput,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    let runner = state.inner().clone();
    let operation_state = runner.clone();
    runner
        .run_operation(operation, async move {
            operation_state
                .cave_read(
                    handle,
                    CaveReadPath::ConversationMessages {
                        conversation_id,
                        page,
                    },
                )
                .await
        })
        .await
}

pub fn registered_command_names() -> &'static [&'static str] {
    REGISTERED_COMMANDS
}

#[tauri::command]
pub async fn cave_get_familiar_contract(
    handle: String,
    familiar_id: String,
    operation: NativeOperationInput,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    let runner = state.inner().clone();
    let operation_state = runner.clone();
    runner
        .run_operation(operation, async move {
            operation_state
                .cave_read(handle, CaveReadPath::FamiliarContract { familiar_id })
                .await
        })
        .await
}

#[tauri::command]
pub async fn cave_get_familiar_analytics(
    handle: String,
    familiar_id: String,
    window: Option<String>,
    recent_limit: Option<u16>,
    operation: NativeOperationInput,
    state: State<'_, NativeConnectionState>,
) -> Result<Value, NativeDiagnostic> {
    let runner = state.inner().clone();
    let operation_state = runner.clone();
    runner
        .run_operation(operation, async move {
            operation_state
                .cave_read(
                    handle,
                    CaveReadPath::FamiliarAnalytics {
                        familiar_id,
                        window,
                        recent_limit,
                    },
                )
                .await
        })
        .await
}
