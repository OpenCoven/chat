use super::*;
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SendRequest {
    pub request_id: String,
    pub familiar_id: String,
    pub session_id: Option<String>,
    pub prompt: String,
}
impl SendRequest {
    pub fn validate(&self) -> Result<(), String> {
        crate::coven_runtime::validate_id(&self.request_id)?;
        crate::coven_runtime::validate_id(&self.familiar_id)?;
        if let Some(id) = &self.session_id {
            crate::coven_runtime::validate_id(id)?;
        }
        if self.prompt.trim().is_empty() || self.prompt.len() > 32768 {
            return Err("A message must contain 1–32768 bytes.".into());
        }
        Ok(())
    }
}

pub(crate) struct RunRecord {
    pub id: String,
    pub familiar_id: String,
    pub cancel: Arc<AtomicBool>,
    pub phone_origin: AtomicBool,
    inner: Mutex<RunContent>,
    pub base_session: Mutex<Option<String>>,
    pub parent_session: Mutex<Option<String>>,
}
struct RunContent {
    status: &'static str,
    events: Vec<Value>,
    bytes: usize,
    error: Option<&'static str>,
}
impl RunRecord {
    pub fn new(id: String, familiar_id: String, cancel: Arc<AtomicBool>) -> Arc<Self> {
        Arc::new(Self {
            id,
            familiar_id,
            cancel,
            phone_origin: AtomicBool::new(false),
            base_session: Mutex::new(None),
            parent_session: Mutex::new(None),
            inner: Mutex::new(RunContent {
                status: "running",
                events: Vec::new(),
                bytes: 0,
                error: None,
            }),
        })
    }
    pub fn observe(&self, event: Value) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "Run unavailable.")?;
        let bytes = serde_json::to_vec(&event)
            .map_err(|_| "Run unavailable.")?
            .len();
        if inner.events.len() >= 4096 || inner.bytes + bytes > 1024 * 1024 {
            return Err(
                "Companion response limit reached; read the remaining history on your Mac.".into(),
            );
        }
        inner.bytes += bytes;
        inner.events.push(event);
        Ok(())
    }
    pub fn finish(&self, result: &Result<Value, String>) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.status = if self.cancel.load(Ordering::SeqCst) {
                "stopped"
            } else if result.is_ok() {
                "completed"
            } else {
                "failed"
            };
            if inner.status == "failed" {
                inner.error = Some("The run could not finish. Check Chat on your Mac.");
            }
        }
    }
    pub fn value(&self) -> Value {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut value = json!({"id":self.id,"familiarId":self.familiar_id,"status":inner.status,"messages":project_messages(&inner.events)});
        if let Some(error) = inner.error {
            value["error"] = json!(error);
        }
        value
    }
    pub fn running(&self) -> bool {
        self.inner.lock().is_ok_and(|r| r.status == "running")
    }
}

#[async_trait::async_trait]
pub(super) trait Backend: Send + Sync {
    async fn snapshot(&self) -> Result<Value, String>;
    async fn history(&self, familiar: String) -> Result<Value, String>;
    fn start(&self, input: SendRequest) -> Result<Arc<RunRecord>, String>;
    fn active(&self) -> Option<Arc<RunRecord>>;
    fn run(&self, id: &str) -> Option<Arc<RunRecord>> {
        self.active().filter(|r| r.id == id)
    }
    fn stop(&self, id: &str) -> Result<(), String>;
}

pub(super) struct NativeBackend {
    pub app: tauri::AppHandle,
}
#[async_trait::async_trait]
impl Backend for NativeBackend {
    async fn snapshot(&self) -> Result<Value, String> {
        crate::coven_runtime::companion_snapshot(self.app.clone()).await
    }
    async fn history(&self, familiar: String) -> Result<Value, String> {
        crate::coven_runtime::companion_history(self.app.clone(), familiar).await
    }
    fn start(&self, input: SendRequest) -> Result<Arc<RunRecord>, String> {
        crate::coven_runtime::companion_start(self.app.clone(), input)
    }
    fn active(&self) -> Option<Arc<RunRecord>> {
        use tauri::Manager;
        self.app
            .state::<crate::coven_runtime::CovenRuntimeState>()
            .companion_active()
    }
    fn run(&self, id: &str) -> Option<Arc<RunRecord>> {
        use tauri::Manager;
        self.app
            .state::<crate::coven_runtime::CovenRuntimeState>()
            .companion_run(id)
    }
    fn stop(&self, id: &str) -> Result<(), String> {
        use tauri::Manager;
        crate::coven_runtime::coven_runtime_cancel(self.app.state(), id.into())
    }
}

pub(crate) fn session_alias(id: &str) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "chat-{}",
        super::credentials::hex(&Sha256::digest(id.as_bytes()))
    )
}
