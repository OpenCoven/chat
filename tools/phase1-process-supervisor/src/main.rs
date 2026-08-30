#[cfg(windows)]
mod windows {
    use std::{
        env, io,
        mem::size_of,
        os::windows::{io::AsRawHandle, process::CommandExt},
        path::PathBuf,
        process::{Child, Command},
        ptr,
    };

    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD,
                THREADENTRY32,
            },
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Threading::{OpenThread, ResumeThread, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME},
        },
    };

    struct Job(isize);

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0 as HANDLE) };
        }
    }

    fn create_job() -> io::Result<Job> {
        let job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if job.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&raw const information).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            let error = io::Error::last_os_error();
            unsafe { CloseHandle(job) };
            return Err(error);
        }
        Ok(Job(job as isize))
    }

    fn resume(child: &Child) -> io::Result<()> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let mut entry = THREADENTRY32 {
            dwSize: size_of::<THREADENTRY32>() as u32,
            ..THREADENTRY32::default()
        };
        let mut found = false;
        let mut status = unsafe { Thread32First(snapshot, &mut entry) };
        while status != 0 {
            if entry.th32OwnerProcessID == child.id() {
                found = true;
                let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                if thread.is_null() || unsafe { ResumeThread(thread) } == u32::MAX {
                    let error = io::Error::last_os_error();
                    if !thread.is_null() {
                        unsafe { CloseHandle(thread) };
                    }
                    unsafe { CloseHandle(snapshot) };
                    return Err(error);
                }
                unsafe { CloseHandle(thread) };
            }
            status = unsafe { Thread32Next(snapshot, &mut entry) };
        }
        unsafe { CloseHandle(snapshot) };
        found
            .then_some(())
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no suspended child thread"))
    }

    pub fn run() -> io::Result<i32> {
        let mut args = env::args_os().skip(1);
        if args.next().as_deref() != Some(std::ffi::OsStr::new("--")) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "missing separator",
            ));
        }
        let executable =
            PathBuf::from(args.next().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "missing executable")
            })?);
        if !executable.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "non-absolute executable",
            ));
        }
        let metadata = std::fs::symlink_metadata(&executable)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "unsafe executable",
            ));
        }
        let job = create_job()?;
        let mut command = Command::new(executable);
        command.args(args).creation_flags(CREATE_SUSPENDED);
        let mut child = command.spawn()?;
        if unsafe { AssignProcessToJobObject(job.0 as HANDLE, child.as_raw_handle()) } == 0 {
            let error = io::Error::last_os_error();
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        if let Err(error) = resume(&child) {
            drop(job);
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        let status = child.wait()?;
        drop(job);
        Ok(status.code().unwrap_or(1))
    }
}

fn main() {
    #[cfg(windows)]
    match windows::run() {
        Ok(code) => std::process::exit(code),
        Err(_) => std::process::exit(1),
    }

    #[cfg(not(windows))]
    std::process::exit(1);
}
