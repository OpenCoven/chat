//! Hands one reviewed web address to the system's default handler (#505).
//!
//! The link review in the window shows the reader where a Markdown link goes,
//! and its Open button sends that address here. The host checks the address
//! again instead of trusting the review, then passes it to one fixed program
//! as one argument, never through a shell. Nothing else in Chat opens an
//! address: the webview's own `target="_blank"` requests are still dropped.

use std::process::Stdio;
use std::time::{Duration, Instant};

/// The review's `REVIEW_ADDRESS_LIMIT`: the longest address, in bytes, Chat opens.
const ADDRESS_LIMIT: usize = 8192;
/// How long a launcher may take to take the address before Chat stops waiting.
const LAUNCH_WAIT: Duration = Duration::from_secs(10);

/// Checks an address the way the review hands it on: an absolute http(s)
/// `URL.href`, which is printable ASCII without spaces, names a site, and here
/// may carry no sign-in name.
pub(crate) fn check_address(address: &str) -> Result<(), String> {
    let refuse = |why: &str| {
        Err(format!(
            "Chat won't open this address: {why}. Use Copy address instead."
        ))
    };
    if address.len() > ADDRESS_LIMIT {
        return refuse("it's longer than 8,192 bytes");
    }
    let Some(rest) = address
        .strip_prefix("https://")
        .or_else(|| address.strip_prefix("http://"))
    else {
        return refuse("it isn't a web address");
    };
    // `URL.href` percent-encodes everything else, so none of these reach here
    // from the review.
    if !address
        .bytes()
        .all(|byte| (0x21..=0x7e).contains(&byte) && !b"\"\\<>".contains(&byte))
    {
        return refuse("it contains spaces or characters a web address can't");
    }
    let site = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if site.is_empty() || site.starts_with(':') {
        return refuse("it doesn't name a site");
    }
    if site.contains('@') {
        return refuse("it carries a sign-in name");
    }
    Ok(())
}

/// The program and arguments that hand `address` to the default handler on
/// `os` (as `std::env::consts::OS` names it). `system_root` is Windows'
/// `%SystemRoot%`.
fn launcher(
    os: &str,
    address: &str,
    system_root: Option<&str>,
) -> Result<(String, Vec<String>), String> {
    match os {
        // `-u` opens the argument as a URL even if it also names a file.
        "macos" => Ok(("/usr/bin/open".into(), vec!["-u".into(), address.into()])),
        // The documented URL handler, run from System32 by full path; it
        // needs no new crate or Windows API feature.
        "windows" => {
            let root = system_root
                .filter(|root| {
                    let bytes = root.as_bytes();
                    bytes.len() > 3 && bytes[0].is_ascii_alphabetic() && &bytes[1..3] == br":\"
                })
                .unwrap_or(r"C:\Windows");
            Ok((
                format!(r"{root}\System32\rundll32.exe"),
                vec!["url.dll,FileProtocolHandler".into(), address.into()],
            ))
        }
        "linux" | "freebsd" | "dragonfly" | "netbsd" | "openbsd" => {
            Ok(("xdg-open".into(), vec![address.into()]))
        }
        _ => Err("Chat can't open web addresses on this system. Use Copy address instead.".into()),
    }
}

/// Runs the launcher and reports whether the system took the address. Exit 0
/// means it did, not that a page rendered.
fn hand_off(program: &str, args: &[String]) -> Result<(), String> {
    let mut child = crate::coven_runtime::child_env::command(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => format!(
                "Chat couldn't find {program} to open web addresses. Use Copy address instead."
            ),
            _ => "Chat couldn't start the program that opens web addresses. Use Copy address instead."
                .into(),
        })?;
    let deadline = Instant::now() + LAUNCH_WAIT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => {
                return Err("Your system didn't take the address. Use Copy address instead.".into())
            }
            // Some launchers stay running as the browser itself. Leave it be,
            // and reap it when it ends.
            Ok(None) if Instant::now() >= deadline => {
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                return Ok(());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => {
                return Err(
                    "Chat couldn't tell whether your system took the address. Use Copy address instead."
                        .into(),
                )
            }
        }
    }
}

