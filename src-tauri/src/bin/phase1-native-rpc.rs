fn main() {
    opencoven_chat_lib::exit_if_internal_coven_health_probe_requested();
    if let Some(result) =
        opencoven_chat_lib::conformance::run_internal_test_reservation_output_if_requested()
    {
        if result.is_err() {
            eprintln!("phase1-native-rpc failed");
            std::process::exit(1);
        }
        return;
    }
    if opencoven_chat_lib::conformance::run_stdio().is_err() {
        eprintln!("phase1-native-rpc failed");
        std::process::exit(1);
    }
}
