using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace OpenCoven
{
    public sealed class WindowsPinnedDirectory : IDisposable
    {
        private IntPtr handle;

        internal WindowsPinnedDirectory(IntPtr value)
        {
            handle = value;
        }

        public void Dispose()
        {
            IntPtr value = handle;
            handle = IntPtr.Zero;
            if (value != IntPtr.Zero)
            {
                WindowsJobSupervisor.ReleasePinnedDirectory(value);
            }
            GC.SuppressFinalize(this);
        }
    }

    public sealed class WindowsJobRunResult
    {
        public int ExitCode { get; internal set; }
        public bool TimedOut { get; internal set; }
        public bool StdoutOverflow { get; internal set; }
        public bool StderrOverflow { get; internal set; }
        public string Stdout { get; internal set; }
        public string Stderr { get; internal set; }
    }

    public sealed class WindowsJobSupervisor : IDisposable
    {
        private const uint CREATE_SUSPENDED = 0x00000004;
        private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        private const uint CREATE_NO_WINDOW = 0x08000000;
        private const uint STARTF_USESTDHANDLES = 0x00000100;
        private const uint HANDLE_FLAG_INHERIT = 0x00000001;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        private const uint JOB_OBJECT_QUERY = 0x0004;
        private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
        private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
        private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
        private const uint WAIT_OBJECT_0 = 0x00000000;
        private const uint WAIT_TIMEOUT = 0x00000102;
        private const uint INFINITE = 0xffffffff;
        private const int JobObjectExtendedLimitInformation = 9;
        private const int SupervisorFailureExitCode = unchecked((int)0xe0434f4d);

        private IntPtr jobHandle;
        private bool disposed;

        private WindowsJobSupervisor(IntPtr handle)
        {
            jobHandle = handle;
        }

        public static WindowsJobSupervisor Create(string name)
        {
            if (String.IsNullOrWhiteSpace(name) ||
                !name.StartsWith(@"Local\OpenCoven.Chat.", StringComparison.Ordinal) ||
                name.Length > 240)
            {
                throw new ArgumentException("Job Object name is outside the reviewed namespace.", "name");
            }

            IntPtr handle = CreateJobObjectW(IntPtr.Zero, name);
            if (handle == IntPtr.Zero)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObjectW failed.");
            }

            try
            {
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits =
                    new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
                IntPtr buffer = Marshal.AllocHGlobal(length);
                try
                {
                    Marshal.StructureToPtr(limits, buffer, false);
                    if (!SetInformationJobObject(
                            handle,
                            JobObjectExtendedLimitInformation,
                            buffer,
                            (uint)length))
                    {
                        throw new Win32Exception(
                            Marshal.GetLastWin32Error(),
                            "SetInformationJobObject failed.");
                    }
                }
                finally
                {
                    Marshal.FreeHGlobal(buffer);
                }
                return new WindowsJobSupervisor(handle);
            }
            catch
            {
                CloseHandle(handle);
                throw;
            }
        }

        public static void RequireCurrentProcessInJob(string name)
        {
            IntPtr expectedJob = OpenJobObjectW(JOB_OBJECT_QUERY, false, name);
            if (expectedJob == IntPtr.Zero)
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "The expected Job Object could not be opened.");
            }

            try
            {
                bool membership;
                if (!IsProcessInJob(GetCurrentProcess(), expectedJob, out membership))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "IsProcessInJob failed.");
                }
                if (!membership)
                {
                    throw new InvalidOperationException(
                        "The process is not a member of the expected Job Object.");
                }
            }
            finally
            {
                CloseHandle(expectedJob);
            }
        }

        public static WindowsPinnedDirectory PinDirectory(string path)
        {
            if (String.IsNullOrWhiteSpace(path) || !Path.IsPathRooted(path))
            {
                throw new ArgumentException("Pinned directory path must be absolute.", "path");
            }
            SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES();
            attributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            IntPtr handle = CreateFileW(
                path,
                0x00000080,
                0x00000001 | 0x00000002,
                ref attributes,
                3,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                IntPtr.Zero);
            if (handle == new IntPtr(-1))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Bootstrap directory could not be pinned.");
            }
            FILE_ATTRIBUTE_TAG_INFO information;
            if (!GetFileInformationByHandleEx(
                    handle,
                    9,
                    out information,
                    (uint)Marshal.SizeOf(typeof(FILE_ATTRIBUTE_TAG_INFO))) ||
                (information.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
                (information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
            {
                CloseHandle(handle);
                throw new InvalidOperationException(
                    "Bootstrap directory is not a stable non-reparse directory.");
            }
            return new WindowsPinnedDirectory(handle);
        }

        public WindowsJobRunResult Run(
            string applicationName,
            string arguments,
            string workingDirectory,
            IDictionary environment,
            TimeSpan TotalTimeout,
            int MaxStdoutBytes,
            int MaxStderrBytes)
        {
            ThrowIfDisposed();
            if (String.IsNullOrWhiteSpace(applicationName) || !Path.IsPathRooted(applicationName))
            {
                throw new ArgumentException("Application path must be absolute.", "applicationName");
            }
            if (applicationName.IndexOf('"') >= 0)
            {
                throw new ArgumentException("Application path contains a quote.", "applicationName");
            }
            if (String.IsNullOrWhiteSpace(workingDirectory) || !Path.IsPathRooted(workingDirectory))
            {
                throw new ArgumentException("Working directory must be absolute.", "workingDirectory");
            }
            if (TotalTimeout <= TimeSpan.Zero || TotalTimeout > TimeSpan.FromHours(1))
            {
                throw new ArgumentOutOfRangeException("TotalTimeout");
            }
            if (MaxStdoutBytes < 1 || MaxStderrBytes < 1)
            {
                throw new ArgumentOutOfRangeException("Output bounds must be positive.");
            }

            SECURITY_ATTRIBUTES inheritable = new SECURITY_ATTRIBUTES();
            inheritable.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            inheritable.bInheritHandle = true;
            IntPtr stdoutRead = IntPtr.Zero;
            IntPtr stdoutWrite = IntPtr.Zero;
            IntPtr stderrRead = IntPtr.Zero;
            IntPtr stderrWrite = IntPtr.Zero;
            IntPtr stdinHandle = IntPtr.Zero;
            PROCESS_INFORMATION process = new PROCESS_INFORMATION();
            IntPtr environmentBlock = IntPtr.Zero;
            Task<PipeCapture> stdoutTask = null;
            Task<PipeCapture> stderrTask = null;
            ManualResetEventSlim overflow = new ManualResetEventSlim(false);

            try
            {
                CreateBoundedPipe(inheritable, out stdoutRead, out stdoutWrite);
                CreateBoundedPipe(inheritable, out stderrRead, out stderrWrite);
                stdinHandle = CreateFileW(
                    "NUL",
                    0x80000000,
                    0x00000001 | 0x00000002,
                    ref inheritable,
                    3,
                    0x00000080,
                    IntPtr.Zero);
                if (stdinHandle == new IntPtr(-1))
                {
                    stdinHandle = IntPtr.Zero;
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Opening NUL failed.");
                }

                STARTUPINFO startup = new STARTUPINFO();
                startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                startup.dwFlags = STARTF_USESTDHANDLES;
                startup.hStdInput = stdinHandle;
                startup.hStdOutput = stdoutWrite;
                startup.hStdError = stderrWrite;
                environmentBlock = BuildEnvironmentBlock(environment);
                StringBuilder commandLine = new StringBuilder();
                commandLine.Append(QuoteArgument(applicationName));
                if (!String.IsNullOrWhiteSpace(arguments))
                {
                    commandLine.Append(' ');
                    commandLine.Append(arguments);
                }

                bool created = CreateProcessW(
                    applicationName,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                    environmentBlock,
                    workingDirectory,
                    ref startup,
                    out process);
                if (!created)
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessW failed.");
                }

                CloseHandle(stdoutWrite);
                stdoutWrite = IntPtr.Zero;
                CloseHandle(stderrWrite);
                stderrWrite = IntPtr.Zero;
                CloseHandle(stdinHandle);
                stdinHandle = IntPtr.Zero;

                if (!AssignProcessToJobObject(jobHandle, process.hProcess))
                {
                    TerminateProcess(process.hProcess, 1);
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "AssignProcessToJobObject failed.");
                }
                bool assigned;
                if (!IsProcessInJob(process.hProcess, jobHandle, out assigned) || !assigned)
                {
                    TerminateJobObject(jobHandle, 1);
                    throw new InvalidOperationException(
                        "Suspended child did not enter the expected Job Object.");
                }

                stdoutTask = ReadPipeAsync(stdoutRead, MaxStdoutBytes, overflow);
                stdoutRead = IntPtr.Zero;
                stderrTask = ReadPipeAsync(stderrRead, MaxStderrBytes, overflow);
                stderrRead = IntPtr.Zero;

                uint resumeResult = ResumeThread(process.hThread);
                if (resumeResult == UInt32.MaxValue)
                {
                    TerminateJobObject(jobHandle, 1);
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread failed.");
                }

                Stopwatch timer = Stopwatch.StartNew();
                bool timedOut = false;
                bool terminated = false;
                while (true)
                {
                    uint wait = WaitForSingleObject(process.hProcess, 50);
                    if (wait == WAIT_OBJECT_0)
                    {
                        break;
                    }
                    if (wait != WAIT_TIMEOUT)
                    {
                        TerminateJobObject(jobHandle, 1);
                        throw new Win32Exception(
                            Marshal.GetLastWin32Error(),
                            "WaitForSingleObject failed.");
                    }
                    if (overflow.IsSet || timer.Elapsed >= TotalTimeout)
                    {
                        timedOut = timer.Elapsed >= TotalTimeout;
                        if (!TerminateJobObject(jobHandle, 1))
                        {
                            throw new Win32Exception(
                                Marshal.GetLastWin32Error(),
                                "TerminateJobObject failed.");
                        }
                        terminated = true;
                        if (WaitForSingleObject(process.hProcess, 30000) != WAIT_OBJECT_0)
                        {
                            throw new TimeoutException(
                                "Terminated supervised root could not be reaped.");
                        }
                        break;
                    }
                }

                uint nativeExitCode;
                if (!GetExitCodeProcess(process.hProcess, out nativeExitCode))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "GetExitCodeProcess failed.");
                }
                int exitCode = unchecked((int)nativeExitCode);
                if (!terminated && exitCode != 0)
                {
                    if (!TerminateJobObject(jobHandle, nativeExitCode))
                    {
                        throw new Win32Exception(
                            Marshal.GetLastWin32Error(),
                            "TerminateJobObject failed after child failure.");
                    }
                }

                if (!Task.WaitAll(new Task[] { stdoutTask, stderrTask }, 30000))
                {
                    TerminateJobObject(jobHandle, 1);
                    throw new TimeoutException("Supervised output readers could not be reaped.");
                }
                PipeCapture stdout = stdoutTask.Result;
                PipeCapture stderr = stderrTask.Result;
                bool outputOverflow = stdout.Overflow || stderr.Overflow;
                return new WindowsJobRunResult
                {
                    ExitCode = timedOut || outputOverflow ? SupervisorFailureExitCode : exitCode,
                    TimedOut = timedOut,
                    StdoutOverflow = stdout.Overflow,
                    StderrOverflow = stderr.Overflow,
                    Stdout = stdout.Text,
                    Stderr = stderr.Text,
                };
            }
            catch
            {
                if (process.hProcess != IntPtr.Zero)
                {
                    TerminateJobObject(jobHandle, 1);
                    WaitForSingleObject(process.hProcess, 30000);
                }
                throw;
            }
            finally
            {
                overflow.Dispose();
                if (environmentBlock != IntPtr.Zero)
                {
                    Marshal.FreeHGlobal(environmentBlock);
                }
                CloseIfValid(process.hThread);
                CloseIfValid(process.hProcess);
                CloseIfValid(stdoutRead);
                CloseIfValid(stdoutWrite);
                CloseIfValid(stderrRead);
                CloseIfValid(stderrWrite);
                CloseIfValid(stdinHandle);
            }
        }

        public void Dispose()
        {
            if (!disposed)
            {
                disposed = true;
                IntPtr handle = jobHandle;
                jobHandle = IntPtr.Zero;
                if (handle != IntPtr.Zero)
                {
                    CloseHandle(handle);
                }
            }
            GC.SuppressFinalize(this);
        }

        private void ThrowIfDisposed()
        {
            if (disposed || jobHandle == IntPtr.Zero)
            {
                throw new ObjectDisposedException("WindowsJobSupervisor");
            }
        }

        private static void CreateBoundedPipe(
            SECURITY_ATTRIBUTES attributes,
            out IntPtr read,
            out IntPtr write)
        {
            if (!CreatePipe(out read, out write, ref attributes, 0))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreatePipe failed.");
            }
            if (!SetHandleInformation(read, HANDLE_FLAG_INHERIT, 0))
            {
                CloseHandle(read);
                CloseHandle(write);
                read = IntPtr.Zero;
                write = IntPtr.Zero;
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "SetHandleInformation failed.");
            }
        }

        private static Task<PipeCapture> ReadPipeAsync(
            IntPtr handle,
            int maximumBytes,
            ManualResetEventSlim overflow)
        {
            SafeFileHandle safeHandle = new SafeFileHandle(handle, true);
            return Task.Run(delegate
            {
                using (safeHandle)
                using (FileStream stream = new FileStream(safeHandle, FileAccess.Read, 4096, false))
                using (MemoryStream captured = new MemoryStream())
                {
                    byte[] buffer = new byte[8192];
                    bool exceeded = false;
                    while (true)
                    {
                        int count = stream.Read(buffer, 0, buffer.Length);
                        if (count == 0)
                        {
                            break;
                        }
                        int remaining = maximumBytes - checked((int)captured.Length);
                        if (remaining > 0)
                        {
                            captured.Write(buffer, 0, Math.Min(remaining, count));
                        }
                        if (count > remaining)
                        {
                            exceeded = true;
                            overflow.Set();
                        }
                    }
                    return new PipeCapture
                    {
                        Overflow = exceeded,
                        Text = new UTF8Encoding(false, true).GetString(captured.ToArray()),
                    };
                }
            });
        }

        private static IntPtr BuildEnvironmentBlock(IDictionary environment)
        {
            SortedDictionary<string, string> values =
                new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (environment != null)
            {
                foreach (DictionaryEntry entry in environment)
                {
                    string key = Convert.ToString(entry.Key);
                    string value = Convert.ToString(entry.Value);
                    if (String.IsNullOrEmpty(key) || key.IndexOf('=') >= 0 ||
                        key.IndexOf('\0') >= 0 || value.IndexOf('\0') >= 0)
                    {
                        throw new ArgumentException("Child environment is malformed.");
                    }
                    values.Add(key, value);
                }
            }

            StringBuilder block = new StringBuilder();
            foreach (KeyValuePair<string, string> entry in values)
            {
                block.Append(entry.Key);
                block.Append('=');
                block.Append(entry.Value);
                block.Append('\0');
            }
            if (values.Count == 0)
            {
                block.Append('\0');
            }
            block.Append('\0');
            byte[] bytes = Encoding.Unicode.GetBytes(block.ToString());
            IntPtr pointer = Marshal.AllocHGlobal(bytes.Length);
            Marshal.Copy(bytes, 0, pointer, bytes.Length);
            return pointer;
        }

        private static string QuoteArgument(string value)
        {
            return "\"" + value + "\"";
        }

        private static void CloseIfValid(IntPtr handle)
        {
            if (handle != IntPtr.Zero && handle != new IntPtr(-1))
            {
                CloseHandle(handle);
            }
        }

        internal static void ReleasePinnedDirectory(IntPtr handle)
        {
            CloseHandle(handle);
        }

        private sealed class PipeCapture
        {
            internal bool Overflow;
            internal string Text;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SECURITY_ATTRIBUTES
        {
            internal int nLength;
            internal IntPtr lpSecurityDescriptor;
            [MarshalAs(UnmanagedType.Bool)]
            internal bool bInheritHandle;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFO
        {
            internal int cb;
            internal string lpReserved;
            internal string lpDesktop;
            internal string lpTitle;
            internal uint dwX;
            internal uint dwY;
            internal uint dwXSize;
            internal uint dwYSize;
            internal uint dwXCountChars;
            internal uint dwYCountChars;
            internal uint dwFillAttribute;
            internal uint dwFlags;
            internal ushort wShowWindow;
            internal ushort cbReserved2;
            internal IntPtr lpReserved2;
            internal IntPtr hStdInput;
            internal IntPtr hStdOutput;
            internal IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            internal IntPtr hProcess;
            internal IntPtr hThread;
            internal uint dwProcessId;
            internal uint dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            internal long PerProcessUserTimeLimit;
            internal long PerJobUserTimeLimit;
            internal uint LimitFlags;
            internal UIntPtr MinimumWorkingSetSize;
            internal UIntPtr MaximumWorkingSetSize;
            internal uint ActiveProcessLimit;
            internal UIntPtr Affinity;
            internal uint PriorityClass;
            internal uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            internal ulong ReadOperationCount;
            internal ulong WriteOperationCount;
            internal ulong OtherOperationCount;
            internal ulong ReadTransferCount;
            internal ulong WriteTransferCount;
            internal ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            internal JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            internal IO_COUNTERS IoInfo;
            internal UIntPtr ProcessMemoryLimit;
            internal UIntPtr JobMemoryLimit;
            internal UIntPtr PeakProcessMemoryUsed;
            internal UIntPtr PeakJobMemoryUsed;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct FILE_ATTRIBUTE_TAG_INFO
        {
            internal uint FileAttributes;
            internal uint ReparseTag;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetInformationJobObject(
            IntPtr job,
            int informationClass,
            IntPtr information,
            uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsProcessInJob(
            IntPtr process,
            IntPtr job,
            [MarshalAs(UnmanagedType.Bool)] out bool result);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr OpenJobObjectW(uint desiredAccess, bool inherit, string name);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateProcessW(
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref STARTUPINFO startupInfo,
            out PROCESS_INFORMATION processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreatePipe(
            out IntPtr readPipe,
            out IntPtr writePipe,
            ref SECURITY_ATTRIBUTES pipeAttributes,
            uint size);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetHandleInformation(
            IntPtr handle,
            uint mask,
            uint flags);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateFileW(
            string name,
            uint desiredAccess,
            uint shareMode,
            ref SECURITY_ATTRIBUTES securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandleEx(
            IntPtr file,
            int informationClass,
            out FILE_ATTRIBUTE_TAG_INFO information,
            uint bufferSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);
    }
}
