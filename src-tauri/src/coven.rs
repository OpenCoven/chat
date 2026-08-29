use std::{
    env,
    ffi::OsString,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use coven_client::{ClientError, DaemonClient, DaemonEndpoint};
use serde::Serialize;

use crate::cave::{NativeDiagnostic, NativeResult};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CovenHealthResult {
    pub status: &'static str,
}

pub(crate) trait CovenHealth: Send + Sync {
    fn health(&self) -> NativeResult<CovenHealthResult>;
}

#[derive(Default)]
pub(crate) struct NativeCovenHealthExecutor {
    busy: Arc<AtomicBool>,
    worker: Arc<Mutex<()>>,
}

impl NativeCovenHealthExecutor {
    pub(crate) async fn execute(
        self: &Arc<Self>,
        health: Arc<dyn CovenHealth>,
    ) -> NativeResult<CovenHealthResult> {
        if self
            .busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(NativeDiagnostic::new("service_unavailable", true));
        }

        let executor = Arc::clone(self);
        tokio::task::spawn_blocking(move || {
            struct BusyReset(Arc<AtomicBool>);

            impl Drop for BusyReset {
                fn drop(&mut self) {
                    self.0.store(false, Ordering::SeqCst);
                }
            }

            let _busy = BusyReset(Arc::clone(&executor.busy));
            let _worker = executor
                .worker
                .lock()
                .map_err(|_| NativeDiagnostic::new("service_unavailable", true))?;
            health.health()
        })
        .await
        .map_err(|_| NativeDiagnostic::new("service_unavailable", true))?
    }
}

type CovenHomeResolver = dyn Fn() -> NativeResult<PathBuf> + Send + Sync;

pub(crate) struct NativeCovenHealth {
    home: Arc<CovenHomeResolver>,
}

impl Default for NativeCovenHealth {
    fn default() -> Self {
        Self {
            home: Arc::new(resolve_coven_home),
        }
    }
}

impl NativeCovenHealth {
    #[cfg(all(test, unix))]
    fn with_home(home: Arc<CovenHomeResolver>) -> Self {
        Self { home }
    }
}

impl CovenHealth for NativeCovenHealth {
    fn health(&self) -> NativeResult<CovenHealthResult> {
        let home = (self.home)()?;
        let endpoint = DaemonEndpoint::discover(home).map_err(map_client_error)?;
        let mut client = DaemonClient::new(endpoint);
        client.health().map_err(map_client_error)?;
        Ok(CovenHealthResult { status: "ok" })
    }
}

fn resolve_coven_home() -> NativeResult<PathBuf> {
    resolve_coven_home_with(env::var_os("COVEN_HOME"), platform_home)
}

fn resolve_coven_home_with(
    explicit: Option<OsString>,
    fallback: impl FnOnce() -> Option<PathBuf>,
) -> NativeResult<PathBuf> {
    if let Some(explicit) = explicit {
        if explicit.is_empty() {
            return Err(NativeDiagnostic::new("service_unavailable", true));
        }
        return Ok(PathBuf::from(explicit));
    }
    fallback()
        .map(|home| home.join(".coven"))
        .ok_or_else(|| NativeDiagnostic::new("service_unavailable", true))
}

#[cfg(unix)]
fn platform_home() -> Option<PathBuf> {
    use std::{ffi::CStr, mem::MaybeUninit, os::unix::ffi::OsStringExt, ptr};

    const INITIAL_BUFFER_BYTES: usize = 16 * 1024;
    const MAX_BUFFER_BYTES: usize = 1024 * 1024;
    let uid = unsafe { libc::geteuid() };
    let mut buffer_bytes = INITIAL_BUFFER_BYTES;
    while buffer_bytes <= MAX_BUFFER_BYTES {
        let mut password = MaybeUninit::<libc::passwd>::uninit();
        let mut result = ptr::null_mut();
        let mut buffer = vec![0_u8; buffer_bytes];
        let status = unsafe {
            libc::getpwuid_r(
                uid,
                password.as_mut_ptr(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &mut result,
            )
        };
        if status == libc::ERANGE {
            buffer_bytes = buffer_bytes.saturating_mul(2);
            continue;
        }
        if status != 0 || result.is_null() {
            return None;
        }
        let password = unsafe { password.assume_init() };
        if password.pw_dir.is_null() {
            return None;
        }
        let bytes = unsafe { CStr::from_ptr(password.pw_dir) }.to_bytes();
        if bytes.is_empty() {
            return None;
        }
        return Some(PathBuf::from(OsString::from_vec(bytes.to_vec())));
    }
    None
}

#[cfg(windows)]
fn platform_home() -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::{
        System::Com::CoTaskMemFree,
        UI::Shell::{FOLDERID_Profile, SHGetKnownFolderPath, KF_FLAG_DEFAULT},
    };

    let mut raw = std::ptr::null_mut();
    let flags = u32::try_from(KF_FLAG_DEFAULT).ok()?;
    let status =
        unsafe { SHGetKnownFolderPath(&FOLDERID_Profile, flags, std::ptr::null_mut(), &mut raw) };
    if status < 0 {
        if !raw.is_null() {
            unsafe { CoTaskMemFree(raw.cast()) };
        }
        return None;
    }
    if raw.is_null() {
        return None;
    }
    let mut length = 0;
    while unsafe { *raw.add(length) } != 0 {
        length += 1;
    }
    let home = PathBuf::from(OsString::from_wide(unsafe {
        std::slice::from_raw_parts(raw, length)
    }));
    unsafe { CoTaskMemFree(raw.cast()) };
    (!home.as_os_str().is_empty()).then_some(home)
}

