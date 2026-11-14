//! App updates (#356). The webview gets two narrow commands, never the
//! plugin's own: what is available, and "install it and restart". The plugin
//! checks every download against the public key in `tauri.conf.json` before
//! anything is installed, and fetches only the endpoint configured there.

use std::{future::Future, time::Duration};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::UpdaterExt;

use crate::coven_runtime::CovenRuntimeState;

/// Release notes are shown as plain text, at most this many bytes.
const NOTES_LIMIT: usize = 4 * 1024;
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Whether a newer release is published, without downloading it.
#[tauri::command]
pub(crate) async fn updater_check(app: AppHandle) -> Result<Value, String> {
    let current = app.package_info().version.to_string();
    let updater = app.updater().map_err(|error| check_failed(&error))?;
    let update = network_request(updater.check(), CHECK_TIMEOUT, check_failed).await?;
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
    with_update_hold(&state, install(&app, &state)).await?;
    app.restart()
}

async fn with_update_hold<T>(
    state: &CovenRuntimeState,
    operation: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    state.begin_update()?;
    let mut hold = UpdateHold {
        state,
        restarting: false,
    };
    let result = operation.await;
    // Success immediately hands off to restart, so no new run may enter then.
    hold.restarting = result.is_ok();
    result
}

struct UpdateHold<'a> {
    state: &'a CovenRuntimeState,
    restarting: bool,
}

impl Drop for UpdateHold<'_> {
    fn drop(&mut self) {
        // Dropped or panicking command futures must release the same hold as errors.
        if !self.restarting {
            self.state.end_update();
        }
    }
}

async fn install(app: &AppHandle, state: &CovenRuntimeState) -> Result<(), String> {
    let updater = app.updater().map_err(|error| check_failed(&error))?;
    let update = network_request(updater.check(), CHECK_TIMEOUT, check_failed)
        .await?
        .ok_or_else(|| "Chat is already up to date.".to_owned())?;
    let bytes = network_request(
        update.download(|_, _| {}, || {}),
        DOWNLOAD_TIMEOUT,
        install_failed,
    )
    .await?;
    // On Windows the installer takes over and Chat exits during `install`.
    state.ready_to_restart();
    update
        .install(bytes)
        .map_err(|error| install_failed(&error))
}

async fn network_request<T>(
    request: impl Future<Output = Result<T, tauri_plugin_updater::Error>>,
    timeout: Duration,
    error: fn(&tauri_plugin_updater::Error) -> String,
) -> Result<T, String> {
    tokio::time::timeout(timeout, request)
        .await
        .map_err(|_| {
            "The update request timed out. Check your internet connection, then try again."
                .to_owned()
        })?
        .map_err(|cause| error(&cause))
}

fn check_failed(error: &tauri_plugin_updater::Error) -> String {
    format!(
        "Chat couldn't check for updates. Check your internet connection, then try again.\n\nDetails: {error}"
    )
}

fn install_failed(error: &tauri_plugin_updater::Error) -> String {
    format!(
        "Chat couldn't install the update. Try again, or download the new version from the releases page.\n\nDetails: {error}"
    )
}

/// `text`, cut on a character boundary at no more than `limit` bytes.
fn bounded(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_owned();
    }
    let suffix = if limit >= "…".len() { "…" } else { "" };
    let mut end = limit - suffix.len();
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{suffix}", &text[..end])
}

#[cfg(test)]
mod tests {
    use super::{bounded, check_failed, network_request, with_update_hold, NOTES_LIMIT};
    use crate::coven_runtime::CovenRuntimeState;
    use std::{future::pending, time::Duration};

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
    }

    #[test]
    fn cancelled_update_releases_the_run_and_quit_hold() {
        let state = CovenRuntimeState::default();
        runtime().block_on(async {
            assert!(tokio::time::timeout(
                Duration::from_millis(10),
                with_update_hold(&state, pending::<Result<(), String>>()),
            )
            .await
            .is_err());
        });
        state
            .register_run("after-cancelled-update")
            .expect("Cancelled updates must allow new runs");
        state
            .begin_update()
            .expect("Cancelled updates must clear their closing hold");
        state.end_update();
    }

    #[test]
    fn stalled_network_request_times_out_and_releases_the_update_hold() {
        let state = CovenRuntimeState::default();
        let result = runtime().block_on(async {
            tokio::time::timeout(
                Duration::from_secs(1),
                with_update_hold(
                    &state,
                    network_request(
                        pending::<Result<(), tauri_plugin_updater::Error>>(),
                        Duration::from_millis(10),
                        check_failed,
                    ),
                ),
            )
            .await
        });
        let failure = result
            .expect("The request must finish at its own deadline")
            .unwrap_err();
        assert!(failure.contains("timed out"), "{failure}");
        state
            .register_run("after-timed-out-update")
            .expect("Timed-out updates must allow new runs");
        state
            .begin_update()
            .expect("Timed-out updates must clear their closing hold");
        state.end_update();
    }

    #[test]
    fn failed_update_releases_the_hold_but_success_keeps_restart_exclusive() {
        let state = CovenRuntimeState::default();
        runtime().block_on(async {
            assert_eq!(
                with_update_hold(&state, async {
                    Err::<(), _>("download refused".to_owned())
                })
                .await,
                Err("download refused".to_owned())
            );
            with_update_hold(&state, async { Ok(()) }).await.unwrap();
        });
        assert!(state.register_run("during-restart").is_err());
        state.end_update();
    }

    #[test]
    fn release_notes_including_ellipsis_fit_the_byte_limit() {
        for text in ["a".repeat(NOTES_LIMIT + 1), "é".repeat(NOTES_LIMIT)] {
            let notes = bounded(&text, NOTES_LIMIT);
            assert!(notes.len() <= NOTES_LIMIT);
            assert!(notes.ends_with('…'));
        }
        assert_eq!(bounded("abc", 0), "");
        assert_eq!(bounded("éabc", 1), "");
    }

    #[test]
    fn release_notes_are_cut_on_a_character_boundary() {
        assert_eq!(bounded("short", 10), "short");
        assert_eq!(bounded("abcdef", 3), "…");
        // "é" is two bytes; a cut inside it backs off to the boundary before.
        assert_eq!(bounded("aé", 2), "a");
    }
}
