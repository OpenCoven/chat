use std::{cell::RefCell, collections::VecDeque, fs, path::PathBuf};

use super::*;

/// A folder of its own under the system temp dir, removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("chat-missions-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

const ROOT: &str = "familiar:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REVISION: &str = "familiar-revision:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:3";
const NEWER_REVISION: &str = "familiar-revision:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:4";
const DIGEST: &str = "3cace37dc76d6e28453698da0b925c028075d9c2360b0e220e3dc087b1507e5b";
const OWNER: &str = "principal:coven-local-owner:0123456789abcdef0123456789abcdef";

/// One CLI call a test saw.
#[derive(Debug, Clone)]
struct Call {
    args: Vec<String>,
    input: Option<Vec<u8>>,
}

impl Call {
    fn key(&self) -> &str {
        let at = self
            .args
            .iter()
            .position(|arg| arg == "--adoption-key")
            .unwrap();
        &self.args[at + 1]
    }
    fn mission_id(&self) -> String {
        if self.args[1] == "submit" {
            mission_id_for(self.key())
        } else {
            self.args[2].clone()
        }
    }
}

type Step = Box<dyn Fn(&Call) -> Result<CliOutput, RunFailure>>;
/// A change a test makes to a submit input or to a view.
type Edit<T> = Box<dyn Fn(&mut T)>;

/// A scripted `coven`: each call takes the next step, and every call is kept.
struct Fake {
    steps: RefCell<VecDeque<Step>>,
    calls: RefCell<Vec<Call>>,
}

impl Fake {
    fn new(steps: Vec<Step>) -> Self {
        Self {
            steps: RefCell::new(steps.into()),
            calls: RefCell::new(Vec::new()),
        }
    }
    fn run(&self, args: &[&str], input: Option<&[u8]>) -> Result<CliOutput, RunFailure> {
        let call = Call {
            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
            input: input.map(<[u8]>::to_vec),
        };
        self.calls.borrow_mut().push(call.clone());
        let step = self
            .steps
            .borrow_mut()
            .pop_front()
            .expect("an unexpected coven call");
        step(&call)
    }
    fn calls(&self) -> Vec<Call> {
        self.calls.borrow().clone()
    }
    fn done(&self) -> bool {
        self.steps.borrow().is_empty()
    }
}

fn printed(code: i32, value: &Value) -> Result<CliOutput, RunFailure> {
    Ok(CliOutput {
        code: Some(code),
        stdout: serde_json::to_vec(value).unwrap(),
        stderr: String::new(),
    })
}

fn silent(code: i32, stderr: &str) -> Result<CliOutput, RunFailure> {
    Ok(CliOutput {
        code: Some(code),
        stdout: Vec::new(),
        stderr: stderr.to_owned(),
    })
}

fn view(mission_id: &str, revision: u64, state: &str) -> Value {
    let terminal = TERMINAL_STATES.contains(&state);
    let mut view = json!({
        "missionId": mission_id,
        "occurrenceId": format!("occ-{mission_id}"),
        "revision": revision,
        "state": state,
        "terminal": terminal,
        "principal": { "principalId": OWNER },
        "familiar": { "rootId": ROOT, "revisionId": REVISION },
        "envelope": { "id": "r0-read.1", "descriptorDigest": { "algorithm": "sha256", "canonicalization": "jcs-rfc8785", "value": DIGEST } },
        "project": { "cwd": "/work/project" },
        "task": { "statement": "Why does the build fail?" },
        "submittedAt": "2026-10-18T12:00:00.000Z",
        "validUntil": "2026-10-18T12:10:00.000Z",
        "attempts": [],
    });
    if REASONED_STATES.contains(&state) {
        view["reason"] = json!("authority_unavailable");
    }
    if terminal {
        view["result"] = json!({ "outcome": state, "settledAt": "2026-10-18T12:00:01.000Z", "artifacts": [], "usage": null, "observation": "unknown" });
    }
    view
}

fn applied(
    call: &Call,
    command: &str,
    outcome: &str,
    result: Value,
) -> Result<CliOutput, RunFailure> {
    printed(
        0,
        &json!({ "schemaVersion": "coven.automations.v1", "command": command, "adoptionKey": call.key(), "outcome": outcome, "result": result }),
    )
}

