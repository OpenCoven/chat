#[tokio::main]
async fn main() {
    let data = std::env::args_os()
        .nth(1)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::env::temp_dir().join(format!("chat-companion-fixture-{}", std::process::id()))
        });
    if let Err(error) = opencoven_chat_lib::companion::fixture::run(data).await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
