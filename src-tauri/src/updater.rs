//! App updates (#356). The webview gets two narrow commands, never the
//! plugin's own: what is available, and "install it and restart". The plugin
//! checks every download against the public key in `tauri.conf.json` before
//! anything is installed, and fetches only the endpoint configured there.

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::UpdaterExt;

use crate::coven_runtime::CovenRuntimeState;

/// Release notes are shown as plain text, at most this many bytes.
const NOTES_LIMIT: usize = 4 * 1024;

/// Whether a newer release is published, without downloading it.
#[tauri::command]
pub(crate) async fn updater_check(app: AppHandle) -> Result<Value, String> {
    let current = app.package_info().version.to_string();
    let update = app
        .updater()
        .map_err(|error| check_failed(&error))?
        .check()
        .await
        .map_err(|error| check_failed(&error))?;
    Ok(match update {
        Some(update) => json!({
            "available": true,
            "currentVersion": current,
            "version": update.version,
            "notes": update.body.as_deref().map(|notes| bounded(notes, NOTES_LIMIT)),
        }),
        None => json!({ "available": false, "currentVersion": current }),
    })
}

/// Downloads the newest release, verifies it, installs it and restarts Chat.
/// Refused while a run is active; no run can start until it finishes or fails.
#[tauri::command]
pub(crate) async fn updater_install(app: AppHandle) -> Result<(), String> {
    let state = app.state::<CovenRuntimeState>();
    state.begin_update()?;
    match install(&app, &state).await {
        Ok(()) => app.restart(),
        Err(error) => {
            state.end_update();
            Err(error)
        }
    }
}

async fn install(app: &AppHandle, state: &CovenRuntimeState) -> Result<(), String> {
    let update = app
        .updater()
        .map_err(|error| check_failed(&error))?
        .check()
        .await
        .map_err(|error| check_failed(&error))?
        .ok_or_else(|| "Chat is already up to date.".to_owned())?;
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|error| install_failed(&error))?;
    // On Windows the installer takes over and Chat exits during `install`.
    state.ready_to_restart();
    update
        .install(bytes)
        .map_err(|error| install_failed(&error))
}

fn check_failed(error: &tauri_plugin_updater::Error) -> String {
    format!(
        "Chat couldn't check for updates. Check your internet connection, then try again.\n\nDetails: {error}"
    )
}

fn install_failed(error: &tauri_plugin_updater::Error) -> String {
    format!(
        "Chat couldn't install the update, and nothing was changed. Try again, or download the new version from the releases page.\n\nDetails: {error}"
    )
}

/// `text`, cut on a character boundary at no more than `limit` bytes.
fn bounded(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_owned();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

#[cfg(test)]
mod tests {
    use super::bounded;

    #[test]
    fn release_notes_are_cut_on_a_character_boundary() {
        assert_eq!(bounded("short", 10), "short");
        assert_eq!(bounded("abcdef", 3), "abc…");
        // "é" is two bytes; a cut inside it backs off to the boundary before.
        assert_eq!(bounded("aé", 2), "a…");
    }
}