fn committed(call: &Call, outcome: &str, state: &str) -> Result<CliOutput, RunFailure> {
    let id = call.mission_id();
    applied(
        call,
        "mission.submit.v1",
        outcome,
        json!({ "missionId": id, "occurrenceId": format!("occ-{id}"), "mission": view(&id, 2, state) }),
    )
}

fn rejected(call: &Call, command: &str, error: Value) -> Result<CliOutput, RunFailure> {
    printed(
        1,
        &json!({ "schemaVersion": "coven.automations.v1", "command": command, "adoptionKey": call.key(), "outcome": "rejected", "error": error }),
    )
}

fn unknown(call: &Call) -> Result<CliOutput, RunFailure> {
    printed(
        3,
        &json!({ "outcome": "unknown", "command": "mission.submit.v1", "adoptionKey": call.key(), "missionId": call.mission_id() }),
    )
}

fn not_found(call: &Call) -> Result<CliOutput, RunFailure> {
    printed(
        1,
        &json!({ "missionId": call.args[2], "error": { "code": "NOT_FOUND", "httpStatus": 404 } }),
    )
}

fn step(f: impl Fn(&Call) -> Result<CliOutput, RunFailure> + 'static) -> Step {
    Box::new(f)
}

fn input(project: &Path) -> SubmitInput {
    SubmitInput {
        familiar_id: "sage".into(),
        root_id: ROOT.into(),
        revision_id: REVISION.into(),
        envelope_digest: DIGEST.into(),
        project_cwd: project.display().to_string(),
        statement: "Why does the build fail?".into(),
        prompt: "Read the last CI log and say why the build fails.".into(),
        timeout_minutes: 10,
    }
}

fn at(millis: u64) -> SystemTime {
    UNIX_EPOCH + Duration::from_millis(millis)
}

const NOW: u64 = 1_792_325_400_123;

fn no_pause(_: usize) {}

/// Submits through `fake` and returns the answer and the record id.
fn submitted(missions: &Missions, fake: &Fake, project: &Path) -> (MissionAnswer, String) {
    let run = |args: &[&str], input: Option<&[u8]>| fake.run(args, input);
    let answer = submit(missions, &run, &input(project), at(NOW), &no_pause).unwrap();
    let id = fake.calls()[0].mission_id();
    (answer, id)
}

