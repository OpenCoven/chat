use super::super::fixture::FixtureBackend;
use super::*;
use std::sync::atomic::Ordering;
fn temp() -> PathBuf {
    std::env::temp_dir().join(uuid::Uuid::new_v4().to_string())
}
async fn connect(host: &Host) -> tokio_rustls::client::TlsStream<tokio::net::TcpStream> {
    let mut roots = rustls::RootCertStore::empty();
    roots
        .add(CertificateDer::from(host.identity.certificate.clone()))
        .unwrap();
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::aws_lc_rs::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_root_certificates(roots)
    .with_no_client_auth();
    let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
    let socket = tokio::net::TcpStream::connect(host.endpoint.trim_start_matches("https://"))
        .await
        .unwrap();
    connector
        .connect(
            rustls::pki_types::ServerName::try_from("coven-chat.local")
                .unwrap()
                .to_owned(),
            socket,
        )
        .await
        .unwrap()
}
async fn request(
    host: &Host,
    method: &str,
    path: &str,
    body: Option<Value>,
    extra: &str,
) -> (u16, Value) {
    let mut stream = connect(host).await;
    let body = body.map(|b| b.to_string()).unwrap_or_default();
    let request=format!("{method} {path} HTTP/1.1\r\nHost: coven-chat.local\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{extra}\r\n{body}",host.identity.token,body.len());
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    let boundary = response.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let header = std::str::from_utf8(&response[..boundary]).unwrap();
    assert!(header.contains("Cache-Control: no-store"));
    (
        header.split_whitespace().nth(1).unwrap().parse().unwrap(),
        serde_json::from_slice(&response[boundary + 4..]).unwrap(),
    )
}
fn send(id: &str) -> Value {
    json!({"requestId":id,"familiarId":"fixture","sessionId":null,"prompt":"hello"})
}
#[tokio::test]
async fn real_tls_host_starts_with_persisted_private_credentials() {
    let root = temp();
    let backend = Arc::new(FixtureBackend::default());
    let host = Host::start(&root, Ipv4Addr::LOCALHOST, backend).unwrap();
    let token = host.identity.token.clone();
    let fingerprint = host.identity.fingerprint();
    let (code, snapshot) = request(&host, "GET", "/v1/snapshot", None, "").await;
    assert_eq!(code, 200);
    assert_eq!(snapshot["familiars"][0]["id"], "fixture");
    assert_eq!(
        request(&host, "GET", "/v1/history?familiarId=fixture", None, "")
            .await
            .1["messages"][0]["role"],
        "assistant"
    );
    assert_eq!(
        request(
            &host,
            "GET",
            "/v1/snapshot",
            None,
            "Origin: https://evil.test\r\n"
        )
        .await
        .0,
        401
    );
    let saved = Identity::load(&root).unwrap();
    assert_eq!(saved.token, token);
    assert_eq!(saved.fingerprint(), fingerprint);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(root.join("identity.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    host.disable();
    std::fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn accepted_send_is_idempotent_changed_replays_fail_and_stop_uses_same_run() {
    let root = temp();
    let backend = Arc::new(FixtureBackend::default());
    let host = Host::start(&root, Ipv4Addr::LOCALHOST, backend.clone()).unwrap();
    let (code, run) = request(&host, "POST", "/v1/send", Some(send("request-1")), "").await;
    assert_eq!(code, 200);
    assert_eq!(run["status"], "running");
    assert_eq!(
        request(&host, "POST", "/v1/send", Some(send("request-1")), "")
            .await
            .0,
        200
    );
    let mut changed = send("request-1");
    changed["prompt"] = json!("different");
    assert_eq!(
        request(&host, "POST", "/v1/send", Some(changed), "")
            .await
            .0,
        409
    );
    assert_eq!(backend.starts.load(Ordering::SeqCst), 1);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let run = request(&host, "GET", "/v1/run?id=request-1", None, "")
        .await
        .1;
    assert!(run["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["role"] == "assistant"));
    assert_eq!(
        request(
            &host,
            "POST",
            "/v1/stop",
            Some(json!({"runId":"request-1"})),
            ""
        )
        .await
        .0,
        200
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        request(&host, "GET", "/v1/run?id=request-1", None, "")
            .await
            .1["status"],
        "stopped"
    );
    host.disable();
    tokio::task::yield_now().await;
    let reopened = Host::start(&root, Ipv4Addr::LOCALHOST, backend.clone()).unwrap();
    assert_eq!(
        request(&reopened, "POST", "/v1/send", Some(send("request-1")), "")
            .await
            .0,
        200
    );
    assert_eq!(backend.starts.load(Ordering::SeqCst), 1);
    reopened.disable();
    std::fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn parser_bounds_and_unknown_fields_fail_before_execution() {
    let root = temp();
    let backend = Arc::new(FixtureBackend::default());
    let host = Host::start(&root, Ipv4Addr::LOCALHOST, backend.clone()).unwrap();
    let mut unknown = send("one");
    unknown["shell"] = json!("no");
    assert_eq!(
        request(&host, "POST", "/v1/send", Some(unknown), "")
            .await
            .0,
        400
    );
    let mut oversized = send("two");
    oversized["prompt"] = json!("x".repeat(41000));
    assert_eq!(
        request(&host, "POST", "/v1/send", Some(oversized), "")
            .await
            .0,
        413
    );
    assert_eq!(
        request(&host, "GET", "/v1/snapshot?unexpected=true", None, "")
            .await
            .0,
        404
    );
    assert_eq!(backend.starts.load(Ordering::SeqCst), 0);
    host.disable();
    std::fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn disable_closes_inflight_tls_and_revokes_authentication() {
    let root = temp();
    let host = Host::start(
        &root,
        Ipv4Addr::LOCALHOST,
        Arc::new(FixtureBackend::default()),
    )
    .unwrap();
    let mut stream = connect(&host).await;
    stream
        .write_all(b"GET /v1/snapshot HTTP/1.1\r\n")
        .await
        .unwrap();
    host.disable();
    let mut bytes = [0; 1];
    let read = tokio::time::timeout(Duration::from_secs(1), stream.read(&mut bytes))
        .await
        .unwrap();
    assert!(read.is_err() || read.unwrap() == 0);
    assert_eq!(
        host.dispatch(Request {
            method: "GET".into(),
            path: "/v1/snapshot".into(),
            bearer: format!("Bearer {}", host.identity.token),
            origin: false,
            body: vec![]
        })
        .await
        .0,
        401
    );
    std::fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn restart_returns_terminal_run_without_executing_an_accepted_id_again() {
    let root = temp();
    let backend = Arc::new(FixtureBackend::default());
    let host = Host::start(&root, Ipv4Addr::LOCALHOST, backend.clone()).unwrap();
    request(&host, "POST", "/v1/send", Some(send("durable")), "").await;
    if let Some(task) = host.disable() {
        let _ = task.await;
    }
    let reopened = Host::start(
        &root,
        Ipv4Addr::LOCALHOST,
        Arc::new(FixtureBackend::default()),
    )
    .unwrap();
    let (code, run) = request(&reopened, "GET", "/v1/run?id=durable", None, "").await;
    assert_eq!(code, 200);
    assert_eq!(run["status"], "failed");
    assert_eq!(run["familiarId"], "fixture");
    assert_eq!(
        request(&reopened, "POST", "/v1/send", Some(send("durable")), "")
            .await
            .0,
        200
    );
    assert_eq!(backend.starts.load(Ordering::SeqCst), 1);
    reopened.disable();
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn rotation_rejects_old_token_and_preserves_certificate_and_receipts() {
    let root = temp();
    let host = Host::start(
        &root,
        Ipv4Addr::LOCALHOST,
        Arc::new(FixtureBackend::default()),
    )
    .unwrap();
    let old_token = host.identity.token.clone();
    let old_fingerprint = host.identity.fingerprint();
    request(&host, "POST", "/v1/send", Some(send("before-forget")), "").await;
    if let Some(task) = host.disable() {
        let _ = task.await;
    }
    let mut identity = Identity::load(&root).unwrap();
    identity.token = credentials::random_token().unwrap();
    identity.save(&root).unwrap();
    let host = Host::start(
        &root,
        Ipv4Addr::LOCALHOST,
        Arc::new(FixtureBackend::default()),
    )
    .unwrap();
    assert_ne!(old_token, host.identity.token);
    assert_eq!(old_fingerprint, host.identity.fingerprint());
    let stale = Request {
        method: "POST".into(),
        path: "/v1/send".into(),
        bearer: format!("Bearer {old_token}"),
        origin: false,
        body: send("after-forget").to_string().into_bytes(),
    };
    assert_eq!(host.dispatch(stale).await.0, 401);
    assert_eq!(
        request(&host, "GET", "/v1/run?id=before-forget", None, "")
            .await
            .1["status"],
        "failed"
    );
    host.disable();
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn untrusted_certificate_and_plaintext_cannot_read_transport() {
    let root = temp();
    let host = Host::start(
        &root,
        Ipv4Addr::LOCALHOST,
        Arc::new(FixtureBackend::default()),
    )
    .unwrap();
    let other = rcgen::generate_simple_self_signed(vec!["coven-chat.local".into()]).unwrap();
    let mut roots = rustls::RootCertStore::empty();
    roots.add(other.cert.der().clone()).unwrap();
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::aws_lc_rs::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_root_certificates(roots)
    .with_no_client_auth();
    let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
    let address = host.endpoint.trim_start_matches("https://");
    let socket = tokio::net::TcpStream::connect(address).await.unwrap();
    assert!(connector
        .connect(
            rustls::pki_types::ServerName::try_from("coven-chat.local")
                .unwrap()
                .to_owned(),
            socket
        )
        .await
        .is_err());
    let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
    socket
        .write_all(b"GET /v1/snapshot HTTP/1.1\r\nHost: test\r\n\r\n")
        .await
        .unwrap();
    let mut bytes = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(1), socket.read_to_end(&mut bytes))
        .await
        .unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("fixture"));
    host.disable();
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn disconnected_sender_recovers_the_one_admitted_run() {
    let root = temp();
    let backend = Arc::new(FixtureBackend::default());
    let host = Host::start(&root, Ipv4Addr::LOCALHOST, backend.clone()).unwrap();
    let mut stream = connect(&host).await;
    let body = send("lost-response").to_string();
    stream.write_all(format!("POST /v1/send HTTP/1.1\r\nHost: test\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", host.identity.token, body.len()).as_bytes()).await.unwrap();
    drop(stream);
    for _ in 0..100 {
        if backend.starts.load(Ordering::SeqCst) == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(
        request(&host, "POST", "/v1/send", Some(send("lost-response")), "")
            .await
            .0,
        200
    );
    assert_eq!(backend.starts.load(Ordering::SeqCst), 1);
    host.disable();
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn handshake_concurrency_and_body_deadline_are_bounded() {
    let root = temp();
    let host = Host::start(
        &root,
        Ipv4Addr::LOCALHOST,
        Arc::new(FixtureBackend::default()),
    )
    .unwrap();
    let mut stalled = Vec::new();
    for _ in 0..16 {
        stalled.push(
            tokio::net::TcpStream::connect(host.endpoint.trim_start_matches("https://"))
                .await
                .unwrap(),
        );
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    let mut overflow = tokio::net::TcpStream::connect(host.endpoint.trim_start_matches("https://"))
        .await
        .unwrap();
    let mut bytes = [0; 1];
    let read = tokio::time::timeout(Duration::from_secs(1), overflow.read(&mut bytes))
        .await
        .unwrap();
    assert!(read.is_err() || read.unwrap() == 0);
    drop(stalled);
    tokio::time::sleep(Duration::from_millis(50)).await;
    let mut slow = connect(&host).await;
    slow.write_all(b"POST /v1/send HTTP/1.1\r\nHost: test\r\nContent-Type: application/json\r\nContent-Length: 50\r\n\r\n{").await.unwrap();
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(7), slow.read_to_end(&mut response))
        .await
        .unwrap()
        .unwrap();
    assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 408"));
    host.disable();
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn maximum_valid_receipt_store_remains_readable_after_restart() {
    let root = temp();
    let _ = Identity::load(&root).unwrap();
    let receipts: BTreeMap<String, Receipt> = (0..RECEIPT_LIMIT)
        .map(|index| {
            (
                format!("{index:0128}"),
                Receipt {
                    digest: "a".repeat(64),
                    familiar_id: "f".repeat(128),
                },
            )
        })
        .collect();
    let bytes = serde_json::to_vec(&receipts).unwrap();
    assert!(bytes.len() > 1024 * 1024);
    crate::chat_lifecycle::persist(&root, RECEIPTS, &bytes).unwrap();
    let host = Host::start(
        &root,
        Ipv4Addr::LOCALHOST,
        Arc::new(FixtureBackend::default()),
    )
    .unwrap();
    assert_eq!(
        request(&host, "POST", "/v1/send", Some(send("over-capacity")), "")
            .await
            .0,
        507
    );
    host.disable();
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn network_rebind_preserves_pin_port_token_and_live_run() {
    let root = temp();
    let backend = Arc::new(FixtureBackend::default());
    let host = Host::start(&root, Ipv4Addr::LOCALHOST, backend.clone()).unwrap();
    request(&host, "POST", "/v1/send", Some(send("moving-network")), "").await;
    let moved = host.rebind(Ipv4Addr::LOCALHOST).await.unwrap();
    assert_eq!(host.identity.token, moved.identity.token);
    assert_eq!(host.identity.port, moved.identity.port);
    assert_eq!(host.identity.fingerprint(), moved.identity.fingerprint());
    assert_eq!(
        request(&moved, "GET", "/v1/run?id=moving-network", None, "")
            .await
            .1["status"],
        "running"
    );
    assert_eq!(
        request(&moved, "POST", "/v1/send", Some(send("moving-network")), "")
            .await
            .0,
        200
    );
    assert_eq!(backend.starts.load(Ordering::SeqCst), 1);
    moved.disable();
    std::fs::remove_dir_all(root).unwrap();
}
