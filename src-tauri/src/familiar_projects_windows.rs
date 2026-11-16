//! Read-only, parent-handle-relative metadata traversal. Never reopen a checked path.
use std::{
    ffi::{c_void, OsStr},
    fs::{File, OpenOptions},
    io,
    mem::{size_of, zeroed},
    os::windows::{
        ffi::OsStrExt,
        fs::OpenOptionsExt,
        io::{AsRawHandle, FromRawHandle},
    },
    path::{Component, Path, PathBuf, Prefix},
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    Storage::FileSystem::{
        FileAttributeTagInfo, GetFileInformationByHandleEx, GetFileType, FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_READ,
        FILE_TRAVERSE, FILE_TYPE_DISK,
    },
};

const SYNCHRONIZE: u32 = 0x0010_0000;
const FILE_OPEN: u32 = 1;
const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x20;
const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const OBJ_CASE_INSENSITIVE: u32 = 0x40;

// ntdll's user-mode ABI. Keep these private rather than widening the governed
// Cargo feature set; the Windows tests pin layout as well as real filesystem use.
#[repr(C)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *mut u16,
}
#[repr(C)]
struct ObjectAttributes {
    length: u32,
    root_directory: HANDLE,
    object_name: *mut UnicodeString,
    attributes: u32,
    security_descriptor: *mut c_void,
    security_quality_of_service: *mut c_void,
}
#[repr(C)]
struct IoStatusBlock {
    status_or_pointer: usize,
    information: usize,
}
#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtCreateFile(
        handle: *mut HANDLE,
        desired_access: u32,
        attributes: *const ObjectAttributes,
        io_status: *mut IoStatusBlock,
        allocation_size: *const i64,
        file_attributes: u32,
        share_access: u32,
        disposition: u32,
        options: u32,
        ea_buffer: *const c_void,
        ea_length: u32,
    ) -> i32;
    fn RtlNtStatusToDosError(status: i32) -> u32;
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn name_units(name: &OsStr) -> io::Result<Vec<u16>> {
    let units: Vec<_> = name.encode_wide().collect();
    if units.is_empty()
        || units.len() > (u16::MAX as usize / 2)
        || units.iter().any(|c| matches!(*c, 0 | 0x2f | 0x5c | 0x3a))
        || name == OsStr::new(".")
        || name == OsStr::new("..")
    {
        return Err(invalid("Invalid metadata path component."));
    }
    Ok(units)
}

fn split_path(path: &Path) -> io::Result<(PathBuf, Vec<&OsStr>)> {
    if !path.is_absolute() {
        return Err(invalid("Metadata path must be absolute."));
    }
    let mut parts = path.components();
    let Some(Component::Prefix(prefix)) = parts.next() else {
        return Err(invalid("Metadata path needs a filesystem root."));
    };
    match prefix.kind() {
        Prefix::Disk(_) | Prefix::VerbatimDisk(_) => {}
        Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => {
            name_units(server)?;
            name_units(share)?;
            if server == OsStr::new("?") {
                return Err(invalid("Device namespaces are not metadata paths."));
            }
        }
        _ => return Err(invalid("Device namespaces are not metadata paths.")),
    }
    if parts.next() != Some(Component::RootDir) {
        return Err(invalid("Metadata path must be rooted."));
    }
    let mut root = PathBuf::from(prefix.as_os_str());
    root.push(r"\");
    let mut names = Vec::new();
    for part in parts {
        let Component::Normal(name) = part else {
            return Err(invalid("Invalid metadata path component."));
        };
        name_units(name)?;
        names.push(name);
    }
    Ok((root, names))
}

fn inspect(file: &File, directory: bool) -> io::Result<()> {
    let handle = file.as_raw_handle();
    // SAFETY: file retains a live owned handle; the output buffer has the exact
    // documented FILE_ATTRIBUTE_TAG_INFO layout and size.
    let mut info: FILE_ATTRIBUTE_TAG_INFO = unsafe { zeroed() };
    if unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileAttributeTagInfo,
            (&mut info as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
            size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if unsafe { GetFileType(handle) } != FILE_TYPE_DISK
        || info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Cave metadata paths must contain ordinary directories and a regular file, without reparse points.",
        ));
    }
    Ok(())
}

fn open_root(root: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .access_mode(FILE_READ_ATTRIBUTES | FILE_TRAVERSE | SYNCHRONIZE)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(root)?;
    inspect(&file, true)?;
    Ok(file)
}

