use std::{
    collections::{HashMap, HashSet, VecDeque},
    future::Future,
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tokio::sync::Notify;
use uuid::{Variant, Version};

use crate::cave::{NativeDiagnostic, NativeResult};

pub(crate) const MAX_NATIVE_OPERATION_TIMEOUT_MS: u32 = 5_000;
const MAX_ACTIVE_OPERATIONS: usize = 256;
const MAX_PENDING_CANCELLATIONS: usize = 4_096;
const MAX_SEEN_ATTEMPTS: usize = 4_096;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeOperationInput {
    attempt_id: String,
    timeout_ms: u32,
}

impl NativeOperationInput {
    pub(crate) fn new(attempt_id: String, timeout_ms: u32) -> NativeResult<Self> {
        let input = Self {
            attempt_id,
            timeout_ms,
        };
        input.validate()?;
        Ok(input)
    }

    pub(crate) fn validate(&self) -> NativeResult<()> {
        validate_attempt_id(&self.attempt_id)?;
        if self.timeout_ms == 0 || self.timeout_ms > MAX_NATIVE_OPERATION_TIMEOUT_MS {
            return Err(NativeDiagnostic::new("invalid_native_input", false));
        }
        Ok(())
    }

    pub(crate) fn attempt_id(&self) -> &str {
        &self.attempt_id
    }

    fn timeout(&self) -> Duration {
        Duration::from_millis(u64::from(self.timeout_ms))
    }
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeCancelReason {
    Aborted,
    Timeout,
}

impl NativeCancelReason {
    fn diagnostic(self) -> NativeDiagnostic {
        match self {
            Self::Aborted => NativeDiagnostic::new("aborted", false),
            Self::Timeout => NativeDiagnostic::new("timeout", true),
        }
    }
}

#[derive(Serialize)]
pub struct NativeCancelResult {
    pub(crate) status: &'static str,
}

impl NativeCancelResult {
    fn cancelled() -> Self {
        Self {
            status: "cancelled",
        }
    }

    fn queued() -> Self {
        Self { status: "queued" }
    }

    fn unknown() -> Self {
        Self { status: "unknown" }
    }
}

#[derive(Default)]
pub(crate) struct NativeOperationRegistry {
    state: Mutex<RegistryState>,
}

#[derive(Default)]
struct RegistryState {
    active: HashMap<String, Arc<OperationSignal>>,
    pending: HashMap<String, NativeCancelReason>,
    pending_order: VecDeque<String>,
    seen: HashSet<String>,
    seen_order: VecDeque<String>,
}

struct OperationSignal {
    reason: AtomicU8,
    notify: Notify,
}

impl OperationSignal {
    fn new() -> Self {
        Self {
            reason: AtomicU8::new(0),
            notify: Notify::new(),
        }
    }

    fn cancel(&self, reason: NativeCancelReason) {
        let encoded = match reason {
            NativeCancelReason::Aborted => 1,
            NativeCancelReason::Timeout => 2,
        };
        if self
            .reason
            .compare_exchange(0, encoded, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            self.notify.notify_waiters();
        }
    }

    fn current(&self) -> Option<NativeCancelReason> {
        match self.reason.load(Ordering::SeqCst) {
            1 => Some(NativeCancelReason::Aborted),
            2 => Some(NativeCancelReason::Timeout),
            _ => None,
        }
    }

    async fn cancelled(&self) -> NativeCancelReason {
        loop {
            let notified = self.notify.notified();
            if let Some(reason) = self.current() {
                return reason;
            }
            notified.await;
        }
    }
}

struct NativeOperationGuard {
    registry: Arc<NativeOperationRegistry>,
    attempt_id: String,
    signal: Arc<OperationSignal>,
    timeout: Duration,
}

impl Drop for NativeOperationGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.registry.state.lock() {
            state.active.remove(&self.attempt_id);
        }
    }
}

