use std::{
    collections::HashMap,
    env,
    io::{self, BufRead, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, MutexGuard},
};

use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::{
    cave::{
        CaveChild, CaveLauncher, NativeCaveClock, NativeCaveDiscoveryReader, NativeCaveSleeper,
        NativeCaveTaskRunner, NativeDiagnostic, NativeResult,
    },
    keyring::{
        validate_credential_origin, Credential, CredentialCustody, CredentialSlot, KeyringError,
    },
    operation::{
        NativeCancelReason, NativeOperationInput, NativeOperationRegistry,
        MAX_NATIVE_OPERATION_TIMEOUT_MS,
    },
    transport::{
        validate_pairing_request, CaveReadPath, ConstrainedTransport, NativeCaveTransport,
        NativePage,
    },
    NativeConnectionState,
};

const MAX_LINE_BYTES: usize = 64 * 1024;
const MAX_REQUEST_ID_BYTES: usize = 128;
const MAX_RPC_WORKERS: usize = 256;
const INVALID_REQUEST_ID: &str = "invalid-request";
pub const CONFORMANCE_INSTALLATION_ID: &str = "4e1d02ca-833b-4d9d-8e9f-31bb8f44f9b5";
pub const CONFORMANCE_NODE_PATH_ENV: &str = "OPENCOVEN_PHASE1_CONFORMANCE_NODE_PATH";
pub const CONFORMANCE_CAVE_SERVER_PATH_ENV: &str = "OPENCOVEN_PHASE1_CONFORMANCE_CAVE_SERVER_PATH";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StrictRequest {
    id: String,
    command: String,
    #[serde(default)]
    args: Option<Value>,
}

struct RpcRequest {
    id: String,
    command: RpcCommand,
}

enum RpcCommand {
    AppInstallationId,
    CaveReadDiscovery {
        operation: NativeOperationInput,
    },
    CaveCancelOperation {
        attempt_id: String,
        reason: NativeCancelReason,
    },
    CaveLaunch,
    CaveHealth {
        handle: String,
        operation: NativeOperationInput,
    },
    CavePairingCreate {
        handle: String,
        request: Value,
        operation: NativeOperationInput,
    },
    CavePairingPoll {
        handle: String,
        request_id: String,
        operation: NativeOperationInput,
    },
    CavePairingExchange {
        handle: String,
        request_id: String,
        operation: NativeOperationInput,
    },
    CaveResetPairing {
        handle: String,
    },
    CaveCredentialStatus {
        handle: String,
        operation: NativeOperationInput,
    },
    CaveForgetCredential {
        handle: String,
        operation: NativeOperationInput,
    },
    CaveListFamiliars {
        handle: String,
        page: NativePage,
        operation: NativeOperationInput,
    },
    CaveListProjects {
        handle: String,
        page: NativePage,
        operation: NativeOperationInput,
    },
    CaveListConversations {
        handle: String,
        page: NativePage,
        operation: NativeOperationInput,
    },
    CaveGetConversation {
        handle: String,
        conversation_id: String,
        operation: NativeOperationInput,
    },
    CaveListConversationMessages {
        handle: String,
        conversation_id: String,
        page: NativePage,
        operation: NativeOperationInput,
    },
    ResetNativeState,
    Shutdown,
}

impl RpcCommand {
    fn runs_concurrently(&self) -> bool {
        matches!(
            self,
            Self::CaveReadDiscovery { .. }
                | Self::CaveHealth { .. }
                | Self::CavePairingCreate { .. }
                | Self::CavePairingPoll { .. }
                | Self::CavePairingExchange { .. }
                | Self::CaveCredentialStatus { .. }
                | Self::CaveForgetCredential { .. }
                | Self::CaveListFamiliars { .. }
                | Self::CaveListProjects { .. }
                | Self::CaveListConversations { .. }
                | Self::CaveGetConversation { .. }
                | Self::CaveListConversationMessages { .. }
        )
    }

    fn is_barrier(&self) -> bool {
        matches!(
            self,
            Self::CaveLaunch
                | Self::CaveResetPairing { .. }
                | Self::ResetNativeState
                | Self::Shutdown
        )
    }
}

#[derive(Clone)]
pub struct SharedMemoryCredentialCustody {
    store: Arc<Mutex<SharedCredentialStore>>,
}

struct SharedCredentialStore {
    credentials: HashMap<String, Credential>,
}

