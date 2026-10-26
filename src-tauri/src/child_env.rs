//! The environment of the programs Chat starts.
//!
//! An AppImage starts Chat with variables that point library, plugin and data
//! search paths into the mounted image. Its runtime names the image (`APPDIR`,
//! `APPIMAGE`, `ARGV0`, `OWD`), AppRun puts the image's directories first in
//! `PATH`, `LD_LIBRARY_PATH` and similar lists, and the GTK hook sets `GTK_*`
//! and `GDK_*`. Chat's own window needs them. The programs Chat starts (Coven,
//! the engine and the `curl` it runs, `tar`, the browser) are the user's, and
//! the image's older libraries break them (#525). [`command`] starts a program
//! with those additions taken out again; outside an AppImage it is
//! `Command::new`.

use std::{
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    process::Command,
    sync::OnceLock,
};

/// Set by the AppImage runtime to describe the image.
const RUNTIME_VARIABLES: [&str; 4] = ["APPDIR", "APPIMAGE", "ARGV0", "OWD"];

/// Set by AppRun and the GTK hook without naming a path. The hook overwrites
/// whatever the user had, so a program gets the desktop's default instead.
const FORCED_VARIABLES: [&str; 3] = ["GDK_BACKEND", "GTK_THEME", "PYTHONDONTWRITEBYTECODE"];

/// One variable to change for a program Chat starts; `None` removes it.
type Change = (OsString, Option<OsString>);

/// A command for `program` that inherits the environment Chat was launched
/// with. Settings a caller adds afterwards, such as `PATH`, still apply.
pub(crate) fn command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    apply(&mut command, changes());
    command
}

/// The value of `key` that a program Chat starts inherits.
pub(crate) fn var_os(key: &str) -> Option<OsString> {
    match changes().iter().find(|(name, _)| name == key) {
        Some((_, value)) => value.clone(),
        None => std::env::var_os(key),
    }
}

fn apply(command: &mut Command, changes: &[Change]) {
    for (key, value) in changes {
        match value {
            Some(value) => command.env(key, value),
            None => command.env_remove(key),
        };
    }
}

fn changes() -> &'static [Change] {
    static CHANGES: OnceLock<Vec<Change>> = OnceLock::new();
    CHANGES.get_or_init(|| {
        if !cfg!(target_os = "linux") {
            return Vec::new();
        }
        let executable = std::env::current_exe().ok();
        match image_dir(std::env::var_os("APPDIR"), executable.as_deref()) {
            Some(image) => changes_for(&image, std::env::vars_os()),
            None => Vec::new(),
        }
    })
}

/// The image Chat runs from: `APPDIR`, when it holds Chat's own executable.
/// Started from another AppImage's terminal, Chat inherits that image's
/// `APPDIR`, and those variables are not Chat's to undo.
fn image_dir(appdir: Option<OsString>, executable: Option<&Path>) -> Option<PathBuf> {
    let image = PathBuf::from(appdir?);
    let executable = executable?;
    if !image.is_absolute() {
        return None;
    }
    // The executable's path is resolved; APPDIR may reach it through a link.
    let resolved = image.canonicalize().unwrap_or_else(|_| image.clone());
    (executable.starts_with(&image) || executable.starts_with(&resolved)).then_some(image)
}

/// The changes that give a program `vars` as they were before the image's
/// runtime, AppRun and GTK hook added to them.
fn changes_for(image: &Path, vars: impl IntoIterator<Item = (OsString, OsString)>) -> Vec<Change> {
    let mut changes = Vec::new();
    for (key, value) in vars {
        let name = key.to_str().unwrap_or_default();
        if RUNTIME_VARIABLES.contains(&name) || FORCED_VARIABLES.contains(&name) {
            changes.push((key, None));
        } else if let Some(kept) = outside_image(image, name, &value) {
            changes.push((key, kept));
        }
    }
    changes
}

