//! Installs the Coven CLI for a person who does not have it, from Coven's
//! pinned GitHub release. The download is checked against a SHA-256 built
//! into Chat before anything is unpacked, and only the release's own
//! executables are installed, into the folder Chat already searches.

use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// The Coven release Chat installs. Moving it means updating every digest
/// below from that release's `SHA256SUMS`.
pub(crate) const COVEN_VERSION: &str = "0.4.10";
/// Larger than any Coven release asset; a bigger response is refused.
const MAX_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// One platform's release archive. `files` are the executables at its root.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Release {
    pub(crate) asset: &'static str,
    pub(crate) sha256: &'static str,
    pub(crate) size: u64,
    pub(crate) files: &'static [&'static str],
}

pub(crate) fn release_for(os: &str, arch: &str) -> Option<Release> {
    let release = |asset, sha256, size, files| Release {
        asset,
        sha256,
        size,
        files,
    };
    match (os, arch) {
        ("macos", "aarch64") => Some(release(
            "coven-v0.4.10-macos-aarch64.tar.gz",
            "3d7fb297aa772e6405afa3e1bfb9fd8f4d99b19dd7339625b83ccbca3bbd624b",
            12_072_707,
            &["coven", "coven-afs-serve"],
        )),
        ("macos", "x86_64") => Some(release(
            "coven-v0.4.10-macos-x64.tar.gz",
            "b194819055c6922ba4e2e5aa6ac10b0e67f76158da8c6669f18b3025a1c67119",
            12_505_542,
            &["coven", "coven-afs-serve"],
        )),
        ("linux", "x86_64") => Some(release(
            "coven-v0.4.10-linux-x64.tar.gz",
            "01589044d05f1dd40823c218531386c6cdc89648a5a3ca4056a0b672c80db7cc",
            11_233_844,
            &["coven"],
        )),
        ("windows", "x86_64") => Some(release(
            "coven-v0.4.10-windows-x64.zip",
            "bd6749dd3e2e248827d498d990589c2c6e2dce5853194b1dc9fb025c933c06fc",
            29_110_900,
            &["coven.exe"],
        )),
        _ => None,
    }
}

pub(crate) fn download_url(release: &Release) -> String {
    format!(
        "https://github.com/OpenCoven/coven/releases/download/v{COVEN_VERSION}/{}",
        release.asset
    )
}

/// Where Chat installs Coven. Both are already on Chat's search list: the
/// user's `~/.local/bin` elsewhere, a per-user program folder on Windows.
pub(crate) fn install_dir(
    windows: bool,
    home: &Path,
    local_app_data: Option<&Path>,
) -> Result<PathBuf, String> {
    if windows {
        local_app_data
            .map(windows_install_dir)
            .ok_or_else(|| "Cannot locate the local programs folder.".to_owned())
    } else {
        Ok(home.join(".local").join("bin"))
    }
}

