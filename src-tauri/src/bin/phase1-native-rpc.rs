fn main() {
    if opencoven_chat_lib::conformance::run_stdio().is_err() {
        eprintln!("phase1-native-rpc failed");
        std::process::exit(1);
    }
}
