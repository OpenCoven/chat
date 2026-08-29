fn main() {
    if opencoven_chat_lib::run_credential_helper_if_requested() {
        return;
    }
    opencoven_chat_lib::run();
}