impl SharedMemoryCredentialCustody {
    pub fn new() -> Self {
        Self {
            store: Arc::new(Mutex::new(SharedCredentialStore {
                credentials: HashMap::new(),
            })),
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, SharedCredentialStore>, KeyringError> {
        self.store.lock().map_err(|_| KeyringError::Failure)
    }
}

impl Default for SharedMemoryCredentialCustody {
    fn default() -> Self {
        Self::new()
    }
}

fn validate_instance_id(instance_id: &str) -> Result<(), KeyringError> {
    if instance_id.is_empty() || instance_id.len() > 128 {
        return Err(KeyringError::Failure);
    }
    Ok(())
}

impl CredentialCustody for SharedMemoryCredentialCustody {
    fn installation_id(&self) -> Result<String, KeyringError> {
        Ok(CONFORMANCE_INSTALLATION_ID.to_owned())
    }

    fn read(&self, instance_id: &str, origin: &str) -> Result<Credential, KeyringError> {
        match self.read_for_pairing_update(instance_id, origin)? {
            CredentialSlot::Current(credential) => Ok(credential),
            CredentialSlot::Missing | CredentialSlot::Stale(_) => Err(KeyringError::NotFound),
        }
    }

    fn read_for_pairing_update(
        &self,
        instance_id: &str,
        origin: &str,
    ) -> Result<CredentialSlot, KeyringError> {
        validate_instance_id(instance_id)?;
        validate_credential_origin(origin)?;
        let store = self.lock()?;
        let Some(credential) = store.credentials.get(instance_id).cloned() else {
            return Ok(CredentialSlot::Missing);
        };
        if credential.origin == origin {
            Ok(CredentialSlot::Current(credential))
        } else {
            Ok(CredentialSlot::Stale(credential))
        }
    }

    fn store_if_current(
        &self,
        instance_id: &str,
        origin: &str,
        expected_credential: Option<&Credential>,
        bearer: &str,
        credential_id: &str,
    ) -> Result<bool, KeyringError> {
        validate_instance_id(instance_id)?;
        validate_credential_origin(origin)?;
        if let Some(expected_credential) = expected_credential {
            validate_credential_origin(&expected_credential.origin)?;
        }
        if bearer.is_empty() || credential_id.is_empty() {
            return Err(KeyringError::Failure);
        }
        let mut store = self.lock()?;
        let matches_expected = match (store.credentials.get(instance_id), expected_credential) {
            (None, None) => true,
            (Some(current), Some(expected)) => {
                current.origin == origin
                    && current.bearer == expected.bearer
                    && current.credential_id == expected.credential_id
                    && current.origin == expected.origin
            }
            _ => false,
        };
        if !matches_expected {
            return Ok(false);
        }
        store.credentials.insert(
            instance_id.to_owned(),
            Credential {
                bearer: bearer.to_owned(),
                credential_id: credential_id.to_owned(),
                origin: origin.to_owned(),
            },
        );
        Ok(true)
    }

    fn replace_stale_if_current(
        &self,
        instance_id: &str,
        origin: &str,
        expected_stale_credential: &Credential,
        bearer: &str,
        credential_id: &str,
    ) -> Result<bool, KeyringError> {
        validate_instance_id(instance_id)?;
        validate_credential_origin(origin)?;
        validate_credential_origin(&expected_stale_credential.origin)?;
        if bearer.is_empty()
            || credential_id.is_empty()
            || expected_stale_credential.origin == origin
        {
            return Err(KeyringError::Failure);
        }
        let mut store = self.lock()?;
        let Some(current) = store.credentials.get(instance_id) else {
            return Ok(false);
        };
        if current.origin == origin
            || current.bearer != expected_stale_credential.bearer
            || current.credential_id != expected_stale_credential.credential_id
            || current.origin != expected_stale_credential.origin
        {
            return Ok(false);
        }
        store.credentials.insert(
            instance_id.to_owned(),
            Credential {
                bearer: bearer.to_owned(),
                credential_id: credential_id.to_owned(),
                origin: origin.to_owned(),
            },
        );
        Ok(true)
    }

    fn delete_if_matches(
        &self,
        instance_id: &str,
        origin: &str,
        expected_credential: &Credential,
    ) -> Result<bool, KeyringError> {
        validate_instance_id(instance_id)?;
        validate_credential_origin(origin)?;
        validate_credential_origin(&expected_credential.origin)?;
        let mut store = self.lock()?;
        let Some(current) = store.credentials.get(instance_id) else {
            return Ok(false);
        };
        if current.origin != origin
            || current.bearer != expected_credential.bearer
            || current.credential_id != expected_credential.credential_id
            || current.origin != expected_credential.origin
        {
            return Ok(false);
        }
        store.credentials.remove(instance_id);
        Ok(true)
    }
}

pub struct ConformanceCaveLauncher;

struct ConformanceCaveChild {
    child: Child,
    reaped: bool,
}

impl ConformanceCaveChild {
    fn terminate_and_reap(&mut self) {
        if self.reaped {
            return;
        }
        let _ = self.child.kill();
        if self.child.wait().is_ok() {
            self.reaped = true;
        }
    }
}

impl CaveChild for ConformanceCaveChild {
    fn try_wait(&mut self) -> NativeResult<bool> {
        if self.reaped {
            return Ok(true);
        }
        self.child
            .try_wait()
            .map(|status| {
                self.reaped = status.is_some();
                self.reaped
            })
            .map_err(|_| NativeDiagnostic::new("cave_launch_failed", true))
    }

    fn terminate(&mut self) -> NativeResult<()> {
        if self.reaped {
            return Ok(());
        }
        match self.child.kill() {
            Ok(()) | Err(_) => {}
        }
        Ok(())
    }

    fn wait(&mut self) -> NativeResult<()> {
        if self.reaped {
            return Ok(());
        }
        self.child
            .wait()
            .map(|_| {
                self.reaped = true;
            })
            .map_err(|_| NativeDiagnostic::new("cave_launch_failed", true))
    }
}

impl Drop for ConformanceCaveChild {
    fn drop(&mut self) {
        self.terminate_and_reap();
    }
}

fn regular_absolute_environment_path(name: &str) -> NativeResult<PathBuf> {
    let path = env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| NativeDiagnostic::new("cave_launch_configuration_invalid", false))?;
    if !path.is_absolute() {
        return Err(NativeDiagnostic::new(
            "cave_launch_configuration_invalid",
            false,
        ));
    }
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|_| NativeDiagnostic::new("cave_launch_configuration_invalid", false))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(NativeDiagnostic::new(
            "cave_launch_configuration_invalid",
            false,
        ));
    }
    Ok(path)
}

impl CaveLauncher for ConformanceCaveLauncher {
    fn launch(&self) -> NativeResult<Box<dyn CaveChild>> {
        let node = regular_absolute_environment_path(CONFORMANCE_NODE_PATH_ENV)?;
        let server = regular_absolute_environment_path(CONFORMANCE_CAVE_SERVER_PATH_ENV)?;
        let child = Command::new(node)
            .arg(server)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|_| NativeDiagnostic::new("cave_launch_failed", true))?;
        Ok(Box::new(ConformanceCaveChild {
            child,
            reaped: false,
        }))
    }
}

#[derive(Clone)]
pub struct RpcRuntime {
    custody: SharedMemoryCredentialCustody,
    state: NativeConnectionState,
}

impl RpcRuntime {
    pub fn new() -> Self {
        let custody = SharedMemoryCredentialCustody::new();
        let operations = Arc::new(NativeOperationRegistry::default());
        Self {
            state: state_with_custody(&custody, operations),
            custody,
        }
    }

    fn reset_native_state(&mut self) {
        self.state
            .cancel_all_operations(NativeCancelReason::Aborted);
        let operations = self.state.operation_registry();
        self.state = state_with_custody(&self.custody, operations);
    }

