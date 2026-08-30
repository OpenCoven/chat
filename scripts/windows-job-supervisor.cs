using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;
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

    public sealed class WindowsIsolatedUser : IDisposable
    {
        private const uint NERR_SUCCESS = 0;
        private const uint NERR_USER_NOT_FOUND = 2221;
        private const uint NERR_USER_EXISTS = 2224;
        private const uint USER_PRIV_USER = 1;
        private const uint UF_SCRIPT = 0x0001;
        private const uint UF_ACCOUNTDISABLE = 0x0002;
        private const uint UF_NORMAL_ACCOUNT = 0x0200;
        private const uint UF_DONT_EXPIRE_PASSWD = 0x10000;
        private const int LOGON32_LOGON_INTERACTIVE = 2;
        private const int LOGON32_PROVIDER_DEFAULT = 0;
        private const int ERROR_INSUFFICIENT_BUFFER = 122;
        private const int MaximumAccountCreationAttempts = 8;

        private string password;
        private bool accountDisabled;
        private Action quarantineIsolatedIdentity;
        private Func<bool> isQuarantineComplete;
        private bool disposed;

        private WindowsIsolatedUser(
            string userName,
            string passwordValue,
            string sid,
            string rootPath,
            string profilePath,
            string tempPath,
            string workspacePath,
            string operatingSystemProfilePath)
        {
            UserName = userName;
            password = passwordValue;
            Sid = sid;
            RootPath = rootPath;
            ProfilePath = profilePath;
            TempPath = tempPath;
            WorkspacePath = workspacePath;
            OperatingSystemProfilePath = operatingSystemProfilePath;
        }

        public string UserName { get; private set; }
        public string Sid { get; private set; }
        public string RootPath { get; private set; }
        public string ProfilePath { get; private set; }
        public string TempPath { get; private set; }
        public string WorkspacePath { get; private set; }
        public string OperatingSystemProfilePath { get; private set; }

        internal string Password
        {
            get
            {
                ThrowIfDisposed();
                RequireEnabledForLogon();
                return password;
            }
        }

        public bool IsDisabled
        {
            get
            {
                ThrowIfDisposed();
                return accountDisabled;
            }
        }

        public static WindowsIsolatedUser Create(string rootPath)
        {
            if (String.IsNullOrWhiteSpace(rootPath) || !Path.IsPathRooted(rootPath))
            {
                throw new ArgumentException(
                    "Isolated bootstrap root must be absolute.",
                    "rootPath");
            }
            string fullRoot = Path.GetFullPath(rootPath);
            if (Directory.Exists(fullRoot) || File.Exists(fullRoot))
            {
                throw new IOException("Isolated bootstrap root already exists.");
            }

            string userName = null;
            string passwordValue = null;
            string sid = null;
            bool accountCreated = false;
            try
            {
                for (int attempt = 0; attempt < MaximumAccountCreationAttempts; attempt++)
                {
                    userName = GenerateUserName();
                    passwordValue = GeneratePassword();
                    USER_INFO_1 information = new USER_INFO_1();
                    information.usri1_name = userName;
                    information.usri1_password = passwordValue;
                    information.usri1_priv = USER_PRIV_USER;
                    information.usri1_flags =
                        UF_SCRIPT | UF_NORMAL_ACCOUNT | UF_DONT_EXPIRE_PASSWD;
                    uint parameterError;
                    uint status = NetUserAdd(
                        null,
                        1,
                        ref information,
                        out parameterError);
                    if (status == NERR_USER_EXISTS)
                    {
                        continue;
                    }
                    if (status != NERR_SUCCESS)
                    {
                        throw new Win32Exception(
                            unchecked((int)status),
                            "Ephemeral local user creation failed.");
                    }
                    accountCreated = true;
                    break;
                }
                if (!accountCreated)
                {
                    throw new InvalidOperationException(
                        "A unique ephemeral local user name could not be allocated.");
                }

                SecurityIdentifier accountSid = (SecurityIdentifier)new NTAccount(
                    Environment.MachineName,
                    userName).Translate(typeof(SecurityIdentifier));
                sid = accountSid.Value;
                ValidateStandardUser(userName, passwordValue, sid);

                string profilePath = Path.Combine(fullRoot, "profile");
                string tempPath = Path.Combine(fullRoot, "temp");
                string workspacePath = Path.Combine(fullRoot, "workspace");
                Directory.CreateDirectory(fullRoot);
                Directory.CreateDirectory(profilePath);
                Directory.CreateDirectory(Path.Combine(profilePath, @"AppData\Roaming"));
                Directory.CreateDirectory(Path.Combine(profilePath, @"AppData\Local"));
                Directory.CreateDirectory(tempPath);
                Directory.CreateDirectory(workspacePath);

                SecurityIdentifier supervisor =
                    WindowsIdentity.GetCurrent().User;
                if (supervisor == null)
                {
                    throw new InvalidOperationException(
                        "Supervisor Windows user SID is unavailable.");
                }
                foreach (string directory in new string[]
                {
                    fullRoot,
                    profilePath,
                    Path.Combine(profilePath, @"AppData\Roaming"),
                    Path.Combine(profilePath, @"AppData\Local"),
                    tempPath,
                    workspacePath,
                })
                {
                    WindowsJobSupervisor.SecureIsolatedDirectory(
                        directory,
                        sid,
                        supervisor.Value);
                }
                WindowsJobSupervisor.ProtectCurrentProcess(
                    sid,
                    supervisor.Value);

                return new WindowsIsolatedUser(
                    userName,
                    passwordValue,
                    sid,
                    fullRoot,
                    profilePath,
                    tempPath,
                    workspacePath,
                    Path.Combine(GetProfilesRoot(), userName));
            }
            catch (Exception original)
            {
                List<Exception> cleanupFailures = new List<Exception>();
                if (Directory.Exists(fullRoot))
                {
                    try
                    {
                        WindowsJobSupervisor.DeleteDirectoryTree(fullRoot);
                    }
                    catch (Exception error)
                    {
                        cleanupFailures.Add(error);
                    }
                }
                if (accountCreated)
                {
                    try
                    {
                        uint status = NetUserDel(null, userName);
                        if (status != NERR_SUCCESS &&
                            status != NERR_USER_NOT_FOUND)
                        {
                            throw new Win32Exception(
                                unchecked((int)status),
                                "Ephemeral local user deletion failed.");
                        }
                        IntPtr information;
                        status = NetUserGetInfo(
                            null,
                            userName,
                            1,
                            out information);
                        if (information != IntPtr.Zero)
                        {
                            NetApiBufferFree(information);
                        }
                        if (status != NERR_USER_NOT_FOUND)
                        {
                            throw new InvalidOperationException(
                                "Ephemeral local user survived cleanup.");
                        }
                    }
                    catch (Exception error)
                    {
                        cleanupFailures.Add(error);
                    }
                }
                if (cleanupFailures.Count != 0)
                {
                    cleanupFailures.Insert(0, original);
                    throw new InvalidOperationException(
                        "Ephemeral local user cleanup failed during creation.",
                        new AggregateException(cleanupFailures.ToArray()));
                }
                throw;
            }
        }

        internal void ThrowIfDisposed()
        {
            if (disposed)
            {
                throw new ObjectDisposedException("WindowsIsolatedUser");
            }
        }

        internal void RequireEnabledForLogon()
        {
            if (accountDisabled || password == null)
            {
                throw new InvalidOperationException(
                    "Ephemeral Windows account is disabled for final artifact handoff.");
            }
        }

        public void DisableAndVerify()
        {
            ThrowIfDisposed();
            IntPtr information = IntPtr.Zero;
            uint status = NetUserGetInfo(null, UserName, 1, out information);
            if (status != NERR_SUCCESS || information == IntPtr.Zero)
            {
                throw new Win32Exception(
                    unchecked((int)status),
                    "Ephemeral local user disablement preflight could not be queried.");
            }

            uint flags;
            try
            {
                USER_INFO_1 current = (USER_INFO_1)Marshal.PtrToStructure(
                    information,
                    typeof(USER_INFO_1));
                flags = current.usri1_flags | UF_ACCOUNTDISABLE;
            }
            finally
            {
                NetApiBufferFree(information);
            }

            USER_INFO_1008 update = new USER_INFO_1008();
            update.usri1008_flags = flags;
            uint parameterError;
            status = NetUserSetInfo(
                null,
                UserName,
                1008,
                ref update,
                out parameterError);
            if (status != NERR_SUCCESS)
            {
                throw new Win32Exception(
                    unchecked((int)status),
                    "Ephemeral local user could not be disabled.");
            }

            information = IntPtr.Zero;
            status = NetUserGetInfo(null, UserName, 1, out information);
            if (status != NERR_SUCCESS || information == IntPtr.Zero)
            {
                throw new Win32Exception(
                    unchecked((int)status),
                    "Ephemeral local user disablement could not be verified.");
            }
            try
            {
                USER_INFO_1 verified = (USER_INFO_1)Marshal.PtrToStructure(
                    information,
                    typeof(USER_INFO_1));
                if ((verified.usri1_flags & UF_ACCOUNTDISABLE) == 0 ||
                    (verified.usri1_flags & UF_NORMAL_ACCOUNT) == 0)
                {
                    throw new InvalidOperationException(
                        "Ephemeral local user disablement verification was ambiguous.");
                }
            }
            finally
            {
                NetApiBufferFree(information);
            }
            accountDisabled = true;
            password = null;
        }

        internal void RequireDisabledAndVerify()
        {
            ThrowIfDisposed();
            if (!accountDisabled || password != null)
            {
                throw new InvalidOperationException(
                    "Ephemeral local user is not disabled for artifact handoff.");
            }
            IntPtr information = IntPtr.Zero;
            uint status = NetUserGetInfo(null, UserName, 1, out information);
            if (status != NERR_SUCCESS || information == IntPtr.Zero)
            {
                throw new Win32Exception(
                    unchecked((int)status),
                    "Ephemeral local user disabled state could not be rechecked.");
            }
            try
            {
                USER_INFO_1 verified = (USER_INFO_1)Marshal.PtrToStructure(
                    information,
                    typeof(USER_INFO_1));
                if ((verified.usri1_flags & UF_ACCOUNTDISABLE) == 0)
                {
                    throw new InvalidOperationException(
                        "Ephemeral local user was re-enabled before artifact handoff.");
                }
            }
            finally
            {
                NetApiBufferFree(information);
            }
        }

        internal void RegisterTerminalQuarantine(
            Action quarantine,
            Func<bool> completion)
        {
            ThrowIfDisposed();
            if (quarantine == null)
            {
                throw new ArgumentNullException("quarantine");
            }
            if (completion == null)
            {
                throw new ArgumentNullException("completion");
            }
            if (quarantineIsolatedIdentity != null &&
                (!Object.Equals(quarantineIsolatedIdentity, quarantine) ||
                    !Object.Equals(isQuarantineComplete, completion)))
            {
                throw new InvalidOperationException(
                    "The isolated Windows identity already has a terminal quarantine owner.");
            }
            quarantineIsolatedIdentity = quarantine;
            isQuarantineComplete = completion;
        }

        private static void ValidateStandardUser(
            string userName,
            string passwordValue,
            string expectedSid)
        {
            IntPtr information = IntPtr.Zero;
            uint status = NetUserGetInfo(null, userName, 1, out information);
            if (status != NERR_SUCCESS || information == IntPtr.Zero)
            {
                throw new Win32Exception(
                    unchecked((int)status),
                    "Ephemeral local user could not be queried.");
            }
            try
            {
                USER_INFO_1 value = (USER_INFO_1)Marshal.PtrToStructure(
                    information,
                    typeof(USER_INFO_1));
                if (value.usri1_priv != USER_PRIV_USER ||
                    (value.usri1_flags & UF_NORMAL_ACCOUNT) == 0 ||
                    (value.usri1_flags & UF_ACCOUNTDISABLE) != 0)
                {
                    throw new InvalidOperationException(
                        "Ephemeral account is not a standard local user.");
                }
            }
            finally
            {
                NetApiBufferFree(information);
            }

            IntPtr token;
            if (!LogonUserW(
                    userName,
                    Environment.MachineName,
                    passwordValue,
                    LOGON32_LOGON_INTERACTIVE,
                    LOGON32_PROVIDER_DEFAULT,
                    out token))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Ephemeral standard-user logon validation failed.");
            }
            try
            {
                using (WindowsIdentity identity = new WindowsIdentity(token))
                {
                    if (identity.User == null || identity.User.Value != expectedSid)
                    {
                        throw new InvalidOperationException(
                            "Ephemeral logon token SID changed.");
                    }
                }
                IntPtr administrators;
                if (!ConvertStringSidToSidW(
                        "S-1-5-32-544",
                        out administrators))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "Administrators SID conversion failed.");
                }
                try
                {
                    bool isAdministrator;
                    if (!CheckTokenMembership(
                            token,
                            administrators,
                            out isAdministrator))
                    {
                        throw new Win32Exception(
                            Marshal.GetLastWin32Error(),
                            "Ephemeral token group validation failed.");
                    }
                    if (isAdministrator)
                    {
                        throw new InvalidOperationException(
                            "Restricted identity unexpectedly belongs to Administrators.");
                    }
                }
                finally
                {
                    LocalFree(administrators);
                }
            }
            finally
            {
                CloseHandle(token);
            }
        }

        private static string GenerateUserName()
        {
            byte[] bytes = new byte[8];
            using (RandomNumberGenerator random = RandomNumberGenerator.Create())
            {
                random.GetBytes(bytes);
            }
            return "ocv" + BitConverter.ToString(bytes)
                .Replace("-", String.Empty)
                .ToLowerInvariant();
        }

        private static string GeneratePassword()
        {
            byte[] bytes = new byte[48];
            using (RandomNumberGenerator random = RandomNumberGenerator.Create())
            {
                random.GetBytes(bytes);
            }
            return Convert.ToBase64String(bytes) + "aA1!";
        }

        private static string GetProfilesRoot()
        {
            uint length = 0;
            GetProfilesDirectoryW(null, ref length);
            if (length == 0 || Marshal.GetLastWin32Error() != ERROR_INSUFFICIENT_BUFFER)
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Windows profile root length could not be queried.");
            }
            StringBuilder value = new StringBuilder(checked((int)length));
            if (!GetProfilesDirectoryW(value, ref length))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Windows profile root could not be queried.");
            }
            return Path.GetFullPath(value.ToString());
        }

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }
            List<Exception> cleanupFailures = new List<Exception>();
            if (quarantineIsolatedIdentity != null)
            {
                bool quarantineComplete = false;
                try
                {
                    quarantineComplete = isQuarantineComplete();
                }
                catch (Exception error)
                {
                    cleanupFailures.Add(error);
                }
                if (!quarantineComplete)
                {
                    try
                    {
                        quarantineIsolatedIdentity();
                    }
                    catch (Exception error)
                    {
                        cleanupFailures.Add(error);
                    }
                }
            }
            disposed = true;
            try
            {
                WindowsJobSupervisor.DeleteOperatingSystemProfile(
                    Sid,
                    OperatingSystemProfilePath);
            }
            catch (Exception error)
            {
                cleanupFailures.Add(error);
            }
            try
            {
                WindowsJobSupervisor.DeleteDirectoryTree(RootPath);
            }
            catch (Exception error)
            {
                cleanupFailures.Add(error);
            }
            try
            {
                uint status = NetUserDel(null, UserName);
                if (status != NERR_SUCCESS && status != NERR_USER_NOT_FOUND)
                {
                    throw new Win32Exception(
                        unchecked((int)status),
                        "Ephemeral local user deletion failed.");
                }
                IntPtr information;
                status = NetUserGetInfo(null, UserName, 1, out information);
                if (information != IntPtr.Zero)
                {
                    NetApiBufferFree(information);
                }
                if (status != NERR_USER_NOT_FOUND)
                {
                    throw new InvalidOperationException(
                        "Ephemeral local user survived cleanup.");
                }
            }
            catch (Exception error)
            {
                cleanupFailures.Add(error);
            }
            password = null;
            if (Directory.Exists(OperatingSystemProfilePath))
            {
                cleanupFailures.Add(new InvalidOperationException(
                    "Ephemeral Windows profile survived cleanup."));
            }
            if (Directory.Exists(RootPath))
            {
                cleanupFailures.Add(new InvalidOperationException(
                    "Ephemeral bootstrap root survived cleanup."));
            }
            GC.SuppressFinalize(this);
            if (cleanupFailures.Count != 0)
            {
                throw new InvalidOperationException(
                    "Ephemeral Windows identity cleanup failed.",
                    new AggregateException(cleanupFailures.ToArray()));
            }
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct USER_INFO_1
        {
            internal string usri1_name;
            internal string usri1_password;
            internal uint usri1_password_age;
            internal uint usri1_priv;
            internal string usri1_home_dir;
            internal string usri1_comment;
            internal uint usri1_flags;
            internal string usri1_script_path;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct USER_INFO_1008
        {
            internal uint usri1008_flags;
        }

        [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
        private static extern uint NetUserAdd(
            string serverName,
            uint level,
            ref USER_INFO_1 buffer,
            out uint parameterError);

        [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
        private static extern uint NetUserGetInfo(
            string serverName,
            string userName,
            uint level,
            out IntPtr buffer);

        [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
        private static extern uint NetUserSetInfo(
            string serverName,
            string userName,
            uint level,
            ref USER_INFO_1008 buffer,
            out uint parameterError);

        [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
        private static extern uint NetUserDel(string serverName, string userName);

        [DllImport("netapi32.dll")]
        private static extern uint NetApiBufferFree(IntPtr buffer);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool LogonUserW(
            string userName,
            string domain,
            string passwordValue,
            int logonType,
            int logonProvider,
            out IntPtr token);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CheckTokenMembership(
            IntPtr token,
            IntPtr sidToCheck,
            [MarshalAs(UnmanagedType.Bool)] out bool isMember);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ConvertStringSidToSidW(
            string stringSid,
            out IntPtr sid);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ConvertSidToStringSidW(
            IntPtr sid,
            out IntPtr stringSid);

        [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetProfilesDirectoryW(
            StringBuilder profilesDirectory,
            ref uint size);

        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr memory);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);
    }

    public sealed class WindowsJobRunResult
    {
        public int ExitCode { get; internal set; }
        public bool TimedOut { get; internal set; }
        public bool StdoutOverflow { get; internal set; }
        public bool StderrOverflow { get; internal set; }
        public bool ResourceQuotaExceeded { get; internal set; }
        public string Stdout { get; internal set; }
        public string Stderr { get; internal set; }
    }

    public sealed class WindowsValidatedArtifact
    {
        private readonly byte[] bytes;

        internal WindowsValidatedArtifact(byte[] value, string sha256)
        {
            bytes = value;
            Sha256 = sha256;
        }

        public byte[] Bytes
        {
            get
            {
                return (byte[])bytes.Clone();
            }
        }

        public int Size
        {
            get
            {
                return bytes.Length;
            }
        }

        public string Sha256 { get; private set; }

        internal byte[] GetTrustedBytes()
        {
            return bytes;
        }
    }

    public sealed class WindowsDirectoryQuota
    {
        public string Label { get; private set; }
        public string PathPattern { get; private set; }
        public long MaxBytes { get; private set; }

        public WindowsDirectoryQuota(string label, string pathPattern, long maxBytes)
        {
            if (String.IsNullOrWhiteSpace(label) || label.Length > 120)
            {
                throw new ArgumentException("Quota label is invalid.", "label");
            }
            if (String.IsNullOrWhiteSpace(pathPattern) || !Path.IsPathRooted(pathPattern))
            {
                throw new ArgumentException("Quota path pattern must be absolute.", "pathPattern");
            }
            string[] segments = pathPattern
                .Substring(Path.GetPathRoot(pathPattern).Length)
                .Split(new char[] { '\\', '/' }, StringSplitOptions.RemoveEmptyEntries);
            foreach (string segment in segments)
            {
                if (segment == "." ||
                    segment == ".." ||
                    segment.IndexOf('?') >= 0 ||
                    (segment.IndexOf('*') >= 0 &&
                        segment != "*" &&
                        (!segment.EndsWith("*", StringComparison.Ordinal) ||
                            segment.IndexOf('*') != segment.Length - 1)))
                {
                    throw new ArgumentException(
                        "Quota path pattern is outside the reviewed grammar.",
                        "pathPattern");
                }
            }
            if (maxBytes < 1)
            {
                throw new ArgumentOutOfRangeException("maxBytes");
            }
            Label = label;
            PathPattern = pathPattern;
            MaxBytes = maxBytes;
        }
    }

    public sealed class WindowsJobSupervisor : IDisposable
    {
        private const uint CREATE_SUSPENDED = 0x00000004;
        private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        private const uint CREATE_NO_WINDOW = 0x08000000;
        private const uint LOGON_WITH_PROFILE = 0x00000001;
        private const uint STARTF_USESTDHANDLES = 0x00000100;
        private const uint HANDLE_FLAG_INHERIT = 0x00000001;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        private const uint JOB_OBJECT_ASSIGN_PROCESS = 0x0001;
        private const uint JOB_OBJECT_SET_ATTRIBUTES = 0x0002;
        private const uint JOB_OBJECT_QUERY = 0x0004;
        private const uint JOB_OBJECT_TERMINATE = 0x0008;
        private const uint PROCESS_TERMINATE = 0x00000001;
        private const uint PROCESS_CREATE_THREAD = 0x00000002;
        private const uint PROCESS_VM_OPERATION = 0x00000008;
        private const uint PROCESS_VM_READ = 0x00000010;
        private const uint PROCESS_VM_WRITE = 0x00000020;
        private const uint PROCESS_DUP_HANDLE = 0x00000040;
        private const uint PROCESS_CREATE_PROCESS = 0x00000080;
        private const uint PROCESS_SET_QUOTA = 0x00000100;
        private const uint PROCESS_SET_INFORMATION = 0x00000200;
        private const uint PROCESS_QUERY_INFORMATION = 0x00000400;
        private const uint PROCESS_SUSPEND_RESUME = 0x00000800;
        private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x00001000;
        private const uint PROCESS_SET_LIMITED_INFORMATION = 0x00002000;
        private const uint DELETE = 0x00010000;
        private const uint READ_CONTROL = 0x00020000;
        private const uint WRITE_DAC = 0x00040000;
        private const uint WRITE_OWNER = 0x00080000;
        private const uint SYNCHRONIZE = 0x00100000;
        private const uint PROCESS_MUTATION_ACCESS =
            PROCESS_TERMINATE |
            PROCESS_CREATE_THREAD |
            PROCESS_VM_OPERATION |
            PROCESS_VM_READ |
            PROCESS_VM_WRITE |
            PROCESS_DUP_HANDLE |
            PROCESS_CREATE_PROCESS |
            PROCESS_SET_QUOTA |
            PROCESS_SET_INFORMATION |
            PROCESS_QUERY_INFORMATION |
            PROCESS_SUSPEND_RESUME |
            PROCESS_SET_LIMITED_INFORMATION |
            DELETE |
            WRITE_DAC |
            WRITE_OWNER;
        private const uint GENERIC_READ = 0x80000000;
        private const uint GENERIC_WRITE = 0x40000000;
        private const uint PROCESS_ALL_ACCESS = 0x001fffff;
        private const uint FILE_ALL_ACCESS = 0x001f01ff;
        private const uint FILE_MODIFY_ACCESS = 0x001301bf;
        private const uint FILE_READ_ATTRIBUTES = 0x00000080;
        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint FILE_SHARE_WRITE = 0x00000002;
        private const uint OWNER_SECURITY_INFORMATION = 0x00000001;
        private const uint DACL_SECURITY_INFORMATION = 0x00000004;
        private const uint PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000;
        private const ushort SE_DACL_PROTECTED = 0x1000;
        private const byte ACCESS_ALLOWED_ACE_TYPE = 0x00;
        private const byte OBJECT_INHERIT_ACE = 0x01;
        private const byte CONTAINER_INHERIT_ACE = 0x02;
        private const byte NO_PROPAGATE_INHERIT_ACE = 0x04;
        private const byte INHERIT_ONLY_ACE = 0x08;
        private const byte INHERITED_ACE = 0x10;
        private const int SE_KERNEL_OBJECT = 6;
        private const int SE_FILE_OBJECT = 1;
        private const int AclSizeInformation = 2;
        private const uint SDDL_REVISION_1 = 1;
        private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
        private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
        private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
        private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
        private const uint CREATE_NEW = 1;
        private const uint OPEN_EXISTING = 3;
        private const uint FILE_TYPE_DISK = 0x0001;
        private const uint WAIT_OBJECT_0 = 0x00000000;
        private const uint WAIT_TIMEOUT = 0x00000102;
        private const uint INFINITE = 0xffffffff;
        private const int ERROR_ACCESS_DENIED = 5;
        private const int ERROR_FILE_NOT_FOUND = 2;
        private const int ERROR_PATH_NOT_FOUND = 3;
        private const int ERROR_NOT_FOUND = 1168;
        private const int JobObjectBasicAccountingInformation = 1;
        private const int JobObjectExtendedLimitInformation = 9;
        private const int SupervisorFailureExitCode = unchecked((int)0xe0434f4d);
        private const int MaximumQuotaEntries = 500000;
        private const int MinimumStableIsolationRounds = 3;
        private const int MaximumIsolationRounds = 120;
        private const int IsolationRoundDelayMilliseconds = 100;
        private const int PostDisableSettlementMilliseconds = 3000;
        private const int MinimumQuarantineObservationMilliseconds = 1000;
        private const int MaximumSchedulerCleanupPasses = 8;
        private const int MaximumBitsCleanupPasses = 8;
        private const int TASK_ENUM_HIDDEN = 1;
        private const uint BG_JOB_ENUM_ALL_USERS = 1;
        private const uint WTS_ANY_SESSION = 0xffffffff;
        private const int WTSTypeProcessInfoLevel1 = 1;
        private const uint TOKEN_QUERY = 0x0008;
        private const int TokenUser = 1;
        private const uint STILL_ACTIVE = 259;

        private IntPtr jobHandle;
        private readonly string supervisedSid;
        private readonly string supervisedUserName;
        private readonly string supervisedQualifiedUserName;
        private readonly string supervisedRootPath;
        private readonly string runIdentity;
        private readonly string runIdentityToken;
        private readonly WindowsIsolatedUser isolatedUser;
        private readonly object quarantineSync = new object();
        private readonly HashSet<string> attributableScheduledTaskFolders =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private WindowsIsolatedUser sealedIsolatedUser;
        private bool terminalProducerAttempted;
        private bool terminalProducerSucceeded;
        private bool quarantineInProgress;
        private bool quarantineCompleted;
        private bool artifactBoundarySealed;
        private bool disposed;

        private WindowsJobSupervisor(
            IntPtr handle,
            WindowsIsolatedUser isolatedUser,
            string identity)
        {
            jobHandle = handle;
            this.isolatedUser = isolatedUser;
            supervisedSid = isolatedUser.Sid;
            supervisedUserName = isolatedUser.UserName;
            supervisedQualifiedUserName =
                Environment.MachineName + "\\" + isolatedUser.UserName;
            supervisedRootPath = isolatedUser.RootPath;
            runIdentity = identity;
            int tokenSeparator = identity.LastIndexOf('.');
            runIdentityToken = tokenSeparator >= 0
                ? identity.Substring(tokenSeparator + 1)
                : identity;
        }

        public long AuthoritativeHandleValue
        {
            get
            {
                ThrowIfDisposed();
                return jobHandle.ToInt64();
            }
        }

        public bool IsQuarantineComplete
        {
            get
            {
                lock (quarantineSync)
                {
                    return quarantineCompleted;
                }
            }
        }

        public static WindowsJobSupervisor Create(
            string name,
            WindowsIsolatedUser isolatedUser)
        {
            if (isolatedUser == null)
            {
                throw new ArgumentNullException("isolatedUser");
            }
            isolatedUser.ThrowIfDisposed();
            if (String.IsNullOrWhiteSpace(name) ||
                !name.StartsWith(@"Local\OpenCoven.Chat.", StringComparison.Ordinal) ||
                name.Length > 240)
            {
                throw new ArgumentException("Job Object name is outside the reviewed namespace.", "name");
            }

            SecurityIdentifier currentUser =
                WindowsIdentity.GetCurrent().User;
            if (currentUser == null)
            {
                throw new InvalidOperationException("Current Windows user SID is unavailable.");
            }
            string currentUserSid = currentUser.Value;
            string sddl = "O:" + currentUserSid +
                "D:P(A;;0x00100004;;;" + isolatedUser.Sid + ")";
            IntPtr securityDescriptor;
            uint securityDescriptorLength;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl,
                    SDDL_REVISION_1,
                    out securityDescriptor,
                    out securityDescriptorLength))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Job Object security descriptor creation failed.");
            }

            try
            {
                SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES();
                attributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
                attributes.lpSecurityDescriptor = securityDescriptor;
                attributes.bInheritHandle = false;
                IntPtr handle = CreateJobObjectW(ref attributes, name);
                if (handle == IntPtr.Zero)
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "CreateJobObjectW failed.");
                }

                try
                {
                    ValidateJobObjectSecurity(
                        handle,
                        currentUserSid,
                        isolatedUser.Sid);
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
                    return new WindowsJobSupervisor(handle, isolatedUser, name);
                }
                catch
                {
                    CloseHandle(handle);
                    throw;
                }
            }
            finally
            {
                LocalFree(securityDescriptor);
            }
        }

        private static void ValidateJobObjectSecurity(
            IntPtr handle,
            string currentUserSid,
            string isolatedSid)
        {
            IntPtr expectedOwner;
            if (!ConvertStringSidToSidW(currentUserSid, out expectedOwner))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Current user SID conversion failed.");
            }
            IntPtr expectedTrustee;
            if (!ConvertStringSidToSidW(isolatedSid, out expectedTrustee))
            {
                LocalFree(expectedOwner);
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Isolated user SID conversion failed.");
            }

            IntPtr owner = IntPtr.Zero;
            IntPtr dacl = IntPtr.Zero;
            IntPtr descriptor = IntPtr.Zero;
            try
            {
                uint status = GetSecurityInfo(
                    handle,
                    SE_KERNEL_OBJECT,
                    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                    out owner,
                    IntPtr.Zero,
                    out dacl,
                    IntPtr.Zero,
                    out descriptor);
                if (status != 0 ||
                    owner == IntPtr.Zero ||
                    dacl == IntPtr.Zero ||
                    descriptor == IntPtr.Zero ||
                    !EqualSid(owner, expectedOwner))
                {
                    throw new InvalidOperationException(
                        "Named Job Object owner or DACL is not the current user.");
                }

                ushort control;
                uint revision;
                if (!GetSecurityDescriptorControl(descriptor, out control, out revision) ||
                    (control & SE_DACL_PROTECTED) == 0)
                {
                    throw new InvalidOperationException(
                        "Named Job Object DACL is not protected.");
                }

                ACL_SIZE_INFORMATION aclInformation;
                if (!GetAclInformation(
                        dacl,
                        out aclInformation,
                        (uint)Marshal.SizeOf(typeof(ACL_SIZE_INFORMATION)),
                        AclSizeInformation) ||
                    aclInformation.AceCount != 1)
                {
                    throw new InvalidOperationException(
                        "Named Job Object DACL must contain exactly one ACE.");
                }

                IntPtr acePointer;
                if (!GetAce(dacl, 0, out acePointer) || acePointer == IntPtr.Zero)
                {
                    throw new InvalidOperationException(
                        "Named Job Object DACL ACE could not be read.");
                }
                ACCESS_ALLOWED_ACE ace =
                    (ACCESS_ALLOWED_ACE)Marshal.PtrToStructure(
                        acePointer,
                        typeof(ACCESS_ALLOWED_ACE));
                IntPtr aceSid = new IntPtr(
                    acePointer.ToInt64() +
                    Marshal.OffsetOf(typeof(ACCESS_ALLOWED_ACE), "SidStart").ToInt64());
                uint reopenedAccess = JOB_OBJECT_QUERY | SYNCHRONIZE;
                uint prohibitedAccess = JOB_OBJECT_SET_ATTRIBUTES |
                    JOB_OBJECT_ASSIGN_PROCESS |
                    JOB_OBJECT_TERMINATE;
                if (ace.Header.AceType != ACCESS_ALLOWED_ACE_TYPE ||
                    ace.Header.AceFlags != 0 ||
                    ace.Mask != reopenedAccess ||
                    (ace.Mask & prohibitedAccess) != 0 ||
                    !EqualSid(aceSid, expectedTrustee))
                {
                    throw new InvalidOperationException(
                        "Named Job Object DACL ACE is not exact query-only current-user access.");
                }
            }
            finally
            {
                if (descriptor != IntPtr.Zero)
                {
                    LocalFree(descriptor);
                }
                LocalFree(expectedTrustee);
                LocalFree(expectedOwner);
            }
        }

        internal static void SecureIsolatedDirectory(
            string path,
            string isolatedSid,
            string supervisorSid)
        {
            EnablePrivilege("SeRestorePrivilege");
            string sddl = "O:" + isolatedSid + "D:P" +
                "(A;OICI;0x001f01ff;;;SY)" +
                "(A;OICI;0x001f01ff;;;BA)" +
                "(A;OICI;0x001f01ff;;;" + supervisorSid + ")" +
                "(A;OICI;0x001301bf;;;" + isolatedSid + ")" +
                "(A;OICI;0x00020000;;;S-1-3-4)";
            IntPtr securityDescriptor;
            uint securityDescriptorLength;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl,
                    SDDL_REVISION_1,
                    out securityDescriptor,
                    out securityDescriptorLength))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Isolated directory security descriptor creation failed.");
            }
            try
            {
                if (!SetFileSecurityW(
                        path,
                        OWNER_SECURITY_INFORMATION |
                            DACL_SECURITY_INFORMATION |
                            PROTECTED_DACL_SECURITY_INFORMATION,
                        securityDescriptor))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "Isolated directory security could not be applied.");
                }
            }
            finally
            {
                LocalFree(securityDescriptor);
            }
            ValidateIsolatedDirectory(path, isolatedSid, supervisorSid);
        }

        public static void ProtectSupervisorDirectory(string path)
        {
            if (String.IsNullOrWhiteSpace(path) ||
                !Path.IsPathRooted(path) ||
                !Directory.Exists(path) ||
                (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            {
                throw new InvalidOperationException(
                    "Supervisor-private directory is missing, relative, or a reparse point.");
            }
            SecurityIdentifier current = WindowsIdentity.GetCurrent().User;
            if (current == null)
            {
                throw new InvalidOperationException(
                    "Supervisor Windows user SID is unavailable.");
            }
            string sddl = "O:" + current.Value + "D:P" +
                "(A;OICI;0x001f01ff;;;SY)" +
                "(A;OICI;0x001f01ff;;;BA)" +
                "(A;OICI;0x001f01ff;;;" + current.Value + ")";
            IntPtr securityDescriptor;
            uint securityDescriptorLength;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl,
                    SDDL_REVISION_1,
                    out securityDescriptor,
                    out securityDescriptorLength))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Supervisor-private directory descriptor creation failed.");
            }
            try
            {
                if (!SetFileSecurityW(
                        path,
                        OWNER_SECURITY_INFORMATION |
                            DACL_SECURITY_INFORMATION |
                            PROTECTED_DACL_SECURITY_INFORMATION,
                        securityDescriptor))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "Supervisor-private directory could not be protected.");
                }
            }
            finally
            {
                LocalFree(securityDescriptor);
            }
        }

        public static void RequireCurrentIdentityOwnsIsolatedDirectory(string path)
        {
            SecurityIdentifier current = WindowsIdentity.GetCurrent().User;
            if (current == null)
            {
                throw new InvalidOperationException(
                    "Restricted Windows identity SID is unavailable.");
            }
            ValidateIsolatedDirectory(path, current.Value, null);
        }

        private static void ValidateIsolatedDirectory(
            string path,
            string isolatedSid,
            string supervisorSid)
        {
            if (String.IsNullOrWhiteSpace(path) ||
                !Path.IsPathRooted(path) ||
                !Directory.Exists(path) ||
                (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            {
                throw new InvalidOperationException(
                    "Restricted directory is missing, relative, or a reparse point.");
            }

            IntPtr expectedOwner = IntPtr.Zero;
            IntPtr expectedSystem = IntPtr.Zero;
            IntPtr expectedAdministrators = IntPtr.Zero;
            IntPtr expectedSupervisor = IntPtr.Zero;
            IntPtr expectedOwnerRights = IntPtr.Zero;
            IntPtr forbiddenEveryone = IntPtr.Zero;
            IntPtr forbiddenAuthenticatedUsers = IntPtr.Zero;
            IntPtr forbiddenUsers = IntPtr.Zero;
            IntPtr owner = IntPtr.Zero;
            IntPtr dacl = IntPtr.Zero;
            IntPtr descriptor = IntPtr.Zero;
            try
            {
                expectedOwner = ConvertSid(isolatedSid, "Restricted owner SID conversion failed.");
                expectedSystem = ConvertSid("S-1-5-18", "SYSTEM SID conversion failed.");
                expectedAdministrators = ConvertSid(
                    "S-1-5-32-544",
                    "Administrators SID conversion failed.");
                if (supervisorSid != null)
                {
                    expectedSupervisor = ConvertSid(
                        supervisorSid,
                        "Supervisor SID conversion failed.");
                }
                expectedOwnerRights = ConvertSid(
                    "S-1-3-4",
                    "Owner Rights SID conversion failed.");
                forbiddenEveryone = ConvertSid(
                    "S-1-1-0",
                    "Everyone SID conversion failed.");
                forbiddenAuthenticatedUsers = ConvertSid(
                    "S-1-5-11",
                    "Authenticated Users SID conversion failed.");
                forbiddenUsers = ConvertSid(
                    "S-1-5-32-545",
                    "Users SID conversion failed.");

                uint status = GetNamedSecurityInfoW(
                    path,
                    SE_FILE_OBJECT,
                    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                    out owner,
                    IntPtr.Zero,
                    out dacl,
                    IntPtr.Zero,
                    out descriptor);
                if (status != 0 ||
                    owner == IntPtr.Zero ||
                    dacl == IntPtr.Zero ||
                    descriptor == IntPtr.Zero ||
                    !EqualSid(owner, expectedOwner))
                {
                    throw new InvalidOperationException(
                        "Restricted directory owner or DACL is not exact.");
                }

                ushort control;
                uint revision;
                if (!GetSecurityDescriptorControl(descriptor, out control, out revision) ||
                    (control & SE_DACL_PROTECTED) == 0)
                {
                    throw new InvalidOperationException(
                        "Restricted directory DACL is not protected.");
                }

                ACL_SIZE_INFORMATION aclInformation;
                if (!GetAclInformation(
                        dacl,
                        out aclInformation,
                        (uint)Marshal.SizeOf(typeof(ACL_SIZE_INFORMATION)),
                        AclSizeInformation) ||
                    aclInformation.AceCount != 5)
                {
                    throw new InvalidOperationException(
                        "Restricted directory DACL must contain exactly five ACEs.");
                }

                bool foundSystem = false;
                bool foundAdministrators = false;
                bool foundSupervisor = false;
                bool foundOwner = false;
                bool foundOwnerRights = false;
                byte directoryFlags = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
                for (uint index = 0; index < aclInformation.AceCount; index++)
                {
                    IntPtr acePointer;
                    if (!GetAce(dacl, index, out acePointer) ||
                        acePointer == IntPtr.Zero)
                    {
                        throw new InvalidOperationException(
                            "Restricted directory DACL ACE could not be read.");
                    }
                    ACCESS_ALLOWED_ACE ace =
                        (ACCESS_ALLOWED_ACE)Marshal.PtrToStructure(
                            acePointer,
                            typeof(ACCESS_ALLOWED_ACE));
                    IntPtr aceSid = new IntPtr(
                        acePointer.ToInt64() +
                        Marshal.OffsetOf(
                            typeof(ACCESS_ALLOWED_ACE),
                            "SidStart").ToInt64());
                    if (ace.Header.AceType != ACCESS_ALLOWED_ACE_TYPE ||
                        ace.Header.AceFlags != directoryFlags)
                    {
                        throw new InvalidOperationException(
                            "Restricted directory DACL contains an unexpected ACE.");
                    }
                    if (EqualSid(aceSid, expectedSystem) &&
                        ace.Mask == FILE_ALL_ACCESS &&
                        !foundSystem)
                    {
                        foundSystem = true;
                    }
                    else if (EqualSid(aceSid, expectedAdministrators) &&
                        ace.Mask == FILE_ALL_ACCESS &&
                        !foundAdministrators)
                    {
                        foundAdministrators = true;
                    }
                    else if (EqualSid(aceSid, expectedOwner) &&
                        ace.Mask == FILE_MODIFY_ACCESS &&
                        !foundOwner)
                    {
                        foundOwner = true;
                    }
                    else if (EqualSid(aceSid, expectedOwnerRights) &&
                        ace.Mask == READ_CONTROL &&
                        !foundOwnerRights)
                    {
                        foundOwnerRights = true;
                    }
                    else if (ace.Mask == FILE_ALL_ACCESS &&
                        !foundSupervisor &&
                        !EqualSid(aceSid, forbiddenEveryone) &&
                        !EqualSid(aceSid, forbiddenAuthenticatedUsers) &&
                        !EqualSid(aceSid, forbiddenUsers) &&
                        (expectedSupervisor == IntPtr.Zero ||
                            EqualSid(aceSid, expectedSupervisor)))
                    {
                        foundSupervisor = true;
                    }
                    else
                    {
                        throw new InvalidOperationException(
                            "Restricted directory DACL trustee or access mask is not exact.");
                    }
                }
                if (!foundSystem ||
                    !foundAdministrators ||
                    !foundSupervisor ||
                    !foundOwner ||
                    !foundOwnerRights)
                {
                    throw new InvalidOperationException(
                        "Restricted directory DACL is incomplete.");
                }
            }
            finally
            {
                if (descriptor != IntPtr.Zero)
                {
                    LocalFree(descriptor);
                }
                FreeLocalSid(forbiddenUsers);
                FreeLocalSid(forbiddenAuthenticatedUsers);
                FreeLocalSid(forbiddenEveryone);
                FreeLocalSid(expectedOwnerRights);
                FreeLocalSid(expectedSupervisor);
                FreeLocalSid(expectedAdministrators);
                FreeLocalSid(expectedSystem);
                FreeLocalSid(expectedOwner);
            }
        }

        internal static void ProtectCurrentProcess(
            string isolatedSid,
            string supervisorSid)
        {
            ProtectProcessSecurity(
                GetCurrentProcess(),
                isolatedSid,
                supervisorSid,
                "Supervisor");
        }

        private static void ProtectRootProcess(
            IntPtr process,
            string isolatedSid)
        {
            SecurityIdentifier supervisor =
                WindowsIdentity.GetCurrent().User;
            if (supervisor == null)
            {
                throw new InvalidOperationException(
                    "Supervisor Windows user SID is unavailable.");
            }
            ProtectProcessSecurity(
                process,
                isolatedSid,
                supervisor.Value,
                "Root");
        }

        private static void ProtectProcessSecurity(
            IntPtr process,
            string isolatedSid,
            string supervisorSid,
            string objectLabel)
        {
            if (process == IntPtr.Zero)
            {
                throw new ArgumentException(
                    objectLabel + " process handle is invalid.",
                    "process");
            }
            EnablePrivilege("SeRestorePrivilege");
            string sddl = "O:" + supervisorSid + "D:P" +
                "(A;;0x001fffff;;;SY)" +
                "(A;;0x001fffff;;;BA)" +
                "(A;;0x001fffff;;;" + supervisorSid + ")" +
                "(A;;0x00101000;;;" + isolatedSid + ")";
            IntPtr securityDescriptor;
            uint securityDescriptorLength;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl,
                    SDDL_REVISION_1,
                    out securityDescriptor,
                    out securityDescriptorLength))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    objectLabel + " process security descriptor creation failed.");
            }
            try
            {
                if (!SetKernelObjectSecurity(
                        process,
                        OWNER_SECURITY_INFORMATION |
                            DACL_SECURITY_INFORMATION |
                            PROTECTED_DACL_SECURITY_INFORMATION,
                        securityDescriptor))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        objectLabel + " process owner or DACL could not be protected.");
                }
            }
            finally
            {
                LocalFree(securityDescriptor);
            }
            ValidateProcessSecurity(
                process,
                isolatedSid,
                supervisorSid,
                objectLabel);
        }

        private static void ValidateProcessSecurity(
            IntPtr process,
            string isolatedSid,
            string supervisorSid,
            string objectLabel)
        {
            IntPtr expectedOwner = ConvertSid(
                supervisorSid,
                "Supervisor owner SID conversion failed.");
            IntPtr expectedSystem = ConvertSid(
                "S-1-5-18",
                "SYSTEM SID conversion failed.");
            IntPtr expectedAdministrators = ConvertSid(
                "S-1-5-32-544",
                "Administrators SID conversion failed.");
            IntPtr expectedRestricted = ConvertSid(
                isolatedSid,
                "Restricted SID conversion failed.");
            IntPtr owner = IntPtr.Zero;
            IntPtr dacl = IntPtr.Zero;
            IntPtr descriptor = IntPtr.Zero;
            try
            {
                uint status = GetSecurityInfo(
                    process,
                    SE_KERNEL_OBJECT,
                    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                    out owner,
                    IntPtr.Zero,
                    out dacl,
                    IntPtr.Zero,
                    out descriptor);
                if (status != 0 ||
                    owner == IntPtr.Zero ||
                    dacl == IntPtr.Zero ||
                    descriptor == IntPtr.Zero ||
                    !EqualSid(owner, expectedOwner))
                {
                    throw new InvalidOperationException(
                        objectLabel + " process owner or DACL is not exact.");
                }
                ushort control;
                uint revision;
                if (!GetSecurityDescriptorControl(descriptor, out control, out revision) ||
                    (control & SE_DACL_PROTECTED) == 0)
                {
                    throw new InvalidOperationException(
                        objectLabel + " process DACL is not protected.");
                }
                ACL_SIZE_INFORMATION aclInformation;
                if (!GetAclInformation(
                        dacl,
                        out aclInformation,
                        (uint)Marshal.SizeOf(typeof(ACL_SIZE_INFORMATION)),
                        AclSizeInformation) ||
                    aclInformation.AceCount != 4)
                {
                    throw new InvalidOperationException(
                        objectLabel + " process DACL must contain exactly four ACEs.");
                }
                bool foundSystem = false;
                bool foundAdministrators = false;
                bool foundSupervisor = false;
                bool foundRestricted = false;
                for (uint index = 0; index < aclInformation.AceCount; index++)
                {
                    IntPtr acePointer;
                    if (!GetAce(dacl, index, out acePointer) ||
                        acePointer == IntPtr.Zero)
                    {
                        throw new InvalidOperationException(
                            objectLabel + " process DACL ACE could not be read.");
                    }
                    ACCESS_ALLOWED_ACE ace =
                        (ACCESS_ALLOWED_ACE)Marshal.PtrToStructure(
                            acePointer,
                            typeof(ACCESS_ALLOWED_ACE));
                    IntPtr aceSid = new IntPtr(
                        acePointer.ToInt64() +
                        Marshal.OffsetOf(
                            typeof(ACCESS_ALLOWED_ACE),
                            "SidStart").ToInt64());
                    if (ace.Header.AceType != ACCESS_ALLOWED_ACE_TYPE ||
                        ace.Header.AceFlags != 0)
                    {
                        throw new InvalidOperationException(
                            objectLabel + " process DACL contains an unexpected ACE.");
                    }
                    if (EqualSid(aceSid, expectedSystem) &&
                        ace.Mask == PROCESS_ALL_ACCESS &&
                        !foundSystem)
                    {
                        foundSystem = true;
                    }
                    else if (EqualSid(aceSid, expectedAdministrators) &&
                        ace.Mask == PROCESS_ALL_ACCESS &&
                        !foundAdministrators)
                    {
                        foundAdministrators = true;
                    }
                    else if (EqualSid(aceSid, expectedOwner) &&
                        ace.Mask == PROCESS_ALL_ACCESS &&
                        !foundSupervisor)
                    {
                        foundSupervisor = true;
                    }
                    else if (EqualSid(aceSid, expectedRestricted) &&
                        ace.Mask ==
                            (PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE) &&
                        (ace.Mask & PROCESS_MUTATION_ACCESS) == 0 &&
                        !foundRestricted)
                    {
                        foundRestricted = true;
                    }
                    else
                    {
                        throw new InvalidOperationException(
                            objectLabel +
                            " process DACL trustee or access mask is not exact.");
                    }
                }
                if (!foundSystem ||
                    !foundAdministrators ||
                    !foundSupervisor ||
                    !foundRestricted)
                {
                    throw new InvalidOperationException(
                        objectLabel + " process DACL is incomplete.");
                }
            }
            finally
            {
                if (descriptor != IntPtr.Zero)
                {
                    LocalFree(descriptor);
                }
                FreeLocalSid(expectedRestricted);
                FreeLocalSid(expectedAdministrators);
                FreeLocalSid(expectedSystem);
                FreeLocalSid(expectedOwner);
            }
        }

        public static void RequireRestrictedSupervisorBoundary(
            int supervisorProcessId,
            long supervisorJobHandleValue)
        {
            if (supervisorProcessId < 1 || supervisorJobHandleValue == 0)
            {
                throw new ArgumentOutOfRangeException(
                    "Supervisor process or Job handle identity is invalid.");
            }
            IntPtr administrators = ConvertSid(
                "S-1-5-32-544",
                "Administrators SID conversion failed.");
            try
            {
                bool isAdministrator;
                if (!CheckTokenMembership(
                        IntPtr.Zero,
                        administrators,
                        out isAdministrator))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "Restricted token group validation failed.");
                }
                if (isAdministrator)
                {
                    throw new InvalidOperationException(
                        "Restricted identity unexpectedly belongs to Administrators.");
                }
            }
            finally
            {
                FreeLocalSid(administrators);
            }

            RequireDeniedProcessAccess(
                supervisorProcessId,
                PROCESS_DUP_HANDLE,
                "PROCESS_DUP_HANDLE open unexpectedly succeeded.");
            RequireDeniedProcessAccess(
                supervisorProcessId,
                WRITE_DAC,
                "WRITE_DAC open unexpectedly succeeded.");
            RequireDeniedProcessAccess(
                supervisorProcessId,
                WRITE_OWNER,
                "WRITE_OWNER open unexpectedly succeeded.");

            IntPtr query = OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                false,
                checked((uint)supervisorProcessId));
            if (query == IntPtr.Zero)
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Supervisor query-only process open was denied.");
            }
            try
            {
                IntPtr duplicated;
                if (DuplicateHandle(
                        query,
                        new IntPtr(supervisorJobHandleValue),
                        GetCurrentProcess(),
                        out duplicated,
                        JOB_OBJECT_QUERY,
                        false,
                        0))
                {
                    CloseHandle(duplicated);
                    throw new InvalidOperationException(
                        "DuplicateHandle unexpectedly succeeded.");
                }

                uint daclStatus = SetSecurityInfo(
                    query,
                    SE_KERNEL_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    IntPtr.Zero);
                if (daclStatus == 0)
                {
                    throw new InvalidOperationException(
                        "Supervisor DACL modification unexpectedly succeeded.");
                }

                SecurityIdentifier current = WindowsIdentity.GetCurrent().User;
                if (current == null)
                {
                    throw new InvalidOperationException(
                        "Restricted Windows identity SID is unavailable.");
                }
                IntPtr currentSid = ConvertSid(
                    current.Value,
                    "Restricted owner SID conversion failed.");
                try
                {
                    uint ownerStatus = SetSecurityInfo(
                        query,
                        SE_KERNEL_OBJECT,
                        OWNER_SECURITY_INFORMATION,
                        currentSid,
                        IntPtr.Zero,
                        IntPtr.Zero,
                        IntPtr.Zero);
                    if (ownerStatus == 0)
                    {
                        throw new InvalidOperationException(
                            "Supervisor owner modification unexpectedly succeeded.");
                    }
                }
                finally
                {
                    FreeLocalSid(currentSid);
                }
            }
            finally
            {
                CloseHandle(query);
            }
        }

        private static void RequireDeniedProcessAccess(
            int processId,
            uint access,
            string failureMessage)
        {
            IntPtr handle = OpenProcess(
                access,
                false,
                checked((uint)processId));
            if (handle != IntPtr.Zero)
            {
                CloseHandle(handle);
                throw new InvalidOperationException(failureMessage);
            }
            if (Marshal.GetLastWin32Error() != ERROR_ACCESS_DENIED)
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Dangerous supervisor process open failed unexpectedly.");
            }
        }

        internal static void DeleteOperatingSystemProfile(
            string sid,
            string expectedProfilePath)
        {
            string registryPath =
                @"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\" + sid;
            string actualProfilePath = null;
            using (RegistryKey profile = Registry.LocalMachine.OpenSubKey(registryPath))
            {
                if (profile != null)
                {
                    actualProfilePath = Convert.ToString(
                        profile.GetValue("ProfileImagePath"));
                    if (!String.IsNullOrWhiteSpace(actualProfilePath))
                    {
                        actualProfilePath = Path.GetFullPath(
                            Environment.ExpandEnvironmentVariables(actualProfilePath));
                    }
                }
            }
            bool registryProfileExists;
            using (RegistryKey profile = Registry.LocalMachine.OpenSubKey(registryPath))
            {
                registryProfileExists = profile != null;
            }
            bool profileExists =
                registryProfileExists ||
                Directory.Exists(expectedProfilePath) ||
                (!String.IsNullOrWhiteSpace(actualProfilePath) &&
                    Directory.Exists(actualProfilePath));
            if (profileExists && !DeleteProfileW(sid, null, null))
            {
                int error = Marshal.GetLastWin32Error();
                if (error != ERROR_FILE_NOT_FOUND &&
                    error != ERROR_PATH_NOT_FOUND &&
                    error != ERROR_NOT_FOUND)
                {
                    throw new Win32Exception(
                        error,
                        "Ephemeral Windows profile deletion failed.");
                }
            }

            Stopwatch timer = Stopwatch.StartNew();
            while (timer.Elapsed < TimeSpan.FromSeconds(10))
            {
                bool registryExists;
                using (RegistryKey profile = Registry.LocalMachine.OpenSubKey(registryPath))
                {
                    registryExists = profile != null;
                }
                if (!registryExists &&
                    !Directory.Exists(expectedProfilePath) &&
                    (String.IsNullOrWhiteSpace(actualProfilePath) ||
                        !Directory.Exists(actualProfilePath)))
                {
                    return;
                }
                Thread.Sleep(100);
            }
            throw new InvalidOperationException(
                "Ephemeral Windows profile survived cleanup.");
        }

        internal static void DeleteDirectoryTree(string root)
        {
            if (!Directory.Exists(root))
            {
                return;
            }
            DirectoryInfo directory = new DirectoryInfo(root);
            if ((directory.Attributes & FileAttributes.ReparsePoint) != 0)
            {
                throw new InvalidOperationException(
                    "Cleanup root became a reparse point.");
            }
            DeleteDirectoryContents(directory);
            directory.Delete(false);
            if (Directory.Exists(root))
            {
                throw new IOException("Ephemeral bootstrap root survived cleanup.");
            }
        }

        private static void DeleteDirectoryContents(DirectoryInfo directory)
        {
            foreach (FileSystemInfo entry in directory.GetFileSystemInfos())
            {
                if ((entry.Attributes & FileAttributes.ReparsePoint) != 0)
                {
                    if ((entry.Attributes & FileAttributes.Directory) != 0)
                    {
                        if (!RemoveDirectoryW(entry.FullName))
                        {
                            throw new Win32Exception(
                                Marshal.GetLastWin32Error(),
                                "Cleanup reparse directory could not be removed.");
                        }
                    }
                    else if (!DeleteFileW(entry.FullName))
                    {
                        throw new Win32Exception(
                            Marshal.GetLastWin32Error(),
                            "Cleanup reparse file could not be removed.");
                    }
                    continue;
                }
                DirectoryInfo childDirectory = entry as DirectoryInfo;
                if (childDirectory != null)
                {
                    DeleteDirectoryContents(childDirectory);
                    childDirectory.Delete(false);
                }
                else
                {
                    entry.Attributes = FileAttributes.Normal;
                    entry.Delete();
                }
            }
        }

        private static IntPtr ConvertSid(string sid, string failureMessage)
        {
            IntPtr converted;
            if (!ConvertStringSidToSidW(sid, out converted))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    failureMessage);
            }
            return converted;
        }

        private static void FreeLocalSid(IntPtr sid)
        {
            if (sid != IntPtr.Zero)
            {
                LocalFree(sid);
            }
        }

        private static void EnablePrivilege(string privilege)
        {
            IntPtr token;
            if (!OpenProcessToken(
                    GetCurrentProcess(),
                    0x0020 | 0x0008,
                    out token))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Supervisor process token could not be opened.");
            }
            try
            {
                LUID luid;
                if (!LookupPrivilegeValueW(null, privilege, out luid))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "Required Windows cleanup privilege is unavailable.");
                }
                TOKEN_PRIVILEGES privileges = new TOKEN_PRIVILEGES();
                privileges.PrivilegeCount = 1;
                privileges.Luid = luid;
                privileges.Attributes = 0x00000002;
                if (!AdjustTokenPrivileges(
                        token,
                        false,
                        ref privileges,
                        0,
                        IntPtr.Zero,
                        IntPtr.Zero) ||
                    Marshal.GetLastWin32Error() == 1300)
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "Required Windows cleanup privilege could not be enabled.");
                }
            }
            finally
            {
                CloseHandle(token);
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

        private static void ExecuteQuarantineSecuritySequence(
            Action terminateAndReapJob,
            Action requireJobZero,
            Action disableAccount,
            Func<int> cleanupScheduledTasks,
            Func<int> cleanupBitsJobs,
            Func<int> drainProcessesByPrimaryTokenSid,
            Action requireFinalIsolation,
            int maximumRounds,
            int delayMilliseconds,
            int postDisableSettlementMilliseconds,
            int minimumObservationMilliseconds)
        {
            if (terminateAndReapJob == null ||
                requireJobZero == null ||
                disableAccount == null ||
                cleanupScheduledTasks == null ||
                cleanupBitsJobs == null ||
                drainProcessesByPrimaryTokenSid == null ||
                requireFinalIsolation == null)
            {
                throw new ArgumentNullException(
                    "Quarantine security sequence delegates may not be null.");
            }
            if (maximumRounds < MinimumStableIsolationRounds ||
                maximumRounds > MaximumIsolationRounds ||
                delayMilliseconds < 0 ||
                delayMilliseconds > 1000 ||
                postDisableSettlementMilliseconds < 0 ||
                postDisableSettlementMilliseconds > 10000 ||
                minimumObservationMilliseconds < 0 ||
                minimumObservationMilliseconds > 10000)
            {
                throw new ArgumentOutOfRangeException(
                    "Quarantine security sequence bounds are invalid.");
            }

            List<Exception> cleanupFailures = new List<Exception>();
            try
            {
                terminateAndReapJob();
            }
            catch (Exception error)
            {
                cleanupFailures.Add(error);
            }
            try
            {
                requireJobZero();
            }
            catch (Exception error)
            {
                cleanupFailures.Add(error);
            }
            bool accountDisabled = false;
            try
            {
                disableAccount();
                accountDisabled = true;
            }
            catch (Exception error)
            {
                cleanupFailures.Add(error);
            }
            if (accountDisabled && postDisableSettlementMilliseconds != 0)
            {
                Thread.Sleep(postDisableSettlementMilliseconds);
            }

            Stopwatch observation = Stopwatch.StartNew();
            int stableRounds = 0;
            for (int round = 0; round < maximumRounds; round++)
            {
                int scheduledTaskCount = -1;
                int bitsJobCount = -1;
                int processCount = -1;
                bool roundFailed = false;
                try
                {
                    scheduledTaskCount = cleanupScheduledTasks();
                }
                catch (Exception error)
                {
                    cleanupFailures.Add(error);
                    roundFailed = true;
                }
                try
                {
                    bitsJobCount = cleanupBitsJobs();
                }
                catch (Exception error)
                {
                    cleanupFailures.Add(error);
                    roundFailed = true;
                }
                try
                {
                    processCount = drainProcessesByPrimaryTokenSid();
                }
                catch (Exception error)
                {
                    cleanupFailures.Add(error);
                    roundFailed = true;
                }
                if (!roundFailed &&
                    scheduledTaskCount >= 0 &&
                    bitsJobCount >= 0 &&
                    processCount >= 0 &&
                    scheduledTaskCount == 0 &&
                    bitsJobCount == 0 &&
                    processCount == 0)
                {
                    stableRounds++;
                }
                else
                {
                    stableRounds = 0;
                }
                if (stableRounds >= MinimumStableIsolationRounds &&
                    observation.ElapsedMilliseconds >=
                        minimumObservationMilliseconds)
                {
                    break;
                }
                if (delayMilliseconds != 0)
                {
                    Thread.Sleep(delayMilliseconds);
                }
            }
            if (stableRounds < MinimumStableIsolationRounds ||
                observation.ElapsedMilliseconds <
                    minimumObservationMilliseconds)
            {
                cleanupFailures.Add(new TimeoutException(
                    "Isolated account persistence did not reach stable terminal zero proof."));
            }
            try
            {
                requireFinalIsolation();
            }
            catch (Exception error)
            {
                cleanupFailures.Add(error);
            }
            if (cleanupFailures.Count != 0)
            {
                throw new InvalidOperationException(
                    "Terminal isolated identity quarantine failed.",
                    new AggregateException(cleanupFailures.ToArray()));
            }
        }

        private static void ExecuteArtifactSecuritySequence(
            Action requireQuarantine,
            Action sealArtifactSource,
            Action requirePostSealIsolation,
            Action captureArtifact)
        {
            if (requireQuarantine == null ||
                sealArtifactSource == null ||
                requirePostSealIsolation == null ||
                captureArtifact == null)
            {
                throw new ArgumentNullException(
                    "Artifact security sequence delegates may not be null.");
            }
            requireQuarantine();
            sealArtifactSource();
            requirePostSealIsolation();
            captureArtifact();
            requirePostSealIsolation();
        }

        private int CleanupScheduledTasks()
        {
            int observed = 0;
            for (int pass = 0; pass < MaximumSchedulerCleanupPasses; pass++)
            {
                RememberRunIdentityScheduledTaskFolders();
                List<ScheduledTaskReference> matches =
                    EnumerateMatchingScheduledTasks(true);
                HashSet<string> matchingPaths = new HashSet<string>(
                    StringComparer.OrdinalIgnoreCase);
                foreach (ScheduledTaskReference match in matches)
                {
                    RememberScheduledTaskFolderChain(match.FolderPath);
                    matchingPaths.Add(match.Path);
                }
                observed = checked(
                    observed +
                    matches.Count +
                    StopMatchingRunningTasks(matchingPaths, true));
                foreach (ScheduledTaskReference match in matches)
                {
                    DeleteScheduledTask(match);
                }
                DeleteAttributableScheduledTaskFolders();

                List<ScheduledTaskReference> remaining =
                    EnumerateMatchingScheduledTasks(false);
                HashSet<string> remainingPaths = new HashSet<string>(
                    StringComparer.OrdinalIgnoreCase);
                foreach (ScheduledTaskReference match in remaining)
                {
                    RememberScheduledTaskFolderChain(match.FolderPath);
                    remainingPaths.Add(match.Path);
                }
                int running = StopMatchingRunningTasks(remainingPaths, false);
                int folders = CountAttributableScheduledTaskFolders();
                if (remaining.Count == 0 && running == 0 && folders == 0)
                {
                    return observed;
                }
            }
            throw new InvalidOperationException(
                "Attributable Task Scheduler registrations or running instances remained.");
        }

        private int InspectScheduledTasks()
        {
            RememberRunIdentityScheduledTaskFolders();
            List<ScheduledTaskReference> registrations =
                EnumerateMatchingScheduledTasks(false);
            HashSet<string> paths = new HashSet<string>(
                StringComparer.OrdinalIgnoreCase);
            foreach (ScheduledTaskReference registration in registrations)
            {
                RememberScheduledTaskFolderChain(registration.FolderPath);
                paths.Add(registration.Path);
            }
            return checked(
                registrations.Count +
                StopMatchingRunningTasks(paths, false) +
                CountAttributableScheduledTaskFolders());
        }

        private List<ScheduledTaskReference> EnumerateMatchingScheduledTasks(
            bool stopMatches)
        {
            object service = null;
            try
            {
                service = CreateTaskService();
                List<string> folders = new List<string>();
                CollectTaskFolderPaths(service, "\\", folders);
                List<ScheduledTaskReference> matches =
                    new List<ScheduledTaskReference>();
                foreach (string folderPath in folders)
                {
                    object folder = null;
                    object tasks = null;
                    try
                    {
                        folder = InvokeComMethod(
                            service,
                            "GetFolder",
                            folderPath);
                        tasks = InvokeComMethod(
                            folder,
                            "GetTasks",
                            TASK_ENUM_HIDDEN);
                        int count = Convert.ToInt32(
                            GetComProperty(tasks, "Count"),
                            CultureInfo.InvariantCulture);
                        for (int index = 1; index <= count; index++)
                        {
                            object task = null;
                            try
                            {
                                task = GetComProperty(tasks, "Item", index);
                                if (!ScheduledTaskMatches(task))
                                {
                                    continue;
                                }
                                string name = Convert.ToString(
                                    GetComProperty(task, "Name"),
                                    CultureInfo.InvariantCulture);
                                string path = Convert.ToString(
                                    GetComProperty(task, "Path"),
                                    CultureInfo.InvariantCulture);
                                if (String.IsNullOrWhiteSpace(name) ||
                                    String.IsNullOrWhiteSpace(path))
                                {
                                    throw new InvalidOperationException(
                                        "Matching scheduled task identity is ambiguous.");
                                }
                                if (stopMatches)
                                {
                                    InvokeComMethod(task, "Stop", 0);
                                    RequireRegisteredTaskInstancesStopped(task);
                                }
                                matches.Add(new ScheduledTaskReference
                                {
                                    FolderPath = folderPath,
                                    Name = name,
                                    Path = path,
                                });
                            }
                            finally
                            {
                                ReleaseComObject(task);
                            }
                        }
                    }
                    finally
                    {
                        ReleaseComObject(tasks);
                        ReleaseComObject(folder);
                    }
                }
                return matches;
            }
            catch (Exception error)
            {
                throw new InvalidOperationException(
                    "Task Scheduler registration enumeration failed.",
                    error);
            }
            finally
            {
                ReleaseComObject(service);
            }
        }

        private static object CreateTaskService()
        {
            Type serviceType = Type.GetTypeFromProgID(
                "Schedule.Service",
                true);
            object service = Activator.CreateInstance(serviceType);
            if (service == null)
            {
                throw new InvalidOperationException(
                    "Task Scheduler COM service could not be created.");
            }
            InvokeComMethod(
                service,
                "Connect",
                Type.Missing,
                Type.Missing,
                Type.Missing,
                Type.Missing);
            bool connected = Convert.ToBoolean(
                GetComProperty(service, "Connected"),
                CultureInfo.InvariantCulture);
            if (!connected)
            {
                ReleaseComObject(service);
                throw new InvalidOperationException(
                    "Task Scheduler COM service did not connect.");
            }
            return service;
        }

        private static void CollectTaskFolderPaths(
            object service,
            string folderPath,
            List<string> paths)
        {
            paths.Add(folderPath);
            object folder = null;
            object folders = null;
            try
            {
                folder = InvokeComMethod(service, "GetFolder", folderPath);
                folders = InvokeComMethod(folder, "GetFolders", 0);
                int count = Convert.ToInt32(
                    GetComProperty(folders, "Count"),
                    CultureInfo.InvariantCulture);
                for (int index = 1; index <= count; index++)
                {
                    object child = null;
                    try
                    {
                        child = GetComProperty(folders, "Item", index);
                        string childPath = Convert.ToString(
                            GetComProperty(child, "Path"),
                            CultureInfo.InvariantCulture);
                        if (String.IsNullOrWhiteSpace(childPath) ||
                            paths.Contains(childPath))
                        {
                            throw new InvalidOperationException(
                                "Task Scheduler folder enumeration was ambiguous.");
                        }
                        CollectTaskFolderPaths(service, childPath, paths);
                    }
                    finally
                    {
                        ReleaseComObject(child);
                    }
                }
            }
            finally
            {
                ReleaseComObject(folders);
                ReleaseComObject(folder);
            }
        }

        private static void RequireRegisteredTaskInstancesStopped(
            object task)
        {
            Stopwatch timer = Stopwatch.StartNew();
            while (true)
            {
                object instances = null;
                try
                {
                    instances = InvokeComMethod(
                        task,
                        "GetInstances",
                        0);
                    int count = Convert.ToInt32(
                        GetComProperty(instances, "Count"),
                        CultureInfo.InvariantCulture);
                    if (count == 0)
                    {
                        return;
                    }
                    for (int index = 1; index <= count; index++)
                    {
                        object instance = null;
                        try
                        {
                            instance = GetComProperty(
                                instances,
                                "Item",
                                index);
                            InvokeComMethod(instance, "Stop");
                        }
                        finally
                        {
                            ReleaseComObject(instance);
                        }
                    }
                }
                finally
                {
                    ReleaseComObject(instances);
                }
                if (timer.Elapsed >= TimeSpan.FromSeconds(10))
                {
                    throw new TimeoutException(
                        "Attributable Task Scheduler instances could not be stopped.");
                }
                Thread.Sleep(50);
            }
        }

        private bool ScheduledTaskMatches(object task)
        {
            string name = Convert.ToString(
                GetComProperty(task, "Name"),
                CultureInfo.InvariantCulture);
            string path = Convert.ToString(
                GetComProperty(task, "Path"),
                CultureInfo.InvariantCulture);
            if (ContainsRunIdentity(name) || ContainsRunIdentity(path))
            {
                return true;
            }

            object definition = null;
            object principal = null;
            object registration = null;
            object actions = null;
            try
            {
                definition = GetComProperty(task, "Definition");
                principal = GetComProperty(definition, "Principal");
                string userId = Convert.ToString(
                    GetComProperty(principal, "UserId"),
                    CultureInfo.InvariantCulture);
                string groupId = Convert.ToString(
                    GetComProperty(principal, "GroupId"),
                    CultureInfo.InvariantCulture);
                if (TaskPrincipalMatches(userId) ||
                    TaskPrincipalMatches(groupId))
                {
                    return true;
                }

                registration = GetComProperty(
                    definition,
                    "RegistrationInfo");
                foreach (string value in new string[]
                {
                    Convert.ToString(
                        GetComProperty(registration, "URI"),
                        CultureInfo.InvariantCulture),
                    Convert.ToString(
                        GetComProperty(registration, "Source"),
                        CultureInfo.InvariantCulture),
                })
                {
                    if (ContainsRunIdentity(value))
                    {
                        return true;
                    }
                }

                actions = GetComProperty(definition, "Actions");
                int actionCount = Convert.ToInt32(
                    GetComProperty(actions, "Count"),
                    CultureInfo.InvariantCulture);
                for (int index = 1; index <= actionCount; index++)
                {
                    object action = null;
                    try
                    {
                        action = GetComProperty(actions, "Item", index);
                        int type = Convert.ToInt32(
                            GetComProperty(action, "Type"),
                            CultureInfo.InvariantCulture);
                        if (type != 0)
                        {
                            continue;
                        }
                        foreach (string value in new string[]
                        {
                            Convert.ToString(
                                GetComProperty(action, "Path"),
                                CultureInfo.InvariantCulture),
                            Convert.ToString(
                                GetComProperty(action, "Arguments"),
                                CultureInfo.InvariantCulture),
                            Convert.ToString(
                                GetComProperty(action, "WorkingDirectory"),
                                CultureInfo.InvariantCulture),
                        })
                        {
                            if (ContainsRunIdentity(value))
                            {
                                return true;
                            }
                        }
                    }
                    finally
                    {
                        ReleaseComObject(action);
                    }
                }
                return false;
            }
            finally
            {
                ReleaseComObject(actions);
                ReleaseComObject(registration);
                ReleaseComObject(principal);
                ReleaseComObject(definition);
            }
        }

        private bool TaskPrincipalMatches(string value)
        {
            if (String.IsNullOrWhiteSpace(value))
            {
                return false;
            }
            string candidate = value.Trim();
            return String.Equals(
                    candidate,
                    supervisedSid,
                    StringComparison.Ordinal) ||
                String.Equals(
                    candidate,
                    supervisedUserName,
                    StringComparison.OrdinalIgnoreCase) ||
                String.Equals(
                    candidate,
                    supervisedQualifiedUserName,
                    StringComparison.OrdinalIgnoreCase) ||
                String.Equals(
                    candidate,
                    ".\\" + supervisedUserName,
                    StringComparison.OrdinalIgnoreCase);
        }

        private bool ContainsRunIdentity(string value)
        {
            if (String.IsNullOrWhiteSpace(value))
            {
                return false;
            }
            return value.IndexOf(
                    runIdentity,
                    StringComparison.OrdinalIgnoreCase) >= 0 ||
                (runIdentityToken.Length >= 16 &&
                    value.IndexOf(
                        runIdentityToken,
                        StringComparison.OrdinalIgnoreCase) >= 0) ||
                value.IndexOf(
                    supervisedRootPath,
                    StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private void RememberScheduledTaskFolderChain(string folderPath)
        {
            if (String.IsNullOrWhiteSpace(folderPath) ||
                !folderPath.StartsWith("\\", StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    "Attributable Task Scheduler folder path is ambiguous.");
            }
            string current = folderPath;
            while (!String.Equals(current, "\\", StringComparison.Ordinal))
            {
                attributableScheduledTaskFolders.Add(current);
                int separator = current.LastIndexOf('\\');
                current = separator <= 0
                    ? "\\"
                    : current.Substring(0, separator);
            }
        }

        private void RememberRunIdentityScheduledTaskFolders()
        {
            object service = null;
            try
            {
                service = CreateTaskService();
                List<string> paths = new List<string>();
                CollectTaskFolderPaths(service, "\\", paths);
                foreach (string path in paths)
                {
                    if (!String.Equals(path, "\\", StringComparison.Ordinal) &&
                        ContainsRunIdentity(path))
                    {
                        RememberScheduledTaskFolderChain(path);
                    }
                }
            }
            finally
            {
                ReleaseComObject(service);
            }
        }

        private int CountAttributableScheduledTaskFolders()
        {
            RememberRunIdentityScheduledTaskFolders();
            object service = null;
            try
            {
                service = CreateTaskService();
                List<string> paths = new List<string>();
                CollectTaskFolderPaths(service, "\\", paths);
                HashSet<string> existing = new HashSet<string>(
                    paths,
                    StringComparer.OrdinalIgnoreCase);
                int matches = 0;
                foreach (string path in attributableScheduledTaskFolders)
                {
                    if (existing.Contains(path))
                    {
                        matches++;
                    }
                }
                return matches;
            }
            finally
            {
                ReleaseComObject(service);
            }
        }

        private void DeleteAttributableScheduledTaskFolders()
        {
            object service = null;
            try
            {
                RememberRunIdentityScheduledTaskFolders();
                service = CreateTaskService();
                List<string> existingPaths = new List<string>();
                CollectTaskFolderPaths(service, "\\", existingPaths);
                HashSet<string> existing = new HashSet<string>(
                    existingPaths,
                    StringComparer.OrdinalIgnoreCase);
                List<string> paths = new List<string>();
                foreach (string path in attributableScheduledTaskFolders)
                {
                    if (existing.Contains(path))
                    {
                        paths.Add(path);
                    }
                }
                paths.Sort(delegate(string left, string right)
                {
                    return right.Length.CompareTo(left.Length);
                });
                foreach (string path in paths)
                {
                    int separator = path.LastIndexOf('\\');
                    string parentPath = separator == 0
                        ? "\\"
                        : path.Substring(0, separator);
                    string name = path.Substring(separator + 1);
                    object parent = null;
                    try
                    {
                        parent = InvokeComMethod(
                            service,
                            "GetFolder",
                            parentPath);
                        InvokeComMethod(parent, "DeleteFolder", name, 0);
                    }
                    finally
                    {
                        ReleaseComObject(parent);
                    }
                }
            }
            catch (Exception error)
            {
                throw new InvalidOperationException(
                    "Attributable Task Scheduler folder could not be deleted.",
                    error);
            }
            finally
            {
                ReleaseComObject(service);
            }
        }

        private static void DeleteScheduledTask(
            ScheduledTaskReference task)
        {
            object service = null;
            object folder = null;
            try
            {
                service = CreateTaskService();
                folder = InvokeComMethod(
                    service,
                    "GetFolder",
                    task.FolderPath);
                InvokeComMethod(folder, "DeleteTask", task.Name, 0);
            }
            catch (Exception error)
            {
                throw new InvalidOperationException(
                    "Attributable Task Scheduler registration could not be deleted.",
                    error);
            }
            finally
            {
                ReleaseComObject(folder);
                ReleaseComObject(service);
            }
        }

        private int StopMatchingRunningTasks(
            HashSet<string> matchingPaths,
            bool stopMatches)
        {
            object service = null;
            object runningTasks = null;
            Dictionary<uint, string> processSids =
                EnumerateProcessPrimaryTokenSids();
            int matches = 0;
            try
            {
                service = CreateTaskService();
                runningTasks = InvokeComMethod(
                    service,
                    "GetRunningTasks",
                    TASK_ENUM_HIDDEN);
                int count = Convert.ToInt32(
                    GetComProperty(runningTasks, "Count"),
                    CultureInfo.InvariantCulture);
                for (int index = 1; index <= count; index++)
                {
                    object runningTask = null;
                    try
                    {
                        runningTask = GetComProperty(
                            runningTasks,
                            "Item",
                            index);
                        string path = Convert.ToString(
                            GetComProperty(runningTask, "Path"),
                            CultureInfo.InvariantCulture);
                        string name = Convert.ToString(
                            GetComProperty(runningTask, "Name"),
                            CultureInfo.InvariantCulture);
                        string currentAction = Convert.ToString(
                            GetComProperty(runningTask, "CurrentAction"),
                            CultureInfo.InvariantCulture);
                        uint processId = Convert.ToUInt32(
                            GetComProperty(runningTask, "EnginePID"),
                            CultureInfo.InvariantCulture);
                        string processSid;
                        bool match =
                            matchingPaths.Contains(path) ||
                            ContainsRunIdentity(path) ||
                            ContainsRunIdentity(name) ||
                            ContainsRunIdentity(currentAction) ||
                            (processId != 0 &&
                                processSids.TryGetValue(
                                    processId,
                                    out processSid) &&
                                String.Equals(
                                    processSid,
                                    supervisedSid,
                                    StringComparison.Ordinal));
                        if (!match)
                        {
                            continue;
                        }
                        matches++;
                        if (stopMatches)
                        {
                            InvokeComMethod(runningTask, "Stop");
                        }
                    }
                    finally
                    {
                        ReleaseComObject(runningTask);
                    }
                }
                return matches;
            }
            catch (Exception error)
            {
                throw new InvalidOperationException(
                    "Task Scheduler running-instance enumeration failed.",
                    error);
            }
            finally
            {
                ReleaseComObject(runningTasks);
                ReleaseComObject(service);
            }
        }

        private static object InvokeComMethod(
            object target,
            string name,
            params object[] arguments)
        {
            if (target == null)
            {
                throw new ArgumentNullException("target");
            }
            try
            {
                return target.GetType().InvokeMember(
                    name,
                    BindingFlags.InvokeMethod,
                    null,
                    target,
                    arguments,
                    CultureInfo.InvariantCulture);
            }
            catch (TargetInvocationException error)
            {
                throw new InvalidOperationException(
                    "Windows COM method invocation failed: " + name + ".",
                    error.InnerException ?? error);
            }
        }

        private static object GetComProperty(
            object target,
            string name,
            params object[] arguments)
        {
            if (target == null)
            {
                throw new ArgumentNullException("target");
            }
            try
            {
                return target.GetType().InvokeMember(
                    name,
                    BindingFlags.GetProperty,
                    null,
                    target,
                    arguments,
                    CultureInfo.InvariantCulture);
            }
            catch (TargetInvocationException error)
            {
                throw new InvalidOperationException(
                    "Windows COM property query failed: " + name + ".",
                    error.InnerException ?? error);
            }
        }

        private static void ReleaseComObject(object value)
        {
            if (value != null && Marshal.IsComObject(value))
            {
                Marshal.FinalReleaseComObject(value);
            }
        }

        private int CleanupBitsJobs()
        {
            int observed = 0;
            for (int pass = 0; pass < MaximumBitsCleanupPasses; pass++)
            {
                int matches = EnumerateMatchingBitsJobs(true);
                observed = checked(observed + matches);
                if (EnumerateMatchingBitsJobs(false) == 0)
                {
                    return observed;
                }
            }
            throw new InvalidOperationException(
                "Attributable BITS jobs remained after cancellation.");
        }

        private int InspectBitsJobs()
        {
            return EnumerateMatchingBitsJobs(false);
        }

        private int EnumerateMatchingBitsJobs(bool cancelMatches)
        {
            IBackgroundCopyManager manager = null;
            IEnumBackgroundCopyJobs jobs = null;
            try
            {
                manager = (IBackgroundCopyManager)new BackgroundCopyManager();
                RequireComSuccess(
                    manager.EnumJobs(BG_JOB_ENUM_ALL_USERS, out jobs),
                    "All-user BITS job enumeration failed.");
                if (jobs == null)
                {
                    throw new InvalidOperationException(
                        "All-user BITS job enumeration returned no enumerator.");
                }
                int matches = 0;
                while (true)
                {
                    IBackgroundCopyJob job = null;
                    uint fetched;
                    int result = jobs.Next(1, out job, out fetched);
                    if (result < 0)
                    {
                        RequireComSuccess(
                            result,
                            "BITS job enumeration failed.");
                    }
                    if (fetched == 0)
                    {
                        ReleaseComObject(job);
                        break;
                    }
                    if (job == null || fetched != 1)
                    {
                        ReleaseComObject(job);
                        throw new InvalidOperationException(
                            "BITS job enumeration returned an ambiguous entry.");
                    }
                    try
                    {
                        IntPtr owner = IntPtr.Zero;
                        RequireComSuccess(
                            job.GetOwner(out owner),
                            "BITS job owner SID query failed.");
                        if (owner == IntPtr.Zero)
                        {
                            throw new InvalidOperationException(
                                "BITS job owner SID query was ambiguous.");
                        }
                        string ownerSid;
                        try
                        {
                            ownerSid = Marshal.PtrToStringUni(owner);
                        }
                        finally
                        {
                            Marshal.FreeCoTaskMem(owner);
                        }
                        if (!String.Equals(
                                ownerSid,
                                supervisedSid,
                                StringComparison.Ordinal))
                        {
                            continue;
                        }
                        matches++;
                        if (cancelMatches)
                        {
                            RequireComSuccess(
                                job.Cancel(),
                                "Attributable BITS job cancellation failed.");
                        }
                    }
                    finally
                    {
                        ReleaseComObject(job);
                    }
                }
                return matches;
            }
            catch (Exception error)
            {
                throw new InvalidOperationException(
                    "BITS all-user cleanup failed.",
                    error);
            }
            finally
            {
                ReleaseComObject(jobs);
                ReleaseComObject(manager);
            }
        }

        private static void RequireComSuccess(
            int result,
            string failure)
        {
            if (result < 0)
            {
                throw new COMException(failure, result);
            }
        }

        private int DrainProcessesByPrimaryTokenSid()
        {
            Dictionary<uint, string> processes =
                EnumerateProcessPrimaryTokenSids();
            List<uint> matches = new List<uint>();
            foreach (KeyValuePair<uint, string> process in processes)
            {
                if (String.Equals(
                        process.Value,
                        supervisedSid,
                        StringComparison.Ordinal))
                {
                    matches.Add(process.Key);
                }
            }

            foreach (uint processId in matches)
            {
                IntPtr process = OpenProcess(
                    PROCESS_TERMINATE |
                        SYNCHRONIZE |
                        PROCESS_QUERY_LIMITED_INFORMATION,
                    false,
                    processId);
                if (process == IntPtr.Zero)
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "Matching isolated-SID process could not be opened.");
                }
                try
                {
                    string verifiedSid = QueryProcessPrimaryTokenSid(process);
                    if (!String.Equals(
                            verifiedSid,
                            supervisedSid,
                            StringComparison.Ordinal))
                    {
                        throw new InvalidOperationException(
                            "Matching isolated-SID process identity changed.");
                    }
                    if (!TerminateProcess(process, 1))
                    {
                        throw new Win32Exception(
                            Marshal.GetLastWin32Error(),
                            "Matching isolated-SID process termination failed.");
                    }
                    uint wait = WaitForSingleObject(process, 30000);
                    if (wait != WAIT_OBJECT_0)
                    {
                        if (wait == WAIT_TIMEOUT)
                        {
                            throw new TimeoutException(
                                "Matching isolated-SID process did not terminate.");
                        }
                        throw new Win32Exception(
                            Marshal.GetLastWin32Error(),
                            "Matching isolated-SID process wait failed.");
                    }
                    uint exitCode;
                    if (!GetExitCodeProcess(process, out exitCode) ||
                        exitCode == STILL_ACTIVE)
                    {
                        throw new InvalidOperationException(
                            "Matching isolated-SID process could not be reaped.");
                    }
                }
                finally
                {
                    CloseHandle(process);
                }
            }
            return matches.Count;
        }

        private int CountProcessesByPrimaryTokenSid()
        {
            int matches = 0;
            foreach (string sid in EnumerateProcessPrimaryTokenSids().Values)
            {
                if (String.Equals(
                        sid,
                        supervisedSid,
                        StringComparison.Ordinal))
                {
                    matches++;
                }
            }
            return matches;
        }

        private static Dictionary<uint, string>
            EnumerateProcessPrimaryTokenSids()
        {
            uint level = 1;
            IntPtr buffer = IntPtr.Zero;
            uint count;
            if (!WTSEnumerateProcessesExW(
                    IntPtr.Zero,
                    ref level,
                    WTS_ANY_SESSION,
                    out buffer,
                    out count))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "System-wide WTS process SID enumeration failed.");
            }
            if (level != 1 || (count != 0 && buffer == IntPtr.Zero))
            {
                if (buffer != IntPtr.Zero)
                {
                    WTSFreeMemoryExW(
                        WTSTypeProcessInfoLevel1,
                        buffer,
                        count);
                }
                throw new InvalidOperationException(
                    "System-wide WTS process SID enumeration was ambiguous.");
            }

            Exception failure = null;
            Dictionary<uint, string> processes =
                new Dictionary<uint, string>();
            try
            {
                int size = Marshal.SizeOf(typeof(WTS_PROCESS_INFO_EXW));
                for (uint index = 0; index < count; index++)
                {
                    IntPtr entry = new IntPtr(
                        buffer.ToInt64() + checked((long)index * size));
                    WTS_PROCESS_INFO_EXW information =
                        (WTS_PROCESS_INFO_EXW)Marshal.PtrToStructure(
                            entry,
                            typeof(WTS_PROCESS_INFO_EXW));
                    if (information.pUserSid == IntPtr.Zero)
                    {
                        if (information.ProcessId == 0)
                        {
                            continue;
                        }
                        throw new InvalidOperationException(
                            "WTS process primary token SID query was ambiguous.");
                    }
                    string sid = ConvertNativeSidToString(
                        information.pUserSid,
                        "WTS process primary token SID conversion failed.");
                    if (processes.ContainsKey(information.ProcessId))
                    {
                        throw new InvalidOperationException(
                            "WTS process enumeration returned a duplicate PID.");
                    }
                    processes.Add(information.ProcessId, sid);
                }
            }
            catch (Exception error)
            {
                failure = error;
            }
            finally
            {
                if (buffer != IntPtr.Zero &&
                    !WTSFreeMemoryExW(
                        WTSTypeProcessInfoLevel1,
                        buffer,
                        count) &&
                    failure == null)
                {
                    failure = new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "WTS process enumeration buffer could not be released.");
                }
            }
            if (failure != null)
            {
                throw failure;
            }
            return processes;
        }

        private static string QueryProcessPrimaryTokenSid(
            IntPtr process)
        {
            IntPtr token;
            if (!OpenProcessToken(process, TOKEN_QUERY, out token))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Matching process primary token could not be opened.");
            }
            try
            {
                uint length = 0;
                GetTokenInformation(
                    token,
                    TokenUser,
                    IntPtr.Zero,
                    0,
                    out length);
                if (length == 0 ||
                    Marshal.GetLastWin32Error() != 122)
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "Matching process token SID length could not be queried.");
                }
                IntPtr buffer = Marshal.AllocHGlobal(
                    checked((int)length));
                try
                {
                    if (!GetTokenInformation(
                            token,
                            TokenUser,
                            buffer,
                            length,
                            out length))
                    {
                        throw new Win32Exception(
                            Marshal.GetLastWin32Error(),
                            "Matching process token SID could not be queried.");
                    }
                    TOKEN_USER user = (TOKEN_USER)Marshal.PtrToStructure(
                        buffer,
                        typeof(TOKEN_USER));
                    if (user.User.Sid == IntPtr.Zero)
                    {
                        throw new InvalidOperationException(
                            "Matching process token SID was ambiguous.");
                    }
                    return ConvertNativeSidToString(
                        user.User.Sid,
                        "Matching process token SID conversion failed.");
                }
                finally
                {
                    Marshal.FreeHGlobal(buffer);
                }
            }
            finally
            {
                CloseHandle(token);
            }
        }

        private static string ConvertNativeSidToString(
            IntPtr sid,
            string failure)
        {
            IntPtr value;
            if (!ConvertSidToStringSidW(sid, out value) ||
                value == IntPtr.Zero)
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    failure);
            }
            try
            {
                string result = Marshal.PtrToStringUni(value);
                if (String.IsNullOrWhiteSpace(result))
                {
                    throw new InvalidOperationException(failure);
                }
                return result;
            }
            finally
            {
                LocalFree(value);
            }
        }

        private void RequirePostSealIsolation(
            WindowsIsolatedUser isolatedUser)
        {
            isolatedUser.RequireDisabledAndVerify();
            int scheduledTasks = InspectScheduledTasks();
            int bitsJobs = InspectBitsJobs();
            int processes = CountProcessesByPrimaryTokenSid();
            if (scheduledTasks != 0 ||
                bitsJobs != 0 ||
                processes != 0)
            {
                throw new InvalidOperationException(
                    "Isolated persistence reappeared during or after artifact sealing.");
            }
        }

        private void RequireFinalQuarantineIsolation()
        {
            List<Exception> proofFailures = new List<Exception>();
            try
            {
                RequireJobHasZeroActiveProcesses();
            }
            catch (Exception error)
            {
                proofFailures.Add(error);
            }
            try
            {
                isolatedUser.RequireDisabledAndVerify();
            }
            catch (Exception error)
            {
                proofFailures.Add(error);
            }
            try
            {
                int scheduledTasks = InspectScheduledTasks();
                if (scheduledTasks != 0)
                {
                    throw new InvalidOperationException(
                        "Task Scheduler terminal zero proof failed.");
                }
            }
            catch (Exception error)
            {
                proofFailures.Add(error);
            }
            try
            {
                int bitsJobs = InspectBitsJobs();
                if (bitsJobs != 0)
                {
                    throw new InvalidOperationException(
                        "BITS terminal zero proof failed.");
                }
            }
            catch (Exception error)
            {
                proofFailures.Add(error);
            }
            try
            {
                int processes = CountProcessesByPrimaryTokenSid();
                if (processes != 0)
                {
                    throw new InvalidOperationException(
                        "Isolated-SID process terminal zero proof failed.");
                }
            }
            catch (Exception error)
            {
                proofFailures.Add(error);
            }
            if (proofFailures.Count != 0)
            {
                throw new InvalidOperationException(
                    "Terminal isolated identity zero proof failed.",
                    new AggregateException(proofFailures.ToArray()));
            }
        }

        public void QuarantineIsolatedIdentity()
        {
            ThrowIfDisposed();
            lock (quarantineSync)
            {
                if (quarantineCompleted)
                {
                    return;
                }
                if (quarantineInProgress)
                {
                    throw new InvalidOperationException(
                        "Terminal isolated identity quarantine is already in progress.");
                }
                quarantineInProgress = true;
                try
                {
                    ExecuteQuarantineSecuritySequence(
                        delegate
                        {
                            TerminateJobAndWaitForZero(
                                jobHandle,
                                1,
                                30000);
                        },
                        delegate
                        {
                            RequireJobHasZeroActiveProcesses();
                        },
                        delegate
                        {
                            isolatedUser.DisableAndVerify();
                        },
                        delegate
                        {
                            return CleanupScheduledTasks();
                        },
                        delegate
                        {
                            return CleanupBitsJobs();
                        },
                        delegate
                        {
                            return DrainProcessesByPrimaryTokenSid();
                        },
                        delegate
                        {
                            RequireFinalQuarantineIsolation();
                        },
                        MaximumIsolationRounds,
                        IsolationRoundDelayMilliseconds,
                        PostDisableSettlementMilliseconds,
                        MinimumQuarantineObservationMilliseconds);
                    quarantineCompleted = true;
                }
                finally
                {
                    quarantineInProgress = false;
                }
            }
        }

        private void RequireQuarantineCompleted(
            WindowsIsolatedUser artifactOwner)
        {
            if (!Object.ReferenceEquals(artifactOwner, isolatedUser) ||
                !String.Equals(
                    artifactOwner.Sid,
                    supervisedSid,
                    StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    "Artifact owner identity does not match the terminal quarantine identity.");
            }
            lock (quarantineSync)
            {
                if (!terminalProducerAttempted ||
                    !terminalProducerSucceeded)
                {
                    throw new InvalidOperationException(
                        "Artifact capture requires a successful terminal producer attempt.");
                }
                if (!quarantineCompleted)
                {
                    throw new InvalidOperationException(
                        "Artifact capture requires completed terminal identity quarantine.");
                }
            }
            RequireFinalQuarantineIsolation();
        }

        public WindowsValidatedArtifact CaptureIsolatedArtifact(
            WindowsIsolatedUser isolatedUser,
            string sourceRoot,
            string sourcePath,
            int maximumBytes)
        {
            ThrowIfDisposed();
            if (isolatedUser == null)
            {
                throw new ArgumentNullException("isolatedUser");
            }
            isolatedUser.ThrowIfDisposed();
            RequireQuarantineCompleted(isolatedUser);
            if (maximumBytes < 1 || maximumBytes > 16 * 1024 * 1024)
            {
                throw new ArgumentOutOfRangeException("maximumBytes");
            }
            string fullRoot = Path.GetFullPath(sourceRoot);
            if (!String.Equals(
                    TrimDirectorySeparator(fullRoot),
                    TrimDirectorySeparator(
                        Path.GetFullPath(isolatedUser.WorkspacePath)),
                    StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException(
                    "Artifact source root is not the isolated workspace.");
            }
            if (artifactBoundarySealed)
            {
                throw new InvalidOperationException(
                    "The final artifact boundary has already been consumed.");
            }
            string fullSource;
            string[] segments = GetStrictDescendantSegments(
                fullRoot,
                sourcePath,
                out fullSource);
            SecurityIdentifier current = WindowsIdentity.GetCurrent().User;
            if (current == null)
            {
                throw new InvalidOperationException(
                    "Supervisor Windows user SID is unavailable.");
            }

            WindowsSealedArtifactSource sealedSource = null;
            WindowsValidatedArtifact captured = null;
            try
            {
                ExecuteArtifactSecuritySequence(
                delegate
                {
                    RequireQuarantineCompleted(isolatedUser);
                },
                delegate
                {
                    sealedSource = SealArtifactSource(
                        isolatedUser,
                        fullRoot,
                        fullSource,
                        segments,
                        current.Value,
                        maximumBytes);
                },
                delegate
                {
                    RequirePostSealIsolation(isolatedUser);
                },
                delegate
                {
                    captured = CaptureSealedArtifact(sealedSource);
                });
                sealedIsolatedUser = isolatedUser;
                artifactBoundarySealed = true;
                return captured;
            }
            finally
            {
                if (sealedSource != null)
                {
                    sealedSource.Dispose();
                }
            }
        }

        private static WindowsSealedArtifactSource SealArtifactSource(
            WindowsIsolatedUser isolatedUser,
            string fullRoot,
            string fullSource,
            string[] segments,
            string supervisorSid,
            int maximumBytes)
        {
            List<IntPtr> parentHandles = new List<IntPtr>();
            IntPtr sourceHandle = IntPtr.Zero;
            try
            {
                string currentPath = TrimDirectorySeparator(fullRoot);
                uint rootVolume = 0;
                for (int index = 0; index < segments.Length; index++)
                {
                    if (index > 0)
                    {
                        currentPath = Path.Combine(
                            currentPath,
                            segments[index - 1]);
                    }
                    IntPtr directoryHandle =
                        OpenArtifactDirectoryForSeal(currentPath);
                    parentHandles.Add(directoryHandle);
                    ValidateDirectoryHandle(
                        directoryHandle,
                        isolatedUser.Sid,
                        supervisorSid,
                        index == 0);
                    BY_HANDLE_FILE_INFORMATION directoryInformation =
                        QueryFileInformation(
                            directoryHandle,
                            "Artifact parent identity could not be queried.");
                    if (index == 0)
                    {
                        rootVolume = directoryInformation.VolumeSerialNumber;
                    }
                    else if (directoryInformation.VolumeSerialNumber != rootVolume)
                    {
                        throw new InvalidOperationException(
                            "Artifact parent crossed the isolated workspace volume.");
                    }
                }

                SECURITY_ATTRIBUTES attributes =
                NonInheritableSecurityAttributes();
                sourceHandle = CreateFileW(
                fullSource,
                GENERIC_READ |
                    READ_CONTROL |
                    WRITE_DAC |
                    WRITE_OWNER,
                FILE_SHARE_READ,
                ref attributes,
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT,
                IntPtr.Zero);
                if (sourceHandle == new IntPtr(-1))
                {
                    sourceHandle = IntPtr.Zero;
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "Artifact record could not be pinned for sealing.");
                }
                if (GetFileType(sourceHandle) != FILE_TYPE_DISK)
                {
                    throw new InvalidOperationException(
                        "Artifact record is not a disk file.");
                }
                FILE_ATTRIBUTE_TAG_INFO attributesBefore =
                QueryAttributeTag(
                    sourceHandle,
                    "Artifact record attributes could not be queried.");
                if ((attributesBefore.FileAttributes &
                    (FILE_ATTRIBUTE_DIRECTORY |
                        FILE_ATTRIBUTE_REPARSE_POINT)) != 0)
                {
                    throw new InvalidOperationException(
                        "Artifact record is not a non-reparse regular file.");
                }
                ValidateIsolatedArtifactHandleSecurity(
                sourceHandle,
                isolatedUser.Sid,
                supervisorSid,
                false,
                false);
                BY_HANDLE_FILE_INFORMATION informationBefore =
                QueryFileInformation(
                    sourceHandle,
                    "Artifact record identity could not be queried.");
                long length = GetFileLength(informationBefore);
                if (informationBefore.NumberOfLinks != 1 ||
                length < 1 ||
                length > maximumBytes ||
                length > Int32.MaxValue)
                {
                    throw new InvalidOperationException(
                        "Artifact record link count or size is outside the trusted bound.");
                }
                if (parentHandles.Count == 0 ||
                informationBefore.VolumeSerialNumber !=
                    QueryFileInformation(
                        parentHandles[0],
                        "Artifact root identity could not be rechecked.")
                    .VolumeSerialNumber)
                {
                    throw new InvalidOperationException(
                        "Artifact record is outside the isolated workspace volume.");
                }

                SealArtifactHandle(sourceHandle, supervisorSid, false);
                for (int index = parentHandles.Count - 1; index >= 0; index--)
                {
                    SealArtifactHandle(
                        parentHandles[index],
                        supervisorSid,
                        true);
                }
                ValidateSupervisorArtifactHandleSecurity(
                sourceHandle,
                supervisorSid,
                false);
                foreach (IntPtr parentHandle in parentHandles)
                {
                    ValidateSupervisorArtifactHandleSecurity(
                        parentHandle,
                        supervisorSid,
                        true);
                }

                FILE_ATTRIBUTE_TAG_INFO attributesAfter =
                QueryAttributeTag(
                    sourceHandle,
                    "Sealed artifact attributes could not be rechecked.");
                BY_HANDLE_FILE_INFORMATION informationAfter =
                QueryFileInformation(
                    sourceHandle,
                    "Sealed artifact identity could not be rechecked.");
                if (!SameFileCaptureMetadata(
                    informationBefore,
                    informationAfter) ||
                attributesAfter.FileAttributes !=
                    attributesBefore.FileAttributes)
                {
                    throw new InvalidOperationException(
                        "Artifact record changed while its ACL was sealed.");
                }

                WindowsSealedArtifactSource result =
                new WindowsSealedArtifactSource(
                    sourceHandle,
                    parentHandles,
                    informationBefore,
                    attributesBefore,
                    checked((int)length),
                    supervisorSid);
                sourceHandle = IntPtr.Zero;
                parentHandles = null;
                return result;
            }
            finally
            {
                CloseIfValid(sourceHandle);
                if (parentHandles != null)
                {
                    for (int index = parentHandles.Count - 1;
                        index >= 0;
                        index--)
                    {
                        CloseIfValid(parentHandles[index]);
                    }
                }
            }
        }

        private static IntPtr OpenArtifactDirectoryForSeal(
            string path)
        {
            SECURITY_ATTRIBUTES attributes =
                NonInheritableSecurityAttributes();
            IntPtr handle = CreateFileW(
                path,
                FILE_READ_ATTRIBUTES |
                READ_CONTROL |
                WRITE_DAC |
                WRITE_OWNER,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                ref attributes,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS |
                FILE_FLAG_OPEN_REPARSE_POINT,
                IntPtr.Zero);
            if (handle == new IntPtr(-1))
            {
                throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                "Artifact parent could not be pinned for sealing.");
            }
            return handle;
        }

        private static void SealArtifactHandle(
            IntPtr handle,
            string supervisorSid,
            bool directory)
        {
            EnablePrivilege("SeRestorePrivilege");
            string flags = directory ? "OICI" : String.Empty;
            string sddl = "O:" + supervisorSid + "D:P" +
                "(A;" + flags + ";0x001f01ff;;;SY)" +
                "(A;" + flags + ";0x001f01ff;;;BA)" +
                "(A;" + flags + ";0x001f01ff;;;" + supervisorSid + ")";
            IntPtr descriptor;
            uint descriptorLength;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl,
                SDDL_REVISION_1,
                out descriptor,
                out descriptorLength))
            {
                throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                "Sealed artifact security descriptor creation failed.");
            }
            try
            {
                IntPtr owner;
                bool ownerDefaulted;
                bool daclPresent;
                IntPtr dacl;
                bool daclDefaulted;
                if (!GetSecurityDescriptorOwner(
                    descriptor,
                    out owner,
                    out ownerDefaulted) ||
                owner == IntPtr.Zero ||
                !GetSecurityDescriptorDacl(
                    descriptor,
                    out daclPresent,
                    out dacl,
                    out daclDefaulted) ||
                !daclPresent ||
                dacl == IntPtr.Zero)
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "Sealed artifact owner or DACL could not be read.");
                }
                uint status = SetSecurityInfo(
                handle,
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION |
                    DACL_SECURITY_INFORMATION |
                    PROTECTED_DACL_SECURITY_INFORMATION,
                owner,
                IntPtr.Zero,
                dacl,
                IntPtr.Zero);
                if (status != 0)
                {
                    throw new Win32Exception(
                        unchecked((int)status),
                        "Artifact owner or DACL could not be sealed.");
                }
            }
            finally
            {
                LocalFree(descriptor);
            }
        }

        private static WindowsValidatedArtifact CaptureSealedArtifact(
            WindowsSealedArtifactSource source)
        {
            if (source == null)
            {
                throw new InvalidOperationException(
                "Sealed artifact source is unavailable.");
            }
            byte[] bytes = new byte[source.Length];
            IntPtr handle = source.TakeSourceHandle();
            using (SafeFileHandle safeHandle =
                new SafeFileHandle(handle, true))
            using (FileStream stream = new FileStream(
                safeHandle,
                FileAccess.Read,
                4096,
                false))
            {
                int offset = 0;
                while (offset < bytes.Length)
                {
                    int read = stream.Read(
                        bytes,
                        offset,
                        bytes.Length - offset);
                    if (read == 0)
                    {
                        throw new EndOfStreamException(
                            "Artifact record ended before its sealed size.");
                    }
                    offset += read;
                }
                if (stream.ReadByte() != -1)
                {
                    throw new InvalidOperationException(
                        "Artifact record exceeded its sealed size.");
                }

                IntPtr stableHandle = safeHandle.DangerousGetHandle();
                ValidateSupervisorArtifactHandleSecurity(
                stableHandle,
                source.SupervisorSid,
                false);
                FILE_ATTRIBUTE_TAG_INFO attributesAfter =
                QueryAttributeTag(
                    stableHandle,
                    "Artifact record attributes changed during capture.");
                BY_HANDLE_FILE_INFORMATION informationAfter =
                QueryFileInformation(
                    stableHandle,
                    "Artifact record identity changed during capture.");
                if (!SameFileCaptureMetadata(
                    source.Information,
                    informationAfter) ||
                attributesAfter.FileAttributes !=
                    source.Attributes.FileAttributes ||
                (attributesAfter.FileAttributes &
                    (FILE_ATTRIBUTE_DIRECTORY |
                        FILE_ATTRIBUTE_REPARSE_POINT)) != 0)
                {
                    throw new InvalidOperationException(
                        "Artifact record changed during sealed handle capture.");
                }
            }
            return new WindowsValidatedArtifact(
                bytes,
                ComputeSha256(bytes));
        }

        private static bool SameFileCaptureMetadata(
            BY_HANDLE_FILE_INFORMATION left,
            BY_HANDLE_FILE_INFORMATION right)
        {
            return SameFileIdentity(left, right) &&
                left.NumberOfLinks == right.NumberOfLinks &&
                left.FileSizeHigh == right.FileSizeHigh &&
                left.FileSizeLow == right.FileSizeLow &&
                left.CreationTime.LowDateTime ==
                right.CreationTime.LowDateTime &&
                left.CreationTime.HighDateTime ==
                right.CreationTime.HighDateTime &&
                left.LastWriteTime.LowDateTime ==
                right.LastWriteTime.LowDateTime &&
                left.LastWriteTime.HighDateTime ==
                right.LastWriteTime.HighDateTime;
        }

        public static void RequireCanonicalSchemaV2Artifact(
            byte[] bytes,
            string expectedSha256,
            string expectedPlatform)
        {
            if (bytes == null ||
                bytes.Length < 1 ||
                bytes.Length > 1024 * 1024 ||
                String.IsNullOrWhiteSpace(expectedSha256) ||
                expectedSha256.Length != 64 ||
                String.IsNullOrWhiteSpace(expectedPlatform) ||
                !String.Equals(
                    ComputeSha256(bytes),
                    expectedSha256,
                    StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    "Handle-captured artifact digest or bound is invalid.");
            }

            try
            {
                string text = new UTF8Encoding(false, true).GetString(bytes);
                using (JsonDocument document = JsonDocument.Parse(bytes))
                {
                    JsonElement root = document.RootElement;
                    JsonElement schemaVersion;
                    JsonElement platform;
                    if (root.ValueKind != JsonValueKind.Object ||
                        !root.TryGetProperty(
                            "schemaVersion",
                            out schemaVersion) ||
                        schemaVersion.ValueKind != JsonValueKind.Number ||
                        schemaVersion.GetInt32() != 2 ||
                        !root.TryGetProperty("platform", out platform) ||
                        platform.ValueKind != JsonValueKind.String ||
                        !String.Equals(
                            platform.GetString(),
                            expectedPlatform,
                            StringComparison.Ordinal))
                    {
                        throw new InvalidOperationException();
                    }
                    byte[] canonical = SerializeCanonicalJson(root);
                    string canonicalText =
                        new UTF8Encoding(false, true).GetString(canonical) +
                        "\n";
                    if (!String.Equals(
                            text,
                            canonicalText,
                            StringComparison.Ordinal))
                    {
                        throw new InvalidOperationException();
                    }
                }
            }
            catch
            {
                throw new InvalidOperationException(
                    "Handle-captured artifact is not canonical schema-v2 evidence.");
            }
        }

        public void PublishValidatedArtifact(
            WindowsValidatedArtifact artifact,
            string destinationRoot,
            string destinationPath)
        {
            ThrowIfDisposed();
            RequireJobHasZeroActiveProcesses();
            if (!artifactBoundarySealed ||
                sealedIsolatedUser == null)
            {
                throw new InvalidOperationException(
                    "Artifact publication requires a sealed isolated boundary.");
            }
            RequirePostSealIsolation(sealedIsolatedUser);
            if (artifact == null)
            {
                throw new ArgumentNullException("artifact");
            }
            string fullRoot = Path.GetFullPath(destinationRoot);
            string fullDestination;
            string[] segments = GetStrictDescendantSegments(
                fullRoot,
                destinationPath,
                out fullDestination);
            SecurityIdentifier current = WindowsIdentity.GetCurrent().User;
            if (current == null)
            {
                throw new InvalidOperationException(
                    "Supervisor Windows user SID is unavailable.");
            }

            List<IntPtr> parentHandles = new List<IntPtr>();
            IntPtr destinationHandle = IntPtr.Zero;
            IntPtr securityDescriptor = IntPtr.Zero;
            try
            {
                string currentPath = TrimDirectorySeparator(fullRoot);
                uint rootVolume = 0;
                for (int index = 0; index < segments.Length; index++)
                {
                    if (index > 0)
                    {
                        currentPath = Path.Combine(
                            currentPath,
                            segments[index - 1]);
                    }
                    IntPtr directoryHandle = OpenArtifactDirectory(currentPath);
                    parentHandles.Add(directoryHandle);
                    ValidateSupervisorArtifactHandleSecurity(
                        directoryHandle,
                        current.Value,
                        true);
                    BY_HANDLE_FILE_INFORMATION directoryInformation =
                        QueryFileInformation(
                            directoryHandle,
                            "Artifact destination parent identity could not be queried.");
                    if (index == 0)
                    {
                        rootVolume = directoryInformation.VolumeSerialNumber;
                    }
                    else if (directoryInformation.VolumeSerialNumber != rootVolume)
                    {
                        throw new InvalidOperationException(
                            "Artifact destination parent crossed its protected volume.");
                    }
                }

                string sddl = "O:" + current.Value + "D:P" +
                    "(A;;0x001f01ff;;;SY)" +
                    "(A;;0x001f01ff;;;BA)" +
                    "(A;;0x001f01ff;;;" + current.Value + ")";
                uint descriptorLength;
                if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
                        sddl,
                        SDDL_REVISION_1,
                        out securityDescriptor,
                        out descriptorLength))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "Protected artifact descriptor creation failed.");
                }
                SECURITY_ATTRIBUTES createAttributes =
                    NonInheritableSecurityAttributes();
                createAttributes.lpSecurityDescriptor = securityDescriptor;
                destinationHandle = CreateFileW(
                    fullDestination,
                    GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
                    0,
                    ref createAttributes,
                    CREATE_NEW,
                    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
                    IntPtr.Zero);
                if (destinationHandle == new IntPtr(-1))
                {
                    destinationHandle = IntPtr.Zero;
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "Protected artifact could not be created.");
                }
                if (GetFileType(destinationHandle) != FILE_TYPE_DISK)
                {
                    throw new InvalidOperationException(
                        "Protected artifact destination is not a disk file.");
                }
                ValidateSupervisorArtifactHandleSecurity(
                    destinationHandle,
                    current.Value,
                    false);
                BY_HANDLE_FILE_INFORMATION before =
                    QueryFileInformation(
                        destinationHandle,
                        "Protected artifact identity could not be queried.");
                if (before.NumberOfLinks != 1 ||
                    parentHandles.Count == 0 ||
                    before.VolumeSerialNumber !=
                        QueryFileInformation(
                            parentHandles[0],
                            "Protected artifact root identity could not be rechecked.")
                        .VolumeSerialNumber)
                {
                    throw new InvalidOperationException(
                        "Protected artifact destination identity is invalid.");
                }

                byte[] trustedBytes = artifact.GetTrustedBytes();
                SafeFileHandle safeHandle =
                    new SafeFileHandle(destinationHandle, true);
                destinationHandle = IntPtr.Zero;
                using (safeHandle)
                using (FileStream stream = new FileStream(
                    safeHandle,
                    FileAccess.ReadWrite,
                    4096,
                    false))
                {
                    stream.Write(trustedBytes, 0, trustedBytes.Length);
                    stream.Flush();
                    if (!FlushFileBuffers(safeHandle.DangerousGetHandle()))
                    {
                        throw new Win32Exception(
                            Marshal.GetLastWin32Error(),
                            "Protected artifact flush failed.");
                    }
                    stream.Position = 0;
                    byte[] verification = new byte[trustedBytes.Length];
                    int offset = 0;
                    while (offset < verification.Length)
                    {
                        int read = stream.Read(
                            verification,
                            offset,
                            verification.Length - offset);
                        if (read == 0)
                        {
                            throw new EndOfStreamException(
                                "Protected artifact verification ended early.");
                        }
                        offset += read;
                    }
                    if (stream.ReadByte() != -1 ||
                        !BytesEqual(trustedBytes, verification) ||
                        !String.Equals(
                            artifact.Sha256,
                            ComputeSha256(verification),
                            StringComparison.Ordinal))
                    {
                        throw new InvalidOperationException(
                            "Protected artifact verification failed.");
                    }

                    IntPtr stableHandle = safeHandle.DangerousGetHandle();
                    FILE_ATTRIBUTE_TAG_INFO attributes =
                        QueryAttributeTag(
                            stableHandle,
                            "Protected artifact attributes could not be queried.");
                    BY_HANDLE_FILE_INFORMATION after =
                        QueryFileInformation(
                            stableHandle,
                            "Protected artifact identity changed during publication.");
                    if (!SameFileIdentity(before, after) ||
                        after.NumberOfLinks != 1 ||
                        GetFileLength(after) != trustedBytes.Length ||
                        (attributes.FileAttributes &
                            (FILE_ATTRIBUTE_DIRECTORY |
                                FILE_ATTRIBUTE_REPARSE_POINT)) != 0)
                    {
                        throw new InvalidOperationException(
                            "Protected artifact changed during publication.");
                    }
                }
                RequirePostSealIsolation(sealedIsolatedUser);
            }
            finally
            {
                CloseIfValid(destinationHandle);
                if (securityDescriptor != IntPtr.Zero)
                {
                    LocalFree(securityDescriptor);
                }
                for (int index = parentHandles.Count - 1; index >= 0; index--)
                {
                    CloseIfValid(parentHandles[index]);
                }
            }
        }

        private static SECURITY_ATTRIBUTES NonInheritableSecurityAttributes()
        {
            SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES();
            attributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            attributes.bInheritHandle = false;
            return attributes;
        }

        private static string[] GetStrictDescendantSegments(
            string root,
            string path,
            out string fullPath)
        {
            if (String.IsNullOrWhiteSpace(root) ||
                String.IsNullOrWhiteSpace(path) ||
                !Path.IsPathRooted(root) ||
                !Path.IsPathRooted(path))
            {
                throw new ArgumentException(
                    "Artifact paths must be absolute.");
            }
            string fullRoot = TrimDirectorySeparator(Path.GetFullPath(root));
            fullPath = Path.GetFullPath(path);
            string prefix = fullRoot + Path.DirectorySeparatorChar;
            if (!fullPath.StartsWith(
                    prefix,
                    StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException(
                    "Artifact path is outside its trusted root.");
            }
            string relative = fullPath.Substring(prefix.Length);
            string[] segments = relative.Split(
                new char[] { '\\', '/' },
                StringSplitOptions.RemoveEmptyEntries);
            if (segments.Length == 0)
            {
                throw new InvalidOperationException(
                    "Artifact path does not name a file.");
            }
            foreach (string segment in segments)
            {
                if (segment == "." ||
                    segment == ".." ||
                    segment.IndexOf(':') >= 0 ||
                    segment.EndsWith(" ", StringComparison.Ordinal) ||
                    segment.EndsWith(".", StringComparison.Ordinal))
                {
                    throw new InvalidOperationException(
                        "Artifact path contains an ambiguous segment.");
                }
            }
            string rebuilt = fullRoot;
            foreach (string segment in segments)
            {
                rebuilt = Path.Combine(rebuilt, segment);
            }
            if (!String.Equals(
                    Path.GetFullPath(rebuilt),
                    fullPath,
                    StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException(
                    "Artifact path canonicalization changed.");
            }
            return segments;
        }

        private static string TrimDirectorySeparator(string path)
        {
            string root = Path.GetPathRoot(path);
            string value = path;
            while (value.Length > root.Length &&
                (value.EndsWith("\\", StringComparison.Ordinal) ||
                    value.EndsWith("/", StringComparison.Ordinal)))
            {
                value = value.Substring(0, value.Length - 1);
            }
            return value;
        }

        private static IntPtr OpenArtifactDirectory(string path)
        {
            SECURITY_ATTRIBUTES attributes = NonInheritableSecurityAttributes();
            IntPtr handle = CreateFileW(
                path,
                FILE_READ_ATTRIBUTES | READ_CONTROL,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                ref attributes,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS |
                    FILE_FLAG_OPEN_REPARSE_POINT,
                IntPtr.Zero);
            if (handle == new IntPtr(-1))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Artifact parent could not be opened without following links.");
            }
            return handle;
        }

        private static void ValidateDirectoryHandle(
            IntPtr handle,
            string isolatedSid,
            string supervisorSid,
            bool requireProtectedDacl)
        {
            if (GetFileType(handle) != FILE_TYPE_DISK)
            {
                throw new InvalidOperationException(
                    "Artifact parent is not on disk.");
            }
            FILE_ATTRIBUTE_TAG_INFO attributes =
                QueryAttributeTag(
                    handle,
                    "Artifact parent attributes could not be queried.");
            if ((attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
                (attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
            {
                throw new InvalidOperationException(
                    "Artifact parent is not a non-reparse directory.");
            }
            ValidateIsolatedArtifactHandleSecurity(
                handle,
                isolatedSid,
                supervisorSid,
                true,
                requireProtectedDacl);
        }

        private static void ValidateIsolatedArtifactHandleSecurity(
            IntPtr handle,
            string isolatedSid,
            string supervisorSid,
            bool directory,
            bool requireProtectedDacl)
        {
            IntPtr expectedOwner = IntPtr.Zero;
            IntPtr expectedSystem = IntPtr.Zero;
            IntPtr expectedAdministrators = IntPtr.Zero;
            IntPtr expectedSupervisor = IntPtr.Zero;
            IntPtr expectedOwnerRights = IntPtr.Zero;
            IntPtr owner = IntPtr.Zero;
            IntPtr dacl = IntPtr.Zero;
            IntPtr descriptor = IntPtr.Zero;
            try
            {
                expectedOwner = ConvertSid(
                    isolatedSid,
                    "Artifact owner SID conversion failed.");
                expectedSystem = ConvertSid(
                    "S-1-5-18",
                    "SYSTEM SID conversion failed.");
                expectedAdministrators = ConvertSid(
                    "S-1-5-32-544",
                    "Administrators SID conversion failed.");
                expectedSupervisor = ConvertSid(
                    supervisorSid,
                    "Supervisor SID conversion failed.");
                expectedOwnerRights = ConvertSid(
                    "S-1-3-4",
                    "Owner Rights SID conversion failed.");
                uint status = GetSecurityInfo(
                    handle,
                    SE_FILE_OBJECT,
                    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                    out owner,
                    IntPtr.Zero,
                    out dacl,
                    IntPtr.Zero,
                    out descriptor);
                if (status != 0 ||
                    owner == IntPtr.Zero ||
                    dacl == IntPtr.Zero ||
                    descriptor == IntPtr.Zero ||
                    !EqualSid(owner, expectedOwner))
                {
                    throw new InvalidOperationException(
                        "Artifact owner or DACL is not exact.");
                }
                ushort control;
                uint revision;
                if (!GetSecurityDescriptorControl(
                        descriptor,
                        out control,
                        out revision) ||
                    (requireProtectedDacl &&
                        (control & SE_DACL_PROTECTED) == 0))
                {
                    throw new InvalidOperationException(
                        "Artifact DACL control is not restrictive.");
                }
                ACL_SIZE_INFORMATION aclInformation;
                if (!GetAclInformation(
                        dacl,
                        out aclInformation,
                        (uint)Marshal.SizeOf(typeof(ACL_SIZE_INFORMATION)),
                        AclSizeInformation) ||
                    aclInformation.AceCount != 5)
                {
                    throw new InvalidOperationException(
                        "Artifact DACL must contain exactly five ACEs.");
                }

                bool foundSystem = false;
                bool foundAdministrators = false;
                bool foundSupervisor = false;
                bool foundOwner = false;
                bool foundOwnerRights = false;
                for (uint index = 0; index < aclInformation.AceCount; index++)
                {
                    IntPtr acePointer;
                    if (!GetAce(dacl, index, out acePointer) ||
                        acePointer == IntPtr.Zero)
                    {
                        throw new InvalidOperationException(
                            "Artifact DACL ACE could not be read.");
                    }
                    ACCESS_ALLOWED_ACE ace =
                        (ACCESS_ALLOWED_ACE)Marshal.PtrToStructure(
                            acePointer,
                            typeof(ACCESS_ALLOWED_ACE));
                    byte allowedFlags = OBJECT_INHERIT_ACE |
                        CONTAINER_INHERIT_ACE |
                        NO_PROPAGATE_INHERIT_ACE |
                        INHERITED_ACE;
                    if (ace.Header.AceType != ACCESS_ALLOWED_ACE_TYPE ||
                        (ace.Header.AceFlags & ~allowedFlags) != 0 ||
                        (ace.Header.AceFlags & INHERIT_ONLY_ACE) != 0)
                    {
                        throw new InvalidOperationException(
                            "Artifact DACL contains an unexpected ACE.");
                    }
                    IntPtr aceSid = new IntPtr(
                        acePointer.ToInt64() +
                        Marshal.OffsetOf(
                            typeof(ACCESS_ALLOWED_ACE),
                            "SidStart").ToInt64());
                    if (EqualSid(aceSid, expectedSystem) &&
                        ace.Mask == FILE_ALL_ACCESS &&
                        !foundSystem)
                    {
                        foundSystem = true;
                    }
                    else if (EqualSid(aceSid, expectedAdministrators) &&
                        ace.Mask == FILE_ALL_ACCESS &&
                        !foundAdministrators)
                    {
                        foundAdministrators = true;
                    }
                    else if (EqualSid(aceSid, expectedSupervisor) &&
                        ace.Mask == FILE_ALL_ACCESS &&
                        !foundSupervisor)
                    {
                        foundSupervisor = true;
                    }
                    else if (EqualSid(aceSid, expectedOwner) &&
                        ace.Mask == FILE_MODIFY_ACCESS &&
                        !foundOwner)
                    {
                        foundOwner = true;
                    }
                    else if (EqualSid(aceSid, expectedOwnerRights) &&
                        ace.Mask == READ_CONTROL &&
                        !foundOwnerRights)
                    {
                        foundOwnerRights = true;
                    }
                    else
                    {
                        throw new InvalidOperationException(
                            "Artifact DACL trustee or access mask is not exact.");
                    }
                }
                if (!foundSystem ||
                    !foundAdministrators ||
                    !foundSupervisor ||
                    !foundOwner ||
                    !foundOwnerRights)
                {
                    throw new InvalidOperationException(
                        "Artifact DACL is incomplete.");
                }
            }
            finally
            {
                if (descriptor != IntPtr.Zero)
                {
                    LocalFree(descriptor);
                }
                FreeLocalSid(expectedOwnerRights);
                FreeLocalSid(expectedSupervisor);
                FreeLocalSid(expectedAdministrators);
                FreeLocalSid(expectedSystem);
                FreeLocalSid(expectedOwner);
            }
        }

        private static void ValidateSupervisorArtifactHandleSecurity(
            IntPtr handle,
            string supervisorSid,
            bool directory)
        {
            IntPtr expectedOwner = IntPtr.Zero;
            IntPtr expectedSystem = IntPtr.Zero;
            IntPtr expectedAdministrators = IntPtr.Zero;
            IntPtr owner = IntPtr.Zero;
            IntPtr dacl = IntPtr.Zero;
            IntPtr descriptor = IntPtr.Zero;
            try
            {
                expectedOwner = ConvertSid(
                    supervisorSid,
                    "Supervisor owner SID conversion failed.");
                expectedSystem = ConvertSid(
                    "S-1-5-18",
                    "SYSTEM SID conversion failed.");
                expectedAdministrators = ConvertSid(
                    "S-1-5-32-544",
                    "Administrators SID conversion failed.");
                uint status = GetSecurityInfo(
                    handle,
                    SE_FILE_OBJECT,
                    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                    out owner,
                    IntPtr.Zero,
                    out dacl,
                    IntPtr.Zero,
                    out descriptor);
                if (status != 0 ||
                    owner == IntPtr.Zero ||
                    dacl == IntPtr.Zero ||
                    descriptor == IntPtr.Zero ||
                    !EqualSid(owner, expectedOwner))
                {
                    throw new InvalidOperationException(
                        "Protected artifact owner or DACL is not exact.");
                }
                ushort control;
                uint revision;
                ACL_SIZE_INFORMATION aclInformation;
                if (!GetSecurityDescriptorControl(
                        descriptor,
                        out control,
                        out revision) ||
                    (control & SE_DACL_PROTECTED) == 0 ||
                    !GetAclInformation(
                        dacl,
                        out aclInformation,
                        (uint)Marshal.SizeOf(typeof(ACL_SIZE_INFORMATION)),
                        AclSizeInformation) ||
                    aclInformation.AceCount != 3)
                {
                    throw new InvalidOperationException(
                        "Protected artifact DACL is not private.");
                }
                bool foundSystem = false;
                bool foundAdministrators = false;
                bool foundSupervisor = false;
                for (uint index = 0; index < aclInformation.AceCount; index++)
                {
                    IntPtr acePointer;
                    if (!GetAce(dacl, index, out acePointer) ||
                        acePointer == IntPtr.Zero)
                    {
                        throw new InvalidOperationException(
                            "Protected artifact DACL ACE could not be read.");
                    }
                    ACCESS_ALLOWED_ACE ace =
                        (ACCESS_ALLOWED_ACE)Marshal.PtrToStructure(
                            acePointer,
                            typeof(ACCESS_ALLOWED_ACE));
                    byte expectedFlags = directory
                        ? (byte)(OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)
                        : (byte)0;
                    if (ace.Header.AceType != ACCESS_ALLOWED_ACE_TYPE ||
                        ace.Header.AceFlags != expectedFlags ||
                        ace.Mask != FILE_ALL_ACCESS)
                    {
                        throw new InvalidOperationException(
                            "Protected artifact DACL contains an unexpected ACE.");
                    }
                    IntPtr aceSid = new IntPtr(
                        acePointer.ToInt64() +
                        Marshal.OffsetOf(
                            typeof(ACCESS_ALLOWED_ACE),
                            "SidStart").ToInt64());
                    if (EqualSid(aceSid, expectedSystem) && !foundSystem)
                    {
                        foundSystem = true;
                    }
                    else if (EqualSid(
                            aceSid,
                            expectedAdministrators) &&
                        !foundAdministrators)
                    {
                        foundAdministrators = true;
                    }
                    else if (EqualSid(aceSid, expectedOwner) &&
                        !foundSupervisor)
                    {
                        foundSupervisor = true;
                    }
                    else
                    {
                        throw new InvalidOperationException(
                            "Protected artifact DACL trustee is not exact.");
                    }
                }
                if (!foundSystem ||
                    !foundAdministrators ||
                    !foundSupervisor)
                {
                    throw new InvalidOperationException(
                        "Protected artifact DACL is incomplete.");
                }
            }
            finally
            {
                if (descriptor != IntPtr.Zero)
                {
                    LocalFree(descriptor);
                }
                FreeLocalSid(expectedAdministrators);
                FreeLocalSid(expectedSystem);
                FreeLocalSid(expectedOwner);
            }
        }

        private static FILE_ATTRIBUTE_TAG_INFO QueryAttributeTag(
            IntPtr handle,
            string failure)
        {
            FILE_ATTRIBUTE_TAG_INFO information;
            if (!GetFileInformationByHandleEx(
                    handle,
                    9,
                    out information,
                    (uint)Marshal.SizeOf(typeof(FILE_ATTRIBUTE_TAG_INFO))))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    failure);
            }
            return information;
        }

        private static BY_HANDLE_FILE_INFORMATION QueryFileInformation(
            IntPtr handle,
            string failure)
        {
            BY_HANDLE_FILE_INFORMATION information;
            if (!GetFileInformationByHandle(handle, out information))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    failure);
            }
            return information;
        }

        private static bool SameFileIdentity(
            BY_HANDLE_FILE_INFORMATION left,
            BY_HANDLE_FILE_INFORMATION right)
        {
            return left.VolumeSerialNumber == right.VolumeSerialNumber &&
                left.FileIndexHigh == right.FileIndexHigh &&
                left.FileIndexLow == right.FileIndexLow;
        }

        private static long GetFileLength(
            BY_HANDLE_FILE_INFORMATION information)
        {
            ulong length = ((ulong)information.FileSizeHigh << 32) |
                information.FileSizeLow;
            if (length > Int64.MaxValue)
            {
                throw new InvalidOperationException(
                    "Artifact file size is not representable.");
            }
            return checked((long)length);
        }

        private static string ComputeSha256(byte[] bytes)
        {
            using (SHA256 hash = SHA256.Create())
            {
                return BitConverter.ToString(hash.ComputeHash(bytes))
                    .Replace("-", String.Empty)
                    .ToLowerInvariant();
            }
        }

        private static byte[] SerializeCanonicalJson(JsonElement root)
        {
            using (MemoryStream output = new MemoryStream())
            {
                JsonWriterOptions options = new JsonWriterOptions();
                options.Indented = true;
                options.Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping;
                using (Utf8JsonWriter writer = new Utf8JsonWriter(
                    output,
                    options))
                {
                    WriteCanonicalJson(writer, root);
                    writer.Flush();
                }
                return output.ToArray();
            }
        }

        private static void WriteCanonicalJson(
            Utf8JsonWriter writer,
            JsonElement value)
        {
            switch (value.ValueKind)
            {
                case JsonValueKind.Object:
                    writer.WriteStartObject();
                    List<JsonProperty> properties =
                        new List<JsonProperty>();
                    HashSet<string> names =
                        new HashSet<string>(StringComparer.Ordinal);
                    foreach (JsonProperty property in value.EnumerateObject())
                    {
                        if (!names.Add(property.Name))
                        {
                            throw new InvalidOperationException();
                        }
                        properties.Add(property);
                    }
                    properties.Sort(delegate (
                        JsonProperty left,
                        JsonProperty right)
                    {
                        return StringComparer.Ordinal.Compare(
                            left.Name,
                            right.Name);
                    });
                    foreach (JsonProperty property in properties)
                    {
                        writer.WritePropertyName(property.Name);
                        WriteCanonicalJson(writer, property.Value);
                    }
                    writer.WriteEndObject();
                    return;
                case JsonValueKind.Array:
                    writer.WriteStartArray();
                    foreach (JsonElement item in value.EnumerateArray())
                    {
                        WriteCanonicalJson(writer, item);
                    }
                    writer.WriteEndArray();
                    return;
                case JsonValueKind.String:
                    writer.WriteStringValue(value.GetString());
                    return;
                case JsonValueKind.Number:
                    long signed;
                    ulong unsigned;
                    decimal decimalValue;
                    double doubleValue;
                    if (value.TryGetInt64(out signed))
                    {
                        writer.WriteNumberValue(signed);
                    }
                    else if (value.TryGetUInt64(out unsigned))
                    {
                        writer.WriteNumberValue(unsigned);
                    }
                    else if (value.TryGetDecimal(out decimalValue))
                    {
                        writer.WriteNumberValue(decimalValue);
                    }
                    else if (value.TryGetDouble(out doubleValue))
                    {
                        writer.WriteNumberValue(doubleValue);
                    }
                    else
                    {
                        throw new InvalidOperationException();
                    }
                    return;
                case JsonValueKind.True:
                    writer.WriteBooleanValue(true);
                    return;
                case JsonValueKind.False:
                    writer.WriteBooleanValue(false);
                    return;
                case JsonValueKind.Null:
                    writer.WriteNullValue();
                    return;
                default:
                    throw new InvalidOperationException();
            }
        }

        private static bool BytesEqual(byte[] left, byte[] right)
        {
            if (left.Length != right.Length)
            {
                return false;
            }
            int difference = 0;
            for (int index = 0; index < left.Length; index++)
            {
                difference |= left[index] ^ right[index];
            }
            return difference == 0;
        }

        private void RequireJobHasZeroActiveProcesses()
        {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
            if (!QueryInformationJobObject(
                    jobHandle,
                    JobObjectBasicAccountingInformation,
                    out accounting,
                    (uint)Marshal.SizeOf(
                        typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)),
                    IntPtr.Zero))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Supervised Job Object state could not be queried.");
            }
            if (accounting.ActiveProcesses != 0)
            {
                throw new InvalidOperationException(
                    "Artifact handoff requires zero active supervised processes.");
            }
        }

        public WindowsJobRunResult RunAsUser(
            WindowsIsolatedUser isolatedUser,
            string applicationName,
            string arguments,
            string workingDirectory,
            IDictionary environment,
            TimeSpan TotalTimeout,
            int MaxStdoutBytes,
            int MaxStderrBytes)
        {
            return RunAsUser(
                isolatedUser,
                applicationName,
                arguments,
                workingDirectory,
                environment,
                TotalTimeout,
                MaxStdoutBytes,
                MaxStderrBytes,
                new WindowsDirectoryQuota[0]);
        }

        public WindowsJobRunResult RunAsUserWithStandardInput(
            WindowsIsolatedUser isolatedUser,
            string applicationName,
            string arguments,
            string workingDirectory,
            IDictionary environment,
            TimeSpan TotalTimeout,
            int MaxStdoutBytes,
            int MaxStderrBytes,
            byte[] StandardInput)
        {
            if (StandardInput == null)
            {
                throw new ArgumentNullException("StandardInput");
            }
            return RunAsUserCore(
                isolatedUser,
                applicationName,
                arguments,
                workingDirectory,
                environment,
                TotalTimeout,
                MaxStdoutBytes,
                MaxStderrBytes,
                new WindowsDirectoryQuota[0],
                (byte[])StandardInput.Clone());
        }

        public WindowsJobRunResult RunAsUser(
            WindowsIsolatedUser isolatedUser,
            string applicationName,
            string arguments,
            string workingDirectory,
            IDictionary environment,
            TimeSpan TotalTimeout,
            int MaxStdoutBytes,
            int MaxStderrBytes,
            WindowsDirectoryQuota[] DirectoryQuotas)
        {
            return RunAsUserCore(
                isolatedUser,
                applicationName,
                arguments,
                workingDirectory,
                environment,
                TotalTimeout,
                MaxStdoutBytes,
                MaxStderrBytes,
                DirectoryQuotas,
                null);
        }

        public WindowsJobRunResult RunProducerAsUserAndQuarantine(
            WindowsIsolatedUser isolatedUser,
            string applicationName,
            string arguments,
            string workingDirectory,
            IDictionary environment,
            TimeSpan TotalTimeout,
            int MaxStdoutBytes,
            int MaxStderrBytes)
        {
            return RunProducerAsUserAndQuarantineCore(
                isolatedUser,
                applicationName,
                arguments,
                workingDirectory,
                environment,
                TotalTimeout,
                MaxStdoutBytes,
                MaxStderrBytes,
                new WindowsDirectoryQuota[0]);
        }

        public WindowsJobRunResult RunProducerAsUserAndQuarantine(
            WindowsIsolatedUser isolatedUser,
            string applicationName,
            string arguments,
            string workingDirectory,
            IDictionary environment,
            TimeSpan TotalTimeout,
            int MaxStdoutBytes,
            int MaxStderrBytes,
            WindowsDirectoryQuota[] DirectoryQuotas)
        {
            return RunProducerAsUserAndQuarantineCore(
                isolatedUser,
                applicationName,
                arguments,
                workingDirectory,
                environment,
                TotalTimeout,
                MaxStdoutBytes,
                MaxStderrBytes,
                DirectoryQuotas);
        }

        private WindowsJobRunResult RunProducerAsUserAndQuarantineCore(
            WindowsIsolatedUser isolatedUser,
            string applicationName,
            string arguments,
            string workingDirectory,
            IDictionary environment,
            TimeSpan TotalTimeout,
            int MaxStdoutBytes,
            int MaxStderrBytes,
            WindowsDirectoryQuota[] DirectoryQuotas)
        {
            ThrowIfDisposed();
            if (isolatedUser == null)
            {
                throw new ArgumentNullException("isolatedUser");
            }
            isolatedUser.ThrowIfDisposed();
            if (!Object.ReferenceEquals(isolatedUser, this.isolatedUser) ||
                !String.Equals(
                    isolatedUser.Sid,
                    supervisedSid,
                    StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    "Terminal producer identity does not match the Job Object identity.");
            }
            lock (quarantineSync)
            {
                if (terminalProducerAttempted)
                {
                    throw new InvalidOperationException(
                        "A terminal producer attempt has already been made.");
                }
                terminalProducerAttempted = true;
                terminalProducerSucceeded = false;
            }
            isolatedUser.RegisterTerminalQuarantine(
                QuarantineIsolatedIdentity,
                delegate
                {
                    return IsQuarantineComplete;
                });

            WindowsJobRunResult result = null;
            Exception producerFailure = null;
            Exception quarantineFailure = null;
            try
            {
                result = RunAsUserCore(
                    isolatedUser,
                    applicationName,
                    arguments,
                    workingDirectory,
                    environment,
                    TotalTimeout,
                    MaxStdoutBytes,
                    MaxStderrBytes,
                    DirectoryQuotas,
                    null);
                lock (quarantineSync)
                {
                    terminalProducerSucceeded =
                        result.ExitCode == 0 &&
                        !result.TimedOut &&
                        !result.StdoutOverflow &&
                        !result.StderrOverflow &&
                        !result.ResourceQuotaExceeded;
                }
            }
            catch (Exception error)
            {
                producerFailure = error;
            }
            finally
            {
                try
                {
                    QuarantineIsolatedIdentity();
                }
                catch (Exception error)
                {
                    quarantineFailure = error;
                }
            }
            if (producerFailure != null && quarantineFailure != null)
            {
                throw new InvalidOperationException(
                    "Terminal producer attempt and identity quarantine both failed.",
                    new AggregateException(
                        producerFailure,
                        quarantineFailure));
            }
            if (producerFailure != null)
            {
                throw new InvalidOperationException(
                    "Terminal producer attempt failed.",
                    producerFailure);
            }
            if (quarantineFailure != null)
            {
                throw new InvalidOperationException(
                    "Terminal producer identity quarantine failed.",
                    quarantineFailure);
            }
            return result;
        }

        private WindowsJobRunResult RunAsUserCore(
            WindowsIsolatedUser isolatedUser,
            string applicationName,
            string arguments,
            string workingDirectory,
            IDictionary environment,
            TimeSpan TotalTimeout,
            int MaxStdoutBytes,
            int MaxStderrBytes,
            WindowsDirectoryQuota[] DirectoryQuotas,
            byte[] StandardInput)
        {
            ThrowIfDisposed();
            if (isolatedUser == null)
            {
                throw new ArgumentNullException("isolatedUser");
            }
            isolatedUser.ThrowIfDisposed();
            isolatedUser.RequireEnabledForLogon();
            if (!String.Equals(
                    isolatedUser.Sid,
                    supervisedSid,
                    StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    "Job Object restricted identity does not match the launch identity.");
            }
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
            if (DirectoryQuotas == null)
            {
                throw new ArgumentNullException("DirectoryQuotas");
            }
            foreach (WindowsDirectoryQuota quota in DirectoryQuotas)
            {
                if (quota == null)
                {
                    throw new ArgumentException(
                        "Directory quotas may not contain null entries.",
                        "DirectoryQuotas");
                }
            }

            SECURITY_ATTRIBUTES inheritable = new SECURITY_ATTRIBUTES();
            inheritable.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            inheritable.bInheritHandle = true;
            IntPtr stdoutRead = IntPtr.Zero;
            IntPtr stdoutWrite = IntPtr.Zero;
            IntPtr stderrRead = IntPtr.Zero;
            IntPtr stderrWrite = IntPtr.Zero;
            IntPtr stdinRead = IntPtr.Zero;
            IntPtr stdinWrite = IntPtr.Zero;
            PROCESS_INFORMATION process = new PROCESS_INFORMATION();
            IntPtr environmentBlock = IntPtr.Zero;
            Task<PipeCapture> stdoutTask = null;
            Task<PipeCapture> stderrTask = null;
            Task inputTask = null;
            Task quotaTask = null;
            CancellationTokenSource quotaCancellation = new CancellationTokenSource();
            ManualResetEventSlim overflow = new ManualResetEventSlim(false);
            ManualResetEventSlim resourceQuotaExceeded = new ManualResetEventSlim(false);

            try
            {
                CreateBoundedPipe(inheritable, out stdoutRead, out stdoutWrite);
                CreateBoundedPipe(inheritable, out stderrRead, out stderrWrite);
                if (StandardInput == null)
                {
                    stdinRead = CreateFileW(
                        "NUL",
                        GENERIC_READ,
                        FILE_SHARE_READ | FILE_SHARE_WRITE,
                        ref inheritable,
                        OPEN_EXISTING,
                        FILE_ATTRIBUTE_NORMAL,
                        IntPtr.Zero);
                    if (stdinRead == new IntPtr(-1))
                    {
                        stdinRead = IntPtr.Zero;
                        throw new Win32Exception(
                            Marshal.GetLastWin32Error(),
                            "Opening NUL failed.");
                    }
                }
                else
                {
                    if (!CreatePipe(
                            out stdinRead,
                            out stdinWrite,
                            ref inheritable,
                            0))
                    {
                        throw new Win32Exception(
                            Marshal.GetLastWin32Error(),
                            "Creating standard input pipe failed.");
                    }
                    if (!SetHandleInformation(
                            stdinWrite,
                            HANDLE_FLAG_INHERIT,
                            0))
                    {
                        throw new Win32Exception(
                            Marshal.GetLastWin32Error(),
                            "Protecting standard input pipe failed.");
                    }
                }

                STARTUPINFO startup = new STARTUPINFO();
                startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                startup.dwFlags = STARTF_USESTDHANDLES;
                startup.hStdInput = stdinRead;
                startup.hStdOutput = stdoutWrite;
                startup.hStdError = stderrWrite;
                environmentBlock = BuildEnvironmentBlock(
                    environment,
                    isolatedUser,
                    jobHandle);
                StringBuilder commandLine = new StringBuilder();
                commandLine.Append(QuoteArgument(applicationName));
                if (!String.IsNullOrWhiteSpace(arguments))
                {
                    commandLine.Append(' ');
                    commandLine.Append(arguments);
                }

                bool created = CreateProcessWithLogonW(
                    isolatedUser.UserName,
                    Environment.MachineName,
                    isolatedUser.Password,
                    LOGON_WITH_PROFILE,
                    applicationName,
                    commandLine,
                    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                    environmentBlock,
                    workingDirectory,
                    ref startup,
                    out process);
                if (!created)
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "CreateProcessWithLogonW failed.");
                }

                CloseHandle(stdoutWrite);
                stdoutWrite = IntPtr.Zero;
                CloseHandle(stderrWrite);
                stderrWrite = IntPtr.Zero;
                CloseHandle(stdinRead);
                stdinRead = IntPtr.Zero;

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
                ProtectRootProcess(process.hProcess, isolatedUser.Sid);

                stdoutTask = ReadPipeAsync(stdoutRead, MaxStdoutBytes, overflow);
                stdoutRead = IntPtr.Zero;
                stderrTask = ReadPipeAsync(stderrRead, MaxStderrBytes, overflow);
                stderrRead = IntPtr.Zero;
                if (DirectoryQuotas.Length > 0)
                {
                    quotaTask = MonitorDirectoryQuotasAsync(
                        DirectoryQuotas,
                        resourceQuotaExceeded,
                        quotaCancellation.Token);
                }

                uint resumeResult = ResumeThread(process.hThread);
                if (resumeResult == UInt32.MaxValue)
                {
                    TerminateJobObject(jobHandle, 1);
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread failed.");
                }
                if (StandardInput != null)
                {
                    inputTask = WritePipeAsync(stdinWrite, StandardInput);
                    stdinWrite = IntPtr.Zero;
                }

                Stopwatch timer = Stopwatch.StartNew();
                bool timedOut = false;
                bool quotaExceeded = false;
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
                    if (
                        overflow.IsSet ||
                        resourceQuotaExceeded.IsSet ||
                        timer.Elapsed >= TotalTimeout)
                    {
                        timedOut = timer.Elapsed >= TotalTimeout;
                        quotaExceeded = resourceQuotaExceeded.IsSet;
                        if (!TerminateJobObject(jobHandle, 1))
                        {
                            throw new Win32Exception(
                                Marshal.GetLastWin32Error(),
                                "TerminateJobObject failed.");
                        }
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
                TerminateJobAndWaitForZero(
                    jobHandle,
                    nativeExitCode == 0 ? 1u : nativeExitCode,
                    30000);

                quotaExceeded = quotaExceeded || resourceQuotaExceeded.IsSet;
                if (DirectoryQuotas.Length > 0)
                {
                    quotaExceeded =
                        DirectoryQuotasExceeded(DirectoryQuotas) || quotaExceeded;
                }
                quotaCancellation.Cancel();
                if (quotaTask != null && !quotaTask.Wait(30000))
                {
                    TerminateJobObject(jobHandle, 1);
                    throw new TimeoutException("Directory quota monitor could not be reaped.");
                }

                List<Task> ioTasks = new List<Task>();
                ioTasks.Add(stdoutTask);
                ioTasks.Add(stderrTask);
                if (inputTask != null)
                {
                    ioTasks.Add(inputTask);
                }
                if (!Task.WaitAll(ioTasks.ToArray(), 30000))
                {
                    TerminateJobObject(jobHandle, 1);
                    throw new TimeoutException("Supervised output readers could not be reaped.");
                }
                PipeCapture stdout = stdoutTask.Result;
                PipeCapture stderr = stderrTask.Result;
                bool outputOverflow = stdout.Overflow || stderr.Overflow;
                return new WindowsJobRunResult
                {
                    ExitCode = timedOut || outputOverflow || quotaExceeded
                        ? SupervisorFailureExitCode
                        : exitCode,
                    TimedOut = timedOut,
                    StdoutOverflow = stdout.Overflow,
                    StderrOverflow = stderr.Overflow,
                    ResourceQuotaExceeded = quotaExceeded,
                    Stdout = stdout.Text,
                    Stderr = stderr.Text,
                };
            }
            catch
            {
                if (process.hProcess != IntPtr.Zero)
                {
                    try
                    {
                        TerminateJobAndWaitForZero(jobHandle, 1, 30000);
                    }
                    catch
                    {
                        TerminateJobObject(jobHandle, 1);
                    }
                    WaitForSingleObject(process.hProcess, 30000);
                }
                throw;
            }
            finally
            {
                quotaCancellation.Cancel();
                if (quotaTask != null)
                {
                    try
                    {
                        quotaTask.Wait(30000);
                    }
                    catch (AggregateException)
                    {
                    }
                }
                if (inputTask != null)
                {
                    try
                    {
                        inputTask.Wait(30000);
                    }
                    catch (AggregateException)
                    {
                    }
                }
                quotaCancellation.Dispose();
                resourceQuotaExceeded.Dispose();
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
                CloseIfValid(stdinRead);
                CloseIfValid(stdinWrite);
            }
        }

        private static void TerminateJobAndWaitForZero(
            IntPtr job,
            uint exitCode,
            int timeoutMilliseconds)
        {
            if (!TerminateJobObject(job, exitCode))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "TerminateJobObject failed during final teardown.");
            }

            Stopwatch timer = Stopwatch.StartNew();
            while (true)
            {
                JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
                if (!QueryInformationJobObject(
                        job,
                        JobObjectBasicAccountingInformation,
                        out accounting,
                        (uint)Marshal.SizeOf(
                            typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)),
                        IntPtr.Zero))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "QueryInformationJobObject failed during final teardown.");
                }
                if (accounting.ActiveProcesses == 0)
                {
                    return;
                }
                if (timer.ElapsedMilliseconds >= timeoutMilliseconds)
                {
                    throw new TimeoutException(
                        "Supervised Job Object processes could not be reaped.");
                }
                Thread.Sleep(10);
            }
        }

        private static Task MonitorDirectoryQuotasAsync(
            WindowsDirectoryQuota[] quotas,
            ManualResetEventSlim exceeded,
            CancellationToken cancellationToken)
        {
            return Task.Run(delegate
            {
                while (!cancellationToken.IsCancellationRequested)
                {
                    try
                    {
                        if (DirectoryQuotasExceeded(quotas))
                        {
                            exceeded.Set();
                            return;
                        }
                    }
                    catch
                    {
                        exceeded.Set();
                        return;
                    }
                    if (cancellationToken.WaitHandle.WaitOne(1000))
                    {
                        return;
                    }
                }
            });
        }

        private static bool DirectoryQuotasExceeded(WindowsDirectoryQuota[] quotas)
        {
            foreach (WindowsDirectoryQuota quota in quotas)
            {
                long total = 0;
                foreach (string path in ExpandQuotaPattern(quota.PathPattern))
                {
                    total = checked(
                        total + MeasureDirectoryBytes(
                            path,
                            quota.MaxBytes - Math.Min(total, quota.MaxBytes)));
                    if (total > quota.MaxBytes)
                    {
                        return true;
                    }
                }
            }
            return false;
        }

        private static IEnumerable<string> ExpandQuotaPattern(string pattern)
        {
            string root = Path.GetPathRoot(pattern);
            string relative = pattern.Substring(root.Length);
            string[] segments = relative.Split(
                new char[] { '\\', '/' },
                StringSplitOptions.RemoveEmptyEntries);
            List<string> candidates = new List<string>();
            candidates.Add(root);
            foreach (string segment in segments)
            {
                List<string> next = new List<string>();
                foreach (string candidate in candidates)
                {
                    if (!Directory.Exists(candidate))
                    {
                        continue;
                    }
                    if (segment.IndexOf('*') >= 0)
                    {
                        foreach (string matched in Directory.GetDirectories(
                            candidate,
                            segment,
                            SearchOption.TopDirectoryOnly))
                        {
                            next.Add(matched);
                        }
                    }
                    else
                    {
                        string child = Path.Combine(candidate, segment);
                        if (Directory.Exists(child))
                        {
                            next.Add(child);
                        }
                    }
                }
                candidates = next;
                if (candidates.Count == 0)
                {
                    break;
                }
            }
            return candidates;
        }

        private static long MeasureDirectoryBytes(string root, long remaining)
        {
            long total = 0;
            int entries = 0;
            Stack<string> directories = new Stack<string>();
            directories.Push(root);
            while (directories.Count > 0)
            {
                string directory = directories.Pop();
                FileAttributes directoryAttributes = File.GetAttributes(directory);
                if ((directoryAttributes & FileAttributes.ReparsePoint) != 0)
                {
                    continue;
                }
                foreach (string entry in Directory.EnumerateFileSystemEntries(directory))
                {
                    entries++;
                    if (entries > MaximumQuotaEntries)
                    {
                        throw new IOException("Directory quota entry bound exceeded.");
                    }
                    FileAttributes attributes = File.GetAttributes(entry);
                    if ((attributes & FileAttributes.ReparsePoint) != 0)
                    {
                        continue;
                    }
                    if ((attributes & FileAttributes.Directory) != 0)
                    {
                        directories.Push(entry);
                    }
                    else
                    {
                        total = checked(total + new FileInfo(entry).Length);
                        if (total > remaining)
                        {
                            return total;
                        }
                    }
                }
            }
            return total;
        }

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }
            List<Exception> cleanupFailures = new List<Exception>();
            if (terminalProducerAttempted && !IsQuarantineComplete)
            {
                try
                {
                    QuarantineIsolatedIdentity();
                }
                catch (Exception error)
                {
                    cleanupFailures.Add(error);
                }
            }
            disposed = true;
            IntPtr handle = jobHandle;
            jobHandle = IntPtr.Zero;
            if (handle != IntPtr.Zero)
            {
                try
                {
                    TerminateJobAndWaitForZero(handle, 1, 30000);
                }
                catch (Exception error)
                {
                    cleanupFailures.Add(error);
                }
                if (!CloseHandle(handle))
                {
                    cleanupFailures.Add(new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "Job Object handle could not be closed."));
                }
            }
            GC.SuppressFinalize(this);
            if (cleanupFailures.Count != 0)
            {
                throw new InvalidOperationException(
                    "Job Object cleanup failed.",
                    new AggregateException(cleanupFailures.ToArray()));
            }
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

        private static Task WritePipeAsync(IntPtr handle, byte[] bytes)
        {
            SafeFileHandle safeHandle = new SafeFileHandle(handle, true);
            return Task.Run(delegate
            {
                using (safeHandle)
                using (FileStream stream = new FileStream(
                    safeHandle,
                    FileAccess.Write,
                    4096,
                    false))
                {
                    stream.Write(bytes, 0, bytes.Length);
                    stream.Flush();
                }
            });
        }

        private static IntPtr BuildEnvironmentBlock(
            IDictionary environment,
            WindowsIsolatedUser isolatedUser,
            IntPtr authoritativeJobHandle)
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
                    values[key] = value;
                }
            }
            values["USERNAME"] = isolatedUser.UserName;
            values["USERDOMAIN"] = Environment.MachineName;
            values["OPENCOVEN_WINDOWS_RESTRICTED_USER_SID"] = isolatedUser.Sid;
            values["OPENCOVEN_WINDOWS_SUPERVISOR_PID"] =
                Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture);
            values["OPENCOVEN_WINDOWS_SUPERVISOR_JOB_HANDLE"] =
                authoritativeJobHandle.ToInt64().ToString(CultureInfo.InvariantCulture);

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

        private sealed class ScheduledTaskReference
        {
            internal string FolderPath;
            internal string Name;
            internal string Path;
        }

        private sealed class WindowsSealedArtifactSource : IDisposable
        {
            private IntPtr sourceHandle;
            private List<IntPtr> parentHandles;

            internal WindowsSealedArtifactSource(
                IntPtr source,
                List<IntPtr> parents,
                BY_HANDLE_FILE_INFORMATION information,
                FILE_ATTRIBUTE_TAG_INFO attributes,
                int length,
                string supervisorSid)
            {
                sourceHandle = source;
                parentHandles = parents;
                Information = information;
                Attributes = attributes;
                Length = length;
                SupervisorSid = supervisorSid;
            }

            internal BY_HANDLE_FILE_INFORMATION Information;
            internal FILE_ATTRIBUTE_TAG_INFO Attributes;
            internal int Length;
            internal string SupervisorSid;

            internal IntPtr TakeSourceHandle()
            {
                IntPtr handle = sourceHandle;
                sourceHandle = IntPtr.Zero;
                if (handle == IntPtr.Zero)
                {
                    throw new InvalidOperationException(
                        "Sealed artifact source handle was already consumed.");
                }
                return handle;
            }

            public void Dispose()
            {
                CloseIfValid(sourceHandle);
                sourceHandle = IntPtr.Zero;
                if (parentHandles != null)
                {
                    for (int index = parentHandles.Count - 1;
                        index >= 0;
                        index--)
                    {
                        CloseIfValid(parentHandles[index]);
                    }
                    parentHandles = null;
                }
            }
        }

        [ComImport]
        [Guid("4991D34B-80A1-4291-83B6-3328366B9097")]
        private class BackgroundCopyManager
        {
        }

        [ComImport]
        [Guid("5CE34C0D-0DC9-4C1F-897C-DAA1B78CEE7C")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IBackgroundCopyManager
        {
            [PreserveSig]
            int CreateJob(
                [MarshalAs(UnmanagedType.LPWStr)] string displayName,
                uint type,
                out Guid jobId,
                out IBackgroundCopyJob job);

            [PreserveSig]
            int GetJob(
                ref Guid jobId,
                out IBackgroundCopyJob job);

            [PreserveSig]
            int EnumJobs(
                uint flags,
                out IEnumBackgroundCopyJobs jobs);

            [PreserveSig]
            int GetErrorDescription(
                int result,
                uint languageId,
                out IntPtr description);
        }

        [ComImport]
        [Guid("1AF4F612-3B71-466F-8F58-7B6F73AC57AD")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IEnumBackgroundCopyJobs
        {
            [PreserveSig]
            int Next(
                uint count,
                out IBackgroundCopyJob job,
                out uint fetched);

            [PreserveSig]
            int Skip(uint count);

            [PreserveSig]
            int Reset();

            [PreserveSig]
            int Clone(out IEnumBackgroundCopyJobs jobs);

            [PreserveSig]
            int GetCount(out uint count);
        }

        [ComImport]
        [Guid("37668D37-507E-4160-9316-26306D150B12")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IBackgroundCopyJob
        {
            [PreserveSig]
            int AddFileSet(uint count, IntPtr fileSet);

            [PreserveSig]
            int AddFile(
                [MarshalAs(UnmanagedType.LPWStr)] string remoteUrl,
                [MarshalAs(UnmanagedType.LPWStr)] string localName);

            [PreserveSig]
            int EnumFiles(out IntPtr files);

            [PreserveSig]
            int Suspend();

            [PreserveSig]
            int Resume();

            [PreserveSig]
            int Cancel();

            [PreserveSig]
            int Complete();

            [PreserveSig]
            int GetId(out Guid jobId);

            [PreserveSig]
            int GetType(out uint type);

            [PreserveSig]
            int GetProgress(out BG_JOB_PROGRESS progress);

            [PreserveSig]
            int GetTimes(out BG_JOB_TIMES times);

            [PreserveSig]
            int GetState(out uint state);

            [PreserveSig]
            int GetError(out IntPtr error);

            [PreserveSig]
            int GetOwner(out IntPtr owner);
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SECURITY_ATTRIBUTES
        {
            internal int nLength;
            internal IntPtr lpSecurityDescriptor;
            [MarshalAs(UnmanagedType.Bool)]
            internal bool bInheritHandle;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ACL_SIZE_INFORMATION
        {
            internal uint AceCount;
            internal uint AclBytesInUse;
            internal uint AclBytesFree;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ACE_HEADER
        {
            internal byte AceType;
            internal byte AceFlags;
            internal ushort AceSize;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ACCESS_ALLOWED_ACE
        {
            internal ACE_HEADER Header;
            internal uint Mask;
            internal uint SidStart;
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
        private struct LUID
        {
            internal uint LowPart;
            internal int HighPart;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct TOKEN_PRIVILEGES
        {
            internal uint PrivilegeCount;
            internal LUID Luid;
            internal uint Attributes;
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
        private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
        {
            internal long TotalUserTime;
            internal long TotalKernelTime;
            internal long ThisPeriodTotalUserTime;
            internal long ThisPeriodTotalKernelTime;
            internal uint TotalPageFaultCount;
            internal uint TotalProcesses;
            internal uint ActiveProcesses;
            internal uint TotalTerminatedProcesses;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct FILE_ATTRIBUTE_TAG_INFO
        {
            internal uint FileAttributes;
            internal uint ReparseTag;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct NATIVE_FILETIME
        {
            internal uint LowDateTime;
            internal uint HighDateTime;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct BG_JOB_PROGRESS
        {
            internal ulong BytesTotal;
            internal ulong BytesTransferred;
            internal uint FilesTotal;
            internal uint FilesTransferred;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct BG_JOB_TIMES
        {
            internal NATIVE_FILETIME CreationTime;
            internal NATIVE_FILETIME ModificationTime;
            internal NATIVE_FILETIME TransferCompletionTime;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SID_AND_ATTRIBUTES
        {
            internal IntPtr Sid;
            internal uint Attributes;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct TOKEN_USER
        {
            internal SID_AND_ATTRIBUTES User;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WTS_PROCESS_INFO_EXW
        {
            internal uint SessionId;
            internal uint ProcessId;
            internal IntPtr pProcessName;
            internal IntPtr pUserSid;
            internal uint NumberOfThreads;
            internal uint HandleCount;
            internal uint PagefileUsage;
            internal uint PeakPagefileUsage;
            internal uint WorkingSetSize;
            internal uint PeakWorkingSetSize;
            internal long UserTime;
            internal long KernelTime;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct BY_HANDLE_FILE_INFORMATION
        {
            internal uint FileAttributes;
            internal NATIVE_FILETIME CreationTime;
            internal NATIVE_FILETIME LastAccessTime;
            internal NATIVE_FILETIME LastWriteTime;
            internal uint VolumeSerialNumber;
            internal uint FileSizeHigh;
            internal uint FileSizeLow;
            internal uint NumberOfLinks;
            internal uint FileIndexHigh;
            internal uint FileIndexLow;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObjectW(
            ref SECURITY_ATTRIBUTES attributes,
            string name);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
            string stringSecurityDescriptor,
            uint stringSecurityDescriptorRevision,
            out IntPtr securityDescriptor,
            out uint securityDescriptorSize);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ConvertStringSidToSidW(
            string stringSid,
            out IntPtr sid);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ConvertSidToStringSidW(
            IntPtr sid,
            out IntPtr stringSid);

        [DllImport("advapi32.dll")]
        private static extern uint GetSecurityInfo(
            IntPtr handle,
            int objectType,
            uint securityInformation,
            out IntPtr owner,
            IntPtr group,
            out IntPtr dacl,
            IntPtr sacl,
            out IntPtr securityDescriptor);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
        private static extern uint GetNamedSecurityInfoW(
            string objectName,
            int objectType,
            uint securityInformation,
            out IntPtr owner,
            IntPtr group,
            out IntPtr dacl,
            IntPtr sacl,
            out IntPtr securityDescriptor);

        [DllImport("advapi32.dll")]
        private static extern uint SetSecurityInfo(
            IntPtr handle,
            int objectType,
            uint securityInformation,
            IntPtr owner,
            IntPtr group,
            IntPtr dacl,
            IntPtr sacl);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetFileSecurityW(
            string fileName,
            uint securityInformation,
            IntPtr securityDescriptor);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetKernelObjectSecurity(
            IntPtr handle,
            uint securityInformation,
            IntPtr securityDescriptor);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetSecurityDescriptorControl(
            IntPtr securityDescriptor,
            out ushort control,
            out uint revision);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetSecurityDescriptorOwner(
            IntPtr securityDescriptor,
            out IntPtr owner,
            [MarshalAs(UnmanagedType.Bool)] out bool ownerDefaulted);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetSecurityDescriptorDacl(
            IntPtr securityDescriptor,
            [MarshalAs(UnmanagedType.Bool)] out bool daclPresent,
            out IntPtr dacl,
            [MarshalAs(UnmanagedType.Bool)] out bool daclDefaulted);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetAclInformation(
            IntPtr acl,
            out ACL_SIZE_INFORMATION information,
            uint informationLength,
            int informationClass);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetAce(IntPtr acl, uint aceIndex, out IntPtr ace);

        [DllImport("advapi32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool EqualSid(IntPtr sid1, IntPtr sid2);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CheckTokenMembership(
            IntPtr token,
            IntPtr sidToCheck,
            [MarshalAs(UnmanagedType.Bool)] out bool isMember);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool OpenProcessToken(
            IntPtr process,
            uint desiredAccess,
            out IntPtr token);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetTokenInformation(
            IntPtr token,
            int tokenInformationClass,
            IntPtr tokenInformation,
            uint tokenInformationLength,
            out uint returnLength);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool LookupPrivilegeValueW(
            string systemName,
            string name,
            out LUID luid);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AdjustTokenPrivileges(
            IntPtr token,
            bool disableAllPrivileges,
            ref TOKEN_PRIVILEGES newState,
            uint bufferLength,
            IntPtr previousState,
            IntPtr returnLength);

        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr memory);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetInformationJobObject(
            IntPtr job,
            int informationClass,
            IntPtr information,
            uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool QueryInformationJobObject(
            IntPtr job,
            int informationClass,
            out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information,
            uint informationLength,
            IntPtr returnLength);

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

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateProcessWithLogonW(
            string userName,
            string domain,
            string password,
            uint logonFlags,
            string applicationName,
            StringBuilder commandLine,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref STARTUPINFO startupInfo,
            out PROCESS_INFORMATION processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(
            uint desiredAccess,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
            uint processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool DuplicateHandle(
            IntPtr sourceProcess,
            IntPtr sourceHandle,
            IntPtr targetProcess,
            out IntPtr targetHandle,
            uint desiredAccess,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
            uint options);

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
        private static extern bool GetFileInformationByHandle(
            IntPtr file,
            out BY_HANDLE_FILE_INFORMATION information);

        [DllImport("kernel32.dll")]
        private static extern uint GetFileType(IntPtr file);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool FlushFileBuffers(IntPtr file);

        [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool DeleteProfileW(
            string sidString,
            string profilePath,
            string computerName);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool DeleteFileW(string fileName);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool RemoveDirectoryW(string pathName);

        [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool WTSEnumerateProcessesExW(
            IntPtr server,
            ref uint level,
            uint sessionId,
            out IntPtr processInfo,
            out uint count);

        [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool WTSFreeMemoryExW(
            int typeClass,
            IntPtr memory,
            uint count);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);
    }
}
