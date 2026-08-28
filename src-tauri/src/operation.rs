use std::{
    collections::{HashMap, HashSet, VecDeque},
    future::Future,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tokio::sync::Notify;

use crate::cave::{NativeDiagnostic, NativeResult};

pub(crate) const MAX_NATIVE_OPERATION_TIMEOUT_MS: u32 = 5_000;
const MAX_ACTIVE_OPERATIONS: usize = 256;
const MAX_PENDING_CANCELLATIONS: usize = 4_096;
const MAX_ATTEMPT_EPOCHS: usize = 8;
const ATTEMPT_COUNTER_WINDOW: u64 = 4_096;
const MAX_NEW_COUNTER: u64 = ATTEMPT_COUNTER_WINDOW;
const ATTEMPT_RANDOM_CHARACTERS: usize = 32;
const MUTATION_IDLE: u8 = 0;
const MUTATION_QUEUED: u8 = 1;
const MUTATION_STARTED: u8 = 2;
const MUTATION_CANCELLED: u8 = 3;
const MUTATION_FINISHED: u8 = 4;
const MUTATION_DISPATCHED: u8 = 5;
const MUTATION_QUEUED_IRREVERSIBLE: u8 = 6;
const AMBIGUITY_CREDENTIAL_UPDATE: u8 = 0;
const AMBIGUITY_EXCHANGE_RECONCILIATION: u8 = 1;

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
        parse_attempt_id(&self.attempt_id)?;
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

    fn in_progress() -> Self {
        Self {
            status: "in_progress",
        }
    }
}

#[derive(Default)]
pub(crate) struct NativeOperationRegistry {
    state: Mutex<RegistryState>,
}

#[derive(Default)]
pub(crate) struct NativeMutationQueue {
    busy: Arc<AtomicBool>,
    worker: Arc<Mutex<()>>,
}

#[derive(Clone)]
pub(crate) struct NativeMutationContext {
    phase: Arc<AtomicU8>,
    signal: Arc<OperationSignal>,
    ambiguity: Arc<AtomicU8>,
    deadline: Instant,
}

#[derive(Clone)]
pub(crate) struct NativeOperationLease {
    signal: Arc<OperationSignal>,
    deadline: Instant,
}

enum MutationCancellation {
    Cancelled,
    Started,
    Finished,
}

#[derive(Default)]
struct RegistryState {
    active: HashMap<AttemptKey, ActiveAttempt>,
    pending: HashMap<AttemptKey, PendingCancellation>,
    pending_order: VecDeque<AttemptKey>,
    epochs: HashMap<u64, AttemptEpoch>,
    highest_epoch: Option<u64>,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct AttemptKey {
    epoch: u64,
    counter: u64,
}

struct AttemptIdentity {
    raw: String,
    key: AttemptKey,
}

struct ActiveAttempt {
    raw: String,
    signal: Arc<OperationSignal>,
    mutation_phase: Option<Arc<AtomicU8>>,
}

struct PendingCancellation {
    raw: String,
    reason: NativeCancelReason,
}

#[derive(Default)]
struct AttemptEpoch {
    highest_counter: u64,
    seen: HashSet<u64>,
}

struct OperationSignal {
    reason: AtomicU8,
    notify: Notify,
    gate: Mutex<()>,
}

impl OperationSignal {
    fn new() -> Self {
        Self {
            reason: AtomicU8::new(0),
            notify: Notify::new(),
            gate: Mutex::new(()),
        }
    }

    fn cancel(&self, reason: NativeCancelReason) -> bool {
        let Ok(_gate) = self.gate.lock() else {
            return false;
        };
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
            true
        } else {
            false
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

pub(crate) struct NativeOperationCommitGuard<'a> {
    signal: &'a OperationSignal,
    _gate: std::sync::MutexGuard<'a, ()>,
}

impl Drop for NativeOperationCommitGuard<'_> {
    fn drop(&mut self) {
        self.signal
            .reason
            .compare_exchange(0, 3, Ordering::SeqCst, Ordering::SeqCst)
            .ok();
    }
}

impl NativeOperationLease {
    pub(crate) fn commit_guard(&self) -> NativeResult<NativeOperationCommitGuard<'_>> {
        let gate = self
            .signal
            .gate
            .lock()
            .map_err(|_| NativeDiagnostic::new("service_unavailable", true))?;
        if let Some(reason) = self.signal.current() {
            return Err(reason.diagnostic());
        }
        if Instant::now() >= self.deadline {
            self.signal
                .reason
                .compare_exchange(0, 2, Ordering::SeqCst, Ordering::SeqCst)
                .ok();
            self.signal.notify.notify_waiters();
            return Err(NativeCancelReason::Timeout.diagnostic());
        }
        Ok(NativeOperationCommitGuard {
            signal: self.signal.as_ref(),
            _gate: gate,
        })
    }
}

