//! Run-budget v1 validation at Chat's native boundary. Preferences are requests;
//! only a settled runtime receipt can authorize a persisted continuation.
use serde::Deserialize;
use serde_json::{json, Value};

pub(super) fn require_adapter(adapters: &Value) -> Result<(), String> {
    let supported = adapters
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["id"] == "coven-code"))
        .is_some_and(|row| {
            row["run_budget"]["version"] == 1 && row["run_budget"]["flag"] == "--max-turns"
        });
    if supported {
        Ok(())
    } else {
        Err("This Coven CLI cannot apply finite model-round budgets. Update Coven before sending; no message was started.".into())
    }
}

#[derive(Deserialize)]
struct Applied {
    max_turns: std::num::NonZeroU32,
    consumed: u32,
    source: String,
}

#[derive(Deserialize)]
struct Continuation {
    session_id: String,
    resumable: bool,
}

#[derive(Deserialize)]
struct Receipt {
    run_budget_version: u8,
    session_id: String,
    harness_session_id: String,
    turn_budget: Applied,
    num_turns: u32,
    is_error: bool,
    outcome: Option<String>,
    continuation: Continuation,
    // The final Coven result is emitted after its process supervisor settles.
    // An earlier native engine result has no duration_ms.
    duration_ms: u64,
}

pub(super) fn settle(
    event: &Value,
    ledger: &str,
    requested: u32,
    exit_code: Option<i32>,
) -> Result<Value, String> {
    let receipt: Receipt = serde_json::from_value(event.clone()).map_err(|_| {
        "Coven did not confirm the applied model-round budget and saved history.".to_string()
    })?;
    let exhausted = receipt.outcome.as_deref() == Some("turn_budget_exhausted");
    if event["type"] != "result"
        || receipt.run_budget_version != 1
        || receipt.session_id != ledger
        || receipt.turn_budget.max_turns.get() != requested
        || receipt.turn_budget.source != "explicit"
        || receipt.turn_budget.consumed > requested
        || receipt.num_turns != receipt.turn_budget.consumed
        || receipt.harness_session_id.is_empty()
        || receipt.harness_session_id.len() > 4096
        || receipt.continuation.session_id != receipt.harness_session_id
        || (exhausted && (!receipt.is_error || receipt.turn_budget.consumed != requested))
    {
        return Err("Coven returned mismatched run-budget or continuation evidence. Work is unfinished; reload the chat before continuing.".into());
    }
    let settled = exit_code == Some(0) || (exhausted && exit_code == Some(1));
    Ok(json!({
        "type": "system", "subtype": "run_budget", "source": "chat-run-budget",
        "session_id": ledger, "harness_session_id": receipt.harness_session_id,
        "run_budget_version": 1, "num_turns": receipt.num_turns,
        "turn_budget": {"max_turns": requested, "consumed": receipt.turn_budget.consumed, "source": receipt.turn_budget.source},
        "continuation": {"session_id": receipt.continuation.session_id, "resumable": settled && receipt.continuation.resumable},
        "is_error": receipt.is_error, "outcome": receipt.outcome,
        "settled": settled, "duration_ms": receipt.duration_ms,
        "process_exit_code": exit_code,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn receipt() -> Value {
        json!({"type":"result","run_budget_version":1,"session_id":"ledger","harness_session_id":"engine",
            "num_turns":10,"is_error":true,"outcome":"turn_budget_exhausted","duration_ms":1,
            "turn_budget":{"max_turns":10,"source":"explicit","consumed":10},
            "continuation":{"session_id":"engine","resumable":true}})
    }
    #[test]
    fn continuation_requires_final_receipt_and_expected_process_settlement() {
        for exit in [None, Some(0), Some(1), Some(7)] {
            assert_eq!(
                settle(&receipt(), "ledger", 10, exit).unwrap()["process_exit_code"],
                json!(exit)
            );
        }
        assert_eq!(
            settle(&receipt(), "ledger", 10, Some(1)).unwrap()["continuation"]["resumable"],
            true
        );
        for exit in [None, Some(7)] {
            assert_eq!(
                settle(&receipt(), "ledger", 10, exit).unwrap()["continuation"]["resumable"],
                false
            );
        }
        let mut early = receipt();
        early.as_object_mut().unwrap().remove("duration_ms");
        assert!(settle(&early, "ledger", 10, Some(0)).is_err());
        assert!(settle(&receipt(), "another-ledger", 10, Some(0)).is_err());
        assert!(settle(&receipt(), "ledger", 50, Some(0)).is_err());
    }
    #[test]
    fn capability_is_declared_instead_of_inferred_from_version() {
        assert!(require_adapter(&json!([{"id":"coven-code","version":"999.0.0"}])).is_err());
        assert!(require_adapter(
            &json!([{"id":"coven-code","run_budget":{"version":1,"flag":"--max-turns"}}])
        )
        .is_ok());
        assert!(require_adapter(
            &json!([{"id":"claude","run_budget":{"version":1,"flag":"--max-turns"}}])
        )
        .is_err());
    }
}
