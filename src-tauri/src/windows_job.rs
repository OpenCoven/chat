//! Process-tree containment on Windows.
//!
//! Unix puts the Coven CLI in its own process group, so stopping a run can
//! signal everything the CLI started. Windows has no process groups in that
//! sense; a kill-on-close Job Object is the equivalent. The CLI is started
//! suspended, assigned to the job, then resumed, so nothing it spawns can
//! escape the job in the gap between creation and assignment. Closing the
//! last handle to the job terminates every process still in it.

use std::{io, process::Child};

/// A Job Object whose processes are terminated when this handle drops.
pub(crate) struct KillOnCloseJob(isize);

impl Drop for KillOnCloseJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(
                self.0 as windows_sys::Win32::Foundation::HANDLE,
            );
        }
    }
}

/// Creates a kill-on-close job and places `child` in it. The child should
/// still be suspended, so that its descendants cannot predate the assignment.
pub(crate) fn contain(child: &Child) -> io::Result<KillOnCloseJob> {
    use std::{mem::size_of, os::windows::io::AsRawHandle, ptr};

    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
    };

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
        unsafe {
            CloseHandle(job);
        }
        return Err(error);
    }
    if unsafe { AssignProcessToJobObject(job, child.as_raw_handle()) } == 0 {
        let error = io::Error::last_os_error();
        unsafe {
            CloseHandle(job);
        }
        return Err(error);
    }
    Ok(KillOnCloseJob(job as isize))
}

/// Resumes every thread of a child created with `CREATE_SUSPENDED`.
pub(crate) fn resume(child: &Child) -> io::Result<()> {
    use std::mem::size_of;

    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD,
                THREADENTRY32,
            },
            Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
        },
    };

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
            if thread.is_null() {
                let error = io::Error::last_os_error();
                unsafe {
                    CloseHandle(snapshot);
                }
                return Err(error);
            }
            if unsafe { ResumeThread(thread) } == u32::MAX {
                let error = io::Error::last_os_error();
                unsafe {
                    CloseHandle(thread);
                    CloseHandle(snapshot);
                }
                return Err(error);
            }
            unsafe {
                CloseHandle(thread);
            }
        }
        status = unsafe { Thread32Next(snapshot, &mut entry) };
    }
    unsafe {
        CloseHandle(snapshot);
    }
    if !found {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "the suspended process had no resumable thread",
        ));
    }
    Ok(())
}