impl NativeOperationRegistry {
    pub(crate) async fn run<T>(
        self: &Arc<Self>,
        input: NativeOperationInput,
        future: impl Future<Output = NativeResult<T>>,
    ) -> NativeResult<T> {
        let guard = self.begin(input)?;
        tokio::pin!(future);
        tokio::select! {
            biased;
            reason = guard.signal.cancelled() => Err(reason.diagnostic()),
            _ = tokio::time::sleep(guard.timeout) => {
                guard.signal.cancel(NativeCancelReason::Timeout);
                Err(NativeCancelReason::Timeout.diagnostic())
            }
            result = &mut future => result,
        }
    }

    pub(crate) fn cancel(
        &self,
        attempt_id: String,
        reason: NativeCancelReason,
    ) -> NativeResult<NativeCancelResult> {
        validate_attempt_id(&attempt_id)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| NativeDiagnostic::new("service_unavailable", true))?;
        if let Some(signal) = state.active.get(&attempt_id) {
            signal.cancel(reason);
            return Ok(NativeCancelResult::cancelled());
        }
        if state.seen.contains(&attempt_id) {
            return Ok(NativeCancelResult::unknown());
        }
        if !state.pending.contains_key(&attempt_id) {
            while state.pending.len() >= MAX_PENDING_CANCELLATIONS {
                let Some(expired) = state.pending_order.pop_front() else {
                    break;
                };
                state.pending.remove(&expired);
            }
            state.pending.insert(attempt_id.clone(), reason);
            state.pending_order.push_back(attempt_id);
        }
        Ok(NativeCancelResult::queued())
    }

    pub(crate) fn cancel_all(&self, reason: NativeCancelReason) {
        if let Ok(state) = self.state.lock() {
            for signal in state.active.values() {
                signal.cancel(reason);
            }
        }
    }

    fn begin(self: &Arc<Self>, input: NativeOperationInput) -> NativeResult<NativeOperationGuard> {
        input.validate()?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| NativeDiagnostic::new("service_unavailable", true))?;
        if state.active.len() >= MAX_ACTIVE_OPERATIONS
            || state.active.contains_key(input.attempt_id())
            || state.seen.contains(input.attempt_id())
        {
            return Err(NativeDiagnostic::new("invalid_native_input", false));
        }
        while state.seen.len() >= MAX_SEEN_ATTEMPTS {
            let candidates = state.seen_order.len();
            let mut removed = false;
            for _ in 0..candidates {
                let Some(expired) = state.seen_order.pop_front() else {
                    break;
                };
                if state.active.contains_key(&expired) {
                    state.seen_order.push_back(expired);
                } else {
                    state.seen.remove(&expired);
                    removed = true;
                    break;
                }
            }
            if !removed {
                return Err(NativeDiagnostic::new("service_unavailable", true));
            }
        }
        let signal = Arc::new(OperationSignal::new());
        if let Some(reason) = state.pending.remove(input.attempt_id()) {
            state
                .pending_order
                .retain(|attempt_id| attempt_id != input.attempt_id());
            signal.cancel(reason);
        }
        state.seen.insert(input.attempt_id.clone());
        state.seen_order.push_back(input.attempt_id.clone());
        state
            .active
            .insert(input.attempt_id.clone(), Arc::clone(&signal));
        let timeout = input.timeout();
        Ok(NativeOperationGuard {
            registry: Arc::clone(self),
            attempt_id: input.attempt_id,
            signal,
            timeout,
        })
    }
}

