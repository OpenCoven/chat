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

/// `coven --version` printing `line`.
fn version(line: &'static str) -> Step {
    step(move |_| {
        Ok(CliOutput {
            code: Some(0),
            stdout: format!("{line}\n").into_bytes(),
            stderr: String::new(),
        })
    })
}

/// A Coven build with missions, from before a release carries them.
const DEVELOPMENT: &str =
    "coven archive/20261019-1363-landed-1-g896dd4a6 (engine coven-code 0.8.0, pinned 0.8.0)";

#[test]
fn preparing_names_the_exact_revision_and_envelope() {
    let fake = Fake::new(vec![
        version(DEVELOPMENT),
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
    let calls: Vec<Vec<String>> = fake.calls().into_iter().map(|call| call.args).collect();
    assert_eq!(
        calls,
        [
            vec!["--version"],
            vec!["missions", "envelopes", "--json"],
            vec!["familiar-ledger", "history", "sage", "--json"],
        ]
    );
}

#[test]
fn an_older_coven_is_never_sent_a_mission_command() {
    // Coven 0.4.10 and earlier read `coven missions …` as a task to cast, so
    // Chat stops at the version.
    for line in [
        "coven v0.4.10 (engine coven-code 0.8.0, pinned 0.8.0)",
        "coven v0.3.2",
    ] {
        let fake = Fake::new(vec![version(line)]);
        let run = |args: &[&str], input: Option<&[u8]>| fake.run(args, input);
        assert!(matches!(
            prepare(&run, "sage").unwrap(),
            MissionPreparation::Unavailable {
                reason: "update-coven",
                ..
            }
        ));
        assert_eq!(fake.calls().len(), 1, "{line}");
    }
    assert_eq!(
        release(b"coven v0.4.11 (engine coven-code 0.8.0)\n"),
        Some((0, 4, 11))
    );
    assert_eq!(release(DEVELOPMENT.as_bytes()), None);
    assert_eq!(release(b"coven v0.4"), None);
    assert_eq!(release(b"coven v1.2.3.4"), None);
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
    // A Coven with missions but without `coven missions envelopes` rejects
    // the usage.
    assert_eq!(
        reason(vec![
            version(DEVELOPMENT),
            step(|_| silent(2, "unrecognized subcommand"))
        ]),
        "update-coven"
    );
    // Exit 1 with nothing printed: a Coven that knows the command has no
    // daemon to ask, or one from before the advertisement.
    assert_eq!(
        reason(vec![
            version(DEVELOPMENT),
            step(|_| silent(1, "no running Coven daemon")),
            step(|_| silent(0, "")),
        ]),
        "coven-not-ready"
    );
    // A Coven that doesn't know the command, read as a task it won't cast.
    assert_eq!(
        reason(vec![
            version(DEVELOPMENT),
            step(|_| silent(1, "Error: refusing to cast without an interactive terminal")),
            step(|_| silent(1, "Error: refusing to cast without an interactive terminal")),
        ]),
        "update-coven"
    );
    assert_eq!(
        reason(vec![step(|_| Err(RunFailure::NotStarted(
            "Coven CLI is not installed.".into()
        )))]),
        "coven-not-ready"
    );
    // A version that can't be read is no reason to stop.
    assert_eq!(
        reason(vec![
            step(|_| silent(1, "")),
            step(|_| printed(0, &json!({ "envelopes": [] }))),
        ]),
        "no-read-envelope"
    );
    assert_eq!(
        reason(vec![
            version(DEVELOPMENT),
            step(|_| printed(0, &envelopes())),
            step(|_| printed(0, &history(json!([])))),
        ]),
        "familiar-unregistered"
    );
    assert_eq!(
        reason(vec![
            version(DEVELOPMENT),
            step(|_| printed(0, &envelopes())),
            step(|_| printed(0, &history(json!([live_root("revoked")])))),
        ]),
        "familiar-inactive"
    );
    assert_eq!(
        reason(vec![
            version(DEVELOPMENT),
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
fn a_resend_that_cannot_reach_coven_keeps_checking() {
    // M-02: the first send was answered with exit 3, so Coven may hold the
    // mission. A later send that never reaches Coven proves nothing, so the
    // record stays and the answer is still "checking".
    let missions = Missions::default();
    let id = record(
        &missions,
        "chat-mission:unreachable",
        Phase::Sending,
        Some(b"{}".to_vec()),
    );
    let fake = Fake::new(vec![
        step(|_| silent(1, "no running Coven daemon")),
        step(|_| silent(1, "no running Coven daemon")),
        step(|_| silent(1, "no running Coven daemon")),
    ]);
    let run = |args: &[&str], input: Option<&[u8]>| fake.run(args, input);
    assert_eq!(
        read(&missions, &run, &id, at(NOW), &no_pause).unwrap(),
        MissionAnswer::Checking {
            mission_id: id.clone()
        }
    );
    let kept = missions.record(&id).unwrap();
    assert_eq!(kept.phase, Phase::Sending);
    assert_eq!(kept.payload.as_deref(), Some(&b"{}"[..]));
    assert!(fake.done());
}

#[test]
fn a_duplicate_submit_uses_a_new_key_and_passes_covens_refusal_through() {
    // M-03 c: the person sends the same mission twice. Each submit has a key
    // of its own, so Coven sees a second mission and applies its concurrency
    // limit. Chat shows that refusal and keeps only the first record.
    let project = Scratch::new();
    let missions = Missions::default();
    let fake = Fake::new(vec![
        step(|call| committed(call, "committed", "queued")),
        step(|call| {
            rejected(
                call,
                "mission.submit.v1",
                json!({ "code": "CONCURRENCY_LIMIT", "message": "one active mission per familiar root and project" }),
            )
        }),
    ]);
    let (first, first_id) = submitted(&missions, &fake, project.path());
    assert!(matches!(first, MissionAnswer::View { .. }));
    let run = |args: &[&str], input: Option<&[u8]>| fake.run(args, input);
    let second = submit(&missions, &run, &input(project.path()), at(NOW), &no_pause).unwrap();
    assert!(matches!(
        second,
        MissionAnswer::Refused { ref code, .. } if code == "CONCURRENCY_LIMIT"
    ));
    let calls = fake.calls();
    assert_ne!(calls[0].key(), calls[1].key());
    assert_eq!(calls[0].input, calls[1].input);
    let listed = missions.list("sage").unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].mission_id, first_id);
}

#[test]
fn a_cancel_that_loses_to_completion_reports_the_completed_view() {
    // M-07: Coven arbitrates the race; Chat shows its verdict unchanged.
    let missions = Missions::default();
    let id = record(&missions, "chat-mission:race", Phase::Committed, None);
    let fake = Fake::new(vec![step(|call| {
        let mut done = view(&call.mission_id(), 6, "completed");
        done["cancellation"] = json!({ "cancellationId": "mc:2", "requestedAt": "2026-10-18T12:00:03.000Z", "outcome": "lost_to_completion" });
        applied(
            call,
            "mission.cancel.v1",
            "committed",
            json!({ "cancellation": done["cancellation"], "mission": done }),
        )
    })]);
    let run = |args: &[&str], input: Option<&[u8]>| fake.run(args, input);
    let MissionAnswer::View { mission } = cancel(&missions, &run, &id, &no_pause).unwrap() else {
        panic!("expected the completed view");
    };
    assert_eq!(mission.state, "completed");
    assert!(mission.terminal);
    assert_eq!(mission.cancellation.as_deref(), Some("lost_to_completion"));
    assert_eq!(mission.result.as_ref().unwrap().outcome, "completed");
    assert_eq!(missions.record(&id).unwrap().phase, Phase::Terminal);
}

#[test]
fn a_revocation_during_observation_ends_the_watch_with_the_revoked_view() {
    // M-12: the familiar revision is withdrawn while the mission runs. Coven
    // reports cancelling, then revoked; the watch ends on the terminal view.
    let missions = Missions::default();
    let id = record(&missions, "chat-mission:revoked", Phase::Committed, None);
    let fake = Fake::new(vec![
        step(|call| printed(0, &view(&call.mission_id(), 2, "running"))),
        step(|call| printed(0, &view(&call.mission_id(), 3, "cancelling"))),
        step(|call| {
            let mut revoked = view(&call.mission_id(), 4, "revoked");
            revoked["reason"] = json!("familiar_revision_revoked");
            printed(0, &revoked)
        }),
    ]);
    let run = |args: &[&str], input: Option<&[u8]>| fake.run(args, input);
    let sent = RefCell::new(Vec::new());
    watch(&missions, &run, &id, &AtomicBool::new(false), &|answer| {
        sent.borrow_mut().push(answer);
        Ok(())
    })
    .unwrap();
    let states: Vec<(u64, String, Option<String>)> = sent
        .borrow()
        .iter()
        .map(|answer| match answer {
            MissionAnswer::View { mission } => (
                mission.revision,
                mission.state.clone(),
                mission.reason.clone(),
            ),
            other => panic!("unexpected {other:?}"),
        })
        .collect();
    assert_eq!(
        states,
        [
            (2, "running".into(), None),
            (3, "cancelling".into(), None),
            (
                4,
                "revoked".into(),
                Some("familiar_revision_revoked".into())
            ),
        ]
    );
    assert!(fake.done());
    assert_eq!(missions.record(&id).unwrap().phase, Phase::Terminal);
}

#[test]
fn the_window_never_receives_a_key_and_cannot_supply_one() {
    let missions = Missions::default();
    let id = record(&missions, "chat-mission:nokey", Phase::Committed, None);
    // What the window lists and shows carries no adoption or cancel key.
    let listed = serde_json::to_string(&missions.list("sage").unwrap()).unwrap();
    assert!(!listed.contains("chat-mission:nokey"));
    assert!(!listed.to_lowercase().contains("key"));
    let shown =
        serde_json::to_string(&parse_view(&view(&id, 1, "unavailable"), "sage").unwrap()).unwrap();
    assert!(!shown.to_lowercase().contains("key"));
    // The window cannot choose a key, or add any other field, to a submit.
    let with_key = json!({
        "familiarId": "sage", "rootId": ROOT, "revisionId": REVISION, "envelopeDigest": DIGEST,
        "projectCwd": "/tmp", "statement": "x", "prompt": "y", "timeoutMinutes": 5,
        "adoptionKey": "chosen",
    });
    assert!(serde_json::from_value::<SubmitInput>(with_key).is_err());
    // A view whose statement is over Coven's limit is refused, not truncated.
    let mut long = view(&id, 1, "unavailable");
    long["task"]["statement"] = json!("é".repeat(STATEMENT_LIMIT + 1));
    assert!(parse_view(&long, "sage").is_err());
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

#[test]
fn timestamps_read_back_exactly_as_written() {
    for millis in [0, 951_868_799_000, NOW, NOW + 600_000] {
        assert_eq!(parse_timestamp(&timestamp(at(millis))), Some(at(millis)));
    }
    for bad in [
        "2026-10-18T12:10:00Z",
        "2026-13-18T12:10:00.123Z",
        "2026-02-30T12:10:00.123Z",
        "2026-10-18 12:10:00.123Z",
        "x026-10-18T12:10:00.123Z",
    ] {
        assert_eq!(parse_timestamp(bad), None, "{bad}");
    }
}

/// A submit through `missions` that Coven answers but leaves open.
fn sent(missions: &Missions, project: &Path) -> String {
    let fake = Fake::new(vec![step(unknown), step(unknown), step(unknown)]);
    let (_, id) = submitted(missions, &fake, project);
    id
}

#[test]
fn records_survive_a_restart_without_any_task_body() {
    let data = Scratch::new();
    let project = Scratch::new();
    let missions = Missions::default();
    missions.open(data.path()).unwrap();
    let id = sent(&missions, project.path());

    let folder = data.path().join("coven-missions");
    let file = folder.join("missions-v1.json");
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains(&id));
    for body in [
        "Why does the build fail?",
        "Read the last CI log",
        "timeoutMinutes",
        "project",
    ] {
        assert!(!text.contains(body), "the record file holds {body}");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&folder).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    // After a restart the record is back, without the payload, so the
    // unanswered submit is settled by reading it (M-01, M-02).
    let restarted = Missions::default();
    restarted.open(data.path()).unwrap();
    let record = restarted.record(&id).unwrap();
    assert_eq!(record.phase, Phase::Sending);
    assert!(record.payload.is_none());
    assert_eq!(record.valid_until, at(NOW + 600_000));
    let fake = Fake::new(vec![step(|call| {
        printed(0, &view(&call.mission_id(), 2, "unavailable"))
    })]);
    let run = |args: &[&str], input: Option<&[u8]>| fake.run(args, input);
    assert!(matches!(
        read(&restarted, &run, &id, at(NOW + 1_000), &no_pause).unwrap(),
        MissionAnswer::View { .. }
    ));
    assert_eq!(
        fake.calls()[0].args,
        ["missions", "get", id.as_str(), "--json"]
    );

    // The settled phase and the owner are kept too.
    let again = Missions::default();
    again.open(data.path()).unwrap();
    let record = again.record(&id).unwrap();
    assert_eq!(record.phase, Phase::Terminal);
    assert_eq!(record.principal_id.as_deref(), Some(OWNER));

    // A finished mission can be removed, and stays removed.
    again.forget(&id).unwrap();
    let last = Missions::default();
    last.open(data.path()).unwrap();
    assert!(last.record(&id).is_err());
}

#[test]
fn an_unreadable_record_file_is_left_alone_and_nothing_is_sent() {
    let data = Scratch::new();
    let folder = data.path().join("coven-missions");
    fs::create_dir_all(&folder).unwrap();
    let file = folder.join("missions-v1.json");
    for contents in [
        "not json".to_owned(),
        json!({ "version": 2, "missions": [] }).to_string(),
        json!({ "version": 1, "missions": [{ "adoptionKey": "chat-mission:x", "missionId": "mission-1" }] }).to_string(),
    ] {
        fs::write(&file, &contents).unwrap();
        let missions = Missions::default();
        assert!(missions.open(data.path()).unwrap_err().contains("can't read its mission list"));
        assert_eq!(fs::read_to_string(&file).unwrap(), contents);
    }
    #[cfg(unix)]
    {
        fs::remove_file(&file).unwrap();
        let elsewhere = data.path().join("elsewhere.json");
        fs::write(
            &elsewhere,
            json!({ "version": 1, "missions": [] }).to_string(),
        )
        .unwrap();
        std::os::unix::fs::symlink(&elsewhere, &file).unwrap();
        assert!(Missions::default().open(data.path()).is_err());
    }

    // A file where the folder belongs is refused the same way.
    let data = Scratch::new();
    fs::write(
        data.path().join("coven-missions"),
        "a file where the folder goes",
    )
    .unwrap();
    assert!(Missions::default().open(data.path()).is_err());

    // A record that can't be saved is dropped, and the submit is never sent.
    // The folder is replaced by a file after the list opened, which no
    // account can write through (CI runs these tests as root).
    let data = Scratch::new();
    let project = Scratch::new();
    let folder = data.path().join("coven-missions");
    fs::create_dir_all(&folder).unwrap();
    let missions = Missions::default();
    missions.open(data.path()).unwrap();
    fs::remove_dir(&folder).unwrap();
    fs::write(&folder, "a file where the folder goes").unwrap();
    let fake = Fake::new(vec![]);
    let run = |args: &[&str], input: Option<&[u8]>| fake.run(args, input);
    let refused = submit(&missions, &run, &input(project.path()), at(NOW), &no_pause);
    assert!(refused.unwrap_err().contains("nothing was sent"));
    assert!(fake.calls().is_empty());
    assert!(missions.list("sage").unwrap().is_empty());
}

#[test]
fn a_mission_still_being_checked_cannot_be_removed() {
    let missions = Missions::default();
    let id = record(
        &missions,
        "chat-mission:5e2b6c35-55e7-4c0a-9a5e-36d27c6a0c41",
        Phase::Sending,
        None,
    );
    assert!(missions.forget(&id).unwrap_err().contains("still checking"));
    assert!(missions.record(&id).is_ok());
}

/// Opt-in round trip against a running Coven daemon, through the real
/// `coven` on `PATH`. Point `HOME` and `COVEN_HOME` at a scratch home with a
/// registered familiar, name it in `COVEN_CHAT_MISSION_SMOKE_FAMILIAR`, and
/// name a project directory in `COVEN_CHAT_MISSION_SMOKE_PROJECT`. Under M0
/// the mission settles `unavailable`; nothing launches.
#[test]
#[ignore = "requires a running Coven daemon at or after coven#1368 in a scratch COVEN_HOME"]
fn installed_coven_missions_round_trip() {
    let familiar = std::env::var("COVEN_CHAT_MISSION_SMOKE_FAMILIAR").unwrap();
    let project = std::env::var("COVEN_CHAT_MISSION_SMOKE_PROJECT").unwrap();
    let missions = Missions::default();

    let MissionPreparation::Ready {
        root_id,
        revision_id,
        envelope_digest,
        ..
    } = prepare(&live, &familiar).unwrap()
    else {
        panic!("the scratch familiar cannot take a mission");
    };
    eprintln!("prepare: root={root_id} revision={revision_id} digest={envelope_digest}");
    let base = SubmitInput {
        familiar_id: familiar.clone(),
        root_id: root_id.clone(),
        revision_id: revision_id.clone(),
        envelope_digest: envelope_digest.clone(),
        project_cwd: project.clone(),
        statement: "Why does the build fail?".into(),
        prompt: "Read README.md and say what it contains.".into(),
        timeout_minutes: 10,
    };

    // M-15: Chat refuses out-of-range input before anything is sent.
    let mut bounds = base.clone();
    bounds.timeout_minutes = 61;
    assert!(submit(&missions, &live, &bounds, SystemTime::now(), &no_pause).is_err());

    // M-05: a digest Coven does not advertise.
    let mut wrong = base.clone();
    wrong.envelope_digest = "0".repeat(64);
    let refused = submit(&missions, &live, &wrong, SystemTime::now(), &no_pause).unwrap();
    eprintln!("M-05: {refused:?}");
    assert!(
        matches!(refused, MissionAnswer::Refused { ref code, .. } if code == "CAPABILITY_UNSUPPORTED")
    );

    // M-04 a: a revision that is not the root's active head.
    let mut stale = base.clone();
    stale.revision_id = format!(
        "{}:999",
        revision_id.rsplit_once(':').map(|(head, _)| head).unwrap()
    );
    let refused = submit(&missions, &live, &stale, SystemTime::now(), &no_pause).unwrap();
    eprintln!("M-04 a: {refused:?}");
    assert!(matches!(
        refused,
        MissionAnswer::Refused { ref code, ref current_revision_id, .. }
            if code == "REVISION_CONFLICT" && current_revision_id.as_deref() == Some(revision_id.as_str())
    ));
    assert!(missions.list(&familiar).unwrap().is_empty());

    // M-06: a valid submit commits, and settles unavailable under M0.
    let answer = submit(&missions, &live, &base, SystemTime::now(), &no_pause).unwrap();
    eprintln!("submit: {answer:?}");
    let MissionAnswer::View { mission } = answer else {
        panic!("expected Coven's view of the committed mission");
    };
    assert_eq!(
        (mission.root_id.as_str(), mission.revision_id.as_str()),
        (root_id.as_str(), revision_id.as_str())
    );
    let id = mission.mission_id.clone();
    let answer = read(&missions, &live, &id, SystemTime::now(), &no_pause).unwrap();
    eprintln!("get: {answer:?}");
    let MissionAnswer::View { mission } = answer else {
        panic!("expected Coven's view");
    };
    assert_eq!(mission.state, "unavailable");
    assert_eq!(mission.reason.as_deref(), Some("authority_unavailable"));
    assert!(mission.terminal);
    assert_eq!(mission.result.as_ref().unwrap().usage, None);
    assert_eq!(missions.record(&id).unwrap().phase, Phase::Terminal);

    // M-09: cancelling a settled mission answers with its view, twice.
    for _ in 0..2 {
        let answer = cancel(&missions, &live, &id, &no_pause).unwrap();
        eprintln!("cancel: {answer:?}");
        assert!(matches!(answer, MissionAnswer::Settled { ref mission } if mission.terminal));
    }

    // Chat reads only missions it sent.
    assert!(read(
        &missions,
        &live,
        &mission_id_for("someone-else:key"),
        SystemTime::now(),
        &no_pause
    )
    .is_err());
}