    pub fn process_line(&mut self, line: &[u8]) -> Value {
        self.process_line_with_action(line).0
    }

    fn process_line_with_action(&mut self, line: &[u8]) -> (Value, bool) {
        let request = match parse_request_line(line) {
            Ok(request) => request,
            Err(response) => return (response, false),
        };
        self.process_request(request)
    }

    fn process_request(&mut self, request: RpcRequest) -> (Value, bool) {
        let id = request.id;
        match self.dispatch(request.command) {
            Ok((result, shutdown)) => (success_response(id, result), shutdown),
            Err(error) => (failure_response(id, error.code, error.retryable), false),
        }
    }

    fn dispatch(&mut self, command: RpcCommand) -> Result<(Value, bool), NativeDiagnostic> {
        let result = match command {
            RpcCommand::AppInstallationId => json!(self.state.installation_id()?),
            RpcCommand::CaveReadDiscovery { operation } => {
                let runner = self.state.clone();
                let operation_state = runner.clone();
                value_from(tauri::async_runtime::block_on(
                    runner.run_operation(operation, async move {
                        operation_state.cave_read_discovery()
                    }),
                )?)?
            }
            RpcCommand::CaveCancelOperation { attempt_id, reason } => {
                value_from(self.state.cancel_operation(attempt_id, reason)?)?
            }
            RpcCommand::CaveLaunch => {
                tauri::async_runtime::block_on(self.state.cave_launch())?;
                Value::Null
            }
            RpcCommand::CaveHealth { handle, operation } => {
                let runner = self.state.clone();
                let operation_state = runner.clone();
                tauri::async_runtime::block_on(runner.run_operation(operation, async move {
                    operation_state.cave_health(handle).await
                }))?
            }
            RpcCommand::CavePairingCreate {
                handle,
                request,
                operation,
            } => {
                let runner = self.state.clone();
                let operation_state = runner.clone();
                tauri::async_runtime::block_on(runner.run_operation(operation, async move {
                    operation_state.cave_pairing_create(handle, request).await
                }))?
            }
            RpcCommand::CavePairingPoll {
                handle,
                request_id,
                operation,
            } => {
                let runner = self.state.clone();
                let operation_state = runner.clone();
                tauri::async_runtime::block_on(runner.run_operation(operation, async move {
                    operation_state.cave_pairing_poll(handle, request_id).await
                }))?
            }
            RpcCommand::CavePairingExchange {
                handle,
                request_id,
                operation,
            } => {
                let runner = self.state.clone();
                let operation_state = runner.clone();
                tauri::async_runtime::block_on(runner.run_operation(operation, async move {
                    operation_state
                        .cave_pairing_exchange(handle, request_id)
                        .await
                }))?
            }
            RpcCommand::CaveResetPairing { handle } => self.state.cave_reset_pairing(handle)?,
            RpcCommand::CaveCredentialStatus { handle, operation } => {
                let runner = self.state.clone();
                let operation_state = runner.clone();
                tauri::async_runtime::block_on(runner.run_operation(operation, async move {
                    operation_state.cave_credential_status(handle).await
                }))?
            }
            RpcCommand::CaveForgetCredential { handle, operation } => {
                let runner = self.state.clone();
                let operation_state = runner.clone();
                tauri::async_runtime::block_on(runner.run_operation(operation, async move {
                    operation_state.cave_forget_credential(handle)
                }))?
            }
            RpcCommand::CaveListFamiliars {
                handle,
                page,
                operation,
            } => {
                let runner = self.state.clone();
                let operation_state = runner.clone();
                tauri::async_runtime::block_on(runner.run_operation(operation, async move {
                    operation_state
                        .cave_read(handle, CaveReadPath::Familiars { page })
                        .await
                }))?
            }
            RpcCommand::CaveListProjects {
                handle,
                page,
                operation,
            } => {
                let runner = self.state.clone();
                let operation_state = runner.clone();
                tauri::async_runtime::block_on(runner.run_operation(operation, async move {
                    operation_state
                        .cave_read(handle, CaveReadPath::Projects { page })
                        .await
                }))?
            }
            RpcCommand::CaveListConversations {
                handle,
                page,
                operation,
            } => {
                let runner = self.state.clone();
                let operation_state = runner.clone();
                tauri::async_runtime::block_on(runner.run_operation(operation, async move {
                    operation_state
                        .cave_read(handle, CaveReadPath::Conversations { page })
                        .await
                }))?
            }
            RpcCommand::CaveGetConversation {
                handle,
                conversation_id,
                operation,
            } => {
                let runner = self.state.clone();
                let operation_state = runner.clone();
                tauri::async_runtime::block_on(runner.run_operation(operation, async move {
                    operation_state
                        .cave_read(handle, CaveReadPath::Conversation { conversation_id })
                        .await
                }))?
            }
            RpcCommand::CaveListConversationMessages {
                handle,
                conversation_id,
                page,
                operation,
            } => {
                let runner = self.state.clone();
                let operation_state = runner.clone();
                tauri::async_runtime::block_on(runner.run_operation(operation, async move {
                    operation_state
                        .cave_read(
                            handle,
                            CaveReadPath::ConversationMessages {
                                conversation_id,
                                page,
                            },
                        )
                        .await
                }))?
            }
            RpcCommand::ResetNativeState => {
                self.reset_native_state();
                json!({ "status": "reset" })
            }
            RpcCommand::Shutdown => return Ok((json!({ "status": "shutting_down" }), true)),
        };
        Ok((result, false))
    }
}

impl Default for RpcRuntime {
    fn default() -> Self {
        Self::new()
    }
}

fn state_with_custody(
    custody: &SharedMemoryCredentialCustody,
    operations: Arc<NativeOperationRegistry>,
) -> NativeConnectionState {
    NativeConnectionState::with_test_launch_collaborators(
        Arc::new(ConstrainedTransport) as Arc<dyn NativeCaveTransport>,
        Arc::new(custody.clone()) as Arc<dyn CredentialCustody>,
        Arc::new(NativeCaveDiscoveryReader),
        Arc::new(ConformanceCaveLauncher),
        Arc::new(NativeCaveClock::default()),
        Arc::new(NativeCaveSleeper),
        Arc::new(NativeCaveTaskRunner),
    )
    .using_operation_registry(operations)
}