impl NativeMutationContext {
    fn queue(&self) -> NativeResult<()> {
        loop {
            let current = self.phase.load(Ordering::SeqCst);
            let queued = match current {
                MUTATION_IDLE => MUTATION_QUEUED,
                MUTATION_DISPATCHED => MUTATION_QUEUED_IRREVERSIBLE,
                _ => {
                    return Err(self
                        .signal
                        .current()
                        .map_or_else(|| self.ambiguous(), NativeCancelReason::diagnostic));
                }
            };
            if self
                .phase
                .compare_exchange(current, queued, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                return Ok(());
            }
        }
    }

    fn cancel_before_start(&self) -> MutationCancellation {
        loop {
            let current = self.phase.load(Ordering::SeqCst);
            match current {
                MUTATION_IDLE | MUTATION_QUEUED => {
                    if self
                        .phase
                        .compare_exchange(
                            current,
                            MUTATION_CANCELLED,
                            Ordering::SeqCst,
                            Ordering::SeqCst,
                        )
                        .is_ok()
                    {
                        return MutationCancellation::Cancelled;
                    }
                }
                MUTATION_DISPATCHED | MUTATION_QUEUED_IRREVERSIBLE | MUTATION_STARTED => {
                    return MutationCancellation::Started;
                }
                MUTATION_FINISHED => return MutationCancellation::Finished,
                MUTATION_CANCELLED => return MutationCancellation::Cancelled,
                _ => return MutationCancellation::Started,
            }
        }
    }

    pub(crate) fn mark_exchange_dispatch(&self) -> NativeResult<()> {
        let _gate = self
            .signal
            .gate
            .lock()
            .map_err(|_| NativeDiagnostic::new("service_unavailable", true))?;
        if let Some(reason) = self.signal.current() {
            return Err(reason.diagnostic());
        }
        if Instant::now() >= self.deadline {
            if self
                .signal
                .reason
                .compare_exchange(0, 2, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                self.signal.notify.notify_waiters();
            }
            return Err(NativeCancelReason::Timeout.diagnostic());
        }
        self.ambiguity
            .store(AMBIGUITY_EXCHANGE_RECONCILIATION, Ordering::SeqCst);
        self.phase
            .compare_exchange(
                MUTATION_IDLE,
                MUTATION_DISPATCHED,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .map(|_| ())
            .map_err(|_| {
                self.signal
                    .current()
                    .map_or_else(|| self.ambiguous(), NativeCancelReason::diagnostic)
            })
    }

    fn ambiguous(&self) -> NativeDiagnostic {
        if self.ambiguity.load(Ordering::SeqCst) == AMBIGUITY_EXCHANGE_RECONCILIATION {
            NativeDiagnostic::new("reconcile_required", false)
        } else {
            NativeDiagnostic::new("credential_update_in_progress", false)
        }
    }
}

impl NativeMutationQueue {
    pub(crate) async fn execute<T: Send + 'static>(
        self: &Arc<Self>,
        context: NativeMutationContext,
        task: impl FnOnce() -> NativeResult<T> + Send + 'static,
    ) -> NativeResult<T> {
        if self
            .busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(context.ambiguous());
        }
        if let Err(error) = context.queue() {
            self.busy.store(false, Ordering::SeqCst);
            return Err(error);
        }
        let queue = Arc::clone(self);
        let phase = Arc::clone(&context.phase);
        let signal = Arc::clone(&context.signal);
        let result = tokio::task::spawn_blocking(move || {
            struct BusyReset(Arc<AtomicBool>);

            impl Drop for BusyReset {
                fn drop(&mut self) {
                    self.0.store(false, Ordering::SeqCst);
                }
            }

            let _busy = BusyReset(Arc::clone(&queue.busy));
            let _worker = queue
                .worker
                .lock()
                .map_err(|_| NativeDiagnostic::new("service_unavailable", true))?;
            let current = phase.load(Ordering::SeqCst);
            let started = match current {
                MUTATION_QUEUED | MUTATION_QUEUED_IRREVERSIBLE => phase.compare_exchange(
                    current,
                    MUTATION_STARTED,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                ),
                _ => Err(current),
            };
            if started.is_err() {
                return Err(signal
                    .current()
                    .map_or_else(|| context.ambiguous(), NativeCancelReason::diagnostic));
            }
            let result = task();
            phase.store(MUTATION_FINISHED, Ordering::SeqCst);
            result
        })
        .await;
        if result.is_err() {
            self.busy.store(false, Ordering::SeqCst);
        }
        result.map_err(|_| NativeDiagnostic::new("service_unavailable", true))?
    }
}

