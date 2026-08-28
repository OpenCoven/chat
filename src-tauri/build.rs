use std::{fs, path::Path};

fn tauri_config_value<'a>(config: &'a serde_json::Value, key: &str) -> &'a str {
    config
        .get(key)
        .and_then(serde_json::Value::as_str)
        .unwrap_or_else(|| panic!("tauri.conf.json is missing a string {key:?}"))
}

fn main() {
    println!("cargo:rerun-if-changed=tauri.conf.json");

    let config_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
    let config = serde_json::from_str::<serde_json::Value>(
        &fs::read_to_string(&config_path).expect("failed to read tauri.conf.json"),
    )
    .expect("failed to parse tauri.conf.json");

    println!(
        "cargo:rustc-env=OPENCOVEN_PRODUCT_NAME={}",
        tauri_config_value(&config, "productName")
    );
    println!(
        "cargo:rustc-env=OPENCOVEN_APP_IDENTIFIER={}",
        tauri_config_value(&config, "identifier")
    );

    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "app_identity",
            "sdk_installation_identity",
            "sdk_discovery_read",
            "sdk_authority_establish",
            "sdk_authority_close",
            "cave_health",
            "cave_managed_pairing_create",
            "cave_managed_pairing_poll",
            "cave_managed_pairing_exchange",
            "cave_credential_state",
            "cave_forget_credential",
            "cave_list_familiars",
            "cave_list_projects",
            "cave_list_conversations",
            "cave_get_conversation",
            "cave_list_conversation_messages",
            "sdk_native_diagnostics",
        ]),
    ))
    .expect("failed to run tauri-build");
}