fn value_from<T: serde::Serialize>(value: T) -> NativeResult<Value> {
    serde_json::to_value(value)
        .map_err(|_| NativeDiagnostic::new("conformance_serialization_failure", false))
}

fn valid_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_REQUEST_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn parsed_request_id(value: &Value) -> &str {
    value
        .as_object()
        .and_then(|object| object.get("id"))
        .and_then(Value::as_str)
        .filter(|id| valid_request_id(id))
        .unwrap_or(INVALID_REQUEST_ID)
}

fn parse_request_line(line: &[u8]) -> Result<RpcRequest, Value> {
    if line.len() > MAX_LINE_BYTES {
        return Err(failure_response(
            INVALID_REQUEST_ID,
            "invalid_request",
            false,
        ));
    }
    let value = match serde_json::from_slice::<Value>(line) {
        Ok(value) => value,
        Err(_) => {
            return Err(failure_response(
                INVALID_REQUEST_ID,
                "invalid_request",
                false,
            ));
        }
    };
    let id = parsed_request_id(&value).to_owned();
    let object = value
        .as_object()
        .ok_or_else(|| failure_response(INVALID_REQUEST_ID, "invalid_request", false))?;
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "id" | "command" | "args"))
    {
        return Err(failure_response(id, "invalid_request", false));
    }
    if object.contains_key("args") && !object["args"].is_object() {
        return Err(failure_response(id, "invalid_request", false));
    }
    let strict = serde_json::from_slice::<StrictRequest>(line)
        .map_err(|_| failure_response(id.clone(), "invalid_request", false))?;
    if !valid_request_id(&strict.id) {
        return Err(failure_response(
            INVALID_REQUEST_ID,
            "invalid_request",
            false,
        ));
    }
    let command = parse_command(&strict.command, strict.args)
        .map_err(|(code, retryable)| failure_response(strict.id.clone(), code, retryable))?;
    Ok(RpcRequest {
        id: strict.id,
        command,
    })
}

fn parse_command(command: &str, args: Option<Value>) -> Result<RpcCommand, (&'static str, bool)> {
    let args = args.unwrap_or_else(|| Value::Object(Map::new()));
    let object = args.as_object().ok_or(("invalid_native_input", false))?;
    let invalid = || Err(("invalid_native_input", false));
    match command {
        "app_installation_id" => {
            expect_exact_args(object, &[])?;
            Ok(RpcCommand::AppInstallationId)
        }
        "cave_read_discovery" => {
            expect_exact_args(object, &["operation"])?;
            Ok(RpcCommand::CaveReadDiscovery {
                operation: required_operation(object)?,
            })
        }
        "cave_cancel_operation" => {
            expect_exact_args(object, &["attemptId", "reason"])?;
            Ok(RpcCommand::CaveCancelOperation {
                attempt_id: required_attempt_id(object, "attemptId")?,
                reason: required_cancel_reason(object, "reason")?,
            })
        }
        "cave_launch" => {
            expect_exact_args(object, &[])?;
            Ok(RpcCommand::CaveLaunch)
        }
        "cave_health" => {
            expect_exact_args(object, &["handle", "operation"])?;
            Ok(RpcCommand::CaveHealth {
                handle: required_string(object, "handle")?,
                operation: required_operation(object)?,
            })
        }
        "cave_pairing_create" => {
            expect_exact_args(object, &["handle", "operation", "request"])?;
            let request = object
                .get("request")
                .filter(|value| value.is_object())
                .cloned();
            match request {
                Some(request) if validate_pairing_request(&request).is_ok() => {
                    Ok(RpcCommand::CavePairingCreate {
                        handle: required_string(object, "handle")?,
                        request,
                        operation: required_operation(object)?,
                    })
                }
                None => invalid(),
                Some(_) => invalid(),
            }
        }
        "cave_pairing_poll" => {
            expect_exact_args(object, &["handle", "operation", "requestId"])?;
            Ok(RpcCommand::CavePairingPoll {
                handle: required_string(object, "handle")?,
                request_id: required_pairing_request_id(object, "requestId")?,
                operation: required_operation(object)?,
            })
        }
        "cave_pairing_exchange" => {
            expect_exact_args(object, &["handle", "operation", "requestId"])?;
            Ok(RpcCommand::CavePairingExchange {
                handle: required_string(object, "handle")?,
                request_id: required_pairing_request_id(object, "requestId")?,
                operation: required_operation(object)?,
            })
        }
        "cave_reset_pairing" => {
            expect_exact_args(object, &["handle"])?;
            Ok(RpcCommand::CaveResetPairing {
                handle: required_string(object, "handle")?,
            })
        }
        "cave_credential_status" => {
            expect_exact_args(object, &["handle", "operation"])?;
            Ok(RpcCommand::CaveCredentialStatus {
                handle: required_string(object, "handle")?,
                operation: required_operation(object)?,
            })
        }
        "cave_forget_credential" => {
            expect_exact_args(object, &["handle", "operation"])?;
            Ok(RpcCommand::CaveForgetCredential {
                handle: required_string(object, "handle")?,
                operation: required_operation(object)?,
            })
        }
        "cave_list_familiars" => {
            expect_exact_args(object, &["handle", "operation", "page"])?;
            Ok(RpcCommand::CaveListFamiliars {
                handle: required_string(object, "handle")?,
                page: required_page(object)?,
                operation: required_operation(object)?,
            })
        }
        "cave_list_projects" => {
            expect_exact_args(object, &["handle", "operation", "page"])?;
            Ok(RpcCommand::CaveListProjects {
                handle: required_string(object, "handle")?,
                page: required_page(object)?,
                operation: required_operation(object)?,
            })
        }
        "cave_list_conversations" => {
            expect_exact_args(object, &["handle", "operation", "page"])?;
            Ok(RpcCommand::CaveListConversations {
                handle: required_string(object, "handle")?,
                page: required_page(object)?,
                operation: required_operation(object)?,
            })
        }
        "cave_get_conversation" => {
            expect_exact_args(object, &["conversationId", "handle", "operation"])?;
            Ok(RpcCommand::CaveGetConversation {
                handle: required_string(object, "handle")?,
                conversation_id: required_conversation_id(object, "conversationId")?,
                operation: required_operation(object)?,
            })
        }
        "cave_list_conversation_messages" => {
            expect_exact_args(object, &["conversationId", "handle", "operation", "page"])?;
            Ok(RpcCommand::CaveListConversationMessages {
                handle: required_string(object, "handle")?,
                conversation_id: required_conversation_id(object, "conversationId")?,
                page: required_page(object)?,
                operation: required_operation(object)?,
            })
        }
        "conformance_reset_native_state" => {
            expect_exact_args(object, &[])?;
            Ok(RpcCommand::ResetNativeState)
        }
        "conformance_shutdown" => {
            expect_exact_args(object, &[])?;
            Ok(RpcCommand::Shutdown)
        }
        _ => Err(("invalid_rpc_command", false)),
    }
}