#[cfg(test)]
impl NativeMutationQueue {
    pub(crate) fn hold_worker(&self) -> std::sync::MutexGuard<'_, ()> {
        self.worker.lock().unwrap()
    }

    pub(crate) fn is_busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }
}

struct NativeOperationGuard {
    registry: Arc<NativeOperationRegistry>,
    key: AttemptKey,
    signal: Arc<OperationSignal>,
    timeout: Duration,
}

impl Drop for NativeOperationGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.registry.state.lock() {
            state.active.remove(&self.key);
        }
    }
}

impl NativeOperationRegistry {
    pub(crate) async fn run<T>(
        self: &Arc<Self>,
        input: NativeOperationInput,
        future: impl Future<Output = NativeResult<T>>,
    ) -> NativeResult<T> {
        let guard = self.begin(input, None)?;
        tokio::pin!(future);
        tokio::select! {
            biased;
            reason = guard.signal.cancelled() => Err(reason.diagnostic()),
            _ = tokio::time::sleep(guard.timeout) => {
                if guard.signal.cancel(NativeCancelReason::Timeout) {
                    Err(NativeCancelReason::Timeout.diagnostic())
                } else {
                    (&mut future).await
                }
            }
            result = &mut future => result,
        }
    }

    pub(crate) async fn run_controlled<T, Fut>(
        self: &Arc<Self>,
        input: NativeOperationInput,
        executor: impl FnOnce(NativeOperationLease) -> Fut,
    ) -> NativeResult<T>
    where
        Fut: Future<Output = NativeResult<T>>,
    {
        let guard = self.begin(input, None)?;
        let lease = NativeOperationLease {
            signal: Arc::clone(&guard.signal),
            deadline: Instant::now() + guard.timeout,
        };
        let future = executor(lease);
        tokio::pin!(future);
        tokio::select! {
            biased;
            reason = guard.signal.cancelled() => Err(reason.diagnostic()),
            _ = tokio::time::sleep(guard.timeout) => {
                if guard.signal.cancel(NativeCancelReason::Timeout) {
                    Err(NativeCancelReason::Timeout.diagnostic())
                } else {
                    (&mut future).await
                }
            }
            result = &mut future => result,
        }
    }

    pub(crate) async fn run_mutating<T, Fut>(
        self: &Arc<Self>,
        input: NativeOperationInput,
        executor: impl FnOnce(NativeMutationContext) -> Fut,
    ) -> NativeResult<T>
    where
        Fut: Future<Output = NativeResult<T>>,
    {
        let phase = Arc::new(AtomicU8::new(MUTATION_IDLE));
        let guard = self.begin(input, Some(Arc::clone(&phase)))?;
        let mutation = NativeMutationContext {
            phase,
            signal: Arc::clone(&guard.signal),
            ambiguity: Arc::new(AtomicU8::new(AMBIGUITY_CREDENTIAL_UPDATE)),
            deadline: Instant::now() + guard.timeout,
        };
        let future = executor(mutation.clone());
        tokio::pin!(future);
        tokio::select! {
            biased;
            reason = guard.signal.cancelled() => {
                match mutation.cancel_before_start() {
                    MutationCancellation::Cancelled => Err(reason.diagnostic()),
                    MutationCancellation::Started => Err(mutation.ambiguous()),
                    MutationCancellation::Finished => (&mut future).await,
                }
            }
            _ = tokio::time::sleep(guard.timeout) => {
                guard.signal.cancel(NativeCancelReason::Timeout);
                match mutation.cancel_before_start() {
                    MutationCancellation::Cancelled => Err(NativeCancelReason::Timeout.diagnostic()),
                    MutationCancellation::Started => Err(mutation.ambiguous()),
                    MutationCancellation::Finished => (&mut future).await,
                }
            }
            result = &mut future => result,
        }
    }

