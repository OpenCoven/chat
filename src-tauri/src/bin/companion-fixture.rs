#[tokio::main]
async fn main() {
    let data = std::env::args_os()
        .nth(1)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::env::temp_dir().join(format!("chat-companion-fixture-{}", std::process::id()))
        });
    // Optional second argument: the address to listen on (a private IPv4
    // address, for example a loopback alias in CI); otherwise the LAN address.
    let bind = std::env::args().nth(2);
    if let Err(error) = opencoven_chat_lib::companion::fixture::run(data, bind).await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