pub(super) fn open_child(parent: &File, name: &OsStr, directory: bool) -> io::Result<File> {
    let mut units = name_units(name)?;
    let bytes = (units.len() * 2) as u16;
    let mut name = UnicodeString {
        length: bytes,
        maximum_length: bytes,
        buffer: units.as_mut_ptr(),
    };
    let attributes = ObjectAttributes {
        length: size_of::<ObjectAttributes>() as u32,
        root_directory: parent.as_raw_handle(),
        object_name: &mut name,
        attributes: OBJ_CASE_INSENSITIVE,
        security_descriptor: null_mut(),
        security_quality_of_service: null_mut(),
    };
    let mut handle = null_mut();
    let mut io_status = IoStatusBlock {
        status_or_pointer: 0,
        information: 0,
    };
    // SAFETY: all pointers remain valid through this synchronous call, parent
    // owns RootDirectory, and the name is exactly one validated component.
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            FILE_READ_ATTRIBUTES
                | SYNCHRONIZE
                | if directory {
                    FILE_TRAVERSE
                } else {
                    FILE_READ_DATA
                },
            &attributes,
            &mut io_status,
            null(),
            0,
            FILE_SHARE_READ,
            FILE_OPEN,
            FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
            null(),
            0,
        )
    };
    if status != 0 {
        if !handle.is_null() {
            // An alternate completion must not leak a handle or count as success.
            unsafe { CloseHandle(handle) };
        }
        return Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(status) } as i32,
        ));
    }
    // SAFETY: successful NtCreateFile transferred one owned handle to us.
    let file = unsafe { File::from_raw_handle(handle) };
    inspect(&file, directory)?;
    Ok(file)
}

pub(super) fn open(path: &Path) -> io::Result<File> {
    let (root, names) = split_path(path)?;
    if names.is_empty() {
        return Err(invalid("Metadata path must name a file."));
    }
    let mut ancestors = vec![open_root(&root)?];
    for (index, name) in names.iter().enumerate() {
        let directory = index + 1 < names.len();
        let child = open_child(ancestors.last().unwrap(), name, directory)?;
        if !directory {
            return Ok(child);
        }
        // Retain every ancestor, denying write/delete sharing until the final
        // handle is acquired. Conflicting writers fail visibly at the open.
        ancestors.push(child);
    }
    unreachable!("nonempty component list returns its final file")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::mem::{align_of, offset_of};

    #[test]
    fn retained_parent_blocks_concurrent_replacement_before_relative_child_open() {
        let root = std::env::temp_dir().join(format!("chat-parent-race-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let parent_path = root.join("parent");
        let moved = root.join("moved");
        std::fs::create_dir(&parent_path).unwrap();
        std::fs::write(parent_path.join("projects.json"), "original").unwrap();
        let parent = open_root(&parent_path).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let gate = barrier.clone();
        let old = parent_path.clone();
        let renamed = moved.clone();
        let attacker = std::thread::spawn(move || {
            gate.wait();
            std::fs::rename(old, renamed)
        });
        barrier.wait();
        assert!(
            attacker.join().unwrap().is_err(),
            "retained parent must deny replacement"
        );
        let mut child = open_child(&parent, OsStr::new("projects.json"), false).unwrap();
        let mut text = String::new();
        std::io::Read::read_to_string(&mut child, &mut text).unwrap();
        assert_eq!(text, "original");
        drop(child);
        drop(parent);
        std::fs::rename(&parent_path, &moved).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn root_and_component_spellings_cannot_escape_the_retained_parent() {
        for path in [
            r"C:relative",
            r"\\.\NUL",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1\projects.json",
            r"C:\projects.json:hidden",
            r"\\?\C:\one\..\projects.json",
        ] {
            assert!(split_path(Path::new(path)).is_err(), "{path}");
        }
        for name in ["", ".", "..", "a/b", r"a\b", "a:hidden", "nul\0byte"] {
            assert!(name_units(OsStr::new(name)).is_err(), "{name:?}");
        }
        for path in [
            r"C:\one\projects.json",
            r"\\?\C:\one\projects.json",
            r"\\server\share\one\projects.json",
            r"\\?\UNC\server\share\one\projects.json",
        ] {
            let (_, parts) = split_path(Path::new(path)).unwrap();
            assert_eq!(parts, vec![OsStr::new("one"), OsStr::new("projects.json")]);
        }
    }

    #[test]
    fn native_abi_layout_matches_windows_pointer_width() {
        assert_eq!(size_of::<IoStatusBlock>(), 2 * size_of::<usize>());
        assert_eq!(align_of::<ObjectAttributes>(), align_of::<usize>());
        if size_of::<usize>() == 8 {
            assert_eq!(size_of::<UnicodeString>(), 16);
            assert_eq!(size_of::<ObjectAttributes>(), 48);
            assert_eq!(offset_of!(ObjectAttributes, root_directory), 8);
            assert_eq!(offset_of!(ObjectAttributes, object_name), 16);
        } else {
            assert_eq!(size_of::<UnicodeString>(), 8);
            assert_eq!(size_of::<ObjectAttributes>(), 24);
            assert_eq!(offset_of!(ObjectAttributes, root_directory), 4);
            assert_eq!(offset_of!(ObjectAttributes, object_name), 8);
        }
    }
}
