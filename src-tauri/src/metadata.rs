use serde::Serialize;

pub const APP_NAME: &str = "OpenCoven Chat";
pub const APP_IDENTIFIER: &str = "ai.opencoven.chat";
pub const APP_PHASE: &str = "phase-0-scaffold";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct AppIdentity {
    pub name: &'static str,
    pub identifier: &'static str,
    pub phase: &'static str,
}

impl AppIdentity {
    pub const fn current() -> Self {
        Self {
            name: APP_NAME,
            identifier: APP_IDENTIFIER,
            phase: APP_PHASE,
        }
    }
}
