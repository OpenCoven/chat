mod commands;
mod metadata;

pub use commands::{app_identity, registered_command_names};
pub use metadata::{AppIdentity, APP_IDENTIFIER, APP_NAME, APP_PHASE};

fn builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default().invoke_handler(tauri::generate_handler![app_identity])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    builder()
        .run(tauri::generate_context!())
        .expect("error while running OpenCoven Chat");
}

#[cfg(test)]
mod smoke_tests {
    use super::{app_identity, registered_command_names, AppIdentity};
    use serde_json::json;

    #[test]
    fn reports_the_application_identity() {
        let identity = app_identity();

        assert_eq!(
            identity,
            AppIdentity {
                name: "OpenCoven Chat",
                identifier: "ai.opencoven.chat",
                phase: "phase-0-scaffold",
            },
        );
        assert_eq!(
            json!(identity),
            json!({
              "name": "OpenCoven Chat",
              "identifier": "ai.opencoven.chat",
              "phase": "phase-0-scaffold"
            }),
        );
    }

    #[test]
    fn registers_the_initial_command_table() {
        assert_eq!(registered_command_names(), &["app_identity"]);
    }
}
