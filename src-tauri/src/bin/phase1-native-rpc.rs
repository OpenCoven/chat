fn main() {
    opencoven_chat_lib::exit_if_internal_coven_health_probe_requested();
    if opencoven_chat_lib::conformance::run_stdio().is_err() {
        eprintln!("phase1-native-rpc failed");
        std::process::exit(1);
    }
}