#[test]
fn mission_ids_and_timestamps_match_coven() {
    // The vector the Coven CLI and the SDK client pin.
    assert_eq!(
        mission_id_for("adopt:mission:0001"),
        "mission-b22855c15769da95a4e6b688337a6fb2"
    );
    assert_eq!(timestamp(at(NOW)), "2026-10-18T12:10:00.123Z");
    assert_eq!(timestamp(at(951_868_799_000)), "2000-02-29T23:59:59.000Z");
    assert_eq!(timestamp(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
    assert!(mission_id_shape(&mission_id_for(&new_key("chat-mission"))));
    assert!(revision_id(REVISION));
    assert!(!revision_id("familiar-revision:aaaa:3"));
    assert!(root_id(ROOT));
    assert!(!root_id("familiar:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
}

#[test]
fn the_runner_keeps_stdout_and_the_exit_status() {
    let shell = |script: &str| {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    };
    let never = AtomicBool::new(false);
    let output = execute(
        shell("printf '{\"missionId\":\"m\"}'; echo refused >&2; exit 1"),
        None,
        &never,
        Duration::from_secs(10),
    )
    .unwrap();
    assert_eq!(output.code, Some(1));
    assert_eq!(output.stdout, br#"{"missionId":"m"}"#);
    assert_eq!(output.stderr, "refused");

    // The payload reaches stdin unchanged.
    let echoed = execute(
        shell("cat"),
        Some(b"{\"task\":1}"),
        &never,
        Duration::from_secs(10),
    )
    .unwrap();
    assert_eq!(
        (echoed.code, echoed.stdout),
        (Some(0), b"{\"task\":1}".to_vec())
    );

    // A process that is still going when Chat gives up may have reached Coven.
    assert!(matches!(
        execute(shell("sleep 5"), None, &never, Duration::from_millis(100)),
        Err(RunFailure::Interrupted(_))
    ));
    let stop = AtomicBool::new(true);
    assert!(matches!(
        execute(shell("true"), None, &stop, Duration::from_secs(10)),
        Err(RunFailure::NotStarted(_))
    ));
    assert!(matches!(
        execute(
            Command::new("/nonexistent/coven"),
            None,
            &never,
            Duration::from_secs(10)
        ),
        Err(RunFailure::NotStarted(_))
    ));
    let killed = execute(shell("kill -9 $$"), None, &never, Duration::from_secs(10)).unwrap();
    assert_eq!(killed.code, None);
}

fn envelopes() -> Value {
    json!({ "envelopes": [{ "id": "r0-read.1", "descriptorDigest": { "algorithm": "sha256", "canonicalization": "jcs-rfc8785", "value": DIGEST } }] })
}

fn history(roots: Value) -> Value {
    json!({ "roots": roots })
}

fn live_root(status: &str) -> Value {
    json!({ "rootId": ROOT, "familiarId": "sage", "generation": 1, "createdAt": "2026-10-01T00:00:00.000Z", "retiredAt": null,
        "revisions": [
            { "revisionId": "familiar-revision:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:2", "status": "superseded" },
            { "revisionId": REVISION, "status": status },
        ] })
}

#[test]
fn preparing_names_the_exact_revision_and_envelope() {
    let fake = Fake::new(vec![
        step(|_| printed(0, &envelopes())),
        step(|_| {
            printed(
                0,
                &history(json!([
                    { "rootId": "familiar:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "familiarId": "sage", "retiredAt": "2026-09-01T00:00:00.000Z",
                      "revisions": [{ "revisionId": "familiar-revision:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:1", "status": "active" }] },
                    live_root("active"),
                ])),
            )
        }),
    ]);
    let run = |args: &[&str], input: Option<&[u8]>| fake.run(args, input);
    assert_eq!(
        prepare(&run, "sage").unwrap(),
        MissionPreparation::Ready {
            familiar_id: "sage".into(),
            root_id: ROOT.into(),
            revision_id: REVISION.into(),
            envelope_id: "r0-read.1",
            envelope_digest: DIGEST.into(),
        }
    );
    assert_eq!(fake.calls()[0].args, ["missions", "envelopes", "--json"]);
    assert_eq!(
        fake.calls()[1].args,
        ["familiar-ledger", "history", "sage", "--json"]
    );
}

#[test]
fn preparing_says_why_a_familiar_cannot_take_a_mission() {
    let reason = |steps: Vec<Step>| {
        let fake = Fake::new(steps);
        let run = |args: &[&str], input: Option<&[u8]>| fake.run(args, input);
        match prepare(&run, "sage").unwrap() {
            MissionPreparation::Unavailable { reason, .. } => reason,
            ready => panic!("expected unavailable, got {ready:?}"),
        }
    };
    // A Coven without `coven missions envelopes` rejects the usage.
    assert_eq!(
        reason(vec![step(|_| silent(2, "unrecognized subcommand"))]),
        "update-coven"
    );
    // No daemon, or one from before the advertisement.
    assert_eq!(
        reason(vec![step(|_| silent(1, "no running Coven daemon"))]),
        "coven-not-ready"
    );
    assert_eq!(
        reason(vec![step(|_| Err(RunFailure::NotStarted(
            "Coven CLI is not installed.".into()
        )))]),
        "coven-not-ready"
    );
    assert_eq!(
        reason(vec![step(|_| printed(0, &json!({ "envelopes": [] })))]),
        "no-read-envelope"
    );
    assert_eq!(
        reason(vec![
            step(|_| printed(0, &envelopes())),
            step(|_| printed(0, &history(json!([])))),
        ]),
        "familiar-unregistered"
    );
    assert_eq!(
        reason(vec![
            step(|_| printed(0, &envelopes())),
            step(|_| printed(0, &history(json!([live_root("revoked")])))),
        ]),
        "familiar-inactive"
    );
    assert_eq!(
        reason(vec![
            step(|_| printed(0, &envelopes())),
            step(|_| silent(1, "Error: the ledger could not be read")),
        ]),
        "ledger-unreadable"
    );
}

#[test]
fn bounds_are_checked_before_anything_is_sent() {
    // M-15: everything Coven would refuse is refused first, with nothing sent
    // and nothing recorded.
    let project = Scratch::new();
    let file = project.path().join("file.txt");
    fs::write(&file, "x").unwrap();
    let cases: Vec<(&str, Edit<SubmitInput>)> = vec![
        (
            "empty title",
            Box::new(|input| input.statement = "   ".into()),
        ),
        (
            "long title",
            Box::new(|input| input.statement = "é".repeat(201)),
        ),
        ("empty prompt", Box::new(|input| input.prompt = "\n".into())),
        (
            "long prompt",
            Box::new(|input| input.prompt = "x".repeat(32 * 1024 + 1)),
        ),
        ("no time", Box::new(|input| input.timeout_minutes = 0)),
        ("long time", Box::new(|input| input.timeout_minutes = 61)),
        (
            "relative project",
            Box::new(|input| input.project_cwd = "work/project".into()),
        ),
        (
            "missing project",
            Box::new(|input| input.project_cwd = "/nonexistent/project".into()),
        ),
        (
            "bad root",
            Box::new(|input| input.root_id = "familiar:1234".into()),
        ),
        (
            "bad revision",
            Box::new(|input| input.revision_id = "familiar-revision:x".into()),
        ),
        (
            "bad digest",
            Box::new(|input| input.envelope_digest = "0".repeat(63)),
        ),
        (
            "bad familiar",
            Box::new(|input| input.familiar_id = "../sage".into()),
        ),
    ];
    let file_project = file.display().to_string();
    let mut cases = cases;
    cases.push((
        "file project",
        Box::new(move |input| input.project_cwd = file_project.clone()),
    ));
    for (name, edit) in cases {
        let missions = Missions::default();
        let fake = Fake::new(vec![]);
        let run = |args: &[&str], input: Option<&[u8]>| fake.run(args, input);
        let mut bad = input(project.path());
        edit(&mut bad);
        assert!(
            submit(&missions, &run, &bad, at(NOW), &no_pause).is_err(),
            "{name}"
        );
        assert!(fake.calls().is_empty(), "{name}");
        assert!(missions.list("sage").unwrap().is_empty(), "{name}");
    }
    // The longest allowed values pass.
    let missions = Missions::default();
    let fake = Fake::new(vec![step(|call| {
        committed(call, "committed", "unavailable")
    })]);
    let run = |args: &[&str], input: Option<&[u8]>| fake.run(args, input);
    let mut edge = input(project.path());
    edge.statement = "é".repeat(200);
    edge.prompt = "x".repeat(32 * 1024);
    edge.timeout_minutes = 60;
    assert!(matches!(
        submit(&missions, &run, &edge, at(NOW), &no_pause).unwrap(),
        MissionAnswer::View { .. }
    ));
}

#[test]
fn a_submit_sends_one_payload_and_settles_unavailable_under_m0() {
    // M-06: Coven commits the mission and settles it unavailable, terminal,
    // without launching anything.
    let project = Scratch::new();
    let missions = Missions::default();
    let fake = Fake::new(vec![step(|call| {
        committed(call, "committed", "unavailable")
    })]);
    let (answer, id) = submitted(&missions, &fake, project.path());
    let MissionAnswer::View { mission } = answer else {
        panic!("expected a view, got {answer:?}");
    };
    assert_eq!(mission.mission_id, id);
    assert_eq!(mission.state, "unavailable");
    assert_eq!(mission.reason.as_deref(), Some("authority_unavailable"));
    assert!(mission.terminal);
    assert_eq!(mission.result.as_ref().unwrap().usage, None);
    assert_eq!(
        missions.list("sage").unwrap(),
        vec![MissionEntry {
            mission_id: id.clone(),
            phase: Phase::Terminal
        }]
    );
    assert_eq!(
        missions.record(&id).unwrap().principal_id.as_deref(),
        Some(OWNER)
    );

    let call = &fake.calls()[0];
    assert_eq!(&call.args[..4], ["missions", "submit", "--json", "-"]);
    assert!(call.key().starts_with("chat-mission:"));
    let payload: Value = serde_json::from_slice(call.input.as_ref().unwrap()).unwrap();
    let canonical = project.path().canonicalize().unwrap().display().to_string();
    assert_eq!(
        payload,
        json!({
            "familiar": { "rootId": ROOT, "revisionId": REVISION },
            "envelope": { "id": "r0-read.1", "descriptorDigest": { "algorithm": "sha256", "canonicalization": "jcs-rfc8785", "value": DIGEST } },
            "project": { "cwd": canonical },
            "task": { "statement": "Why does the build fail?", "prompt": "Read the last CI log and say why the build fails." },
            "limits": { "timeoutMinutes": 10 },
            "validUntil": "2026-10-18T12:20:00.123Z",
        })
    );
}

#[test]
fn an_unanswered_submit_is_sent_again_with_the_same_key_and_body() {
    // M-02: the answer to the first send is lost; the second replays it.
    let project = Scratch::new();
    let missions = Missions::default();
    let fake = Fake::new(vec![
        step(|_| {
            Err(RunFailure::Interrupted(
                "Coven did not answer in time.".into(),
            ))
        }),
        step(|call| committed(call, "replayed", "unavailable")),
    ]);
    let (answer, id) = submitted(&missions, &fake, project.path());
    assert!(matches!(answer, MissionAnswer::View { ref mission } if mission.mission_id == id));
    let calls = fake.calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].args, calls[1].args);
    assert_eq!(calls[0].input, calls[1].input);

    // Exit 3 every time: Chat keeps the record and says it is still checking,
    // never that nothing happened.
    let missions = Missions::default();
    let fake = Fake::new(vec![step(unknown), step(unknown), step(unknown)]);
    let (answer, id) = submitted(&missions, &fake, project.path());
    assert_eq!(
        answer,
        MissionAnswer::Checking {
            mission_id: id.clone()
        }
    );
    assert_eq!(missions.record(&id).unwrap().phase, Phase::Sending);
    // A send proven unsent after an unanswered one leaves the outcome open.
    let missions = Missions::default();
    let fake = Fake::new(vec![
        step(unknown),
        step(|_| silent(1, "no running Coven daemon")),
        step(unknown),
    ]);
    let (answer, id) = submitted(&missions, &fake, project.path());
    assert_eq!(answer, MissionAnswer::Checking { mission_id: id });
}

#[test]
fn refusals_and_unsent_submits_leave_nothing_behind() {
    let project = Scratch::new();
    let refused = |error: Value| {
        let missions = Missions::default();
        let fake = Fake::new(vec![step(move |call| {
            rejected(call, "mission.submit.v1", error.clone())
        })]);
        let (answer, _) = submitted(&missions, &fake, project.path());
        assert!(missions.list("sage").unwrap().is_empty());
        answer
    };
    // M-03 b: the key was used for a different body.
    assert!(matches!(
        refused(json!({ "code": "ADOPTION_REPLAY_MISMATCH", "message": "changed body" })),
        MissionAnswer::Refused { ref code, .. } if code == "ADOPTION_REPLAY_MISMATCH"
    ));
    // M-04: the familiar changed since the person reviewed it.
    assert_eq!(
        refused(
            json!({ "code": "REVISION_CONFLICT", "message": "stale", "details": { "currentRevisionId": NEWER_REVISION } })
        ),
        MissionAnswer::Refused {
            code: "REVISION_CONFLICT".into(),
            message: "stale".into(),
            current_revision_id: Some(NEWER_REVISION.into()),
        }
    );
    // M-05: Coven no longer offers the envelope the person reviewed.
    assert!(matches!(
        refused(json!({ "code": "CAPABILITY_UNSUPPORTED", "message": "envelope", "details": { "supportedEnvelopes": [] } })),
        MissionAnswer::Refused { ref code, .. } if code == "CAPABILITY_UNSUPPORTED"
    ));

    // Nothing reached Coven: no daemon, or a Coven without missions.
    for (code, stderr) in [
        (1, "no running Coven daemon"),
        (2, "unrecognized subcommand"),
    ] {
        let missions = Missions::default();
        let fake = Fake::new(vec![step(move |_| silent(code, stderr))]);
        let (answer, _) = submitted(&missions, &fake, project.path());
        assert!(matches!(answer, MissionAnswer::NotSent { .. }), "{code}");
        assert!(missions.list("sage").unwrap().is_empty());
    }
}

/// A committed record, as after a submit Coven accepted.
fn record(missions: &Missions, key: &str, phase: Phase, payload: Option<Vec<u8>>) -> String {
    let id = mission_id_for(key);
    missions
        .insert(Record {
            key: key.into(),
            mission_id: id.clone(),
            familiar_id: "sage".into(),
            root_id: ROOT.into(),
            revision_id: REVISION.into(),
            principal_id: (phase != Phase::Sending).then(|| OWNER.into()),
            phase,
            valid_until: at(NOW + 600_000),
            created_at: at(NOW),
            payload,
            cancel_key: None,
        })
        .unwrap();
    id
}

#[test]
fn a_restart_settles_an_unanswered_submit_by_reading_it() {
    // M-01: after a restart Chat no longer has the payload. "No such mission"
    // is final only once validUntil has passed.
    let missions = Missions::default();
    let id = record(&missions, "chat-mission:restart", Phase::Sending, None);
    let fake = Fake::new(vec![step(not_found), step(not_found)]);
    let run = |args: &[&str], input: Option<&[u8]>| fake.run(args, input);
    assert_eq!(
        read(&missions, &run, &id, at(NOW + 60_000), &no_pause).unwrap(),
        MissionAnswer::Checking {
            mission_id: id.clone()
        }
    );
    assert_eq!(
        read(&missions, &run, &id, at(NOW + 600_000), &no_pause).unwrap(),
        MissionAnswer::NeverSent {
            mission_id: id.clone()
        }
    );
    assert!(missions.record(&id).is_err());
    assert_eq!(
        fake.calls()[0].args,
        ["missions", "get", id.as_str(), "--json"]
    );

    // If it exists, the record becomes committed.
    let id = record(&missions, "chat-mission:found", Phase::Sending, None);
    let fake = Fake::new(vec![step(|call| {
        printed(0, &view(&call.mission_id(), 1, "queued"))
    })]);
    let run = |args: &[&str], input: Option<&[u8]>| fake.run(args, input);
    assert!(matches!(
        read(&missions, &run, &id, at(NOW), &no_pause).unwrap(),
        MissionAnswer::View { .. }
    ));
    assert_eq!(missions.record(&id).unwrap().phase, Phase::Committed);

    // While Chat still holds the payload, it sends the submit again instead.
    let id = record(
        &missions,
        "chat-mission:resend",
        Phase::Sending,
        Some(b"{}".to_vec()),
    );
    let fake = Fake::new(vec![step(|call| {
        committed(call, "replayed", "unavailable")
    })]);
    let run = |args: &[&str], input: Option<&[u8]>| fake.run(args, input);
    assert!(matches!(
        read(&missions, &run, &id, at(NOW), &no_pause).unwrap(),
        MissionAnswer::View { .. }
    ));
    assert_eq!(fake.calls()[0].input.as_deref(), Some(&b"{}"[..]));
    assert_eq!(fake.calls()[0].key(), "chat-mission:resend");
}

#[test]
fn views_for_another_mission_familiar_or_owner_are_dropped() {
    // M-11 b.
    let missions = Missions::default();
    let id = record(&missions, "chat-mission:bound", Phase::Committed, None);
    let edits: Vec<Edit<Value>> = vec![
        Box::new(|view| {
            view["familiar"]["rootId"] = json!("familiar:cccccccccccccccccccccccccccccccc")
        }),
        Box::new(|view| view["familiar"]["revisionId"] = json!(NEWER_REVISION)),
        Box::new(|view| {
            view["principal"]["principalId"] =
                json!("principal:coven-local-owner:ffffffffffffffffffffffffffffffff")
        }),
        Box::new(|view| view["missionId"] = json!(mission_id_for("chat-mission:other"))),
    ];
    for edit in edits {
        let mut foreign = view(&id, 5, "queued");
        edit(&mut foreign);
        let fake = Fake::new(vec![step(move |_| printed(0, &foreign))]);
        let run = |args: &[&str], input: Option<&[u8]>| fake.run(args, input);
        assert_eq!(
            read(&missions, &run, &id, at(NOW), &no_pause).unwrap(),
            MissionAnswer::Mismatch {
                mission_id: id.clone()
            }
        );
    }
    assert_eq!(missions.record(&id).unwrap().phase, Phase::Committed);
    assert_eq!(
        missions.record(&id).unwrap().principal_id.as_deref(),
        Some(OWNER)
    );

    // M-11 a: a Coven that doesn't know a mission it accepted.
    let fake = Fake::new(vec![step(not_found)]);
    let run = |args: &[&str], input: Option<&[u8]>| fake.run(args, input);
    assert_eq!(
        read(&missions, &run, &id, at(NOW), &no_pause).unwrap(),
        MissionAnswer::Gone {
            mission_id: id.clone()
        }
    );
    // Chat reads only missions it sent.
    let fake = Fake::new(vec![]);
    let run = |args: &[&str], input: Option<&[u8]>| fake.run(args, input);
    assert!(read(
        &missions,
        &run,
        &mission_id_for("someone-else:key"),
        at(NOW),
        &no_pause
    )
    .is_err());
    assert!(fake.calls().is_empty());
}

#[test]
fn malformed_or_inconsistent_views_are_refused() {
    let id = mission_id_for("chat-mission:shape");
    assert!(parse_view(&view(&id, 1, "unavailable"), "sage").is_ok());
    let edits: Vec<Edit<Value>> = vec![
        Box::new(|view| view["terminal"] = json!(false)),
        Box::new(|view| {
            view.as_object_mut()
                .unwrap()
                .remove("reason")
                .map(|_| ())
                .unwrap()
        }),
        Box::new(|view| view["result"]["outcome"] = json!("completed")),
        Box::new(|view| {
            view.as_object_mut()
                .unwrap()
                .remove("result")
                .map(|_| ())
                .unwrap()
        }),
        Box::new(|view| view["state"] = json!("submitted")),
        Box::new(|view| view["reason"] = json!("made_up")),
        Box::new(|view| {
            view["result"]["usage"] = json!({ "source": "estimate", "inputTokens": 1 })
        }),
        Box::new(|view| {
            view["result"]["usage"] = json!({ "source": "harness_result_event", "costUsd": -1 })
        }),
        Box::new(|view| view["missionId"] = json!("mission-1")),
    ];
    for (index, edit) in edits.iter().enumerate() {
        let mut bad = view(&id, 1, "unavailable");
        edit(&mut bad);
        assert!(parse_view(&bad, "sage").is_err(), "edit {index}");
    }
    let mut reported = view(&id, 1, "unavailable");
    reported["result"]["usage"] =
        json!({ "source": "harness_result_event", "inputTokens": 12, "costUsd": 0.01 });
    assert_eq!(
        parse_view(&reported, "sage").unwrap().result.unwrap().usage,
        Some(json!({ "inputTokens": 12, "costUsd": 0.01 }))
    );
}

#[test]
fn a_cancel_reuses_its_key_and_a_settled_mission_answers_with_its_view() {
    // M-09: under M0 every mission has settled before a cancel can arrive.
    let missions = Missions::default();
    let id = record(&missions, "chat-mission:cancel", Phase::Terminal, None);
    let settled = view(&id, 3, "unavailable");
    let fake = Fake::new(vec![
        step(|_| {
            Err(RunFailure::Interrupted(
                "Coven did not answer in time.".into(),
            ))
        }),
        step(move |call| {
            rejected(
                call,
                "mission.cancel.v1",
                json!({ "code": "ILLEGAL_TRANSITION", "message": "settled", "details": { "mission": settled.clone() } }),
            )
        }),
    ]);
    let run = |args: &[&str], input: Option<&[u8]>| fake.run(args, input);
    let answer = cancel(&missions, &run, &id, &no_pause).unwrap();
    assert!(
        matches!(answer, MissionAnswer::Settled { ref mission } if mission.state == "unavailable")
    );
    let calls = fake.calls();
    assert_eq!(
        &calls[0].args[..4],
        ["missions", "cancel", id.as_str(), "--json"]
    );
    assert!(calls[0].key().starts_with("chat-mission-cancel:"));
    assert_eq!(calls[0].key(), calls[1].key());
    assert_eq!(missions.record(&id).unwrap().cancel_key, None);

    // A queued mission is cancelled, and its view says so.
    let id = record(&missions, "chat-mission:queued", Phase::Committed, None);
    let fake = Fake::new(vec![step(|call| {
        let mut cancelled = view(&call.mission_id(), 4, "cancelled");
        cancelled["cancellation"] = json!({ "cancellationId": "mc:1", "requestedAt": "2026-10-18T12:00:02.000Z", "outcome": "cancelled" });
        applied(
            call,
            "mission.cancel.v1",
            "committed",
            json!({ "cancellation": cancelled["cancellation"], "mission": cancelled }),
        )
    })]);
    let run = |args: &[&str], input: Option<&[u8]>| fake.run(args, input);
    let answer = cancel(&missions, &run, &id, &no_pause).unwrap();
    assert!(
        matches!(answer, MissionAnswer::View { ref mission } if mission.cancellation.as_deref() == Some("cancelled"))
    );
    assert_eq!(missions.record(&id).unwrap().phase, Phase::Terminal);

    // Nothing is cancelled while Chat is still checking whether the submit
    // reached Coven.
    let id = record(&missions, "chat-mission:sending", Phase::Sending, None);
    let fake = Fake::new(vec![]);
    let run = |args: &[&str], input: Option<&[u8]>| fake.run(args, input);
    assert!(cancel(&missions, &run, &id, &no_pause).is_err());
    assert!(fake.calls().is_empty());
}

#[test]
fn a_watch_sends_each_new_answer_once_and_stops_at_terminal() {
    let missions = Missions::default();
    let id = record(&missions, "chat-mission:watch", Phase::Committed, None);
    let fake = Fake::new(vec![
        step(|call| printed(0, &view(&call.mission_id(), 1, "queued"))),
        step(|call| printed(0, &view(&call.mission_id(), 1, "queued"))),
        step(|call| printed(0, &view(&call.mission_id(), 2, "running"))),
        step(|call| printed(0, &view(&call.mission_id(), 1, "queued"))),
        step(|call| printed(0, &view(&call.mission_id(), 3, "unavailable"))),
    ]);
    let run = |args: &[&str], input: Option<&[u8]>| fake.run(args, input);
    let sent = RefCell::new(Vec::new());
    let started = Instant::now();
    watch(&missions, &run, &id, &AtomicBool::new(false), &|answer| {
        sent.borrow_mut().push(answer);
        Ok(())
    })
    .unwrap();
    let revisions: Vec<(u64, String)> = sent
        .borrow()
        .iter()
        .map(|answer| match answer {
            MissionAnswer::View { mission } => (mission.revision, mission.state.clone()),
            other => panic!("unexpected {other:?}"),
        })
        .collect();
    assert_eq!(
        revisions,
        [
            (1, "queued".into()),
            (2, "running".into()),
            (3, "unavailable".into())
        ]
    );
    assert!(fake.done());
    assert!(started.elapsed() >= WATCH_INTERVAL * 4);

    // A stopped watch reads nothing more.
    let fake = Fake::new(vec![]);
    let run = |args: &[&str], input: Option<&[u8]>| fake.run(args, input);
    watch(&missions, &run, &id, &AtomicBool::new(true), &|_| Ok(())).unwrap();
    assert!(fake.calls().is_empty());
}

#[test]
fn answers_reach_the_window_in_their_documented_shape() {
    let id = mission_id_for("chat-mission:wire");
    let mission = parse_view(&view(&id, 2, "unavailable"), "sage").unwrap();
    assert_eq!(
        serde_json::to_value(MissionAnswer::View {
            mission: Box::new(mission)
        })
        .unwrap(),
        json!({ "kind": "view", "mission": {
            "missionId": id, "familiarId": "sage", "revision": 2, "state": "unavailable", "terminal": true,
            "reason": "authority_unavailable", "rootId": ROOT, "revisionId": REVISION, "principalId": OWNER,
            "statement": "Why does the build fail?", "projectCwd": "/work/project",
            "submittedAt": "2026-10-18T12:00:00.000Z", "validUntil": "2026-10-18T12:10:00.000Z", "attempts": 0,
            "result": { "outcome": "unavailable", "settledAt": "2026-10-18T12:00:01.000Z", "observation": "unknown", "reports": 0, "usage": null },
        } })
    );
    assert_eq!(
        serde_json::to_value(MissionAnswer::Checking {
            mission_id: id.clone()
        })
        .unwrap(),
        json!({ "kind": "checking", "missionId": id })
    );
    assert_eq!(
        serde_json::to_value(MissionAnswer::NotSent {
            message: "no daemon".into()
        })
        .unwrap(),
        json!({ "kind": "not-sent", "message": "no daemon" })
    );
    assert_eq!(
        serde_json::to_value(MissionPreparation::Unavailable {
            reason: "update-coven",
            detail: String::new()
        })
        .unwrap(),
        json!({ "status": "unavailable", "reason": "update-coven", "detail": "" })
    );
}