#[cfg(not(any(unix, windows)))]
fn platform_home() -> Option<PathBuf> {
    None
}

fn map_status(status: u16) -> NativeDiagnostic {
    match status {
        401 => NativeDiagnostic::new("unauthorized", false),
        403 => NativeDiagnostic::new("scope_denied", false),
        404 => NativeDiagnostic::new("not_found", true),
        409 => NativeDiagnostic::new("conflict", false),
        429 => NativeDiagnostic::new("rate_limited", true),
        500..=599 => NativeDiagnostic::new("service_unavailable", true),
        _ => NativeDiagnostic::new("invalid_response", false),
    }
}

fn map_client_error(error: ClientError) -> NativeDiagnostic {
    match error {
        ClientError::Discovery(_) => NativeDiagnostic::new("reconcile_required", false),
        ClientError::Io { source, .. } if source.kind() == std::io::ErrorKind::TimedOut => {
            NativeDiagnostic::new("timeout", true)
        }
        ClientError::Io { .. } => NativeDiagnostic::new("service_unavailable", true),
        ClientError::ResponseTooLarge { .. } | ClientError::RequestTooLarge { .. } => {
            NativeDiagnostic::new("body_limit", false)
        }
        ClientError::InvalidHttpResponse(_)
        | ClientError::InvalidUtf8(_)
        | ClientError::InvalidJson(_)
        | ClientError::InvalidRouteParameter(_) => NativeDiagnostic::new("invalid_response", false),
        ClientError::ProtocolVersion { .. }
        | ClientError::StructuredErrorsUnavailable
        | ClientError::CapabilityUnavailable { .. } => {
            NativeDiagnostic::new("incompatible_version", false)
        }
        ClientError::HealthNotReady => NativeDiagnostic::new("service_unavailable", true),
        ClientError::DaemonInstanceChanged => NativeDiagnostic::new("reconcile_required", false),
        ClientError::Daemon { status, .. } | ClientError::HttpStatus(status) => map_status(status),
        ClientError::LegacyShutdownUpgradeRequired { .. } | ClientError::UnsupportedPlatform => {
            NativeDiagnostic::new("unsupported_operation", false)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    #[cfg(unix)]
    use std::sync::Arc;

    use coven_client::{ClientError, DaemonError};
    use serde_json::json;

    use super::{map_client_error, resolve_coven_home_with};
    #[cfg(unix)]
    use super::{CovenHealth, CovenHealthResult, NativeCovenHealth};

    #[test]
    fn maps_client_failures_to_bounded_diagnostics_without_leaking_details() {
        let canary = "/Users/owner/private/.coven/coven.sock secret-native-cause";
        let errors = [
            (
                ClientError::Discovery(canary.to_owned()),
                ("reconcile_required", false),
            ),
            (
                ClientError::Io {
                    operation: "failed to connect to Coven daemon socket",
                    source: std::io::Error::other(canary),
                },
                ("service_unavailable", true),
            ),
            (
                ClientError::ProtocolVersion {
                    expected: "coven.daemon.v1",
                    actual: canary.to_owned(),
                },
                ("incompatible_version", false),
            ),
            (
                ClientError::Daemon {
                    status: 503,
                    error: DaemonError {
                        code: canary.to_owned(),
                        message: canary.to_owned(),
                        details: json!({ "path": canary }),
                    },
                },
                ("service_unavailable", true),
            ),
            (
                ClientError::UnsupportedPlatform,
                ("unsupported_operation", false),
            ),
        ];

        for (error, expected) in errors {
            let diagnostic = map_client_error(error);
            assert_eq!((diagnostic.code, diagnostic.retryable), expected);
            assert!(!serde_json::to_string(&diagnostic).unwrap().contains(canary));
        }
    }

    #[test]
    fn explicit_home_wins_and_missing_platform_home_fails_closed() {
        let explicit = PathBuf::from("explicit-coven-home");
        assert_eq!(
            resolve_coven_home_with(Some(explicit.clone().into_os_string()), || None).unwrap(),
            explicit
        );
        assert_eq!(
            resolve_coven_home_with(None, || Some(PathBuf::from("platform-home"))).unwrap(),
            PathBuf::from("platform-home").join(".coven")
        );
        assert_eq!(
            resolve_coven_home_with(Some(std::ffi::OsString::new()), || {
                Some(PathBuf::from("platform-home"))
            })
            .unwrap_err()
            .code,
            "service_unavailable"
        );
        assert_eq!(
            resolve_coven_home_with(None, || None).unwrap_err().code,
            "service_unavailable"
        );
    }

    #[cfg(unix)]
    #[test]
    fn owner_current_connected_socket_health_succeeds() {
        use std::{
            fs,
            io::{Read, Write},
            os::unix::{fs::PermissionsExt, net::UnixListener},
            thread,
        };

        let root = std::env::current_dir()
            .unwrap()
            .join(format!(".c{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let socket = root.join("coven.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            stream.read_to_end(&mut request).unwrap();
            assert!(request.starts_with(b"GET /api/v1/health HTTP/1.1\r\n"));
            let body = br#"{"ok":true,"apiVersion":"coven.daemon.v1","covenVersion":"0.1.0","capabilities":{"sessions":true,"events":true,"eventCursor":"sequence","structuredErrors":true}}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(body).unwrap();
        });

        let resolver_root = root.clone();
        let health = NativeCovenHealth::with_home(Arc::new(move || Ok(resolver_root.clone())));
        assert_eq!(health.health().unwrap(), CovenHealthResult { status: "ok" });
        server.join().unwrap();
        fs::remove_dir_all(&root).unwrap();
    }
}
