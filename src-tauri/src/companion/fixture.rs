//! Explicitly feature-gated transport fixture; absent from production builds.
use super::{
    backend::{Backend, RunRecord, SendRequest},
    *,
};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::Duration,
};
#[derive(Default)]
pub(super) struct FixtureBackend {
    pub starts: AtomicUsize,
    pub active: Mutex<Option<Arc<RunRecord>>>,
}
#[async_trait::async_trait]
impl Backend for FixtureBackend {
    async fn snapshot(&self) -> Result<Value, String> {
        Ok(
            json!({"version":1,"familiars":[{"id":"fixture","name":"fixture","displayName":"Fixture Familiar","description":"Native transport acceptance fixture","emoji":"🧪"}],"sessions":[],"activeRun":null}),
        )
    }
    async fn history(&self, familiar: String) -> Result<Value, String> {
        if familiar != "fixture" {
            return Err("Unknown fixture familiar".into());
        }
        Ok(
            json!({"sessionId":null,"messages":[{"id":"fixture-history","role":"assistant","text":"Secure companion connected."}],"hasMore":false,"activeRunId":self.active().map(|r|r.id.clone())}),
        )
    }
    fn start(&self, input: SendRequest) -> Result<Arc<RunRecord>, String> {
        let mut active = self.active.lock().unwrap();
        if active.as_ref().is_some_and(|r| r.running()) {
            return Err("Busy".into());
        }
        self.starts.fetch_add(1, Ordering::SeqCst);
        let run = RunRecord::new(
            input.request_id,
            input.familiar_id,
            Arc::new(AtomicBool::new(false)),
        );
        run.observe(
            json!({"type":"user","message":{"content":[{"type":"text","text":input.prompt}]}}),
        )?;
        *active = Some(run.clone());
        let worker = run.clone();
        tokio::spawn(async move {
            for part in ["Fixture ", "reply ", "arrived."] {
                tokio::time::sleep(Duration::from_millis(150)).await;
                if worker.cancel.load(Ordering::SeqCst) {
                    worker.finish(&Err("Stopped".into()));
                    return;
                }
                let _ = worker.observe(json!({"type":"text_delta","text":part}));
            }
            // Long enough for simulator UI acceptance to exercise Stop.
            for _ in 0..100 {
                if worker.cancel.load(Ordering::SeqCst) {
                    worker.finish(&Err("Stopped".into()));
                    return;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            worker.finish(&Ok(json!({})));
        });
        Ok(run)
    }
    fn active(&self) -> Option<Arc<RunRecord>> {
        self.active
            .lock()
            .unwrap()
            .as_ref()
            .filter(|r| r.running())
            .cloned()
    }
    fn stop(&self, id: &str) -> Result<(), String> {
        let active = self
            .active()
            .filter(|r| r.id == id)
            .ok_or("Run not found")?;
        active.cancel.store(true, Ordering::SeqCst);
        Ok(())
    }
}
/// Run a same-LAN HTTPS fixture and print its private pairing receipt once.
pub async fn run(data: PathBuf) -> Result<(), String> {
    std::fs::create_dir_all(&data).map_err(|_| "Cannot create fixture parent directory.")?;
    let host = super::host::Host::start(
        &data.join("companion"),
        super::lan_ip()?,
        Arc::new(FixtureBackend::default()),
    )?;
    println!(
        "{}",
        json!({"pairingLink":host.pairing_link(),"endpoint":host.endpoint})
    );
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .map_err(|_| "Cannot install fixture cleanup.")?;
        tokio::select! { _=tokio::signal::ctrl_c()=>{}, _=terminate.recv()=>{} }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
    if let Some(task) = host.disable() {
        let _ = task.await;
    }
    Ok(())
}
