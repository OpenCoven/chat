use std::{fs, path::Path};

const NATIVE_COMMANDS: &[&str] = &[
    "app_identity",
    "cave_read_discovery",
    "cave_launch",
    "cave_health",
    "cave_pairing_create",
    "cave_pairing_poll",
    "cave_pairing_exchange",
    "cave_reset_pairing",
    "cave_credential_status",
    "cave_forget_credential",
    "cave_list_familiars",
    "cave_list_projects",
    "cave_list_conversations",
    "cave_get_conversation",
    "cave_list_conversation_messages",
];

fn tauri_config_value<'a>(config: &'a serde_json::Value, key: &str) -> &'a str {
    config
        .get(key)
        .and_then(serde_json::Value::as_str)
        .unwrap_or_else(|| panic!("tauri.conf.json is missing a string {key:?}"))
}

fn prune_generated_desktop_schema() {
    let schema_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("gen")
        .join("schemas")
        .join("desktop-schema.json");
    let Ok(contents) = fs::read_to_string(&schema_path) else {
        return;
    };
    let Ok(mut schema) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return;
    };
    let Some(entries) = schema
        .pointer_mut("/definitions/Identifier/oneOf")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return;
    };
    entries.retain(|entry| {
        let Some(permission) = entry.get("const").and_then(serde_json::Value::as_str) else {
            return true;
        };
        let Some((kind, command)) = permission.split_once('-') else {
            return true;
        };
        !matches!(kind, "allow" | "deny")
            || NATIVE_COMMANDS
                .iter()
                .any(|expected| command == expected.replace('_', "-"))
    });
    let serialized = serde_json::to_string_pretty(&schema)
        .expect("generated desktop schema should stay serializable");
    fs::write(schema_path, format!("{serialized}\n"))
        .expect("failed to update generated desktop schema permissions");
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

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(NATIVE_COMMANDS)),
    )
    .expect("failed to run tauri-build");
    prune_generated_desktop_schema();
}
