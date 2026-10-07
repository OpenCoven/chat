//! Opt-in, LAN-only companion. The desktop remains the execution authority.
use serde_json::{json, Value};
use subtle::ConstantTimeEq;

fn authorized(expected: &str, bearer: &str, origin: bool) -> bool {
    let supplied = bearer.strip_prefix("Bearer ").unwrap_or("");
    !origin
        && expected.len() == 64
        && supplied.len() == 64
        && bool::from(expected.as_bytes().ct_eq(supplied.as_bytes()))
}

pub(crate) fn project_messages(events: &[Value]) -> Vec<Value> {
    let mut messages: Vec<Value> = Vec::new();
    let mut delta: Option<usize> = None;
    for (index, event) in events.iter().enumerate() {
        let kind = event["type"].as_str().unwrap_or("");
        if kind == "text_delta" {
            if let Some(text) = event["text"].as_str() {
                if let Some(i) = delta {
                    let mut accumulated = messages[i]["text"].as_str().unwrap_or("").to_owned();
                    accumulated.push_str(text);
                    messages[i]["text"] = json!(accumulated);
                } else {
                    delta = Some(messages.len());
                    messages.push(json!({"id":index.to_string(),"role":"assistant","text":text}));
                }
            }
            continue;
        }
        delta = None;
        if kind == "tool_start" {
            messages.push(json!({"id":index.to_string(),"role":"status","text":"Working…"}));
        }
        let notice =
            kind == "system" && event["subtype"] == "notice" && event["source"] == "chat-replay";
        if matches!(kind, "user" | "assistant") || notice {
            if let Some(blocks) = event.pointer("/message/content").and_then(Value::as_array) {
                let text = blocks
                    .iter()
                    .filter(|b| b["type"] == "text")
                    .filter_map(|b| b["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n\n");
                if !text.is_empty() {
                    messages.push(json!({"id":index.to_string(),"role":if notice {"status"} else {kind},"text":text}));
                }
            }
        }
    }
    messages
}

#[cfg(test)]
mod tests;

pub(crate) mod backend;
mod credentials;
mod host;
use std::sync::{Arc, Mutex};
use tauri::Manager;

#[derive(Default)]
pub(crate) struct CompanionState {
    host: Mutex<Option<Arc<host::Host>>>,
    operations: tokio::sync::Mutex<()>,
    monitor: Mutex<Option<tokio::task::JoinHandle<()>>>,
    requested: std::sync::atomic::AtomicBool,
    error: Mutex<Option<String>>,
    shutting_down: std::sync::atomic::AtomicBool,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pairing_link: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}
impl Status {
    fn off(error: Option<String>) -> Self {
        Self {
            enabled: false,
            pairing_link: None,
            error,
        }
    }
    fn on(host: &host::Host) -> Self {
        Self {
            enabled: true,
            pairing_link: Some(host.pairing_link()),
            error: None,
        }
    }
}
impl CompanionState {
    pub(crate) fn shutdown(&self) {
        self.stop_monitor();
        self.shutting_down
            .store(true, std::sync::atomic::Ordering::SeqCst);
        if let Ok(mut host) = self.host.lock() {
            if let Some(host) = host.take() {
                host.disable();
            }
        }
    }
    fn stop_monitor(&self) {
        self.requested
            .store(false, std::sync::atomic::Ordering::SeqCst);
        if let Ok(mut task) = self.monitor.lock() {
            if let Some(task) = task.take() {
                task.abort();
            }
        }
    }
    fn start_monitor(&self, app: tauri::AppHandle) {
        self.requested
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let Ok(mut monitor) = self.monitor.lock() else {
            return;
        };
        if monitor.as_ref().is_some_and(|task| !task.is_finished()) {
            return;
        }
        *monitor = Some(tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                let state = app.state::<CompanionState>();
                let _operation = state.operations.lock().await;
                if !state.requested.load(std::sync::atomic::Ordering::SeqCst)
                    || state
                        .shutting_down
                        .load(std::sync::atomic::Ordering::SeqCst)
                {
                    break;
                }
                let Ok(ip) = lan_ip() else {
                    continue;
                };
                let current = state.host.lock().ok().and_then(|host| host.clone());
                if let Some(current) = current {
                    if current.address() == Some(ip) {
                        continue;
                    }
                    let result = current.rebind(ip).await;
                    let Ok(mut host) = state.host.lock() else {
                        break;
                    };
                    // A synchronous app shutdown may happen during the join.
                    if state
                        .shutting_down
                        .load(std::sync::atomic::Ordering::SeqCst)
                    {
                        if let Ok(next) = result {
                            next.disable();
                        }
                        break;
                    }
                    match result {
                        Ok(next) => {
                            *host = Some(next);
                            if let Ok(mut error) = state.error.lock() {
                                *error = None;
                            }
                        }
                        Err(message) => {
                            *host = None;
                            if let Ok(mut error) = state.error.lock() {
                                *error = Some(message);
                            }
                        }
                    }
                } else {
                    let status = start_native(&app, &state);
                    if let Ok(mut error) = state.error.lock() {
                        *error = status.error;
                    }
                }
            }
        }));
    }
    async fn stop(&self) {
        let task = self
            .host
            .lock()
            .ok()
            .and_then(|mut host| host.take())
            .and_then(|host| host.disable());
        if let Some(task) = task {
            let _ = task.await;
        }
    }
}
impl Drop for CompanionState {
    fn drop(&mut self) {
        self.shutdown();
    }
}
#[tauri::command]
pub(crate) fn companion_status(state: tauri::State<'_, CompanionState>) -> Status {
    match state.host.lock() {
        Ok(host) => host.as_ref().map_or_else(
            || Status {
                enabled: state.requested.load(std::sync::atomic::Ordering::SeqCst),
                pairing_link: None,
                error: state.error.lock().ok().and_then(|error| error.clone()),
            },
            |h| Status::on(h),
        ),
        Err(_) => Status::off(Some("Companion unavailable.".into())),
    }
}
fn start_native(app: &tauri::AppHandle, state: &CompanionState) -> Status {
    let Ok(mut host) = state.host.lock() else {
        return Status::off(Some("Companion unavailable.".into()));
    };
    if state
        .shutting_down
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        return Status::off(Some("Chat is shutting down.".into()));
    }
    if let Some(host) = host.as_ref() {
        return Status::on(host);
    }
    let result = (|| {
        let data = app
            .path()
            .app_local_data_dir()
            .map_err(|_| "Cannot locate companion storage.")?;
        std::fs::create_dir_all(&data).map_err(|_| "Cannot create companion storage.")?;
        host::Host::start(
            &data.join("iphone-companion"),
            lan_ip()?,
            Arc::new(backend::NativeBackend { app: app.clone() }),
        )
    })();
    match result {
        Ok(running) => {
            let status = Status::on(&running);
            *host = Some(running);
            status
        }
        Err(error) => Status::off(Some(error)),
    }
}
#[tauri::command]
pub(crate) async fn companion_enable(app: tauri::AppHandle) -> Status {
    let state = app.state::<CompanionState>();
    let _operation = state.operations.lock().await;
    let status = start_native(&app, &state);
    if status.enabled {
        state.start_monitor(app.clone());
    }
    status
}
#[tauri::command]
pub(crate) async fn companion_disable(app: tauri::AppHandle) -> Status {
    let state = app.state::<CompanionState>();
    let _operation = state.operations.lock().await;
    state.stop_monitor();
    state.stop().await;
    cancel_phone_run(&app);
    if let Ok(mut error) = state.error.lock() {
        *error = None;
    }
    Status::off(None)
}
#[tauri::command]
pub(crate) async fn companion_forget(app: tauri::AppHandle) -> Status {
    let state = app.state::<CompanionState>();
    let _operation = state.operations.lock().await;
    let enabled = state.requested.load(std::sync::atomic::Ordering::SeqCst);
    state.stop_monitor();
    state.stop().await;
    cancel_phone_run(&app);
    let result = (|| {
        let data = app
            .path()
            .app_local_data_dir()
            .map_err(|_| "Cannot locate companion storage.")?;
        std::fs::create_dir_all(&data).map_err(|_| "Cannot create companion storage.")?;
        let data = data.join("iphone-companion");
        let mut identity = credentials::Identity::load(&data)?;
        identity.token = credentials::random_token()?;
        identity.save(&data)
    })();
    match result {
        Ok(()) if enabled => {
            let status = start_native(&app, &state);
            if status.enabled {
                state.start_monitor(app.clone());
            }
            status
        }
        Ok(()) => Status::off(None),
        Err(error) => Status::off(Some(error)),
    }
}
#[tauri::command]
pub(crate) fn companion_active_run(
    state: tauri::State<'_, crate::coven_runtime::CovenRuntimeState>,
) -> Value {
    state
        .companion_active()
        .filter(|run| run.phone_origin.load(std::sync::atomic::Ordering::SeqCst))
        .map_or(
            Value::Null,
            |r| json!({"runId":r.id,"familiarId":r.familiar_id,"status":"running"}),
        )
}
fn cancel_phone_run(app: &tauri::AppHandle) {
    if let Some(run) = app
        .state::<crate::coven_runtime::CovenRuntimeState>()
        .companion_active()
        .filter(|run| run.phone_origin.load(std::sync::atomic::Ordering::SeqCst))
    {
        run.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}
fn lan_ip() -> Result<std::net::Ipv4Addr, String> {
    // UDP connect selects a local route; no datagram is transmitted.
    let socket =
        std::net::UdpSocket::bind("0.0.0.0:0").map_err(|_| "Cannot inspect your local network.")?;
    socket
        .connect("192.168.0.1:9")
        .map_err(|_| "Connect your Mac to a local network first.")?;
    match socket
        .local_addr()
        .map_err(|_| "Cannot inspect your local network.")?
        .ip()
    {
        std::net::IpAddr::V4(ip) if ip.is_private() => Ok(ip),
        _ => Err("Connect your Mac to a private local network first.".into()),
    }
}
#[cfg(any(test, feature = "companion-fixture"))]
pub mod fixture;
