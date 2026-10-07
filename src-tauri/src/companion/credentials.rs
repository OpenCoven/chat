use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::Path};

const FILE: &str = "identity.json";
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Identity {
    pub token: String,
    pub certificate: Vec<u8>,
    pub key: Vec<u8>,
    pub port: u16,
}
pub(super) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
impl Identity {
    pub fn fingerprint(&self) -> String {
        hex(&Sha256::digest(&self.certificate))
    }
    pub fn load(data: &Path) -> Result<Self, String> {
        private_directory(data)?;
        if let Some(bytes) = read_private(data, FILE, 32 * 1024)? {
            let value: Self = serde_json::from_slice(&bytes)
                .map_err(|_| "Companion credentials are unreadable.")?;
            if value.token.len() != 64
                || !value.token.bytes().all(|b| b.is_ascii_hexdigit())
                || value.certificate.is_empty()
                || value.key.is_empty()
            {
                return Err("Companion credentials are invalid.".into());
            }
            return Ok(value);
        }
        let cert = rcgen::generate_simple_self_signed(vec!["coven-chat.local".into()])
            .map_err(|_| "Cannot create the companion certificate.")?;
        let value = Self {
            token: random_token()?,
            certificate: cert.cert.der().to_vec(),
            key: cert.signing_key.serialize_der(),
            port: 0,
        };
        value.save(data)?;
        Ok(value)
    }
    pub fn save(&self, data: &Path) -> Result<(), String> {
        crate::chat_lifecycle::persist(
            data,
            FILE,
            &serde_json::to_vec(self).map_err(|_| "Cannot save companion credentials.")?,
        )
    }
}
pub(super) fn random_token() -> Result<String, String> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|_| "Cannot generate companion credentials.")?;
    Ok(hex(&bytes))
}
pub(super) fn private_directory(data: &Path) -> Result<(), String> {
    #[cfg(not(unix))]
    {
        let _ = data;
        Err("iPhone companion currently requires macOS or Linux.".into())
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        if !data.exists() {
            fs::DirBuilder::new()
                .mode(0o700)
                .create(data)
                .map_err(|_| "Cannot create private companion storage.")?;
        }
        let metadata =
            fs::symlink_metadata(data).map_err(|_| "Cannot inspect companion storage.")?;
        if !metadata.is_dir() || metadata.permissions().mode() & 0o077 != 0 {
            return Err("Companion storage must be a private directory.".into());
        }
        Ok(())
    }
}
pub(super) fn read_private(
    data: &Path,
    name: &str,
    limit: usize,
) -> Result<Option<Vec<u8>>, String> {
    let path = data.join(name);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot inspect companion storage.".into()),
    };
    if !metadata.is_file() || metadata.len() > limit as u64 {
        return Err("Companion storage is invalid or full.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("Companion storage is not private.".into());
        }
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut bytes = Vec::new();
    options
        .open(path)
        .map_err(|_| "Cannot open companion storage.")?
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read companion storage.")?;
    if bytes.len() > limit {
        return Err("Companion storage is full.".into());
    }
    Ok(Some(bytes))
}