    pub(crate) fn cancel(
        &self,
        attempt_id: String,
        reason: NativeCancelReason,
    ) -> NativeResult<NativeCancelResult> {
        let identity = parse_attempt_id(&attempt_id)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| NativeDiagnostic::new("service_unavailable", true))?;
        if let Some(active) = state.active.get(&identity.key) {
            if active.raw == identity.raw {
                let cancelled = active.signal.cancel(reason);
                if !cancelled {
                    return Ok(NativeCancelResult::in_progress());
                }
                return Ok(
                    if active.mutation_phase.as_ref().is_some_and(|phase| {
                        matches!(
                            phase.load(Ordering::SeqCst),
                            MUTATION_DISPATCHED
                                | MUTATION_QUEUED_IRREVERSIBLE
                                | MUTATION_STARTED
                                | MUTATION_FINISHED
                        )
                    }) {
                        NativeCancelResult::in_progress()
                    } else {
                        NativeCancelResult::cancelled()
                    },
                );
            }
            return Ok(NativeCancelResult::unknown());
        }
        if let Some(pending) = state.pending.get(&identity.key) {
            return Ok(if pending.raw == identity.raw {
                NativeCancelResult::queued()
            } else {
                NativeCancelResult::unknown()
            });
        }
        if sequence_was_consumed(&state, identity.key) {
            return Ok(NativeCancelResult::unknown());
        }
        validate_pending_sequence(&state, identity.key)?;
        mark_sequence_consumed(&mut state, identity.key)?;
        if !state.pending.contains_key(&identity.key) {
            while state.pending.len() >= MAX_PENDING_CANCELLATIONS {
                let Some(expired) = state.pending_order.pop_front() else {
                    break;
                };
                state.pending.remove(&expired);
            }
            state.pending.insert(
                identity.key,
                PendingCancellation {
                    raw: identity.raw,
                    reason,
                },
            );
            state.pending_order.push_back(identity.key);
        }
        Ok(NativeCancelResult::queued())
    }

    pub(crate) fn cancel_all(&self, reason: NativeCancelReason) {
        if let Ok(state) = self.state.lock() {
            for active in state.active.values() {
                active.signal.cancel(reason);
            }
        }
    }

    fn begin(
        self: &Arc<Self>,
        input: NativeOperationInput,
        mutation_phase: Option<Arc<AtomicU8>>,
    ) -> NativeResult<NativeOperationGuard> {
        input.validate()?;
        let identity = parse_attempt_id(input.attempt_id())?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| NativeDiagnostic::new("service_unavailable", true))?;
        if state.active.len() >= MAX_ACTIVE_OPERATIONS {
            return Err(NativeDiagnostic::new("service_unavailable", true));
        }
        if state.active.contains_key(&identity.key) {
            return Err(NativeDiagnostic::new("invalid_native_input", false));
        }
        let signal = Arc::new(OperationSignal::new());
        let pending = state.pending.remove(&identity.key);
        if pending.is_some() {
            state
                .pending_order
                .retain(|attempt_key| *attempt_key != identity.key);
        }
        if let Some(pending) = pending {
            if pending.raw != identity.raw {
                return Err(NativeDiagnostic::new("invalid_native_input", false));
            }
            signal.cancel(pending.reason);
        } else {
            if sequence_was_consumed(&state, identity.key) {
                return Err(NativeDiagnostic::new("invalid_native_input", false));
            }
            validate_pending_sequence(&state, identity.key)?;
            mark_sequence_consumed(&mut state, identity.key)?;
        }
        state.active.insert(
            identity.key,
            ActiveAttempt {
                raw: identity.raw,
                signal: Arc::clone(&signal),
                mutation_phase,
            },
        );
        let timeout = input.timeout();
        Ok(NativeOperationGuard {
            registry: Arc::clone(self),
            key: identity.key,
            signal,
            timeout,
        })
    }
}

fn parse_attempt_id(attempt_id: &str) -> NativeResult<AttemptIdentity> {
    if attempt_id.len() > 64 {
        return Err(NativeDiagnostic::new("invalid_native_input", false));
    }
    let Some(value) = attempt_id.strip_prefix("op1-") else {
        return Err(NativeDiagnostic::new("invalid_native_input", false));
    };
    let mut parts = value.splitn(3, '-');
    let epoch = parse_decimal(parts.next())?;
    let counter = parse_decimal(parts.next())?;
    let _random = parts
        .next()
        .filter(|value| {
            value.len() == ATTEMPT_RANDOM_CHARACTERS
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        })
        .ok_or_else(|| NativeDiagnostic::new("invalid_native_input", false))?;
    Ok(AttemptIdentity {
        raw: attempt_id.to_owned(),
        key: AttemptKey { epoch, counter },
    })
}

