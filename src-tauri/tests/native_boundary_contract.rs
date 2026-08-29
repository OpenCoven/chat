use opencoven_chat_lib::{
    validate_unix_peer_identity, validate_windows_pipe_identity, AuthorityDescriptor,
    AuthorityLifecycle, CanonicalPageCommandInput, DiagnosticCode, DiscoveryHandleInput,
    HealthCommandInput, ManagedPairingCommandInput, NativeResponse, NativeResponseOperation,
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
}

#[test]
fn public_snapshots_reject_secret_and_private_control_fields() {
    for payload in [
        json!({"data": {"bearer": "credential"}}),
        json!({"data": {"pairingSecret": "credential"}}),
        json!({"data": {"prompt": "private prompt"}}),
        json!({"error": {"cause": "raw keychain failure"}}),
        json!({"data": {"attachment": {"name": "private.pdf"}}}),
    ] {
        assert_eq!(
            NativeResponse::snapshot(NativeResponseOperation::Health, 200, payload)
                .expect_err("sensitive command output must fail closed")
                .code,
            DiagnosticCode::InvalidResponse
        );
    }
}

#[test]
fn public_snapshots_do_not_duplicate_client_v1_parsing() {
    let content = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    let response = NativeResponse::snapshot(
        NativeResponseOperation::ListConversationMessages,
        299,
        json!({
            "futureEnvelope": true,
            "data": {
                "messages": [{
                    "id": "future-id",
                    "unknownPublicField": 7,
                    "text": content
                }]
            }
        }),
    )
    .expect("the packed SDK, not Rust, owns protocol validation");
    let rendered = serde_json::to_value(response).expect("snapshot should serialize");

    assert_eq!(rendered["statusCode"], 299);
    assert_eq!(
        rendered["payload"]["data"]["messages"][0]["unknownPublicField"],
        7
    );
    assert_eq!(rendered["payload"]["data"]["messages"][0]["text"], content);
}

#[test]
fn public_snapshots_reject_secret_shaped_metadata_and_error_values() {
    for payload in [
        json!({
            "data": {
                "metadata": {
                    "accessToken": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
                }
            }
        }),
        json!({
            "error": {
                "code": "internal_error",
                "message": "safe",
                "metadata": {
                    "traceValue": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
                }
            }
        }),
    ] {
        assert_eq!(
            NativeResponse::snapshot(NativeResponseOperation::Health, 500, payload)
                .expect_err("non-content secret-shaped values must fail closed")
                .code,
            DiagnosticCode::InvalidResponse
        );
    }
}

#[test]
fn command_arguments_use_exact_camel_case_envelopes() {
    assert!(serde_json::from_value::<HealthCommandInput>(json!({
        "authority": {
            "handle": "authority:00000000-0000-4000-8000-000000000001",
            "generation": 1
        },
        "requestId": "request-1"
    }))
    .is_ok());

    assert!(serde_json::from_value::<CanonicalPageCommandInput>(json!({
        "authority": {
            "handle": "authority:00000000-0000-4000-8000-000000000001",
            "generation": 1
        },
        "requestId": "request-1",
        "options": {"limit": 25}
    }))
    .is_ok());

    assert!(serde_json::from_value::<ManagedPairingCommandInput>(json!({
        "authority": {
            "handle": "authority:00000000-0000-4000-8000-000000000001",
            "generation": 1
        },
        "requestId": "request-1",
        "pairingRequestId": "11111111-1111-4111-8111-111111111111"
    }))
    .is_ok());

    assert!(serde_json::from_value::<DiscoveryHandleInput>(json!({
        "discoveryHandle": "discovery:00000000-0000-4000-8000-000000000001"
    }))
    .is_ok());

    assert!(serde_json::from_value::<HealthCommandInput>(json!({
        "authority": {
            "handle": "authority:00000000-0000-4000-8000-000000000001",
            "generation": 1
        },
        "request_id": "request-1"
    }))
    .is_err());
}
