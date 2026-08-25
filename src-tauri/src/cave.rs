use std::{
    net::IpAddr,
    path::{Path, PathBuf},
    process::{Child, Command},
};

use serde::{Deserialize, Serialize};
use url::{Host, Url};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NativeDiagnostic {
    pub code: &'static str,
    pub retryable: bool,
}

impl NativeDiagnostic {
    pub const fn new(code: &'static str, retryable: bool) -> Self {
        Self { code, retryable }
    }
}

pub type NativeResult<T> = Result<T, NativeDiagnostic>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CaveIdentity {
    pub instance_id: String,
    pub epoch: u64,
}

#[derive(Clone)]
pub(crate) struct ValidatedCaveAuthority {
    discovery_url: Url,
    client_origin: Url,
    identity: CaveIdentity,
}

impl ValidatedCaveAuthority {
    pub(crate) fn discovery_url(&self) -> &Url {
        &self.discovery_url
    }

    pub(crate) fn client_url(&self, path: &str) -> NativeResult<Url> {
        self.client_origin
            .join(path)
            .map_err(|_| NativeDiagnostic::new("invalid_cave_destination", false))
    }

    pub(crate) fn identity(&self) -> &CaveIdentity {
        &self.identity
    }
}

#[cfg(test)]
pub(crate) fn test_authority(instance_id: &str, epoch: u64) -> ValidatedCaveAuthority {
    ValidatedCaveAuthority {
        discovery_url: Url::parse("http://127.0.0.1:4310/api/v1/discovery").unwrap(),
        client_origin: Url::parse("http://127.0.0.1:4310/").unwrap(),
        identity: CaveIdentity {
            instance_id: instance_id.to_owned(),
            epoch,
        },
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverySnapshot {
    pub instance_id: String,
    pub epoch: u64,
}

impl From<&ValidatedCaveAuthority> for DiscoverySnapshot {
    fn from(authority: &ValidatedCaveAuthority) -> Self {
        Self {
            instance_id: authority.identity.instance_id.clone(),
            epoch: authority.identity.epoch,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiscoveryDocument {
    instance_id: String,
    epoch: u64,
    #[serde(alias = "endpoint")]
    client_v1_url: String,
}

pub(crate) fn validate_discovery_url(value: &str) -> NativeResult<Url> {
    let url =
        Url::parse(value).map_err(|_| NativeDiagnostic::new("invalid_discovery_url", false))?;

    validate_loopback_host(&url, "non_loopback_discovery")?;

    if url.scheme() != "http" {
        return Err(NativeDiagnostic::new("invalid_discovery_scheme", false));
    }

    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(NativeDiagnostic::new("unsafe_discovery_url", false));
    }

    if url.path() != "/api/v1/discovery" {
        return Err(NativeDiagnostic::new("invalid_discovery_path", false));
    }

    Ok(url)
}

pub(crate) fn parse_discovery_document(
    discovery_url: Url,
    document: DiscoveryDocument,
) -> NativeResult<ValidatedCaveAuthority> {
    if document.instance_id.is_empty() {
        return Err(NativeDiagnostic::new("invalid_discovery_response", false));
    }

    let mut client_origin = Url::parse(&document.client_v1_url)
        .map_err(|_| NativeDiagnostic::new("invalid_discovery_response", false))?;

    validate_loopback_host(&client_origin, "non_loopback_discovery")?;

    if client_origin.scheme() != "http"
        || !client_origin.username().is_empty()
        || client_origin.password().is_some()
        || client_origin.query().is_some()
        || client_origin.fragment().is_some()
        || !matches!(client_origin.path(), "" | "/")
    {
        return Err(NativeDiagnostic::new("unsafe_discovery_response", false));
    }

    client_origin.set_path("/");

    Ok(ValidatedCaveAuthority {
        discovery_url,
        client_origin,
        identity: CaveIdentity {
            instance_id: document.instance_id,
            epoch: document.epoch,
        },
    })
}

fn validate_loopback_host(url: &Url, code: &'static str) -> NativeResult<()> {
    let Some(host) = url.host() else {
        return Err(NativeDiagnostic::new(code, false));
    };

    let is_loopback = match host {
        Host::Ipv4(address) => IpAddr::V4(address).is_loopback(),
        Host::Ipv6(address) => IpAddr::V6(address).is_loopback(),
        Host::Domain(_) => false,
    };

    if is_loopback {
        Ok(())
    } else {
        Err(NativeDiagnostic::new(code, false))
    }
}

pub(crate) fn approved_cave_paths() -> &'static [&'static str] {
    #[cfg(target_os = "macos")]
    {
        &["/Applications/OpenCoven Cave.app/Contents/MacOS/OpenCoven Cave"]
    }

    #[cfg(target_os = "windows")]
    {
        &[
            r"C:\Program Files\OpenCoven Cave\OpenCoven Cave.exe",
            r"C:\Program Files (x86)\OpenCoven Cave\OpenCoven Cave.exe",
        ]
    }

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        &["/opt/opencoven-cave/opencoven-cave"]
    }
}

pub(crate) fn resolve_installed_cave_binary() -> NativeResult<PathBuf> {
    resolve_installed_cave_binary_from(|candidate| candidate.is_file())
}

pub(crate) fn resolve_installed_cave_binary_from(
    is_installed_file: impl Fn(&Path) -> bool,
) -> NativeResult<PathBuf> {
    approved_cave_paths()
        .iter()
        .map(PathBuf::from)
        .find(|candidate| is_installed_file(candidate))
        .ok_or_else(|| NativeDiagnostic::new("cave_not_installed", true))
}

pub(crate) fn build_cave_command(path: &Path) -> Command {
    Command::new(path)
}

pub(crate) fn launch_installed_cave() -> NativeResult<Child> {
    let executable = resolve_installed_cave_binary()?;

    build_cave_command(&executable)
        .spawn()
        .map_err(|_| NativeDiagnostic::new("cave_launch_failed", true))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        approved_cave_paths, build_cave_command, resolve_installed_cave_binary_from,
        validate_discovery_url,
    };

    #[test]
    fn manual_discovery_rejects_non_loopback_hosts() {
        let error = validate_discovery_url("https://example.com/discovery").unwrap_err();
        assert_eq!(error.code, "non_loopback_discovery");
    }

    #[test]
    fn manual_discovery_rejects_non_cave_api_paths() {
        let error = validate_discovery_url("http://127.0.0.1:4310/health").unwrap_err();
        assert_eq!(error.code, "invalid_discovery_path");
    }

    #[test]
    fn cave_launch_resolves_and_uses_an_exact_approved_installed_path() {
        let approved = Path::new(approved_cave_paths()[0]);
        let executable =
            resolve_installed_cave_binary_from(|candidate| candidate == approved).unwrap();
        let command = build_cave_command(&executable);

        assert_eq!(command.get_program(), approved);
    }
}
