use crate::sdk_diagnostics::{DiagnosticCode, NativeError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnixPeerIdentity {
    pub uid: u32,
    pub gid: Option<u32>,
    pub pid: Option<u32>,
}

pub fn validate_unix_peer_identity(
    identity: &UnixPeerIdentity,
    expected_uid: u32,
) -> Result<(), NativeError> {
    if identity.uid != expected_uid {
        return Err(NativeError::new(DiagnosticCode::OwnerMismatch, false));
    }
    if identity.pid == Some(0) {
        return Err(NativeError::new(DiagnosticCode::UnsafeEndpoint, false));
    }
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub fn inspect_connected_unix_peer(
    stream: &std::os::unix::net::UnixStream,
) -> Result<UnixPeerIdentity, NativeError> {
    use std::os::fd::AsRawFd;

    let descriptor = stream.as_raw_fd();

    #[cfg(target_os = "linux")]
    {
        let mut credentials = libc::ucred {
            pid: 0,
            uid: 0,
            gid: 0,
        };
        let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        // SAFETY: the descriptor is live and the output buffer and length match libc::ucred.
        let status = unsafe {
            libc::getsockopt(
                descriptor,
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&raw mut credentials).cast(),
                &raw mut length,
            )
        };
        if status != 0 || length as usize != std::mem::size_of::<libc::ucred>() {
            return Err(NativeError::platform_security_unavailable());
        }
        return Ok(UnixPeerIdentity {
            uid: credentials.uid,
            gid: Some(credentials.gid),
            pid: u32::try_from(credentials.pid).ok().filter(|pid| *pid > 0),
        });
    }

    #[cfg(target_os = "macos")]
    {
        let mut uid = 0;
        let mut gid = 0;
        // SAFETY: getpeereid writes uid/gid for the connected Unix descriptor.
        let status = unsafe { libc::getpeereid(descriptor, &raw mut uid, &raw mut gid) };
        if status != 0 {
            return Err(NativeError::platform_security_unavailable());
        }
        Ok(UnixPeerIdentity {
            uid,
            gid: Some(gid),
            pid: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{validate_unix_peer_identity, UnixPeerIdentity};
    use crate::sdk_diagnostics::DiagnosticCode;

    #[test]
    fn rejects_zero_peer_pid_when_one_is_reported() {
        let error = validate_unix_peer_identity(
            &UnixPeerIdentity {
                uid: 501,
                gid: Some(20),
                pid: Some(0),
            },
            501,
        )
        .expect_err("zero is not a live peer pid");
        assert_eq!(error.code, DiagnosticCode::UnsafeEndpoint);
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn inspects_a_live_connected_peer() {
        let (client, _server) =
            std::os::unix::net::UnixStream::pair().expect("socket pair should open");
        let identity =
            super::inspect_connected_unix_peer(&client).expect("peer credentials should exist");
        // SAFETY: geteuid has no preconditions.
        let expected_uid = unsafe { libc::geteuid() };
        validate_unix_peer_identity(&identity, expected_uid)
            .expect("the connected socket pair is owned by the current user");
    }
}
