use super::*;

// Companion adapters use the same CLI normalization, canonical storage lock,
// run exclusion, cancellation flag and send_local implementation as the window.
static COMPANION_READS: std::sync::LazyLock<Arc<tokio::sync::Semaphore>> =
    std::sync::LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(4)));

pub(crate) async fn companion_snapshot(app: AppHandle) -> Result<Value, String> {
    let permit = COMPANION_READS
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Companion reads are busy.")?;
    let data = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate chat storage.")?;
    blocking(move || {
        let _permit = permit;
        let familiars = cli_json(&["familiars", "--json"])?;
        let familiars = familiars.as_array().ok_or("Invalid familiars.")?.iter().map(|f| {
            validate_id(string(f,"id")?)?;
            Ok(json!({"id":string(f,"id")?,"name":string(f,"name")?,"displayName":string(f,"display_name")?,"description":f.get("description"),"emoji":f.get("emoji")}))
        }).collect::<Result<Vec<Value>,String>>()?;
        let _storage = crate::chat_lifecycle::STORAGE_LOCK.lock().map_err(|_| "Chat unavailable.")?;
        let sessions = visible_sessions(&data, &cli_json(&["sessions", "--all", "--json"])?)?;
        let sessions = sessions.as_array().ok_or("Invalid sessions.")?.iter().map(|s| json!({
            "id":crate::companion::backend::session_alias(s["id"].as_str().unwrap_or("")),
            "familiarId":s["familiarId"],"title":s["title"],"archived":s["archived"]
        })).collect::<Vec<_>>();
        Ok(json!({"version":1,"familiars":familiars,"sessions":sessions,"activeRun":null}))
    }).await
}

pub(crate) async fn companion_history(app: AppHandle, familiar: String) -> Result<Value, String> {
    validate_id(&familiar)?;
    let permit = COMPANION_READS
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Companion reads are busy.")?;
    let data = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate chat storage.")?;
    blocking(move || {
        let _permit = permit;
        let _storage = crate::chat_lifecycle::STORAGE_LOCK.lock().map_err(|_| "Chat unavailable.")?;
        let state = app.state::<CovenRuntimeState>();
        // Lifecycle mutations take the run lock before the storage lock. Never
        // wait for that lock while holding storage: a contested read retries.
        let runs = state.runs.try_lock().map_err(|_| "Chat is changing; retry this read.")?;
        let active = state.companion_views.try_lock().map_err(|_| "Chat is changing; retry this read.")?.iter()
            .find(|run| run.familiar_id == familiar && run.running() && runs.contains_key(&run.id)).cloned();
        drop(runs);
        let Some(id) = crate::chat_canonical::head(&data,&familiar)? else {
            return Ok(json!({"sessionId":null,"messages":[],"hasMore":false,"activeRunId":active.as_ref().map(|r| &r.id)}));
        };
        history_projection(&id, active.as_deref(), |selected_id| {
            if selected_id == id { return read_session(&data, selected_id, Budget::BASE); }
            // This is the exact parent captured at shared-run admission, not
            // an arbitrary session requested by the phone.
            crate::chat_lifecycle::require_visible(&data, selected_id)?;
            crate::chat_origin::require_chat_origin(&data, selected_id)?;
            let selected = get_session(selected_id)?;
            if selected["familiar_id"].as_str() != Some(familiar.as_str()) { return Err("Chat identity changed.".into()); }
            read_session_contents(&data, &selected, Budget::BASE)
        })

    }).await
}