fn parse_decimal(value: Option<&str>) -> NativeResult<u64> {
    let value = value
        .filter(|value| {
            !value.is_empty()
                && (value.len() == 1 || !value.starts_with('0'))
                && value.bytes().all(|byte| byte.is_ascii_digit())
        })
        .ok_or_else(|| NativeDiagnostic::new("invalid_native_input", false))?;
    value
        .parse()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| NativeDiagnostic::new("invalid_native_input", false))
}

fn sequence_was_consumed(state: &RegistryState, key: AttemptKey) -> bool {
    let Some(epoch) = state.epochs.get(&key.epoch) else {
        return state
            .highest_epoch
            .is_some_and(|highest| key.epoch < highest);
    };
    key.counter <= epoch.highest_counter.saturating_sub(ATTEMPT_COUNTER_WINDOW)
        || epoch.seen.contains(&key.counter)
}

fn validate_pending_sequence(state: &RegistryState, key: AttemptKey) -> NativeResult<()> {
    if let Some(epoch) = state.epochs.get(&key.epoch) {
        if epoch.highest_counter == 0 {
            return Ok(());
        }
        if key.counter > epoch.highest_counter.saturating_add(ATTEMPT_COUNTER_WINDOW) {
            return Err(NativeDiagnostic::new("invalid_native_input", false));
        }
        return Ok(());
    }
    if state
        .highest_epoch
        .is_some_and(|highest| key.epoch < highest)
    {
        return Err(NativeDiagnostic::new("invalid_native_input", false));
    }
    validate_new_epoch(key)
}

fn mark_sequence_consumed(state: &mut RegistryState, key: AttemptKey) -> NativeResult<()> {
    let inserted = match state.epochs.entry(key.epoch) {
        std::collections::hash_map::Entry::Vacant(entry) => {
            validate_new_epoch(key)?;
            entry.insert(AttemptEpoch::default());
            true
        }
        std::collections::hash_map::Entry::Occupied(_) => false,
    };
    if inserted {
        state.highest_epoch = Some(
            state
                .highest_epoch
                .map_or(key.epoch, |highest| highest.max(key.epoch)),
        );
        while state.epochs.len() > MAX_ATTEMPT_EPOCHS {
            let Some(oldest) = state.epochs.keys().copied().min() else {
                break;
            };
            state.epochs.remove(&oldest);
        }
    }
    let epoch = state
        .epochs
        .get_mut(&key.epoch)
        .ok_or_else(|| NativeDiagnostic::new("invalid_native_input", false))?;
    if epoch.highest_counter == 0 {
        if key.counter > MAX_NEW_COUNTER {
            return Err(NativeDiagnostic::new("invalid_native_input", false));
        }
        epoch.highest_counter = key.counter;
    } else if key.counter > epoch.highest_counter {
        if key.counter - epoch.highest_counter > ATTEMPT_COUNTER_WINDOW {
            return Err(NativeDiagnostic::new("invalid_native_input", false));
        }
        epoch.highest_counter = key.counter;
        let minimum = epoch.highest_counter.saturating_sub(ATTEMPT_COUNTER_WINDOW);
        epoch.seen.retain(|counter| *counter > minimum);
    } else if key.counter <= epoch.highest_counter.saturating_sub(ATTEMPT_COUNTER_WINDOW)
        || epoch.seen.contains(&key.counter)
    {
        return Err(NativeDiagnostic::new("invalid_native_input", false));
    }
    epoch.seen.insert(key.counter);
    Ok(())
}