fn expect_exact_args(
    object: &Map<String, Value>,
    expected: &[&str],
) -> Result<(), (&'static str, bool)> {
    if object.len() != expected.len()
        || object
            .keys()
            .any(|key| !expected.iter().any(|expected| key == expected))
    {
        return Err(("invalid_native_input", false));
    }
    Ok(())
}

fn required_string(object: &Map<String, Value>, key: &str) -> Result<String, (&'static str, bool)> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or(("invalid_native_input", false))
}

fn required_attempt_id(
    object: &Map<String, Value>,
    key: &str,
) -> Result<String, (&'static str, bool)> {
    let attempt_id = required_string(object, key)?;
    NativeOperationInput::new(attempt_id.clone(), 1)
        .map_err(|_| ("invalid_native_input", false))?;
    Ok(attempt_id)
}

fn required_operation(
    object: &Map<String, Value>,
) -> Result<NativeOperationInput, (&'static str, bool)> {
    let operation = object
        .get("operation")
        .and_then(Value::as_object)
        .ok_or(("invalid_native_input", false))?;
    expect_exact_args(operation, &["attemptId", "timeoutMs"])?;
    let attempt_id = required_string(operation, "attemptId")?;
    let timeout_ms = operation
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value <= MAX_NATIVE_OPERATION_TIMEOUT_MS)
        .ok_or(("invalid_native_input", false))?;
    NativeOperationInput::new(attempt_id, timeout_ms).map_err(|_| ("invalid_native_input", false))
}

fn required_cancel_reason(
    object: &Map<String, Value>,
    key: &str,
) -> Result<NativeCancelReason, (&'static str, bool)> {
    match object.get(key).and_then(Value::as_str) {
        Some("aborted") => Ok(NativeCancelReason::Aborted),
        Some("timeout") => Ok(NativeCancelReason::Timeout),
        _ => Err(("invalid_native_input", false)),
    }
}

fn required_conversation_id(
    object: &Map<String, Value>,
    key: &str,
) -> Result<String, (&'static str, bool)> {
    let value = required_string(object, key)?;
    if value.trim().is_empty()
        || matches!(value.as_str(), "." | "..")
        || value.len() > 2_048
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~'))
    {
        return Err(("invalid_native_input", false));
    }
    Ok(value)
}

fn required_pairing_request_id(
    object: &Map<String, Value>,
    key: &str,
) -> Result<String, (&'static str, bool)> {
    let value = required_string(object, key)?;
    let parsed = uuid::Uuid::parse_str(&value).map_err(|_| ("invalid_native_input", false))?;
    if parsed.to_string() != value || parsed.get_variant() != uuid::Variant::RFC4122 {
        return Err(("invalid_native_input", false));
    }
    Ok(value)
}

fn required_page(object: &Map<String, Value>) -> Result<NativePage, (&'static str, bool)> {
    let page = object
        .get("page")
        .and_then(Value::as_object)
        .ok_or(("invalid_native_input", false))?;
    expect_allowed_args(page, &["limit", "cursor"])?;
    let limit = match page.get("limit") {
        Some(value) => value
            .as_u64()
            .and_then(|limit| u16::try_from(limit).ok())
            .ok_or(("invalid_native_input", false))?,
        None => 0,
    };
    let cursor = match page.get("cursor") {
        Some(value) => Some(
            value
                .as_str()
                .map(str::to_owned)
                .ok_or(("invalid_native_input", false))?,
        ),
        None => None,
    };
    let page = NativePage {
        limit: page.contains_key("limit").then_some(limit),
        cursor,
    };
    page.validate()
        .map_err(|_| ("invalid_native_input", false))?;
    Ok(page)
}

fn expect_allowed_args(
    object: &Map<String, Value>,
    allowed: &[&str],
) -> Result<(), (&'static str, bool)> {
    if object
        .keys()
        .any(|key| !allowed.iter().any(|allowed| key == allowed))
    {
        return Err(("invalid_native_input", false));
    }
    Ok(())
}

fn success_response(id: String, result: Value) -> Value {
    json!({
        "id": id,
        "ok": true,
        "result": result,
    })
}

fn failure_response(id: impl Into<String>, code: &'static str, retryable: bool) -> Value {
    json!({
        "id": id.into(),
        "ok": false,
        "error": {
            "code": code,
            "retryable": retryable,
        },
    })
}

enum BoundedLine {
    Line(Vec<u8>),
    Oversized,
}

fn read_bounded_line(reader: &mut impl BufRead) -> io::Result<Option<BoundedLine>> {
    let mut line = Vec::with_capacity(8 * 1024);
    let mut oversized = false;
    let mut read_any = false;

    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return if read_any {
                Ok(Some(if oversized {
                    BoundedLine::Oversized
                } else {
                    BoundedLine::Line(line)
                }))
            } else {
                Ok(None)
            };
        }
        read_any = true;

        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let content_len = newline.unwrap_or(buffer.len());
        if !oversized {
            let remaining = MAX_LINE_BYTES - line.len();
            let copy_len = content_len.min(remaining);
            line.extend_from_slice(&buffer[..copy_len]);
            oversized = content_len > remaining;
        }

        let consumed = newline.map_or(buffer.len(), |position| position + 1);
        reader.consume(consumed);
        if newline.is_some() {
            return Ok(Some(if oversized {
                BoundedLine::Oversized
            } else {
                BoundedLine::Line(line)
            }));
        }
    }
}

