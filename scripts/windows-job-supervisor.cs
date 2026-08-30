using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
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
        private const uint UF_NORMAL_ACCOUNT = 0x0200;
        private const uint UF_DONT_EXPIRE_PASSWD = 0x10000;
        private const int LOGON32_LOGON_INTERACTIVE = 2;
        private const int LOGON32_PROVIDER_DEFAULT = 0;
        private const int ERROR_INSUFFICIENT_BUFFER = 122;
        private const int MaximumAccountCreationAttempts = 8;

        private string password;
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
                return password;
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
                    (value.usri1_flags & UF_NORMAL_ACCOUNT) == 0)
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
            disposed = true;
            Exception failure = null;
            try
            {
                WindowsJobSupervisor.DeleteOperatingSystemProfile(
                    Sid,
                    OperatingSystemProfilePath);
            }
            catch (Exception error)
            {
                failure = error;
            }
            try
            {
                WindowsJobSupervisor.DeleteDirectoryTree(RootPath);
            }
            catch (Exception error)
            {
                if (failure == null)
                {
                    failure = error;
                }
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
                if (failure == null)
                {
                    failure = error;
                }
            }
            password = null;
            if (Directory.Exists(OperatingSystemProfilePath))
            {
                failure = failure ?? new InvalidOperationException(
                    "Ephemeral Windows profile survived cleanup.");
            }
            if (Directory.Exists(RootPath))
            {
                failure = failure ?? new InvalidOperationException(
                    "Ephemeral bootstrap root survived cleanup.");
            }
            GC.SuppressFinalize(this);
            if (failure != null)
            {
                throw new InvalidOperationException(
                    "Ephemeral Windows identity cleanup failed.",
                    failure);
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
        private const uint PROCESS_DUP_HANDLE = 0x00000040;
        private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x00001000;
        private const uint READ_CONTROL = 0x00020000;
        private const uint WRITE_DAC = 0x00040000;
        private const uint WRITE_OWNER = 0x00080000;
        private const uint SYNCHRONIZE = 0x00100000;
        private const uint PROCESS_ALL_ACCESS = 0x001fffff;
        private const uint FILE_ALL_ACCESS = 0x001f01ff;
        private const uint FILE_MODIFY_ACCESS = 0x001301bf;
        private const uint OWNER_SECURITY_INFORMATION = 0x00000001;
        private const uint DACL_SECURITY_INFORMATION = 0x00000004;
        private const uint PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000;
        private const ushort SE_DACL_PROTECTED = 0x1000;
        private const byte ACCESS_ALLOWED_ACE_TYPE = 0x00;
        private const byte OBJECT_INHERIT_ACE = 0x01;
        private const byte CONTAINER_INHERIT_ACE = 0x02;
        private const int SE_KERNEL_OBJECT = 6;
        private const int SE_FILE_OBJECT = 1;
        private const int AclSizeInformation = 2;
        private const uint SDDL_REVISION_1 = 1;
        private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
        private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
        private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
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

        private IntPtr jobHandle;
        private readonly string supervisedSid;
        private bool disposed;

        private WindowsJobSupervisor(IntPtr handle, string isolatedSid)
        {
            jobHandle = handle;
            supervisedSid = isolatedSid;
        }

        public long AuthoritativeHandleValue
        {
            get
            {
                ThrowIfDisposed();
                return jobHandle.ToInt64();
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
                    return new WindowsJobSupervisor(handle, isolatedUser.Sid);
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
            string sddl = "D:P" +
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
                    "Supervisor process security descriptor creation failed.");
            }
            try
            {
                if (!SetKernelObjectSecurity(
                        GetCurrentProcess(),
                        DACL_SECURITY_INFORMATION |
                            PROTECTED_DACL_SECURITY_INFORMATION,
                        securityDescriptor))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "Supervisor process DACL could not be protected.");
                }
            }
            finally
            {
                LocalFree(securityDescriptor);
            }
            ValidateSupervisorProcessSecurity(isolatedSid, supervisorSid);
        }

        private static void ValidateSupervisorProcessSecurity(
            string isolatedSid,
            string supervisorSid)
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
                    GetCurrentProcess(),
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
                        "Supervisor process owner or DACL is not exact.");
                }
                ushort control;
                uint revision;
                if (!GetSecurityDescriptorControl(descriptor, out control, out revision) ||
                    (control & SE_DACL_PROTECTED) == 0)
                {
                    throw new InvalidOperationException(
                        "Supervisor process DACL is not protected.");
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
                        "Supervisor process DACL must contain exactly four ACEs.");
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
                            "Supervisor process DACL ACE could not be read.");
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
                            "Supervisor process DACL contains an unexpected ACE.");
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
                        !foundRestricted)
                    {
                        foundRestricted = true;
                    }
                    else
                    {
                        throw new InvalidOperationException(
                            "Supervisor process DACL trustee or access mask is not exact.");
                    }
                }
                if (!foundSystem ||
                    !foundAdministrators ||
                    !foundSupervisor ||
                    !foundRestricted)
                {
                    throw new InvalidOperationException(
                        "Supervisor process DACL is incomplete.");
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
            ThrowIfDisposed();
            if (isolatedUser == null)
            {
                throw new ArgumentNullException("isolatedUser");
            }
            isolatedUser.ThrowIfDisposed();
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
            IntPtr stdinHandle = IntPtr.Zero;
            PROCESS_INFORMATION process = new PROCESS_INFORMATION();
            IntPtr environmentBlock = IntPtr.Zero;
            Task<PipeCapture> stdoutTask = null;
            Task<PipeCapture> stderrTask = null;
            Task quotaTask = null;
            CancellationTokenSource quotaCancellation = new CancellationTokenSource();
            ManualResetEventSlim overflow = new ManualResetEventSlim(false);
            ManualResetEventSlim resourceQuotaExceeded = new ManualResetEventSlim(false);

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
                    true,
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
                CloseIfValid(stdinHandle);
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
            if (!disposed)
            {
                disposed = true;
                IntPtr handle = jobHandle;
                jobHandle = IntPtr.Zero;
                Exception failure = null;
                if (handle != IntPtr.Zero)
                {
                    try
                    {
                        TerminateJobAndWaitForZero(handle, 1, 30000);
                    }
                    catch (Exception error)
                    {
                        failure = error;
                    }
                    CloseHandle(handle);
                }
                GC.SuppressFinalize(this);
                if (failure != null)
                {
                    throw new InvalidOperationException(
                        "Job Object cleanup failed.",
                        failure);
                }
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
            bool inheritHandles,
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

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);
    }
}