pub(crate) fn companion_start(
    app: AppHandle,
    request: crate::companion::backend::SendRequest,
) -> Result<Arc<crate::companion::backend::RunRecord>, String> {
    use tauri::Emitter;
    if !cfg!(unix) {
        return Err("Companion execution requires macOS or Linux.".into());
    }
    request.validate()?;
    let state = app.state::<CovenRuntimeState>();
    let data = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate chat storage.")?;
    let (cancel, registration) = state.register_run(&request.request_id)?;
    let record = crate::companion::backend::RunRecord::new(
        request.request_id.clone(),
        request.familiar_id.clone(),
        cancel.clone(),
    );
    *record.base_session.lock().map_err(|_| "Run unavailable.")? = request.session_id.clone();
    record.phone_origin.store(true, Ordering::SeqCst);
    state.remember_companion(record.clone())?;
    let worker_record = record.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _registration = registration;
        let emit = |status: &str, event: Option<Value>| {
            let _ = app.emit("companion-run",json!({"runId":request.request_id,"familiarId":request.familiar_id,"status":status,"event":event}));
        };
        emit("running", None);
        let result = (|| {
            let session = {
                let _storage = crate::chat_lifecycle::STORAGE_LOCK
                    .lock()
                    .map_err(|_| "Chat unavailable.")?;
                let current = crate::chat_canonical::head(&data, &request.familiar_id)?;
                if current
                    .as_deref()
                    .map(crate::companion::backend::session_alias)
                    != request.session_id
                {
                    return Err(
                        "The familiar's chat changed. Reload its history before sending.".into(),
                    );
                }
                *worker_record
                    .parent_session
                    .lock()
                    .map_err(|_| "Run unavailable.")? = current.clone();
                current
            };
            let input = SendInput {
                run_id: request.request_id.clone(),
                familiar_id: Some(request.familiar_id.clone()),
                session_id: session,
                prompt: request.prompt.clone(),
                harness: None,
                attachments: Vec::new(),
            };
            send_local(&data, input, &cancel, &mut |event| {
                worker_record.observe(event.clone())?;
                emit("running", Some(event));
                Ok(())
            })
        })();
        worker_record.finish(&result);
        let value = worker_record.value();
        emit(value["status"].as_str().unwrap_or("failed"), None);
    });
    Ok(record)
}

fn history_projection(
    id: &str,
    active: Option<&crate::companion::backend::RunRecord>,
    mut read: impl FnMut(&str) -> Result<Value, String>,
) -> Result<Value, String> {
    let current_alias = crate::companion::backend::session_alias(id);
    let selected = match active {
        Some(run)
            if run
                .base_session
                .lock()
                .map_err(|_| "Run unavailable.")?
                .as_deref()
                != Some(current_alias.as_str()) =>
        {
            run.parent_session
                .lock()
                .map_err(|_| "Run unavailable.")?
                .clone()
        }
        _ => Some(id.to_owned()),
    };
    // Read only the prior turn's lineage. Raw engine events do not reliably
    // carry session_id, so event-field filtering cannot establish ownership.
    let history = match selected {
        Some(selected) => read(&selected)?,
        None => json!({"events":[],"hasMore":false}),
    };
    let events = history["events"].as_array().ok_or("Invalid history.")?;
    Ok(
        json!({"sessionId":current_alias,"messages":crate::companion::project_messages(events),"hasMore":history["hasMore"],"activeRunId":active.map(|r|&r.id)}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn active_history_excludes_sessionless_events_by_turn_provenance() {
        let run = crate::companion::backend::RunRecord::new(
            "active".into(),
            "familiar".into(),
            Arc::new(AtomicBool::new(false)),
        );
        *run.base_session.lock().unwrap() =
            Some(crate::companion::backend::session_alias("previous"));
        *run.parent_session.lock().unwrap() = Some("previous".into());
        let previous = json!({"type":"assistant","message":{"content":[{"type":"text","text":"Earlier reply"}]}});
        let history=history_projection("current",Some(&run),|id|Ok(json!({"events":if id=="previous" {vec![previous.clone()]} else {vec![previous.clone(),json!({"type":"text_delta","text":"Active reply without session id"})]},"hasMore":false}))).unwrap();
        assert_eq!(history["activeRunId"], "active");
        assert_eq!(history["messages"].as_array().unwrap().len(), 1);
        assert_eq!(history["messages"][0]["text"], "Earlier reply");
    }
}