#[tauri::command]
pub(crate) async fn open_reviewed_link(address: String) -> Result<(), String> {
    check_address(&address)?;
    let system_root = std::env::var("SystemRoot").ok();
    let (program, args) = launcher(std::env::consts::OS, &address, system_root.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || hand_off(&program, &args))
        .await
        .map_err(|_| "Chat couldn't hand the address on. Use Copy address instead.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reviewed_web_addresses_are_accepted() {
        let longest = format!("https://example.com/{}", "a".repeat(ADDRESS_LIMIT - 20));
        assert_eq!(longest.len(), ADDRESS_LIMIT);
        for address in [
            "https://example.com/",
            "http://example.com:8080/a/b?c=d&e=f#g",
            "https://[::1]:3000/",
            "https://xn--bcher-kva.example/path",
            "https://medium.com/@someone/post",
            "https://example.com/a|b^c[d]",
            longest.as_str(),
        ] {
            assert_eq!(check_address(address), Ok(()), "{address}");
        }
    }

    #[test]
    fn anything_else_is_refused_and_names_copy_address() {
        let over = format!("https://example.com/{}", "a".repeat(ADDRESS_LIMIT));
        for (address, why) in [
            ("", "isn't a web address"),
            ("ftp://example.com/", "isn't a web address"),
            ("javascript:alert(1)", "isn't a web address"),
            ("HTTPS://EXAMPLE.COM/", "isn't a web address"),
            ("file:///etc/passwd", "isn't a web address"),
            ("https://", "doesn't name a site"),
            ("https:///path", "doesn't name a site"),
            ("https://:443/", "doesn't name a site"),
            ("https://user@example.com/", "sign-in name"),
            ("https://user:secret@example.com/", "sign-in name"),
            ("https://exa mple.com/", "can't"),
            ("https://example.com/\n", "can't"),
            ("https://example.com/é", "can't"),
            ("https://example.com/a\\b", "can't"),
            ("https://example.com/\"", "can't"),
            (over.as_str(), "8,192 bytes"),
        ] {
            let error = check_address(address).expect_err(address);
            assert!(error.contains(why), "{address:?}: {error}");
            assert!(
                error.ends_with("Use Copy address instead."),
                "{address:?}: {error}"
            );
        }
    }

    #[test]
    fn each_platform_has_one_fixed_launcher_and_the_address_as_one_argument() {
        let address = "https://example.com/a?b=c";
        assert_eq!(
            launcher("macos", address, None),
            Ok(("/usr/bin/open".into(), vec!["-u".into(), address.into()]))
        );
        assert_eq!(
            launcher("linux", address, None),
            Ok(("xdg-open".into(), vec![address.into()]))
        );
        let rundll = |root| launcher("windows", address, root).unwrap();
        let expected_args = vec![
            "url.dll,FileProtocolHandler".to_string(),
            address.to_string(),
        ];
        assert_eq!(
            rundll(Some(r"D:\Win")),
            (
                r"D:\Win\System32\rundll32.exe".into(),
                expected_args.clone()
            )
        );
        // A missing or odd %SystemRoot% never moves the launcher off the system drive's Windows.
        for root in [
            None,
            Some(""),
            Some("relative"),
            Some(r"\\server\share"),
            Some("C:"),
        ] {
            assert_eq!(
                rundll(root),
                (
                    r"C:\Windows\System32\rundll32.exe".into(),
                    expected_args.clone()
                ),
                "{root:?}"
            );
        }
        let error = launcher("haiku", address, None).unwrap_err();
        assert!(error.contains("Use Copy address instead."), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn a_launcher_reports_only_whether_the_system_took_the_address() {
        assert_eq!(hand_off("/usr/bin/true", &[]), Ok(()));
        let refused = hand_off("/usr/bin/false", &[]).unwrap_err();
        assert!(refused.contains("didn't take the address"), "{refused}");
        let missing = hand_off("/nonexistent/chat-opener", &[]).unwrap_err();
        assert!(missing.contains("couldn't find"), "{missing}");
        assert!(missing.ends_with("Use Copy address instead."), "{missing}");
    }
}
