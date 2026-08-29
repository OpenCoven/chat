const COVEN_SOURCE: &str = include_str!("../src/coven.rs");
const APP_MAIN_SOURCE: &str = include_str!("../src/main.rs");
const RPC_MAIN_SOURCE: &str = include_str!("../src/bin/phase1-native-rpc.rs");

const PROBE_ENTRYPOINT: &str =
    "opencoven_chat_lib::exit_if_internal_coven_health_probe_requested();";

#[test]
fn native_coven_health_uses_a_fixed_null_stdio_self_process_boundary() {
    for required in [
        "std::env::current_exe()",
        "Command::new",
        "COVEN_HEALTH_PROBE_ARGUMENT",
        ".stdin(Stdio::null())",
        ".stdout(Stdio::null())",
        ".stderr(Stdio::null())",
        ".kill()",
        ".wait()",
    ] {
        assert!(
            COVEN_SOURCE.contains(required),
            "missing required process-boundary element: {required}"
        );
    }

    for forbidden in [
        "set_hook",
        "take_hook",
        "ScopedRedactingPanicHook",
        "powershell",
        "opencoven coven health",
    ] {
        assert!(
            !COVEN_SOURCE.contains(forbidden),
            "forbidden native health mechanism remains: {forbidden}"
        );
    }
}

#[test]
fn both_production_binaries_check_probe_mode_before_normal_startup() {
    assert_eq!(
        first_main_statement(APP_MAIN_SOURCE),
        Some(PROBE_ENTRYPOINT)
    );
    assert_eq!(
        first_main_statement(RPC_MAIN_SOURCE),
        Some(PROBE_ENTRYPOINT)
    );
}

fn first_main_statement(source: &str) -> Option<&str> {
    source
        .split_once("fn main() {")?
        .1
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
}