pub fn run_stdio() -> io::Result<()> {
    let mut runtime = RpcRuntime::new();
    let stdin = io::stdin();
    let mut stdin = stdin.lock();
    let stdout = Arc::new(Mutex::new(io::BufWriter::new(io::stdout())));
    let mut workers = Vec::new();
    while let Some(line) = read_bounded_line(&mut stdin)? {
        reap_rpc_workers(&mut workers)?;
        let request = match line {
            BoundedLine::Line(line) => match parse_request_line(&line) {
                Ok(request) => request,
                Err(response) => {
                    write_rpc_response(&stdout, &response)?;
                    continue;
                }
            },
            BoundedLine::Oversized => {
                write_rpc_response(
                    &stdout,
                    &failure_response(INVALID_REQUEST_ID, "invalid_request", false),
                )?;
                continue;
            }
        };
        if request.command.runs_concurrently() {
            if workers.len() >= MAX_RPC_WORKERS {
                write_rpc_response(
                    &stdout,
                    &failure_response(request.id, "service_unavailable", true),
                )?;
                continue;
            }
            let mut worker_runtime = runtime.clone();
            let worker_stdout = Arc::clone(&stdout);
            workers.push(std::thread::spawn(move || {
                let (response, _) = worker_runtime.process_request(request);
                write_rpc_response(&worker_stdout, &response)
            }));
            continue;
        }
        if request.command.is_barrier() {
            runtime
                .state
                .cancel_all_operations(NativeCancelReason::Aborted);
            join_rpc_workers(&mut workers)?;
        }
        let (response, shutdown) = runtime.process_request(request);
        write_rpc_response(&stdout, &response)?;
        if shutdown {
            break;
        }
    }
    runtime
        .state
        .cancel_all_operations(NativeCancelReason::Aborted);
    join_rpc_workers(&mut workers)?;
    Ok(())
}

fn write_rpc_response(
    stdout: &Arc<Mutex<io::BufWriter<io::Stdout>>>,
    response: &Value,
) -> io::Result<()> {
    let mut stdout = stdout
        .lock()
        .map_err(|_| io::Error::other("RPC stdout lock was poisoned"))?;
    serde_json::to_writer(&mut *stdout, response)?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}

fn join_rpc_workers(workers: &mut Vec<std::thread::JoinHandle<io::Result<()>>>) -> io::Result<()> {
    for worker in workers.drain(..) {
        worker
            .join()
            .map_err(|_| io::Error::other("RPC worker panicked"))??;
    }
    Ok(())
}

