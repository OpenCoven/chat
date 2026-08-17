use crate::metadata::AppIdentity;

pub const REGISTERED_COMMANDS: &[&str] = &["app_identity"];

#[tauri::command]
pub fn app_identity() -> AppIdentity {
    AppIdentity::current()
}

pub fn registered_command_names() -> &'static [&'static str] {
    REGISTERED_COMMANDS
}