pub(crate) fn windows_install_dir(local_app_data: &Path) -> PathBuf {
    local_app_data
        .join("Programs")
        .join("OpenCoven")
        .join("Coven")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Streams the release archive to `destination`, checking its size as it
/// arrives and its SHA-256 at the end. A mismatch leaves nothing installed.
pub(crate) async fn download(
    client: &reqwest::Client,
    url: &str,
    release: &Release,
    destination: &Path,
    cancel: &AtomicBool,
    progress: &mut (dyn FnMut(u64, u64) + Send),
) -> Result<(), String> {
    const FAILED: &str =
        "Coven could not be downloaded. Check your internet connection, then try again.";
    let mut response = client.get(url).send().await.map_err(|_| FAILED)?;
    if !response.status().is_success() {
        return Err(FAILED.into());
    }
    if response
        .content_length()
        .is_some_and(|length| length != release.size || length > MAX_ARCHIVE_BYTES)
    {
        return Err(
            "The Coven download was not the expected file, so it was not installed. Try again."
                .into(),
        );
    }
    let mut file = File::create(destination).map_err(|_| "Coven could not be saved to disk.")?;
    let mut hasher = Sha256::new();
    let mut received = 0u64;
    progress(0, release.size);
    while let Some(chunk) = response.chunk().await.map_err(|_| FAILED)? {
        if cancel.load(Ordering::SeqCst) {
            return Err(crate::coven_runtime::RUN_CANCELLED.into());
        }
        received += chunk.len() as u64;
        if received > release.size || received > MAX_ARCHIVE_BYTES {
            return Err(
                "The Coven download was larger than expected, so it was not installed. Try again."
                    .into(),
            );
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .map_err(|_| "Coven could not be saved to disk.")?;
        progress(received, release.size);
    }
    file.sync_all()
        .map_err(|_| "Coven could not be saved to disk.")?;
    if received != release.size || hex(&hasher.finalize()) != release.sha256 {
        return Err("The Coven download did not match the expected file, so it was not installed. Try again.".into());
    }
    Ok(())
}

/// The system `tar`, by absolute path: macOS and Linux ship one, and so does
/// Windows 10 and later, which also reads zip archives.
fn tar_program(windows: bool) -> Option<PathBuf> {
    if windows {
        std::env::var_os("SystemRoot")
            .map(|root| PathBuf::from(root).join("System32").join("tar.exe"))
            .filter(|path| path.is_file())
    } else {
        ["/usr/bin/tar", "/bin/tar"]
            .into_iter()
            .map(PathBuf::from)
            .find(|path| path.is_file())
    }
}

fn run_tar(tar: &Path, args: &[&std::ffi::OsStr]) -> Result<String, String> {
    let output = Command::new(tar)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|_| "Coven could not be unpacked.")?;
    if !output.status.success() {
        return Err("Coven could not be unpacked.".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// The archive must hold exactly the release's executables, at its root.
fn check_entries(listing: &str, expected: &[&str]) -> Result<(), String> {
    let mut entries: Vec<&str> = listing
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    entries.sort_unstable();
    let mut wanted = expected.to_vec();
    wanted.sort_unstable();
    if entries != wanted {
        return Err("The Coven download held unexpected files, so it was not installed.".into());
    }
    Ok(())
}

/// Lists, checks, then unpacks `archive` into `staging`.
pub(crate) fn unpack(
    windows: bool,
    archive: &Path,
    staging: &Path,
    release: &Release,
) -> Result<(), String> {
    let tar = tar_program(windows).ok_or("This computer has no tar program to unpack Coven.")?;
    check_entries(
        &run_tar(&tar, &["-tf".as_ref(), archive.as_os_str()])?,
        release.files,
    )?;
    run_tar(
        &tar,
        &[
            "-xf".as_ref(),
            archive.as_os_str(),
            "-C".as_ref(),
            staging.as_os_str(),
        ],
    )?;
    Ok(())
}

/// Moves each unpacked executable into `destination`. `staging` must be on
/// the same volume (it is created inside `destination`), so each move is a
/// rename: no half-written executable is ever visible under its real name.
pub(crate) fn install_files(
    staging: &Path,
    destination: &Path,
    files: &[&str],
) -> Result<(), String> {
    for name in files {
        let from = staging.join(name);
        let metadata = fs::symlink_metadata(&from).map_err(|_| "Coven could not be unpacked.")?;
        if !metadata.is_file() {
            return Err(
                "The Coven download held unexpected files, so it was not installed.".into(),
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&from, fs::Permissions::from_mode(0o755))
                .map_err(|_| "Coven could not be installed.")?;
        }
        let to = destination.join(name);
        if cfg!(windows) && to.exists() {
            fs::remove_file(&to).map_err(|_| "Coven could not replace an older copy.")?;
        }
        fs::rename(&from, &to).map_err(|_| "Coven could not be installed.")?;
    }
    Ok(())
}

/// Downloads, verifies and installs Coven, reporting each stage through
/// `on_event` as `{ type: "progress", stage, received?, total? }`.
pub(crate) async fn install(
    cancel: &AtomicBool,
    on_event: &mut (dyn FnMut(Value) -> Result<(), String> + Send),
) -> Result<Value, String> {
    let windows = cfg!(windows);
    let release = release_for(std::env::consts::OS, std::env::consts::ARCH)
        .ok_or("Coven Chat cannot install Coven on this computer yet.")?;
    let home = crate::coven_runtime::home()?;
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute());
    let destination = install_dir(windows, &home, local_app_data.as_deref())?;
    fs::create_dir_all(&destination).map_err(|_| "Coven's install folder could not be created.")?;
    let staging = destination.join(format!(".coven-install-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&staging).map_err(|_| "Coven's install folder could not be created.")?;
    let result = async {
        let client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(DOWNLOAD_TIMEOUT)
            .build()
            .map_err(|_| "Coven could not be downloaded.")?;
        let archive = staging.join(release.asset);
        let mut sent: Result<(), String> = Ok(());
        download(
            &client,
            &download_url(&release),
            &release,
            &archive,
            cancel,
            &mut |received, total| {
                if sent.is_ok() {
                    sent = on_event(json!({
                        "type": "progress",
                        "stage": "download",
                        "received": received,
                        "total": total,
                    }));
                }
            },
        )
        .await?;
        sent?;
        on_event(json!({ "type": "progress", "stage": "install" }))?;
        let unpacked = staging.join("unpacked");
        fs::create_dir(&unpacked).map_err(|_| "Coven could not be unpacked.")?;
        unpack(windows, &archive, &unpacked, &release)?;
        install_files(&unpacked, &destination, release.files)?;
        Ok::<(), String>(())
    }
    .await;
    let _ = fs::remove_dir_all(&staging);
    result?;
    let installed = crate::coven_runtime::resolve_cli()
        .map_err(|_| "Coven was installed but Chat cannot find it. Choose Check again.")?;
    Ok(json!({ "version": COVEN_VERSION, "installed": installed.is_file() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("opencoven-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn every_supported_platform_pins_a_release() {
        for (os, arch, extension) in [
            ("macos", "aarch64", ".tar.gz"),
            ("macos", "x86_64", ".tar.gz"),
            ("linux", "x86_64", ".tar.gz"),
            ("windows", "x86_64", ".zip"),
        ] {
            let release = release_for(os, arch).unwrap();
            assert!(release
                .asset
                .starts_with(&format!("coven-v{COVEN_VERSION}-")));
            assert!(release.asset.ends_with(extension));
            assert_eq!(release.sha256.len(), 64);
            assert!(release.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()));
            assert!(release.size > 0 && release.size <= MAX_ARCHIVE_BYTES);
            assert!(!release.files.is_empty());
            assert!(download_url(&release)
                .starts_with("https://github.com/OpenCoven/coven/releases/download/v"));
        }
        assert_eq!(release_for("linux", "aarch64"), None);
        assert_eq!(release_for("freebsd", "x86_64"), None);
    }

    #[test]
    fn installs_into_a_folder_chat_already_searches() {
        let home = Path::new("/home/val");
        assert_eq!(
            install_dir(false, home, None).unwrap(),
            home.join(".local").join("bin")
        );
        let local = Path::new("/c/Users/val/AppData/Local");
        assert_eq!(
            install_dir(true, home, Some(local)).unwrap(),
            local.join("Programs").join("OpenCoven").join("Coven")
        );
        assert!(install_dir(true, home, None).is_err());
    }

    #[test]
    fn archive_must_hold_exactly_the_release_executables() {
        assert!(check_entries("coven\ncoven-afs-serve\n", &["coven", "coven-afs-serve"]).is_ok());
        assert!(check_entries("coven-afs-serve\ncoven", &["coven", "coven-afs-serve"]).is_ok());
        for listing in [
            "coven\n",
            "coven\nextra\n",
            "../coven\n",
            "bin/coven\n",
            "/coven\n",
            "",
        ] {
            assert!(
                check_entries(listing, &["coven"]).is_ok() == (listing == "coven\n"),
                "{listing:?}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn unpacks_and_installs_only_the_listed_executables() {
        let root = temp("coven-unpack");
        let source = root.join("source");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("coven"), "#!/bin/sh\necho coven 0.4.9\n").unwrap();
        let archive = root.join("coven.tar.gz");
        let status = Command::new(tar_program(false).unwrap())
            .args([
                "-czf".as_ref(),
                archive.as_os_str(),
                "-C".as_ref(),
                source.as_os_str(),
                "coven".as_ref(),
            ])
            .status()
            .unwrap();
        assert!(status.success());
        let release = Release {
            asset: "coven.tar.gz",
            sha256: "",
            size: 0,
            files: &["coven"],
        };
        let staging = root.join("staging");
        fs::create_dir_all(&staging).unwrap();
        unpack(false, &archive, &staging, &release).unwrap();
        let destination = root.join("bin");
        fs::create_dir_all(&destination).unwrap();
        install_files(&staging, &destination, release.files).unwrap();
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(destination.join("coven"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o755);
        assert!(!staging.join("coven").exists());
        // An archive with anything else in it is refused before unpacking.
        fs::write(source.join("surprise"), "x").unwrap();
        let mixed = root.join("mixed.tar.gz");
        Command::new(tar_program(false).unwrap())
            .args([
                "-czf".as_ref(),
                mixed.as_os_str(),
                "-C".as_ref(),
                source.as_os_str(),
                "coven".as_ref(),
                "surprise".as_ref(),
            ])
            .status()
            .unwrap();
        let other = root.join("other");
        fs::create_dir_all(&other).unwrap();
        assert!(unpack(false, &mixed, &other, &release).is_err());
        assert!(!other.join("surprise").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    /// Serves `body` once over plain HTTP on a loopback port.
    async fn serve_once(body: Vec<u8>, length: Option<usize>) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).await;
            let header = match length {
                Some(length) => format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n"
                ),
                None => "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_owned(),
            };
            let _ = socket.write_all(header.as_bytes()).await;
            let _ = socket.write_all(&body).await;
            let _ = socket.shutdown().await;
        });
        format!("http://{address}/coven.tar.gz")
    }

    #[tokio::test]
    async fn download_accepts_only_the_pinned_bytes() {
        let body = b"pinned coven archive".to_vec();
        let digest = hex(&Sha256::digest(&body));
        let digest: &'static str = Box::leak(digest.into_boxed_str());
        let release = Release {
            asset: "coven.tar.gz",
            sha256: digest,
            size: body.len() as u64,
            files: &["coven"],
        };
        let client = reqwest::Client::new();
        let root = temp("coven-download");
        let cancel = AtomicBool::new(false);
        let mut seen = Vec::new();

        let url = serve_once(body.clone(), Some(body.len())).await;
        let target = root.join("good");
        download(
            &client,
            &url,
            &release,
            &target,
            &cancel,
            &mut |received, total| seen.push((received, total)),
        )
        .await
        .unwrap();
        assert_eq!(fs::read(&target).unwrap(), body);
        assert_eq!(seen.first(), Some(&(0, body.len() as u64)));
        assert_eq!(seen.last(), Some(&(body.len() as u64, body.len() as u64)));

        // Same length, different bytes: the digest refuses it.
        let url = serve_once(
            b"tampered coven archiv".to_vec()[..body.len()].to_vec(),
            Some(body.len()),
        )
        .await;
        let error = download(
            &client,
            &url,
            &release,
            &root.join("tampered"),
            &cancel,
            &mut |_, _| {},
        )
        .await
        .unwrap_err();
        assert!(error.contains("did not match"), "{error}");

        // A declared length other than the release's is refused before reading.
        let url = serve_once(body.clone(), Some(body.len() + 1)).await;
        let error = download(
            &client,
            &url,
            &release,
            &root.join("long"),
            &cancel,
            &mut |_, _| {},
        )
        .await
        .unwrap_err();
        assert!(error.contains("not the expected file"), "{error}");

        // Without a declared length, extra bytes are still refused as they arrive.
        let mut longer = body.clone();
        longer.extend_from_slice(b" and more");
        let url = serve_once(longer, None).await;
        let error = download(
            &client,
            &url,
            &release,
            &root.join("stream"),
            &cancel,
            &mut |_, _| {},
        )
        .await
        .unwrap_err();
        assert!(error.contains("larger than expected"), "{error}");

        // A cancelled run stops before writing anything more.
        cancel.store(true, Ordering::SeqCst);
        let url = serve_once(body.clone(), Some(body.len())).await;
        let error = download(
            &client,
            &url,
            &release,
            &root.join("cancelled"),
            &cancel,
            &mut |_, _| {},
        )
        .await
        .unwrap_err();
        assert_eq!(error, crate::coven_runtime::RUN_CANCELLED);
        fs::remove_dir_all(&root).unwrap();
    }

    /// Downloads, verifies and installs the real pinned release. Network and
    /// a scratch home are required:
    /// `HOME=$(mktemp -d) cargo test --lib live_install -- --ignored`.
    #[tokio::test]
    #[ignore = "downloads the pinned Coven release; run with HOME set to a scratch folder"]
    async fn live_install_into_a_scratch_home() {
        let home = crate::coven_runtime::home().unwrap();
        let real = std::env::var_os("USER")
            .map(|user| Path::new("/Users").join(user))
            .unwrap_or_default();
        assert_ne!(home, real, "point HOME at a scratch folder first");
        let cancel = AtomicBool::new(false);
        let mut stages = Vec::new();
        install(&cancel, &mut |event| {
            stages.push(event["stage"].as_str().unwrap_or_default().to_owned());
            Ok(())
        })
        .await
        .unwrap();
        assert!(stages.contains(&"download".to_owned()));
        assert!(stages.contains(&"install".to_owned()));
        let release = release_for(std::env::consts::OS, std::env::consts::ARCH).unwrap();
        let destination = install_dir(cfg!(windows), &home, None).unwrap();
        for name in release.files {
            assert!(destination.join(name).is_file(), "{name}");
        }
        let output = Command::new(destination.join(release.files[0]))
            .arg("--version")
            .env("COVEN_HOME", home.join(".coven-scratch"))
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains(COVEN_VERSION));
        assert!(fs::read_dir(&destination).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".coven-install-")));
    }
}