fn reap_rpc_workers(workers: &mut Vec<std::thread::JoinHandle<io::Result<()>>>) -> io::Result<()> {
    let mut index = 0;
    while index < workers.len() {
        if workers[index].is_finished() {
            let worker = workers.swap_remove(index);
            worker
                .join()
                .map_err(|_| io::Error::other("RPC worker panicked"))??;
        } else {
            index += 1;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        env,
        sync::{Mutex, OnceLock},
    };

    use super::{
        parse_request_line, read_bounded_line, BoundedLine, ConformanceCaveLauncher, RpcRuntime,
        SharedMemoryCredentialCustody, CONFORMANCE_INSTALLATION_ID, CONFORMANCE_NODE_PATH_ENV,
        INVALID_REQUEST_ID, MAX_LINE_BYTES,
    };
    use crate::{
        cave::CaveLauncher,
        keyring::{Credential, CredentialCustody, CredentialSlot, KeyringError},
    };
    use serde_json::json;

    const INSTANCE_ID: &str = "instance-1";
    const FIRST_ORIGIN: &str = "http://127.0.0.1:4310/";
    const SECOND_ORIGIN: &str = "http://127.0.0.1:4320/";
    static ENVIRONMENT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    struct ScopedCaveHome(Option<std::ffi::OsString>);

    impl ScopedCaveHome {
        fn missing() -> Self {
            let original = env::var_os("COVEN_CAVE_HOME");
            env::set_var(
                "COVEN_CAVE_HOME",
                env::current_dir().unwrap().join("no-cave"),
            );
            Self(original)
        }
    }

    impl Drop for ScopedCaveHome {
        fn drop(&mut self) {
            match self.0.take() {
                Some(value) => env::set_var("COVEN_CAVE_HOME", value),
                None => env::remove_var("COVEN_CAVE_HOME"),
            }
        }
    }

    fn credential(origin: &str, bearer: &str, credential_id: &str) -> Credential {
        Credential {
            bearer: bearer.to_owned(),
            credential_id: credential_id.to_owned(),
            origin: origin.to_owned(),
        }
    }

    #[test]
    fn rejects_unknown_top_level_keys_and_malformed_lines_without_echoing_them() {
        let canary = "native-rpc-input-canary";
        let unknown_key =
            format!(r#"{{"id":"request-1","command":"app_installation_id","leak":"{canary}"}}"#);
        let malformed = format!(r#"{{"id":"request-1","command":"{canary}""#);

        for line in [unknown_key.as_bytes(), malformed.as_bytes()] {
            let response = match parse_request_line(line) {
                Ok(_) => panic!("malformed request must fail"),
                Err(response) => response,
            };

            assert_eq!(response["ok"], false);
            assert_eq!(response["error"]["code"], "invalid_request");
            assert!(!response.to_string().contains(canary));
        }
    }

    #[test]
    fn rejects_oversized_lines_and_unsafe_request_ids() {
        let oversized = vec![b'x'; MAX_LINE_BYTES + 1];
        let oversized_response = match parse_request_line(&oversized) {
            Ok(_) => panic!("oversized request must fail"),
            Err(response) => response,
        };
        let unsafe_response =
            match parse_request_line(br#"{"id":"unsafe id","command":"app_installation_id"}"#) {
                Ok(_) => panic!("unsafe request id must fail"),
                Err(response) => response,
            };

        assert_eq!(oversized_response["id"], INVALID_REQUEST_ID);
        assert_eq!(unsafe_response["id"], INVALID_REQUEST_ID);
        assert_eq!(oversized_response["error"]["code"], "invalid_request");
    }

    #[test]
    fn bounded_reader_drains_oversized_lines_before_reading_the_next_request() {
        let mut input = vec![b'x'; MAX_LINE_BYTES + 1];
        input.extend_from_slice(b"\n{\"id\":\"next\",\"command\":\"app_installation_id\"}\n");
        let mut reader = std::io::Cursor::new(input);

        assert!(matches!(
            read_bounded_line(&mut reader).unwrap(),
            Some(BoundedLine::Oversized)
        ));
        match read_bounded_line(&mut reader).unwrap() {
            Some(BoundedLine::Line(line)) => {
                assert_eq!(line, br#"{"id":"next","command":"app_installation_id"}"#);
            }
            _ => panic!("the next bounded request must remain readable"),
        }
        assert!(read_bounded_line(&mut reader).unwrap().is_none());
    }

    #[test]
    fn rejects_unknown_commands_and_malformed_exact_args() {
        let _environment = ENVIRONMENT_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _cave_home = ScopedCaveHome::missing();
        let mut runtime = RpcRuntime::new();
        let unknown = runtime.process_line(br#"{"id":"one","command":"not-a-command"}"#);
        let extra = runtime.process_line(
            br#"{"id":"two","command":"cave_health","args":{"handle":"x","extra":true}}"#,
        );
        let missing = runtime.process_line(
            br#"{"id":"three","command":"cave_list_familiars","args":{"handle":"x"}}"#,
        );
        let zero_limit = runtime.process_line(
            br#"{"id":"four","command":"cave_list_familiars","args":{"handle":"x","page":{"limit":0}}}"#,
        );
        let noncanonical_cursor = runtime.process_line(
            br#"{"id":"five","command":"cave_list_projects","args":{"handle":"x","page":{"limit":20,"cursor":"A"}}}"#,
        );
        let unsafe_conversation = runtime.process_line(
            br#"{"id":"six","command":"cave_get_conversation","args":{"handle":"x","conversationId":".."}}"#,
        );
        let widened_pairing = runtime.process_line(
            br#"{"id":"seven","command":"cave_pairing_create","args":{"handle":"x","request":{"appName":"OpenCoven Chat","installationId":"00000000-0000-4000-8000-000000000001","scopes":["chat:write"],"headers":{"authorization":"forbidden"}}}}"#,
        );
        let unsafe_pairing_id = runtime.process_line(
            br#"{"id":"eight","command":"cave_pairing_poll","args":{"handle":"x","requestId":"../request"}}"#,
        );
        let bounded_operation = runtime.process_line(
            br#"{"id":"nine","command":"cave_health","args":{"handle":"x","operation":{"attemptId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","timeoutMs":25}}}"#,
        );
        let cancellation = runtime.process_line(
            br#"{"id":"ten","command":"cave_cancel_operation","args":{"attemptId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","reason":"aborted"}}"#,
        );
        let oversized_timeout = runtime.process_line(
            br#"{"id":"eleven","command":"cave_health","args":{"handle":"x","operation":{"attemptId":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","timeoutMs":5001}}}"#,
        );
        let malformed_cancel = runtime.process_line(
            br#"{"id":"twelve","command":"cave_cancel_operation","args":{"attemptId":"not-an-attempt","reason":"secret-cause"}}"#,
        );

        assert_eq!(unknown["error"]["code"], "invalid_rpc_command");
        assert_eq!(extra["error"]["code"], "invalid_native_input");
        assert_eq!(missing["error"]["code"], "invalid_native_input");
        assert_eq!(zero_limit["error"]["code"], "invalid_native_input");
        assert_eq!(noncanonical_cursor["error"]["code"], "invalid_native_input");
        assert_eq!(unsafe_conversation["error"]["code"], "invalid_native_input");
        assert_eq!(widened_pairing["error"]["code"], "invalid_native_input");
        assert_eq!(unsafe_pairing_id["error"]["code"], "invalid_native_input");
        assert_eq!(
            bounded_operation["error"]["code"],
            "cave_discovery_not_found"
        );
        assert_eq!(
            cancellation,
            json!({
                "id": "ten",
                "ok": true,
                "result": { "status": "queued" },
            })
        );
        assert_eq!(oversized_timeout["error"]["code"], "invalid_native_input");
        assert_eq!(malformed_cancel["error"]["code"], "invalid_native_input");
        assert!(!malformed_cancel.to_string().contains("secret-cause"));
    }

    #[test]
    fn rpc_cancellation_is_single_use_and_cannot_affect_a_new_attempt() {
        let _environment = ENVIRONMENT_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _cave_home = ScopedCaveHome::missing();
        let mut runtime = RpcRuntime::new();
        let cancelled_attempt = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let fresh_attempt = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

        assert_eq!(
            runtime.process_line(
                format!(
                    r#"{{"id":"cancel","command":"cave_cancel_operation","args":{{"attemptId":"{cancelled_attempt}","reason":"aborted"}}}}"#
                )
                .as_bytes(),
            ),
            json!({
                "id": "cancel",
                "ok": true,
                "result": { "status": "queued" },
            })
        );
        assert_eq!(
            runtime.process_line(
                format!(
                    r#"{{"id":"aborted","command":"cave_health","args":{{"handle":"x","operation":{{"attemptId":"{cancelled_attempt}","timeoutMs":100}}}}}}"#
                )
                .as_bytes(),
            ),
            json!({
                "id": "aborted",
                "ok": false,
                "error": { "code": "aborted", "retryable": false },
            })
        );
        assert_eq!(
            runtime.process_line(
                format!(
                    r#"{{"id":"stale","command":"cave_cancel_operation","args":{{"attemptId":"{cancelled_attempt}","reason":"timeout"}}}}"#
                )
                .as_bytes(),
            ),
            json!({
                "id": "stale",
                "ok": true,
                "result": { "status": "unknown" },
            })
        );
        assert_eq!(
            runtime.process_line(
                format!(
                    r#"{{"id":"fresh","command":"cave_health","args":{{"handle":"x","operation":{{"attemptId":"{fresh_attempt}","timeoutMs":100}}}}}}"#
                )
                .as_bytes(),
            )["error"]["code"],
            "cave_discovery_not_found"
        );
    }

    #[test]
    fn emits_only_the_safe_response_shapes() {
        let canary = "bearer-canary-must-not-escape";
        let success = super::success_response("request-1".to_owned(), json!({"status": "ok"}));
        let failure = super::failure_response("request-2", "cave_discovery_not_found", true);

        assert_eq!(
            success,
            json!({"id":"request-1","ok":true,"result":{"status":"ok"}})
        );
        assert_eq!(
            failure,
            json!({
                "id":"request-2",
                "ok":false,
                "error":{"code":"cave_discovery_not_found","retryable":true}
            })
        );
        assert!(!failure.to_string().contains(canary));
        assert!(!failure["error"]
            .as_object()
            .unwrap()
            .contains_key("message"));
        assert!(!failure["error"].as_object().unwrap().contains_key("cause"));
    }

    #[test]
    fn shared_custody_uses_fixed_id_and_matches_current_stale_and_cas_semantics() {
        let custody = SharedMemoryCredentialCustody::new();
        let first = credential(FIRST_ORIGIN, "bearer-first-canary", "credential-1");
        let replacement = credential(SECOND_ORIGIN, "bearer-second-canary", "credential-2");

        assert_eq!(
            custody.installation_id().unwrap(),
            CONFORMANCE_INSTALLATION_ID
        );
        assert!(custody
            .store_if_current(
                INSTANCE_ID,
                FIRST_ORIGIN,
                None,
                &first.bearer,
                &first.credential_id,
            )
            .unwrap());
        assert!(matches!(
            custody
                .read_for_pairing_update(INSTANCE_ID, FIRST_ORIGIN)
                .unwrap(),
            CredentialSlot::Current(current) if current.is_same_identity(&first)
        ));
        assert!(matches!(
            custody
                .read_for_pairing_update(INSTANCE_ID, SECOND_ORIGIN)
                .unwrap(),
            CredentialSlot::Stale(current) if current.is_same_identity(&first)
        ));
        assert!(!custody
            .store_if_current(
                INSTANCE_ID,
                FIRST_ORIGIN,
                Some(&replacement),
                "bearer-third",
                "credential-3",
            )
            .unwrap());
        assert!(custody
            .replace_stale_if_current(
                INSTANCE_ID,
                SECOND_ORIGIN,
                &first,
                &replacement.bearer,
                &replacement.credential_id,
            )
            .unwrap());
        assert_eq!(
            custody
                .read(INSTANCE_ID, SECOND_ORIGIN)
                .unwrap()
                .credential_id,
            replacement.credential_id
        );
        assert!(!custody
            .delete_if_matches(INSTANCE_ID, SECOND_ORIGIN, &first)
            .unwrap());
        assert!(custody
            .delete_if_matches(INSTANCE_ID, SECOND_ORIGIN, &replacement)
            .unwrap());
        assert!(matches!(
            custody.read(INSTANCE_ID, SECOND_ORIGIN),
            Err(KeyringError::NotFound)
        ));

        let source = include_str!("conformance.rs");
        assert!(!source.contains(&["derive(", "Debug"].concat()));
        assert!(!source.contains(&["derive(", "Serialize"].concat()));
    }

    #[test]
    fn shared_custody_reports_failure_after_a_poisoned_lock() {
        let custody = SharedMemoryCredentialCustody::new();
        let poisoned = custody.clone();
        let _ = std::thread::spawn(move || {
            let _guard = poisoned.store.lock().unwrap();
            panic!("poison the conformance-only custody lock");
        })
        .join();

        assert!(matches!(
            custody.read_for_pairing_update(INSTANCE_ID, FIRST_ORIGIN),
            Err(KeyringError::Failure)
        ));
    }

    #[test]
    fn launcher_requires_absolute_regular_node_configuration() {
        let _environment = ENVIRONMENT_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let original = env::var_os(CONFORMANCE_NODE_PATH_ENV);
        env::set_var(CONFORMANCE_NODE_PATH_ENV, "relative-node");

        let error = match ConformanceCaveLauncher.launch() {
            Ok(_) => panic!("relative node configuration must fail"),
            Err(error) => error,
        };

        assert_eq!(error.code, "cave_launch_configuration_invalid");
        match original {
            Some(value) => env::set_var(CONFORMANCE_NODE_PATH_ENV, value),
            None => env::remove_var(CONFORMANCE_NODE_PATH_ENV),
        }
    }

    #[test]
    fn runtime_uses_native_discovery_and_can_reset_without_touching_a_keyring() {
        let _environment = ENVIRONMENT_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let original = env::var_os("COVEN_CAVE_HOME");
        env::set_var(
            "COVEN_CAVE_HOME",
            env::current_dir().unwrap().join("no-cave"),
        );
        let mut runtime = RpcRuntime::new();

        let before = runtime.process_line(br#"{"id":"one","command":"app_installation_id"}"#);
        let discovery = runtime.process_line(
            br#"{"id":"two","command":"cave_read_discovery","args":{"operation":{"attemptId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","timeoutMs":100}}}"#,
        );
        let reset =
            runtime.process_line(br#"{"id":"three","command":"conformance_reset_native_state"}"#);
        let after = runtime.process_line(br#"{"id":"four","command":"app_installation_id"}"#);
        let (shutdown, should_exit) =
            runtime.process_line_with_action(br#"{"id":"five","command":"conformance_shutdown"}"#);

        assert_eq!(before["result"], CONFORMANCE_INSTALLATION_ID);
        assert_eq!(
            discovery["error"],
            json!({"code":"cave_discovery_not_found","retryable":true})
        );
        assert_eq!(reset["result"], json!({"status": "reset"}));
        assert_eq!(after["result"], before["result"]);
        assert_eq!(shutdown["result"], json!({"status": "shutting_down"}));
        assert!(should_exit);

        match original {
            Some(value) => env::set_var("COVEN_CAVE_HOME", value),
            None => env::remove_var("COVEN_CAVE_HOME"),
        }
    }
}
