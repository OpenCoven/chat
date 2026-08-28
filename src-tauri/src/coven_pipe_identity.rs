use crate::sdk_diagnostics::{DiagnosticCode, NativeError};

const MAX_IDENTITY_CHARACTERS: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsPipeIdentity {
    pub owner_identity: String,
    pub owner_only: bool,
    pub pipe_identity: String,
    pub server_process_id: u32,
    pub process_creation_time: u64,
    pub reparse_point: bool,
}

fn valid_identity(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_IDENTITY_CHARACTERS
        && !value.chars().any(char::is_control)
}

fn validate_one(
    current_user_identity: &str,
    identity: &WindowsPipeIdentity,
) -> Result<(), NativeError> {
    if !valid_identity(current_user_identity)
        || !valid_identity(&identity.owner_identity)
        || !valid_identity(&identity.pipe_identity)
        || !identity.owner_only
        || identity.server_process_id == 0
        || identity.process_creation_time == 0
        || identity.reparse_point
    {
        return Err(NativeError::new(DiagnosticCode::UnsafeEndpoint, false));
    }
    if identity.owner_identity != current_user_identity {
        return Err(NativeError::new(DiagnosticCode::OwnerMismatch, false));
    }
    Ok(())
}

pub fn validate_windows_pipe_identity(
    current_user_identity: &str,
    initial: &WindowsPipeIdentity,
    connected: &WindowsPipeIdentity,
) -> Result<(), NativeError> {
    validate_one(current_user_identity, initial)?;
    validate_one(current_user_identity, connected)?;
    if initial != connected {
        return Err(NativeError::new(DiagnosticCode::UnsafeEndpoint, false));
    }
    Ok(())
}

pub trait WindowsPipeIdentityProvider: Send + Sync {
    fn current_user_identity(&self) -> Result<String, NativeError>;
    fn inspect_path(&self, path: &str) -> Result<WindowsPipeIdentity, NativeError>;
    fn inspect_connected(
        &self,
        connected_handle: usize,
    ) -> Result<WindowsPipeIdentity, NativeError>;
}

pub struct SystemWindowsPipeIdentityProvider;

impl WindowsPipeIdentityProvider for SystemWindowsPipeIdentityProvider {
    fn current_user_identity(&self) -> Result<String, NativeError> {
        Err(NativeError::platform_security_unavailable())
    }

    fn inspect_path(&self, _path: &str) -> Result<WindowsPipeIdentity, NativeError> {
        Err(NativeError::platform_security_unavailable())
    }

    fn inspect_connected(
        &self,
        _connected_handle: usize,
    ) -> Result<WindowsPipeIdentity, NativeError> {
        Err(NativeError::platform_security_unavailable())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        validate_windows_pipe_identity, SystemWindowsPipeIdentityProvider,
        WindowsPipeIdentityProvider,
    };
    use crate::sdk_diagnostics::DiagnosticCode;

    #[test]
    fn system_provider_never_silently_degrades() {
        let error = SystemWindowsPipeIdentityProvider
            .current_user_identity()
            .expect_err("unimplemented OS inspection must fail closed");
        assert_eq!(error.code, DiagnosticCode::PlatformSecurityUnavailable);
    }

    #[test]
    fn connected_process_replacement_is_rejected() {
        let initial = super::WindowsPipeIdentity {
            owner_identity: "S-1-5-21-current".into(),
            owner_only: true,
            pipe_identity: "pipe-object".into(),
            server_process_id: 123,
            process_creation_time: 456,
            reparse_point: false,
        };
        let mut connected = initial.clone();
        connected.process_creation_time += 1;
        assert_eq!(
            validate_windows_pipe_identity("S-1-5-21-current", &initial, &connected)
                .expect_err("server replacement must fail")
                .code,
            DiagnosticCode::UnsafeEndpoint
        );
    }
}
