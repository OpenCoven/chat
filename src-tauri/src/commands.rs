use crate::metadata::AppIdentity;

#[tauri::command]
pub fn app_identity() -> AppIdentity {
    AppIdentity::current()
}
