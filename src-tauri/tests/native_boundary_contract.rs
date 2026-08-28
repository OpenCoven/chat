use opencoven_chat_lib::{
    validate_unix_peer_identity, validate_windows_pipe_identity, AuthorityDescriptor,
    AuthorityLifecycle, DiagnosticCode, HealthCommandInput, NativeResponse,
    UnavailableCredentialCustody, UnixPeerIdentity, WindowsPipeIdentity,
};
use serde_json::json;

const PUBLIC_KEY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const KEY_ID: &str = "tDE1VahIyqtAoH7mJ7uT3yzaF6EnK70vG9JMvTMCOAM";

fn authority_json(instance_id: &str) -> serde_json::Value {
    json!({
        "version": 2,
        "endpoint": {
            "kind": "http",
            "url": "http://127.0.0.1:3020"
        },
        "freshness": {
            "pid": 4321,
            "nonce": PUBLIC_KEY,
            "startedAt": "2026-08-28T00:00:00.000Z"
        },
        "record": {
            "identity": format!("sha256:{}", "a".repeat(64)),
            "device": 7,
            "inode": 11
        },
        "authority": {
            "mechanism": "hpke-bound-v1",
            "mode": "enforce",
            "keyId": KEY_ID,
            "publicKey": PUBLIC_KEY,
            "suite": {
                "kemId": 32,
                "kdfId": 1,
                "aeadId": 2
            }
        },
        "instanceId": instance_id
    })
}

fn authority(instance_id: &str) -> AuthorityDescriptor {
    AuthorityDescriptor::from_json(authority_json(instance_id))
        .expect("the deterministic authority fixture should be valid")
}

#[test]
fn stale_generation_rejects_a_delayed_operation() {
    let lifecycle = AuthorityLifecycle::default();
    let first = lifecycle
        .replace(authority("00000000-0000-4000-8000-000000000001"))
        .expect("first authority should open");
    let request = lifecycle
        .begin_request(&first, "request-1")
        .expect("request should begin");

    lifecycle
        .replace(authority("00000000-0000-4000-8000-000000000002"))
        .expect("replacement should open");

    let error = lifecycle
        .finish_request(&request)
        .expect_err("the delayed request must be stale");
    assert_eq!(error.code, DiagnosticCode::ReconcileRequired);
}

#[test]
fn authority_input_rejects_hostile_and_oversized_values() {
    let mut hostile = authority_json("00000000-0000-4000-8000-000000000001");
    hostile["endpoint"]["url"] = json!("http://127.0.0.1:3020/?secret=leak");
    assert_eq!(
        AuthorityDescriptor::from_json(hostile)
            .expect_err("query-bearing endpoints must fail")
            .code,
        DiagnosticCode::UnsafeEndpoint
    );

    let mut oversized = authority_json("00000000-0000-4000-8000-000000000001");
    oversized["freshness"]["startedAt"] = json!("x".repeat(257));
    assert_eq!(
        AuthorityDescriptor::from_json(oversized)
            .expect_err("oversized timestamps must fail")
            .code,
        DiagnosticCode::InvalidRequest
    );
}

#[test]
fn unavailable_keychain_fails_closed() {
    let custody = UnavailableCredentialCustody::secure_store();
    let error = custody
        .installation_id()
        .expect_err("there must be no memory or plaintext fallback");
    assert_eq!(error.code, DiagnosticCode::SecureStoreUnavailable);
}

#[test]
fn wrong_unix_peer_identity_is_rejected() {
    let error = validate_unix_peer_identity(
        &UnixPeerIdentity {
            uid: 502,
            gid: Some(20),
            pid: Some(987),
        },
        501,
    )
    .expect_err("a foreign connected uid must fail");
    assert_eq!(error.code, DiagnosticCode::OwnerMismatch);
}