fn validate_attempt_id(attempt_id: &str) -> NativeResult<()> {
    let parsed = uuid::Uuid::parse_str(attempt_id)
        .map_err(|_| NativeDiagnostic::new("invalid_native_input", false))?;
    if parsed.get_variant() != Variant::RFC4122
        || parsed.get_version() != Some(Version::Random)
        || parsed.to_string() != attempt_id
    {
        return Err(NativeDiagnostic::new("invalid_native_input", false));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;

    const FIRST_ATTEMPT: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const SECOND_ATTEMPT: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    #[test]
    fn queued_abort_prevents_operation_start() {
        let registry = Arc::new(NativeOperationRegistry::default());
        let started = Arc::new(AtomicBool::new(false));
        assert_eq!(
            registry
                .cancel(FIRST_ATTEMPT.to_owned(), NativeCancelReason::Aborted)
                .unwrap()
                .status,
            "queued"
        );
        let started_by_future = Arc::clone(&started);
        let result = tauri::async_runtime::block_on(registry.run(
            NativeOperationInput::new(FIRST_ATTEMPT.to_owned(), 100).unwrap(),
            async move {
                started_by_future.store(true, Ordering::SeqCst);
                Ok(())
            },
        ));

        assert_eq!(result, Err(NativeDiagnostic::new("aborted", false)));
        assert!(!started.load(Ordering::SeqCst));
    }

    #[test]
    fn in_flight_abort_and_timeout_return_canonical_diagnostics() {
        let registry = Arc::new(NativeOperationRegistry::default());
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let operation_registry = Arc::clone(&registry);
        let operation_started = Arc::clone(&started);
        let operation_release = Arc::clone(&release);
        let operation = std::thread::spawn(move || {
            tauri::async_runtime::block_on(operation_registry.run(
                NativeOperationInput::new(FIRST_ATTEMPT.to_owned(), 1_000).unwrap(),
                async move {
                    operation_started.notify_one();
                    operation_release.notified().await;
                    Ok(())
                },
            ))
        });
        tauri::async_runtime::block_on(started.notified());
        assert_eq!(
            registry
                .cancel(FIRST_ATTEMPT.to_owned(), NativeCancelReason::Aborted)
                .unwrap()
                .status,
            "cancelled"
        );
        assert_eq!(
            operation.join().unwrap(),
            Err(NativeDiagnostic::new("aborted", false))
        );

        let timeout = tauri::async_runtime::block_on(registry.run(
            NativeOperationInput::new(SECOND_ATTEMPT.to_owned(), 1).unwrap(),
            std::future::pending::<NativeResult<()>>(),
        ));
        assert_eq!(timeout, Err(NativeDiagnostic::new("timeout", true)));
    }

    #[test]
    fn stale_cancel_cannot_affect_a_new_attempt_and_inputs_are_bounded() {
        let registry = Arc::new(NativeOperationRegistry::default());
        assert_eq!(
            tauri::async_runtime::block_on(registry.run(
                NativeOperationInput::new(FIRST_ATTEMPT.to_owned(), 100).unwrap(),
                async { Ok(()) },
            )),
            Ok(())
        );
        assert_eq!(
            registry
                .cancel(FIRST_ATTEMPT.to_owned(), NativeCancelReason::Timeout)
                .unwrap()
                .status,
            "unknown"
        );
        assert_eq!(
            tauri::async_runtime::block_on(registry.run(
                NativeOperationInput::new(SECOND_ATTEMPT.to_owned(), 100).unwrap(),
                async { Ok("new") },
            )),
            Ok("new")
        );
        assert_eq!(
            tauri::async_runtime::block_on(registry.run(
                NativeOperationInput::new(FIRST_ATTEMPT.to_owned(), 100).unwrap(),
                async { Ok(()) },
            )),
            Err(NativeDiagnostic::new("invalid_native_input", false))
        );
        assert!(NativeOperationInput::new(SECOND_ATTEMPT.to_owned(), 0).is_err());
        assert!(NativeOperationInput::new(
            "not-an-attempt".to_owned(),
            MAX_NATIVE_OPERATION_TIMEOUT_MS
        )
        .is_err());
        assert!(NativeOperationInput::new(
            "cccccccc-cccc-4ccc-8ccc-cccccccccccc".to_owned(),
            MAX_NATIVE_OPERATION_TIMEOUT_MS + 1
        )
        .is_err());
    }
}
