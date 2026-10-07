use super::*;
#[test]
fn bearer_is_exact_and_origins_are_rejected() {
    let token = "a".repeat(64);
    assert!(authorized(&token, &format!("Bearer {token}"), false));
    assert!(!authorized(&token, &format!("Bearer {token}"), true));
    assert!(!authorized(
        &token,
        &format!("Bearer {}", "b".repeat(64)),
        false
    ));
    assert!(!authorized(&token, &token, false));
}
#[test]
fn projection_includes_prose_and_excludes_tool_payloads_and_backend_metadata() {
    let messages = project_messages(&[
        json!({"type":"system","subtype":"init","session_id":"secret-session","workspace":"/private"}),
        json!({"type":"text_delta","text":"Hello"}),
        json!({"type":"text_delta","text":" world"}),
        json!({"type":"tool_start","tool":"read","input":{"path":"/private"}}),
        json!({"type":"assistant","message":{"content":[{"type":"text","text":"Done"},{"type":"tool_use","input":{"secret":"secret"}}]}}),
    ]);
    assert_eq!(messages[0]["text"], "Hello world");
    assert_eq!(messages.last().unwrap()["text"], "Done");
    let wire = serde_json::to_string(&messages).unwrap();
    assert!(!wire.contains("/private") && !wire.contains("secret"));
}

#[test]
fn replay_disclosure_is_a_status_message_without_system_metadata() {
    let messages = project_messages(&[
        json!({"type":"system","subtype":"notice","source":"chat-replay","session_id":"secret","message":{"content":[{"type":"text","text":"Chat carried 4 earlier turns into this run."}]}}),
        json!({"type":"system","subtype":"init","workspace":"/private","message":{"content":[{"type":"text","text":"Internal startup"}]}}),
    ]);
    assert_eq!(
        messages,
        vec![
            json!({"id":"0","role":"status","text":"Chat carried 4 earlier turns into this run."})
        ]
    );
}