#[test]
fn foreign_or_mismatched_windows_pipe_identity_is_rejected() {
    let expected = WindowsPipeIdentity {
        owner_identity: "S-1-5-21-current".into(),
        owner_only: true,
        pipe_identity: "pipe-object-1".into(),
        server_process_id: 4321,
        process_creation_time: 99,
        reparse_point: false,
    };
    let mut foreign = expected.clone();
    foreign.owner_identity = "S-1-5-21-foreign".into();
    assert_eq!(
        validate_windows_pipe_identity("S-1-5-21-current", &foreign, &foreign)
            .expect_err("foreign ownership must fail")
            .code,
        DiagnosticCode::OwnerMismatch
    );

    let mut connected = expected.clone();
    connected.pipe_identity = "pipe-object-2".into();
    assert_eq!(
        validate_windows_pipe_identity("S-1-5-21-current", &expected, &connected)
            .expect_err("connected identity changes must fail")
            .code,
        DiagnosticCode::UnsafeEndpoint
    );

    let mut reparse = expected.clone();
    reparse.reparse_point = true;
    assert_eq!(
        validate_windows_pipe_identity("S-1-5-21-current", &reparse, &reparse)
            .expect_err("reparse-backed pipes must fail")
            .code,
        DiagnosticCode::UnsafeEndpoint
    );
}

#[test]
fn public_responses_reject_secret_and_message_content() {
    for payload in [
        json!({"data": {"bearer": "bearer-sentinel"}}),
        json!({"data": {"pairingSecret": "secret-sentinel"}}),
        json!({"data": {"prompt": "private prompt"}}),
        json!({"data": {"message": "private message"}}),
        json!({"data": {"value": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}}),
    ] {
        assert_eq!(
            NativeResponse::health(200, payload)
                .expect_err("sensitive command output must fail closed")
                .code,
            DiagnosticCode::InvalidResponse
        );
    }
}

#[test]
fn operation_responses_reject_causes_keychain_records_and_unknown_fields() {
    let error_envelope = |error: serde_json::Value| {
        json!({
            "apiVersion": "1.0",
            "minimumClientVersion": "0.1.0",
            "capabilities": ["health"],
            "operations": ["health.read"],
            "requestId": "request-1",
            "error": error
        })
    };

    assert_eq!(
        NativeResponse::health(
            500,
            error_envelope(json!({
                "code": "service_unavailable",
                "message": "failed at /Users/private/.opencoven/cave.json",
                "retryable": true,
                "cause": "raw keychain failure"
            }))
        )
        .expect_err("raw causes are not an allowlisted error field")
        .code,
        DiagnosticCode::InvalidResponse
    );

    let safe = NativeResponse::health(
        500,
        error_envelope(json!({
            "code": "service_unavailable",
            "message": "failed at /Users/private/.opencoven/cave.json",
            "retryable": true
        })),
    )
    .expect("known protocol errors should be reduced to a safe DTO");
    let rendered = serde_json::to_string(&safe).expect("safe response should serialize");
    assert!(!rendered.contains("/Users/private"));
    assert!(!rendered.contains("keychain"));

    for payload in [
        json!({
            "apiVersion": "1.0",
            "minimumClientVersion": "0.1.0",
            "capabilities": ["health"],
            "operations": ["health.read"],
            "data": {
                "instanceId": "00000000-0000-4000-8000-000000000001",
                "pairingRequired": true,
                "releaseVersion": "0.1.0",
                "serializedKeychainRecord": "private"
            }
        }),
        json!({
            "apiVersion": "1.0",
            "minimumClientVersion": "0.1.0",
            "capabilities": ["health"],
            "operations": ["health.read"],
            "data": {
                "instanceId": "00000000-0000-4000-8000-000000000001",
                "pairingRequired": true,
                "releaseVersion": "0.1.0"
            },
            "unknown": true
        }),
    ] {
        assert_eq!(
            NativeResponse::health(200, payload)
                .expect_err("unknown operation fields must fail closed")
                .code,
            DiagnosticCode::InvalidResponse
        );
    }
}

#[test]
fn command_arguments_use_one_exact_camel_case_envelope() {
    let parsed = serde_json::from_value::<HealthCommandInput>(json!({
        "authority": {
            "handle": "authority:00000000-0000-4000-8000-000000000001",
            "generation": 1
        },
        "requestId": "request-1"
    }));
    assert!(parsed.is_ok());

    assert!(serde_json::from_value::<HealthCommandInput>(json!({
        "authority": {
            "handle": "authority:00000000-0000-4000-8000-000000000001",
            "generation": 1
        },
        "request_id": "request-1"
    }))
    .is_err());
    assert!(serde_json::from_value::<HealthCommandInput>(json!({
        "authority": {
            "handle": "authority:00000000-0000-4000-8000-000000000001",
            "generation": 1
        },
        "requestId": "request-1",
        "extra": true
    }))
    .is_err());
}
