use super::{
    backend::{Backend, RunRecord, SendRequest},
    credentials::{self, Identity},
    *,
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    net::{Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::{JoinHandle, JoinSet},
};
use tokio_rustls::{
    rustls::{
        self,
        pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer},
    },
    TlsAcceptor,
};

const BODY_LIMIT: usize = 40 * 1024;
const HEADER_LIMIT: usize = 8192;
const RECEIPT_LIMIT: usize = 4096;
const RESPONSE_LIMIT: usize = 2 * 1024 * 1024;
const RECEIPTS: &str = "receipts.json";
const RECEIPT_BYTES_LIMIT: usize = 2 * 1024 * 1024;
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    digest: String,
    familiar_id: String,
}
impl Receipt {
    fn recovered(&self, id: &str) -> Value {
        json!({"id":id,"familiarId":self.familiar_id,"status":"failed","messages":[],"error":"Chat restarted or released this run from memory. Read its saved history; do not resend this request."})
    }
}
struct Gate {
    enabled: bool,
    receipts: BTreeMap<String, Receipt>,
    runs: BTreeMap<String, Arc<RunRecord>>,
}
pub(super) struct Host {
    data: PathBuf,
    identity: Identity,
    pub endpoint: String,
    backend: Arc<dyn Backend>,
    gate: Mutex<Gate>,
    task: Mutex<Option<JoinHandle<()>>>,
    advertisement: Mutex<Option<std::process::Child>>,
}
impl Host {
    pub fn start(
        data: &Path,
        ip: Ipv4Addr,
        backend: Arc<dyn Backend>,
    ) -> Result<Arc<Self>, String> {
        Self::start_with_runs(data, ip, backend, BTreeMap::new())
    }
    fn start_with_runs(
        data: &Path,
        ip: Ipv4Addr,
        backend: Arc<dyn Backend>,
        runs: BTreeMap<String, Arc<RunRecord>>,
    ) -> Result<Arc<Self>, String> {
        if !(ip.is_private() || cfg!(test) && ip.is_loopback()) {
            return Err("Connect your Mac to a private local network first.".into());
        }
        let mut identity = Identity::load(data)?;
        let receipts = match credentials::read_private(data, RECEIPTS, RECEIPT_BYTES_LIMIT)? {
            Some(bytes) => serde_json::from_slice::<BTreeMap<String, Receipt>>(&bytes)
                .map_err(|_| "Companion send receipts are unreadable.")?,
            None => BTreeMap::new(),
        };
        if receipts.len() > RECEIPT_LIMIT
            || receipts.iter().any(|(id, receipt)| {
                crate::coven_runtime::validate_id(id).is_err()
                    || crate::coven_runtime::validate_id(&receipt.familiar_id).is_err()
                    || receipt.digest.len() != 64
                    || !receipt.digest.bytes().all(|b| b.is_ascii_hexdigit())
            })
        {
            return Err("Companion send receipts are invalid.".into());
        }
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::aws_lc_rs::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map_err(|_| "Cannot configure companion TLS.")?
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(identity.certificate.clone())],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(identity.key.clone())),
        )
        .map_err(|_| "Companion certificate cannot be loaded.")?;
        // A stable port keeps saved pairings useful after restarting Chat. Do
        // not silently move if the saved port is occupied.
        let listener = std::net::TcpListener::bind((ip, identity.port)).map_err(|_| {
            "The companion address is unavailable. Check your network and try again."
        })?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "Cannot start companion listener.")?;
        let port = listener
            .local_addr()
            .map_err(|_| "Cannot inspect companion listener.")?
            .port();
        identity.port = port;
        identity.save(data)?;
        let listener =
            TcpListener::from_std(listener).map_err(|_| "Cannot start companion listener.")?;
        let host = Arc::new(Self {
            data: data.into(),
            identity,
            endpoint: format!("https://{ip}:{port}"),
            backend,
            gate: Mutex::new(Gate {
                enabled: true,
                receipts,
                runs,
            }),
            task: Mutex::new(None),
            advertisement: Mutex::new(None),
        });
        let task_host = host.clone();
        *host.task.lock().map_err(|_| "Companion unavailable.")? = Some(tokio::spawn(async move {
            let acceptor = TlsAcceptor::from(Arc::new(config));
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    Some(_) = connections.join_next(), if !connections.is_empty() => {},
                    accepted = listener.accept() => {
                        let Ok((socket, peer)) = accepted else { break; };
                        if connections.len() >= 16 || !allowed_peer(peer) { continue; }
                        let host = task_host.clone();
                        let acceptor = acceptor.clone();
                        connections.spawn(async move {
                            let handshake = tokio::time::timeout(Duration::from_secs(5), acceptor.accept(socket)).await;
                            let Ok(Ok(mut stream)) = handshake else { return; };
                            let _ = tokio::time::timeout(Duration::from_secs(65), async {
                                let request = tokio::time::timeout(Duration::from_secs(5), read_request(&mut stream)).await;
                                let response = match request {
                                    Ok(Ok(request)) => host.dispatch(request).await,
                                    Ok(Err(code)) => (code, json!({"error":"Invalid or oversized request."})),
                                    Err(_) => (408,json!({"error":"Request timed out."})),
                                };
                                let mut body = serde_json::to_vec(&response.1).unwrap_or_default();
                                let mut code = response.0;
                                if body.len() > RESPONSE_LIMIT { code=413; body=b"{\"error\":\"Read a smaller history on your Mac.\"}".to_vec(); }
                                if !host.enabled() { return; }
                                let header = format!("HTTP/1.1 {code} {}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n", reason(code), body.len());
                                let _ = stream.write_all(header.as_bytes()).await;
                                let _ = stream.write_all(&body).await;
                                let _ = stream.shutdown().await;
                            }).await;
                        });
                    }
                }
            }
        }));
        #[cfg(target_os = "macos")]
        if !cfg!(test) {
            // dns-sd is provided by macOS. It owns the advertisement only;
            // TLS pinning remains the sole server identity check.
            let child = std::process::Command::new("/usr/bin/dns-sd")
                .args([
                    "-R",
                    "Coven Chat",
                    "_coven-chat._tcp",
                    "local",
                    &port.to_string(),
                    &format!("fingerprint={}", host.identity.fingerprint()),
                    &format!("url={}", host.endpoint),
                ])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .ok();
            *host.advertisement.lock().unwrap_or_else(|e| e.into_inner()) = child;
        }
        Ok(host)
    }
    pub async fn rebind(self: &Arc<Self>, ip: Ipv4Addr) -> Result<Arc<Self>, String> {
        let runs = {
            let mut gate = self.gate.lock().map_err(|_| "Companion unavailable.")?;
            gate.enabled = false;
            std::mem::take(&mut gate.runs)
        };
        // Network changes revoke sockets, not already admitted Coven runs.
        if let Some(task) = self.close_connections(false) {
            let _ = task.await;
        }
        Self::start_with_runs(&self.data, ip, self.backend.clone(), runs)
    }
    pub fn address(&self) -> Option<Ipv4Addr> {
        url::Url::parse(&self.endpoint)
            .ok()?
            .host_str()?
            .parse()
            .ok()
    }

    pub fn pairing_link(&self) -> String {
        let mut url = url::Url::parse("coven-chat://pair").expect("constant URL");
        url.query_pairs_mut()
            .append_pair("endpoint", &self.endpoint)
            .append_pair("token", &self.identity.token)
            .append_pair("fingerprint", &self.identity.fingerprint());
        url.into()
    }
    fn enabled(&self) -> bool {
        self.gate.lock().is_ok_and(|g| g.enabled)
    }
    pub fn disable(&self) -> Option<JoinHandle<()>> {
        self.close_connections(true)
    }
    fn close_connections(&self, cancel_runs: bool) -> Option<JoinHandle<()>> {
        if let Ok(mut gate) = self.gate.lock() {
            gate.enabled = false;
            if cancel_runs {
                for run in gate.runs.values().filter(|r| r.running()) {
                    run.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
                }
            }
        }
        let task = self.task.lock().ok().and_then(|mut task| task.take());
        if let Some(task) = &task {
            task.abort();
        }
        if let Ok(mut advertisement) = self.advertisement.lock() {
            if let Some(mut child) = advertisement.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        task
    }
    async fn dispatch(&self, request: Request) -> (u16, Value) {
        {
            let Ok(gate) = self.gate.lock() else {
                return error(503, "Companion unavailable.");
            };
            if !gate.enabled || !authorized(&self.identity.token, &request.bearer, request.origin) {
                return error(401, "Pair again from Chat on your Mac.");
            }
        }
        let parsed = match url::Url::parse(&format!("https://companion{}", request.path)) {
            Ok(p) => p,
            Err(_) => return error(400, "Invalid request."),
        };
        let query: Vec<_> = parsed.query_pairs().collect();
        match (request.method.as_str(), parsed.path()) {
            ("GET", "/v1/snapshot") if query.is_empty() => match self.backend.snapshot().await {
                Ok(mut value) => {
                    value["activeRun"] = self.backend.active().map_or(Value::Null, |r| r.value());
                    (200, value)
                }
                Err(_) => error(503, "Cannot read Chat. Check Coven on your Mac."),
            },
            ("GET", "/v1/history") if query.len() == 1 && query[0].0 == "familiarId" => {
                if crate::coven_runtime::validate_id(&query[0].1).is_err() {
                    return error(400, "Invalid familiar.");
                }
                match self.backend.history(query[0].1.to_string()).await {
                    Ok(value) => (200, value),
                    Err(_) => error(503, "Cannot read this chat. Refresh Chat on your Mac."),
                }
            }
            ("GET", "/v1/run") if query.len() == 1 && query[0].0 == "id" => {
                let gate = self.gate.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(run) = gate.runs.get(query[0].1.as_ref()) {
                    return (200, run.value());
                }
                if let Some(run) = self.backend.run(&query[0].1) {
                    return (200, run.value());
                }
                if let Some(receipt) = gate.receipts.get(query[0].1.as_ref()) {
                    return (200, receipt.recovered(&query[0].1));
                }
                error(404, "Run not found.")
            }
            ("POST", "/v1/send") if query.is_empty() => {
                let input: SendRequest = match serde_json::from_slice(&request.body) {
                    Ok(input) => input,
                    Err(_) => return error(400, "Invalid send request."),
                };
                if input.validate().is_err() {
                    return error(400, "Invalid message or identifier.");
                }
                let digest = credentials::hex(&Sha256::digest(
                    serde_json::to_vec(&input).unwrap_or_default(),
                ));
                // Authentication, revocation, receipt persistence and admission
                // are one transaction. A disconnected HTTP task never owns the run.
                let mut gate = self.gate.lock().unwrap_or_else(|e| e.into_inner());
                if !gate.enabled {
                    return error(401, "Pair again from Chat on your Mac.");
                }
                if let Some(previous) = gate.receipts.get(&input.request_id) {
                    if previous.digest != digest {
                        return error(
                            409,
                            "This request ID was already used for a different message.",
                        );
                    }
                    if let Some(run) = gate.runs.get(&input.request_id) {
                        return (200, run.value());
                    }
                    return (200, previous.recovered(&input.request_id));
                }
                if gate.receipts.len() >= RECEIPT_LIMIT {
                    return error(507, "Companion send receipts are full. Send from your Mac.");
                }
                // Persist before execution; even a crash between these steps is
                // an indeterminate accepted send, never permission to repeat it.
                gate.receipts.insert(
                    input.request_id.clone(),
                    Receipt {
                        digest,
                        familiar_id: input.familiar_id.clone(),
                    },
                );
                if save_receipts(&self.data, &gate.receipts).is_err() {
                    gate.receipts.remove(&input.request_id);
                    return error(503, "Cannot save the send receipt. No run was started.");
                }
                let failed_id = input.request_id.clone();
                let failed_familiar = input.familiar_id.clone();
                match self.backend.start(input) {
                    Ok(run) => {
                        let value = run.value();
                        if gate.runs.len() >= 16 {
                            gate.runs.retain(|_, r| r.running());
                        }
                        gate.runs.insert(run.id.clone(), run);
                        (200, value)
                    }
                    Err(_) => {
                        let run = RunRecord::new(
                            failed_id,
                            failed_familiar,
                            Arc::new(std::sync::atomic::AtomicBool::new(false)),
                        );
                        run.finish(&Err("Cannot start this run.".into()));
                        let value = run.value();
                        if gate.runs.len() >= 16 {
                            gate.runs.retain(|_, r| r.running());
                        }
                        gate.runs.insert(run.id.clone(), run);
                        (200, value)
                    }
                }
            }
            ("POST", "/v1/stop") if query.is_empty() => {
                #[derive(serde::Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Stop {
                    run_id: String,
                }
                let input: Stop = match serde_json::from_slice(&request.body) {
                    Ok(v) => v,
                    Err(_) => return error(400, "Invalid stop request."),
                };
                let gate = self.gate.lock().unwrap_or_else(|e| e.into_inner());
                if !gate.enabled {
                    return error(401, "Pair again from Chat on your Mac.");
                }
                match self.backend.stop(&input.run_id) {
                    Ok(()) => (200, json!({"ok":true})),
                    Err(_) => error(409, "This run is no longer active."),
                }
            }
            _ => error(404, "Unknown companion request."),
        }
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.disable();
    }
}
fn allowed_peer(peer: SocketAddr) -> bool {
    matches!(peer.ip(),std::net::IpAddr::V4(ip) if ip.is_private() || (cfg!(test) && ip.is_loopback()))
}
fn error(code: u16, message: &str) -> (u16, Value) {
    (code, json!({"error":message}))
}
fn reason(code: u16) -> &'static str {
    match code {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        408 => "Request Timeout",
        409 => "Conflict",
        413 => "Content Too Large",
        507 => "Insufficient Storage",
        _ => "Service Unavailable",
    }
}
struct Request {
    method: String,
    path: String,
    bearer: String,
    origin: bool,
    body: Vec<u8>,
}
async fn read_request<S: tokio::io::AsyncRead + Unpin>(stream: &mut S) -> Result<Request, u16> {
    let mut bytes = Vec::new();
    let header_end;
    loop {
        if let Some(index) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            header_end = index + 4;
            break;
        }
        if bytes.len() >= HEADER_LIMIT {
            return Err(413);
        }
        let mut block = [0; 1024];
        let count = stream.read(&mut block).await.map_err(|_| 400u16)?;
        if count == 0 {
            return Err(400);
        }
        bytes.extend_from_slice(&block[..count]);
    }
    if header_end > HEADER_LIMIT {
        return Err(413);
    }
    let mut headers = [httparse::EMPTY_HEADER; 32];
    let mut parsed = httparse::Request::new(&mut headers);
    parsed.parse(&bytes[..header_end]).map_err(|_| 400u16)?;
    let method = parsed.method.ok_or(400u16)?.to_owned();
    let path = parsed.path.ok_or(400u16)?.to_owned();
    if !path.starts_with('/')
        || path.starts_with("//")
        || path.contains('#')
        || parsed.version != Some(1)
    {
        return Err(400);
    }
    let mut bearer = None;
    let mut length = None;
    let mut origin = false;
    let mut content_type = None;
    for header in parsed.headers.iter() {
        let name = header.name.to_ascii_lowercase();
        match name.as_str() {
            "authorization" => {
                if bearer.is_some() {
                    return Err(400);
                }
                bearer = Some(
                    std::str::from_utf8(header.value)
                        .map_err(|_| 400u16)?
                        .to_owned(),
                );
            }
            "origin" => origin = true,
            "content-length" => {
                if length.is_some() {
                    return Err(400);
                }
                let value = std::str::from_utf8(header.value).map_err(|_| 400u16)?;
                if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
                    return Err(400);
                }
                length = Some(value.parse::<usize>().map_err(|_| 413u16)?);
            }
            "content-type" => {
                if content_type.is_some() {
                    return Err(400);
                }
                content_type = Some(header.value.to_vec());
            }
            "transfer-encoding" | "expect" => return Err(400),
            _ => {}
        }
    }
    let length = length.unwrap_or(0);
    if length > BODY_LIMIT {
        return Err(413);
    }
    if method == "GET" && length != 0 {
        return Err(400);
    }
    if method == "POST" && content_type.as_deref() != Some(b"application/json".as_slice()) {
        return Err(400);
    }
    while bytes.len() < header_end + length {
        let mut block = [0; 4096];
        let max = block.len().min(header_end + length - bytes.len());
        let count = stream.read(&mut block[..max]).await.map_err(|_| 400u16)?;
        if count == 0 {
            return Err(400);
        }
        bytes.extend_from_slice(&block[..count]);
    }
    if bytes.len() != header_end + length {
        return Err(400);
    }
    Ok(Request {
        method,
        path,
        bearer: bearer.unwrap_or_default(),
        origin,
        body: bytes[header_end..].to_vec(),
    })
}

#[cfg(all(test, unix))]
mod tests;

fn save_receipts(data: &Path, receipts: &BTreeMap<String, Receipt>) -> Result<(), String> {
    let bytes = serde_json::to_vec(receipts).map_err(|_| "Cannot encode send receipts.")?;
    if bytes.len() > RECEIPT_BYTES_LIMIT {
        return Err("Companion send receipts are full.".into());
    }
    crate::chat_lifecycle::persist(data, RECEIPTS, &bytes)
}