fn validate_new_epoch(key: AttemptKey) -> NativeResult<()> {
    if key.counter > MAX_NEW_COUNTER {
        return Err(NativeDiagnostic::new("invalid_native_input", false));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            atomic::{AtomicBool, Ordering},
            Barrier,
        },
        time::Duration,
    };

    use super::*;

    fn test_epoch() -> u64 {
        1_787_900_000_000
    }

    fn generated_attempt(epoch: u64, counter: u64) -> String {
        format!("op1-{epoch}-{counter}-00000000000000000000000000000000")
    }

    #[test]
    fn queued_abort_prevents_operation_start() {
        let registry = Arc::new(NativeOperationRegistry::default());
        let started = Arc::new(AtomicBool::new(false));
        let attempt = generated_attempt(test_epoch(), 1);
        assert_eq!(
            registry
                .cancel(attempt.clone(), NativeCancelReason::Aborted)
                .unwrap()
                .status,
            "queued"
        );
        let started_by_future = Arc::clone(&started);
        let result = tauri::async_runtime::block_on(registry.run(
            NativeOperationInput::new(attempt, 100).unwrap(),
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
        let epoch = test_epoch();
        let first_attempt = generated_attempt(epoch, 1);
        let second_attempt = generated_attempt(epoch, 2);
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let operation_registry = Arc::clone(&registry);
        let operation_started = Arc::clone(&started);
        let operation_release = Arc::clone(&release);
        let operation_attempt = first_attempt.clone();
        let operation = std::thread::spawn(move || {
            tauri::async_runtime::block_on(operation_registry.run(
                NativeOperationInput::new(operation_attempt, 1_000).unwrap(),
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
                .cancel(first_attempt, NativeCancelReason::Aborted)
                .unwrap()
                .status,
            "cancelled"
        );
        assert_eq!(
            operation.join().unwrap(),
            Err(NativeDiagnostic::new("aborted", false))
        );

        let timeout = tauri::async_runtime::block_on(registry.run(
            NativeOperationInput::new(second_attempt, 1).unwrap(),
            std::future::pending::<NativeResult<()>>(),
        ));
        assert_eq!(timeout, Err(NativeDiagnostic::new("timeout", true)));
    }

    #[test]
    fn stale_cancel_cannot_affect_a_new_attempt_and_inputs_are_bounded() {
        let registry = Arc::new(NativeOperationRegistry::default());
        let epoch = test_epoch();
        let first_attempt = generated_attempt(epoch, 1);
        let second_attempt = generated_attempt(epoch, 2);
        assert_eq!(
            tauri::async_runtime::block_on(registry.run(
                NativeOperationInput::new(first_attempt.clone(), 100).unwrap(),
                async { Ok(()) },
            )),
            Ok(())
        );
        assert_eq!(
            registry
                .cancel(first_attempt.clone(), NativeCancelReason::Timeout)
                .unwrap()
                .status,
            "unknown"
        );
        assert_eq!(
            tauri::async_runtime::block_on(registry.run(
                NativeOperationInput::new(second_attempt.clone(), 100).unwrap(),
                async { Ok("new") },
            )),
            Ok("new")
        );
        assert_eq!(
            tauri::async_runtime::block_on(registry.run(
                NativeOperationInput::new(first_attempt, 100).unwrap(),
                async { Ok(()) },
            )),
            Err(NativeDiagnostic::new("invalid_native_input", false))
        );
        assert!(NativeOperationInput::new(second_attempt, 0).is_err());
        assert!(NativeOperationInput::new(
            "not-an-attempt".to_owned(),
            MAX_NATIVE_OPERATION_TIMEOUT_MS
        )
        .is_err());
        assert!(NativeOperationInput::new(
            generated_attempt(epoch, 3),
            MAX_NATIVE_OPERATION_TIMEOUT_MS + 1
        )
        .is_err());
    }

    #[test]
    fn completed_attempts_remain_single_use_beyond_the_tracking_window() {
        let registry = Arc::new(NativeOperationRegistry::default());
        let epoch = test_epoch();
        let first = generated_attempt(epoch, 1);
        for counter in 1..=(ATTEMPT_COUNTER_WINDOW + 32) {
            assert_eq!(
                tauri::async_runtime::block_on(registry.run(
                    NativeOperationInput::new(generated_attempt(epoch, counter), 100).unwrap(),
                    async { Ok(()) },
                )),
                Ok(())
            );
        }

        assert_eq!(
            registry
                .cancel(first.clone(), NativeCancelReason::Aborted)
                .unwrap()
                .status,
            "unknown"
        );
        assert_eq!(
            tauri::async_runtime::block_on(
                registry.run(NativeOperationInput::new(first, 100).unwrap(), async {
                    Ok(())
                },)
            ),
            Err(NativeDiagnostic::new("invalid_native_input", false))
        );
    }

    #[test]
    fn cancelled_attempts_remain_single_use_after_tombstone_eviction() {
        let registry = Arc::new(NativeOperationRegistry::default());
        let epoch = test_epoch();
        let first = generated_attempt(epoch, 1);
        for counter in 1..=(MAX_PENDING_CANCELLATIONS as u64 + 32) {
            assert_eq!(
                registry
                    .cancel(
                        generated_attempt(epoch, counter),
                        NativeCancelReason::Aborted,
                    )
                    .unwrap()
                    .status,
                "queued"
            );
        }

        assert_eq!(
            registry
                .cancel(first.clone(), NativeCancelReason::Timeout)
                .unwrap()
                .status,
            "unknown"
        );
        assert_eq!(
            tauri::async_runtime::block_on(
                registry.run(NativeOperationInput::new(first, 100).unwrap(), async {
                    Ok(())
                },)
            ),
            Err(NativeDiagnostic::new("invalid_native_input", false))
        );
    }

    #[test]
    fn random_unknown_uuid_cancellations_do_not_grow_registry_memory() {
        let registry = NativeOperationRegistry::default();
        for index in 0..5_000_u64 {
            let attempt = format!("00000000-0000-4000-8000-{index:012x}");
            assert!(registry
                .cancel(attempt, NativeCancelReason::Aborted)
                .is_err());
        }
        let state = registry.state.lock().unwrap();
        assert!(state.active.is_empty());
        assert!(state.pending.is_empty());
        assert!(state.epochs.is_empty());
    }

    #[test]
    fn evicted_epochs_remain_permanently_stale() {
        let registry = Arc::new(NativeOperationRegistry::default());
        let first_epoch = test_epoch();
        let first = generated_attempt(first_epoch, 1);
        for offset in 0..=(MAX_ATTEMPT_EPOCHS as u64 + 2) {
            assert_eq!(
                tauri::async_runtime::block_on(
                    registry.run(
                        NativeOperationInput::new(generated_attempt(first_epoch + offset, 1), 100,)
                            .unwrap(),
                        async { Ok(()) },
                    )
                ),
                Ok(())
            );
        }
        assert!(registry.state.lock().unwrap().epochs.len() <= MAX_ATTEMPT_EPOCHS);
        assert_eq!(
            registry
                .cancel(first.clone(), NativeCancelReason::Aborted)
                .unwrap()
                .status,
            "unknown"
        );
        assert_eq!(
            tauri::async_runtime::block_on(
                registry.run(NativeOperationInput::new(first, 100).unwrap(), async {
                    Ok(())
                },)
            ),
            Err(NativeDiagnostic::new("invalid_native_input", false))
        );
    }

    #[test]
    fn exchange_dispatch_and_cancellation_have_one_authoritative_order() {
        let cancelled_signal = Arc::new(OperationSignal::new());
        let cancelled_phase = Arc::new(AtomicU8::new(MUTATION_IDLE));
        let cancelled = NativeMutationContext {
            phase: Arc::clone(&cancelled_phase),
            signal: Arc::clone(&cancelled_signal),
            ambiguity: Arc::new(AtomicU8::new(AMBIGUITY_CREDENTIAL_UPDATE)),
            deadline: Instant::now() + Duration::from_secs(1),
        };
        assert!(cancelled_signal.cancel(NativeCancelReason::Aborted));
        assert_eq!(
            cancelled.mark_exchange_dispatch(),
            Err(NativeDiagnostic::new("aborted", false))
        );
        assert_eq!(cancelled_phase.load(Ordering::SeqCst), MUTATION_IDLE);

        let dispatched_signal = Arc::new(OperationSignal::new());
        let dispatched_phase = Arc::new(AtomicU8::new(MUTATION_IDLE));
        let dispatched = NativeMutationContext {
            phase: Arc::clone(&dispatched_phase),
            signal: Arc::clone(&dispatched_signal),
            ambiguity: Arc::new(AtomicU8::new(AMBIGUITY_CREDENTIAL_UPDATE)),
            deadline: Instant::now() + Duration::from_secs(1),
        };
        assert_eq!(dispatched.mark_exchange_dispatch(), Ok(()));
        assert!(dispatched_signal.cancel(NativeCancelReason::Aborted));
        assert_eq!(dispatched_phase.load(Ordering::SeqCst), MUTATION_DISPATCHED);
        assert_eq!(
            dispatched.ambiguous(),
            NativeDiagnostic::new("reconcile_required", false)
        );
    }

    #[test]
    fn queued_cancelled_mutation_never_starts() {
        let registry = Arc::new(NativeOperationRegistry::default());
        let queue = Arc::new(NativeMutationQueue::default());
        let worker = queue.worker.lock().unwrap();
        let started = Arc::new(AtomicBool::new(false));
        let operation_registry = Arc::clone(&registry);
        let operation_queue = Arc::clone(&queue);
        let task_started = Arc::clone(&started);
        let attempt = generated_attempt(test_epoch(), 1);
        let operation_attempt = attempt.clone();
        let operation = std::thread::spawn(move || {
            tauri::async_runtime::block_on(operation_registry.run_mutating(
                NativeOperationInput::new(operation_attempt, 1_000).unwrap(),
                move |mutation| async move {
                    operation_queue
                        .execute(mutation, move || {
                            task_started.store(true, Ordering::SeqCst);
                            Ok(())
                        })
                        .await
                },
            ))
        });
        while !queue.busy.load(Ordering::SeqCst) {
            std::thread::yield_now();
        }
        registry
            .cancel(attempt, NativeCancelReason::Aborted)
            .unwrap();
        assert_eq!(
            operation.join().unwrap(),
            Err(NativeDiagnostic::new("aborted", false))
        );
        drop(worker);
        while queue.busy.load(Ordering::SeqCst) {
            std::thread::yield_now();
        }
        assert!(!started.load(Ordering::SeqCst));
    }

    #[test]
    fn queued_expired_mutation_never_starts() {
        let registry = Arc::new(NativeOperationRegistry::default());
        let queue = Arc::new(NativeMutationQueue::default());
        let worker = queue.worker.lock().unwrap();
        let started = Arc::new(AtomicBool::new(false));
        let operation_queue = Arc::clone(&queue);
        let task_started = Arc::clone(&started);
        let operation = tauri::async_runtime::block_on(registry.run_mutating(
            NativeOperationInput::new(generated_attempt(test_epoch(), 1), 1).unwrap(),
            move |mutation| async move {
                operation_queue
                    .execute(mutation, move || {
                        task_started.store(true, Ordering::SeqCst);
                        Ok(())
                    })
                    .await
            },
        ));

        assert_eq!(operation, Err(NativeDiagnostic::new("timeout", true)));
        drop(worker);
        while queue.busy.load(Ordering::SeqCst) {
            std::thread::yield_now();
        }
        assert!(!started.load(Ordering::SeqCst));
    }

    #[test]
    fn started_mutation_returns_ambiguity_and_blocks_duplicate_work_until_coherent() {
        let registry = Arc::new(NativeOperationRegistry::default());
        let queue = Arc::new(NativeMutationQueue::default());
        let started = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let mutated = Arc::new(AtomicBool::new(false));
        let operation_registry = Arc::clone(&registry);
        let operation_queue = Arc::clone(&queue);
        let task_started = Arc::clone(&started);
        let task_release = Arc::clone(&release);
        let task_mutated = Arc::clone(&mutated);
        let attempt = generated_attempt(test_epoch(), 1);
        let operation_attempt = attempt.clone();
        let operation = std::thread::spawn(move || {
            tauri::async_runtime::block_on(operation_registry.run_mutating(
                NativeOperationInput::new(operation_attempt, 1_000).unwrap(),
                move |mutation| async move {
                    operation_queue
                        .execute(mutation, move || {
                            task_started.wait();
                            task_release.wait();
                            task_mutated.store(true, Ordering::SeqCst);
                            Ok(())
                        })
                        .await
                },
            ))
        });
        started.wait();
        assert_eq!(
            registry
                .cancel(attempt, NativeCancelReason::Aborted)
                .unwrap()
                .status,
            "in_progress"
        );

        let duplicate = tauri::async_runtime::block_on(registry.run_mutating(
            NativeOperationInput::new(generated_attempt(test_epoch(), 2), 100).unwrap(),
            {
                let queue = Arc::clone(&queue);
                move |mutation| async move { queue.execute(mutation, || Ok(())).await }
            },
        ));
        assert_eq!(
            duplicate,
            Err(NativeDiagnostic::new(
                "credential_update_in_progress",
                false,
            ))
        );
        assert_eq!(
            operation.join().unwrap(),
            Err(NativeDiagnostic::new(
                "credential_update_in_progress",
                false,
            ))
        );
        assert!(!mutated.load(Ordering::SeqCst));
        release.wait();
        while queue.busy.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(mutated.load(Ordering::SeqCst));

        assert_eq!(
            tauri::async_runtime::block_on(registry.run_mutating(
                NativeOperationInput::new(generated_attempt(test_epoch(), 3), 100).unwrap(),
                {
                    let queue = Arc::clone(&queue);
                    move |mutation| async move { queue.execute(mutation, || Ok("coherent")).await }
                },
            )),
            Ok("coherent")
        );
    }
}
