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
/// The address the fixture listens on. A requested address must be a private
/// IPv4 address, because the phone's `Pairing.parse` accepts only those: a
/// loopback alias such as 10.255.255.1 works, 127.0.0.1 does not. Without a
/// request, the fixture binds to the machine's LAN address as the app does.
pub fn bind_address(requested: Option<&str>) -> Result<std::net::Ipv4Addr, String> {
    let Some(requested) = requested.map(str::trim).filter(|value| !value.is_empty()) else {
        return super::lan_ip();
    };
    let ip: std::net::Ipv4Addr = requested
        .parse()
        .map_err(|_| format!("The fixture address {requested:?} is not an IPv4 address."))?;
    if !ip.is_private() {
        return Err(format!(
            "The fixture address {ip} must be a private IPv4 address, such as 10.255.255.1."
        ));
    }
    Ok(ip)
}

/// Run a same-LAN HTTPS fixture and print its private pairing receipt once.
/// `bind` names the address to listen on; see [`bind_address`].
pub async fn run(data: PathBuf, bind: Option<String>) -> Result<(), String> {
    std::fs::create_dir_all(&data).map_err(|_| "Cannot create fixture parent directory.")?;
    let host = super::host::Host::start(
        &data.join("companion"),
        bind_address(bind.as_deref())?,
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

#[cfg(test)]
mod bind_tests {
    use super::bind_address;

    #[test]
    fn requested_private_addresses_are_used_as_given() {
        assert_eq!(
            bind_address(Some("10.255.255.1")).unwrap(),
            "10.255.255.1".parse::<std::net::Ipv4Addr>().unwrap()
        );
        assert_eq!(
            bind_address(Some(" 192.168.5.9 ")).unwrap(),
            "192.168.5.9".parse::<std::net::Ipv4Addr>().unwrap()
        );
    }

    #[test]
    fn requested_addresses_the_phone_would_reject_are_refused() {
        for value in ["127.0.0.1", "8.8.8.8", "169.254.1.1", "::1", "not-an-ip"] {
            let error = bind_address(Some(value)).unwrap_err();
            assert!(error.contains("fixture address"), "{value}: {error}");
        }
    }

    #[test]
    fn an_empty_request_means_the_lan_address() {
        // Either outcome is the LAN lookup's, not a parse error.
        for value in [None, Some(""), Some("  ")] {
            match bind_address(value) {
                Ok(ip) => assert!(ip.is_private()),
                Err(error) => assert!(error.contains("local network"), "{error}"),
            }
        }
    }
}
