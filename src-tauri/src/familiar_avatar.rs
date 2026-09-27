use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    fs::File,
    io::{self, Cursor, Read},
    path::Path,
};

const MAX_FILE_BYTES: u64 = 40 * 1024 * 1024;

pub(crate) fn read_avatar(workspace: &Path, name: &str) -> Result<Option<String>, String> {
    if !workspace.is_absolute()
        || name.is_empty()
        || name.len() > 128
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("Invalid familiar avatar identity.".into());
    }
    let file = match open_avatar(workspace, name) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot open familiar avatar: {error}")),
    };
    let metadata = file
        .metadata()
        .map_err(|error| format!("Cannot inspect familiar avatar: {error}"))?;
    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
        return Err("Familiar avatar must be an image file no larger than 40 MiB.".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Cannot read familiar avatar: {error}"))?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("Familiar avatar exceeds 40 MiB.".into());
    }
    let format = match image::guess_format(&bytes) {
        Ok(format @ (image::ImageFormat::Png | image::ImageFormat::Jpeg)) => format,
        _ => return Err("Familiar avatar is not a supported PNG or JPEG file.".into()),
    };
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|error| format!("Cannot decode familiar avatar: {error}"))?;
    let mut encoded = Cursor::new(Vec::new());
    image
        .thumbnail(128, 128)
        .write_to(&mut encoded, image::ImageFormat::Png)
        .map_err(|error| format!("Cannot encode familiar avatar thumbnail: {error}"))?;
    Ok(Some(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(encoded.into_inner())
    )))
}

#[cfg(unix)]
fn open_avatar(workspace: &Path, name: &str) -> io::Result<File> {
    use std::{
        ffi::{CStr, CString},
        fs::OpenOptions,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::OpenOptionsExt,
        },
    };

    fn child(parent: &File, name: &CStr, flags: i32) -> io::Result<File> {
        // Anchor both lookups to open directories; never follow swapped avatar symlinks.
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | flags,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }
    let root = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC)
        .open(workspace)?;
    let directory = child(&root, c"avatars", libc::O_DIRECTORY)?;
    let filename = CString::new(format!("{name}.png"))
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Invalid avatar name."))?;
    child(&directory, &filename, libc::O_NONBLOCK)
}

#[cfg(not(unix))]
fn open_avatar(_workspace: &Path, _name: &str) -> io::Result<File> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Safe local avatar loading is unavailable on this platform.",
    ))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::{fs, io::Cursor, path::PathBuf};

    struct Workspace(PathBuf);
    impl Workspace {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("chat-avatar-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(path.join("avatars")).unwrap();
            Self(path)
        }
        fn image(&self) {
            image::DynamicImage::new_rgba8(512, 256)
                .save_with_format(self.0.join("avatars/astra.png"), image::ImageFormat::Png)
                .unwrap();
        }
    }
    impl Drop for Workspace {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn reads_verified_avatar_path_and_returns_a_small_png_without_changing_original() {
        let workspace = Workspace::new();
        workspace.image();
        let original = fs::read(workspace.0.join("avatars/astra.png")).unwrap();
        let url = read_avatar(&workspace.0, "astra").unwrap().unwrap();
        let bytes = STANDARD
            .decode(url.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap();
        let thumbnail =
            image::ImageReader::with_format(Cursor::new(bytes), image::ImageFormat::Png)
                .decode()
                .unwrap();
        assert_eq!((thumbnail.width(), thumbnail.height()), (128, 64));
        assert_eq!(
            fs::read(workspace.0.join("avatars/astra.png")).unwrap(),
            original
        );
    }

    #[test]
    fn accepts_jpeg_content_under_the_canonical_png_filename() {
        let workspace = Workspace::new();
        image::DynamicImage::new_rgb8(256, 256)
            .save_with_format(
                workspace.0.join("avatars/astra.png"),
                image::ImageFormat::Jpeg,
            )
            .unwrap();
        let url = read_avatar(&workspace.0, "astra").unwrap().unwrap();
        let bytes = STANDARD
            .decode(url.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap();
        assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
    }

    #[test]
    fn missing_avatar_is_optional_but_invalid_name_or_file_is_an_error() {
        let workspace = Workspace::new();
        assert_eq!(read_avatar(&workspace.0, "astra").unwrap(), None);
        assert!(read_avatar(&workspace.0, "../astra").is_err());
        fs::write(workspace.0.join("avatars/astra.png"), b"not a PNG").unwrap();
        assert!(read_avatar(&workspace.0, "astra").is_err());
    }

    #[test]
    fn refuses_symlinked_avatar_files_and_directories() {
        let workspace = Workspace::new();
        workspace.image();
        std::os::unix::fs::symlink(
            workspace.0.join("avatars/astra.png"),
            workspace.0.join("avatars/echo.png"),
        )
        .unwrap();
        assert!(read_avatar(&workspace.0, "echo").is_err());
        fs::rename(workspace.0.join("avatars"), workspace.0.join("pictures")).unwrap();
        std::os::unix::fs::symlink(workspace.0.join("pictures"), workspace.0.join("avatars"))
            .unwrap();
        assert!(read_avatar(&workspace.0, "astra").is_err());
    }

    #[test]
    fn refuses_oversized_input_before_decoding() {
        let workspace = Workspace::new();
        fs::File::create(workspace.0.join("avatars/astra.png"))
            .unwrap()
            .set_len(40 * 1024 * 1024 + 1)
            .unwrap();
        assert!(read_avatar(&workspace.0, "astra").is_err());
    }
}
