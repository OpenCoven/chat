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
    outcome: Option<&'static str>,
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
                outcome: None,
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
            let outcome =
                crate::coven_runtime::run_outcome(result, self.cancel.load(Ordering::SeqCst));
            // Keep the existing phone status vocabulary. The additive typed
            // outcome and readable error identify unfinished budget exhaustion.
            inner.status = if outcome == "unfinished" {
                "failed"
            } else {
                outcome
            };
            inner.outcome = (outcome == "unfinished").then_some("turn_budget_exhausted");
            inner.error = match outcome {
                "unfinished" => Some("The model-round allowance was exhausted. Work is unfinished; check desktop Chat for saved continuation."),
                "failed" => Some("The run could not finish. Check Chat on your Mac."),
                _ => None,
            };
        }
    }
    pub fn value(&self) -> Value {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut value = json!({"id":self.id,"familiarId":self.familiar_id,"status":inner.status,"messages":project_messages(&inner.events)});
        if let Some(error) = inner.error {
            value["error"] = json!(error);
        }
        if let Some(outcome) = inner.outcome {
            value["outcome"] = json!(outcome);
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
    /// Spends an open request and starts its one turn with write access.
    /// The familiar an open request belongs to; `None` once it has closed.
    fn open_approval(&self, approval_id: &str) -> Result<Option<String>, String>;
    fn allow(&self, request_id: String, approval_id: String) -> Result<Arc<RunRecord>, String>;
    fn decline(&self, approval_id: &str) -> Result<(), String>;
    fn permission_log(&self) -> Result<Value, String>;
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
    fn open_approval(&self, approval_id: &str) -> Result<Option<String>, String> {
        crate::coven_runtime::companion_open_approval(&self.app, approval_id)
    }
    fn allow(&self, request_id: String, approval_id: String) -> Result<Arc<RunRecord>, String> {
        crate::coven_runtime::companion_allow(self.app.clone(), request_id, approval_id)
    }
    fn decline(&self, approval_id: &str) -> Result<(), String> {
        crate::coven_runtime::companion_decline(&self.app, approval_id)
    }
    fn permission_log(&self) -> Result<Value, String> {
        crate::coven_runtime::companion_permission_log(&self.app)
    }
}

pub(crate) fn session_alias(id: &str) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "chat-{}",
        super::credentials::hex(&Sha256::digest(id.as_bytes()))
    )
}

#[cfg(test)]
mod budget_tests {
    use super::*;

    #[test]
    fn exhausted_transport_is_unfinished_for_phone_clients() {
        let cancel = Arc::new(AtomicBool::new(false));
        let record = RunRecord::new("r".into(), "f".into(), cancel.clone());
        let result = Ok(json!({"runId":"r","events":[{
            "type":"system","subtype":"run_budget","source":"chat-run-budget",
            "settled":true,"outcome":"turn_budget_exhausted"
        }]}));
        record.finish(&result);
        assert_eq!(record.value()["status"], "failed");
        assert_eq!(record.value()["outcome"], "turn_budget_exhausted");
        assert!(record.value()["error"]
            .as_str()
            .unwrap()
            .contains("unfinished"));
        assert!(!record.running());
        cancel.store(true, Ordering::SeqCst);
        record.finish(&result);
        assert_eq!(record.value()["status"], "stopped");
        assert!(record.value().get("outcome").is_none());
    }
}