/// `value`'s entries outside the image, or `None` when it names nothing inside
/// it. Empty entries go too: one means the current directory, and AppRun adds
/// one when the variable was unset.
fn outside_image(image: &Path, name: &str, value: &OsStr) -> Option<Option<OsString>> {
    let entries: Vec<PathBuf> = std::env::split_paths(value).collect();
    if !entries.iter().any(|entry| entry.starts_with(image)) {
        return None;
    }
    // The GTK hook puts `$APPDIR/usr/share:/usr/share:` in front of the launch
    // value of XDG_DATA_DIRS; AppRun's own entry ends in a slash.
    let hook_share = image.join("usr/share");
    let from_hook = |entry: &Path| entry == hook_share && !entry.to_string_lossy().ends_with('/');
    let mut kept = Vec::new();
    let mut after_hook = false;
    for entry in entries {
        let added_by_hook =
            after_hook && name == "XDG_DATA_DIRS" && entry == Path::new("/usr/share");
        after_hook = from_hook(&entry);
        if entry.as_os_str().is_empty() || entry.starts_with(image) || added_by_hook {
            continue;
        }
        kept.push(entry);
    }
    Some(if kept.is_empty() {
        None
    } else {
        std::env::join_paths(kept).ok()
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    const IMAGE: &str = "/tmp/appimage_extracted_f5309590";

    fn var(key: &str, value: &str) -> (OsString, OsString) {
        (key.into(), value.replace("$APPDIR", IMAGE).into())
    }

    fn changes(vars: &[(&str, &str)]) -> Vec<(String, Option<String>)> {
        changes_for(Path::new(IMAGE), vars.iter().map(|(k, v)| var(k, v)))
            .into_iter()
            .map(|(key, value)| {
                (
                    key.into_string().unwrap(),
                    value.map(|value| value.into_string().unwrap()),
                )
            })
            .collect()
    }

    /// The environment v0.0.7's AppImage started Chat with on Ubuntu 24.04
    /// (packaged acceptance run 40149595495), launched with none of these set
    /// except PATH.
    const RELEASE_LAUNCH: &[(&str, &str)] = &[
        ("APPDIR", "$APPDIR"),
        ("APPIMAGE", "/home/val/OpenCoven.Chat_0.0.7_amd64.AppImage"),
        ("ARGV0", "/home/val/OpenCoven.Chat_0.0.7_amd64.AppImage"),
        ("GDK_BACKEND", "x11"),
        ("GDK_PIXBUF_MODULE_FILE", "$APPDIR//usr/lib/gdk-pixbuf-2.0/2.10.0/loaders.cache"),
        ("GIO_EXTRA_MODULES", "$APPDIR/usr/lib/x86_64-linux-gnu/gio/modules"),
        ("GI_TYPELIB_PATH", "$APPDIR//usr/lib/girepository-1.0"),
        ("GSETTINGS_SCHEMA_DIR", "$APPDIR/usr/share/glib-2.0/schemas/:$APPDIR//usr/share/glib-2.0/schemas"),
        ("GST_PLUGIN_SYSTEM_PATH", "$APPDIR/usr/lib/gstreamer:"),
        ("GST_PLUGIN_SYSTEM_PATH_1_0", "$APPDIR/usr/lib/gstreamer-1.0:"),
        ("GTK_DATA_PREFIX", "$APPDIR"),
        ("GTK_EXE_PREFIX", "$APPDIR//usr"),
        ("GTK_IM_MODULE_FILE", "$APPDIR//usr/lib/gtk-3.0/3.0.0/immodules.cache"),
        ("GTK_PATH", "$APPDIR//usr/lib/gtk-3.0"),
        ("GTK_THEME", "Adwaita:light"),
        ("HOME", "/home/val"),
        (
            "LD_LIBRARY_PATH",
            "$APPDIR/usr/lib/:$APPDIR/usr/lib/i386-linux-gnu/:$APPDIR/usr/lib/x86_64-linux-gnu/:$APPDIR/usr/lib32/:$APPDIR/usr/lib64/:$APPDIR/lib/:$APPDIR/lib/i386-linux-gnu/:$APPDIR/lib/x86_64-linux-gnu/:$APPDIR/lib32/:$APPDIR/lib64/:",
        ),
        (
            "PATH",
            "$APPDIR/usr/bin/:$APPDIR/usr/sbin/:$APPDIR/usr/games/:$APPDIR/bin/:$APPDIR/sbin/:/usr/local/bin:/usr/bin:/bin",
        ),
        ("PERLLIB", "$APPDIR/usr/share/perl5/:$APPDIR/usr/lib/perl5/:"),
        ("PYTHONDONTWRITEBYTECODE", "1"),
        ("PYTHONHOME", "$APPDIR/usr/"),
        ("PYTHONPATH", "$APPDIR/usr/share/pyshared/:"),
        ("QT_PLUGIN_PATH", "$APPDIR/usr/lib/qt4/plugins/:$APPDIR/usr/lib/qt5/plugins/:"),
        ("XDG_DATA_DIRS", "$APPDIR/usr/share/:$APPDIR/usr/share:/usr/share:"),
    ];

    #[test]
    fn a_release_appimage_launch_is_undone() {
        let changes = changes(RELEASE_LAUNCH);
        let removed: Vec<&str> = changes
            .iter()
            .filter(|(_, value)| value.is_none())
            .map(|(key, _)| key.as_str())
            .collect();
        assert_eq!(
            removed,
            [
                "APPDIR",
                "APPIMAGE",
                "ARGV0",
                "GDK_BACKEND",
                "GDK_PIXBUF_MODULE_FILE",
                "GIO_EXTRA_MODULES",
                "GI_TYPELIB_PATH",
                "GSETTINGS_SCHEMA_DIR",
                "GST_PLUGIN_SYSTEM_PATH",
                "GST_PLUGIN_SYSTEM_PATH_1_0",
                "GTK_DATA_PREFIX",
                "GTK_EXE_PREFIX",
                "GTK_IM_MODULE_FILE",
                "GTK_PATH",
                "GTK_THEME",
                "LD_LIBRARY_PATH",
                "PERLLIB",
                "PYTHONDONTWRITEBYTECODE",
                "PYTHONHOME",
                "PYTHONPATH",
                "QT_PLUGIN_PATH",
                "XDG_DATA_DIRS",
            ]
        );
        let kept: Vec<_> = changes
            .iter()
            .filter(|(_, value)| value.is_some())
            .collect();
        assert_eq!(
            kept,
            [&(
                "PATH".to_owned(),
                Some("/usr/local/bin:/usr/bin:/bin".to_owned())
            )]
        );
    }

    #[test]
    fn launch_values_behind_the_image_entries_are_kept() {
        let changes = changes(&[
            ("LD_LIBRARY_PATH", "$APPDIR/usr/lib/:$APPDIR/lib64/:/opt/cuda/lib64"),
            (
                "XDG_DATA_DIRS",
                "$APPDIR/usr/share/:$APPDIR/usr/share:/usr/share:/usr/share/ubuntu:/usr/local/share/:/usr/share/:/var/lib/snapd/desktop",
            ),
            ("GST_PLUGIN_SYSTEM_PATH", "$APPDIR/usr/lib/gstreamer:/opt/gst"),
        ]);
        assert_eq!(
            changes,
            [
                (
                    "LD_LIBRARY_PATH".to_owned(),
                    Some("/opt/cuda/lib64".to_owned())
                ),
                (
                    "XDG_DATA_DIRS".to_owned(),
                    Some(
                        "/usr/share/ubuntu:/usr/local/share/:/usr/share/:/var/lib/snapd/desktop"
                            .to_owned()
                    )
                ),
                (
                    "GST_PLUGIN_SYSTEM_PATH".to_owned(),
                    Some("/opt/gst".to_owned())
                ),
            ]
        );
    }

    #[test]
    fn variables_outside_the_image_are_left_alone() {
        let changes = changes(&[
            ("HOME", "/home/val"),
            ("PATH", "/usr/local/bin:/usr/bin"),
            // Shares the image's name as a prefix but is another directory.
            (
                "LD_LIBRARY_PATH",
                "/tmp/appimage_extracted_f53095901/usr/lib",
            ),
            ("GTK_OVERLAY_SCROLLING", "1"),
        ]);
        assert!(changes.is_empty(), "{changes:?}");
    }

    #[test]
    fn only_the_image_holding_chat_counts() {
        let inside = Path::new("/tmp/.mount_OpenCoX1/usr/bin/opencoven-chat");
        assert_eq!(
            image_dir(Some("/tmp/.mount_OpenCoX1".into()), Some(inside)),
            Some(PathBuf::from("/tmp/.mount_OpenCoX1"))
        );
        let installed = Path::new("/usr/bin/opencoven-chat");
        assert_eq!(
            image_dir(Some("/tmp/.mount_OtherX2".into()), Some(installed)),
            None
        );
        assert_eq!(image_dir(Some("relative/dir".into()), Some(inside)), None);
        assert_eq!(image_dir(None, Some(inside)), None);
        assert_eq!(image_dir(Some("/tmp/.mount_OpenCoX1".into()), None), None);
    }

    #[test]
    fn a_command_carries_the_changes_and_later_settings_win() {
        let mut command = Command::new("/bin/true");
        apply(
            &mut command,
            &[
                ("LD_LIBRARY_PATH".into(), None),
                ("PATH".into(), Some("/usr/bin".into())),
            ],
        );
        command.env("PATH", "/home/val/.local/bin:/usr/bin");
        let envs: Vec<_> = command
            .get_envs()
            .map(|(key, value)| (key.to_owned(), value.map(OsStr::to_owned)))
            .collect();
        assert_eq!(
            envs,
            [
                ("LD_LIBRARY_PATH".into(), None),
                ("PATH".into(), Some("/home/val/.local/bin:/usr/bin".into())),
            ]
        );
    }
}
