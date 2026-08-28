use serde::Serialize;

pub const APP_NAME: &str = env!("OPENCOVEN_PRODUCT_NAME");
pub const APP_IDENTIFIER: &str = env!("OPENCOVEN_APP_IDENTIFIER");
pub const APP_PHASE: &str = "phase-1-read-only-production";

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
