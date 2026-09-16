param([switch]$CompileOnly, [switch]$PortableOnly)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not ($CompileOnly -or $PortableOnly) -and -not $IsWindows) { throw 'Residual cleanup regression requires native Windows.' }
$source = if ($env:OPENCOVEN_WINDOWS_JOB_SUPERVISOR_SOURCE) {
  $env:OPENCOVEN_WINDOWS_JOB_SUPERVISOR_SOURCE
} else { Join-Path $PSScriptRoot 'windows-job-supervisor.cs' }
if (-not ('OpenCoven.WindowsJobSupervisor' -as [type])) {
  Add-Type -TypeDefinition ([IO.File]::ReadAllText($source))
}
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;
namespace OpenCoven.Tests {
    public static class ProfileResidualNativeFixture {
        [DllImport("userenv.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool DeleteProfileW(string sid, string path, string computer);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateHardLinkW(string link, string target, IntPtr security);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(string path, uint access, uint sharing,
            IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool DeviceIoControl(SafeFileHandle handle, uint control, byte[] input,
            uint inputSize, IntPtr output, uint outputSize, out uint returned, IntPtr overlapped);
        [DllImport("advapi32.dll", ExactSpelling = true)]
        private static extern uint SetSecurityInfo(SafeFileHandle handle, uint type, uint information,
            IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
        [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
        private static extern int NetUserDel(string server, string user);
        [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
        private static extern int NetUserGetInfo(string server, string user, int level, out IntPtr info);
        [DllImport("netapi32.dll")]
        private static extern int NetApiBufferFree(IntPtr info);
        public static bool Registered(string sid) {
            using (var key = Registry.LocalMachine.OpenSubKey(
                @"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\" + sid))
                return key != null;
        }
        public static void Unregister(string sid, string path) {
            bool accepted = DeleteProfileW(sid, path, null);
            int error = Marshal.GetLastWin32Error();
            if (!accepted && error != 2 && error != 3 && error != 1168)
                throw new Win32Exception(error, "Fixture userenv removal failed.");
            if (Registered(sid)) throw new InvalidOperationException("Fixture registration survived userenv removal.");
        }
        public static void Link(string link, string target) {
            if (!CreateHardLinkW(link, target, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Fixture hard-link creation failed.");
        }
        public static int DeleteAccess(string path) {
            using (var handle = CreateFileW(path, 0x00010000, 7, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero))
                return handle.IsInvalid ? Marshal.GetLastWin32Error() : 0;
        }
        public static int ReadAccess(string path) {
            using (var handle = CreateFileW(path, 0x00120081, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero))
                return handle.IsInvalid ? Marshal.GetLastWin32Error() : 0;
        }
        public static void SetReadDenial(string path, bool denied) {
            SetReadDenialWithAccess(path, denied, 0x00060000, 0x80000004);
        }
        private static void SetReadDenialWithAccess(string path, bool denied, uint access, uint information) {
            using (var user = WindowsIdentity.GetCurrent()) {
                if (user.User == null) throw new InvalidOperationException("Fixture supervisor SID unavailable.");
                var acl = new RawSecurityDescriptor("D:P" + (denied ? "(D;;0x1;;;WD)" : "") +
                    "(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;" + user.User.Value + ")").DiscretionaryAcl;
                byte[] bytes = new byte[acl.BinaryLength];
                acl.GetBinaryForm(bytes, 0);
                IntPtr native = Marshal.AllocHGlobal(bytes.Length);
                try {
                    Marshal.Copy(bytes, 0, native, bytes.Length);
                    // Set only the retained entry's DACL, never the junction target's ACL.
                    using (var handle = CreateFileW(path, access, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
                        if (handle.IsInvalid)
                            throw new Win32Exception(Marshal.GetLastWin32Error(), "Fixture ACL handle unavailable.");
                        uint status = SetSecurityInfo(handle, 1, information, IntPtr.Zero, IntPtr.Zero, native, IntPtr.Zero);
                        if (status != 0) throw new Win32Exception((int)status, "Fixture read denial could not be set.");
                    }
                } finally { Marshal.FreeHGlobal(native); }
            }
        }
        public static void CompareReadDenialControls(string root) {
            Directory.CreateDirectory(root);
            uint[] access = { 0x00040000, 0x00060000, 0x00040000 };
            uint[] information = { 0x80000004, 0x80000004, 0x00000004 };
            string[] labels = { "baseline", "read-control", "unprotected-control" };
            var cleanupFailures = new List<Exception>();
            int contractFailures = 0;
            for (int index = 0; index < labels.Length; index++) {
                string path = Path.Combine(root, index.ToString() + ".bin");
                string phase = "create";
                try {
                    File.WriteAllText(path, "owned");
                    phase = "install";
                    SetReadDenialWithAccess(path, true, access[index], information[index]);
                    phase = "denied-read";
                    int denied = ReadAccess(path);
                    Console.WriteLine("Native ACL comparison: control=" + labels[index] + ";denied-read=" + denied);
                    phase = "restore";
                    SetReadDenialWithAccess(path, false, access[index], information[index]);
                    phase = "restored-read";
                    int restored = ReadAccess(path);
                    Console.WriteLine("Native ACL comparison: control=" + labels[index] + ";restored-read=" + restored);
                    if (index != 1 || denied != 5 || restored != 0) {
                        contractFailures++;
                        Console.WriteLine("Native ACL comparison: control=" + labels[index] + ";contract=mismatch");
                    }
                } catch (Exception error) {
                    string operation = error is Win32Exception && error.Message == "Fixture ACL handle unavailable." ? "open" :
                        error is Win32Exception && error.Message == "Fixture read denial could not be set." ? "set" : "other";
                    Console.WriteLine("Native ACL comparison: control=" + labels[index] + ";phase=" + phase +
                        ";operation=" + operation + ";cause=" + FailureCategory(error));
                    if (index == 1 || phase != "install" || operation != "set" ||
                        !(error is Win32Exception nativeError) || nativeError.NativeErrorCode != 5)
                        contractFailures++;
                } finally {
                    try { File.Delete(path); } catch (Exception error) { cleanupFailures.Add(error); }
                }
            }
            try { Directory.Delete(root); } catch (Exception error) { cleanupFailures.Add(error); }
            if (cleanupFailures.Count != 0)
                throw new InvalidOperationException("Native ACL comparison fixture cleanup failed: count=" + cleanupFailures.Count + ".",
                    new AggregateException(cleanupFailures));
            if (contractFailures != 0)
                throw new InvalidOperationException("Native ACL comparison contract failed: count=" + contractFailures + ".");
        }
        private static object Invoke(MethodInfo method, params object[] args) {
            try { return method.Invoke(null, args); }
            catch (TargetInvocationException error) {
                ExceptionDispatchInfo.Capture(error.InnerException).Throw();
                throw;
            }
        }
        private static void SetJunctionInPlace(string directory, string target) {
            byte[] substitute = Encoding.Unicode.GetBytes(@"\??\" + target);
            byte[] print = Encoding.Unicode.GetBytes(target);
            byte[] buffer = new byte[16 + substitute.Length + 2 + print.Length + 2];
            Array.Copy(BitConverter.GetBytes(0xa0000003u), 0, buffer, 0, 4);
            Array.Copy(BitConverter.GetBytes(checked((ushort)(buffer.Length - 8))), 0, buffer, 4, 2);
            Array.Copy(BitConverter.GetBytes(checked((ushort)substitute.Length)), 0, buffer, 10, 2);
            Array.Copy(BitConverter.GetBytes(checked((ushort)(substitute.Length + 2))), 0, buffer, 12, 2);
            Array.Copy(BitConverter.GetBytes(checked((ushort)print.Length)), 0, buffer, 14, 2);
            Array.Copy(substitute, 0, buffer, 16, substitute.Length);
            Array.Copy(print, 0, buffer, 18 + substitute.Length, print.Length);
            using (var mutation = CreateFileW(directory, 0x40000000, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
                if (mutation.IsInvalid)
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "In-place junction writer could not be opened.");
                uint returned;
                if (!DeviceIoControl(mutation, 0x000900a4, buffer, (uint)buffer.Length, IntPtr.Zero, 0, out returned, IntPtr.Zero))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "In-place junction conversion did not establish the race.");
            }
        }
        public static void RequireInPlaceConfinement(Type supervisor, string directory, string target) {
            var flags = BindingFlags.Static | BindingFlags.NonPublic;
            var query = supervisor.GetMethod("QueryFileInformation", flags);
            var tag = supervisor.GetMethod("QueryAttributeTag", flags);
            var same = supervisor.GetMethod("SameFileIdentity", flags);
            var contents = supervisor.GetMethod("DeleteProfileResidualDirectoryContents", flags);
            var relative = supervisor.GetMethod("OpenProfileResidualRelative", flags);
            if (query == null || tag == null || same == null || contents == null || relative == null)
                throw new InvalidOperationException("Retained-directory confinement seams are missing.");
            string canary = Path.Combine(target, "keep.bin");
            using (var parent = CreateFileW(Path.GetDirectoryName(directory), 0x00120081, 3,
                IntPtr.Zero, 3, 0x02200000, IntPtr.Zero))
            using (var retained = CreateFileW(directory, 0x00130081, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
                if (parent.IsInvalid || retained.IsInvalid)
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Fixture directory retention failed.");
                object before = Invoke(query, retained.DangerousGetHandle(), "Fixture identity unavailable.");
                object attributes = Invoke(tag, retained.DangerousGetHandle(), "Fixture attributes unavailable.");
                uint value = (uint)attributes.GetType().GetField("FileAttributes", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(attributes);
                if ((value & 0x410) != 0x10 || Directory.GetFileSystemEntries(directory).Length != 0)
                    throw new InvalidOperationException("The in-place conversion control was not an empty ordinary directory.");
                uint volume = (uint)before.GetType().GetField("VolumeSerialNumber", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(before);
                using (var external = File.Open(canary, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
                    object outside = Invoke(query, external.SafeFileHandle.DangerousGetHandle(), "Fixture sentinel identity unavailable.");
                    if (volume != (uint)outside.GetType().GetField("VolumeSerialNumber", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(outside))
                        throw new InvalidOperationException("The junction sentinel is not on the same volume.");
                }
                // Deterministically occupy the production boundary after handle inspection and
                // before enumeration/child open. No rename or fabricated retained handle is involved.
                SetJunctionInPlace(directory, target);
                object after = Invoke(query, retained.DangerousGetHandle(), "Converted identity unavailable.");
                if (!(bool)Invoke(same, before, after) ||
                    (File.GetAttributes(directory) & FileAttributes.ReparsePoint) == 0)
                    throw new InvalidOperationException("The conversion did not preserve the inspected directory identity.");
                string enumeration = "completed", relativeOpen = "missing";
                try {
                    Invoke(contents, parent, Path.GetFileName(directory), retained, volume,
                        System.Diagnostics.Stopwatch.StartNew(), 2, 0);
                } catch (Win32Exception error) when (error.GetType().Name == "CleanupDeleteException") {
                    enumeration = "win32-" + error.NativeErrorCode;
                } catch (InvalidOperationException error) when (
                    error.Message == "Residual enumeration requires the same ordinary directory.") {
                    enumeration = "changed-directory";
                }
                SafeFileHandle escaped = null;
                try {
                    escaped = (SafeFileHandle)Invoke(relative, retained, "keep.bin", true, 3, "child", false);
                    if (escaped != null)
                        throw new InvalidOperationException("Relative child lookup escaped into the junction target.");
                } catch (Win32Exception error) when (error.GetType().Name == "CleanupDeleteException") {
                    relativeOpen = "win32-" + error.NativeErrorCode;
                } finally { if (escaped != null) escaped.Dispose(); }
                if (!File.Exists(canary) || File.ReadAllText(canary) != "external-canary")
                    throw new InvalidOperationException("In-place conversion redirected cleanup into the external sentinel.");
                Console.WriteLine("Native in-place junction observation: enumeration=" + enumeration + ";relative-open=" + relativeOpen);
            }
        }
        public static void RunTeardown(Action[] stages) {
            if (stages == null || stages.Length > 32)
                throw new ArgumentException("Fixture teardown stages are outside their bound.");
            var failures = new List<Exception>();
            var failedStages = new List<string>();
            var categories = new List<string>();
            for (int index = 0; index < stages.Length; index++) {
                try { stages[index](); }
                catch (Exception error) {
                    failures.Add(error);
                    failedStages.Add(index.ToString(System.Globalization.CultureInfo.InvariantCulture));
                    categories.Add(FailureCategory(error));
                }
            }
            if (failures.Count != 0)
                throw new InvalidOperationException(
                    "Native residual fixture teardown failed: stages=" + String.Join(",", failedStages) +
                        ". causes=" + String.Join(",", categories) + ".",
                    new AggregateException(failures.ToArray()));
        }
        public static string FailureCategory(Exception error) {
            Exception root = error.GetBaseException();
            var native = root as Win32Exception;
            if (native != null) return "win32-" + native.NativeErrorCode;
            return (root is EntryPointNotFoundException ? "entry-point" :
                root is DllNotFoundException ? "dll" :
                root is UnauthorizedAccessException ? "access-denied" :
                root is InvalidOperationException ? "invalid-operation" : "managed") +
                ":" + unchecked((uint)root.HResult).ToString("x8");
        }
        public static void TestTeardown() {
            string root = Path.Combine(Path.GetTempPath(), "opencoven-teardown-" + Guid.NewGuid().ToString("N"));
            string external = root + "-external";
            Directory.CreateDirectory(root);
            Directory.CreateDirectory(external);
            string file = Path.Combine(root, "held");
            var held = File.Open(file, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
            var holder = new DelayedHolder(held, Task.FromException(new TimeoutException("injected-private-poll-failure")));
            var calls = new List<string>();
            Exception failure = null;
            try {
                try {
                    RunTeardown(new Action[] {
                        () => { calls.Add("holder"); holder.Dispose(); },
                        () => { calls.Add("job"); },
                        () => { calls.Add("pins"); },
                        () => { calls.Add("token"); },
                        () => { calls.Add("profile"); File.Delete(file); },
                        () => { calls.Add("account"); throw new InvalidOperationException("injected-private-account-failure"); },
                        () => { calls.Add("root"); Directory.Delete(root); },
                        () => { calls.Add("external"); Directory.Delete(external); }
                    });
                } catch (Exception error) when (error is InvalidOperationException || error is TimeoutException) {
                    failure = error;
                }
                if (String.Join(",", calls) != "holder,job,pins,token,profile,account,root,external" ||
                    Directory.Exists(root) || Directory.Exists(external))
                    throw new InvalidOperationException("A faulted polling task skipped remaining fixture teardown stages.");
                var aggregate = failure == null ? null : failure.InnerException as AggregateException;
                if (aggregate == null || aggregate.InnerExceptions.Count != 2 ||
                    failure.Message.Contains("injected-private") || failure.Message.Contains(root) ||
                    !failure.Message.Contains("causes=managed:80131505,invalid-operation:80131509."))
                    throw new InvalidOperationException("Fixture teardown did not retain both failures with a bounded outer diagnostic.");
            } finally {
                held.Dispose();
                if (Directory.Exists(root)) Directory.Delete(root, true);
                if (Directory.Exists(external)) Directory.Delete(external, true);
            }
        }
        public static void RemoveAccount(string user) {
            int result = NetUserDel(null, user);
            if (result != 0 && result != 2221)
                throw new Win32Exception(result, "Fixture account removal failed.");
            IntPtr info;
            result = NetUserGetInfo(null, user, 0, out info);
            try {
                if (result != 2221) throw new InvalidOperationException("Fixture account survived cleanup.");
            } finally { if (info != IntPtr.Zero) NetApiBufferFree(info); }
        }
        public static void FailQuarantine() { throw new InvalidOperationException("injected-incomplete-quarantine"); }
        public static bool Incomplete() { return false; }
        public sealed class DelayedHolder : IDisposable {
            private readonly FileStream stream;
            private readonly ManualResetEventSlim stop = new ManualResetEventSlim();
            private readonly Task release;
            public bool Released { get; private set; }
            internal DelayedHolder(FileStream held, Task releaseTask) {
                stream = held;
                release = releaseTask;
            }
            public DelayedHolder(object application, FileStream held, string sid) {
                stream = held;
                var pin = (SafeFileHandle)application.GetType().GetField("profile",
                    BindingFlags.Instance | BindingFlags.NonPublic).GetValue(application);
                release = Task.Run(() => {
                    var timer = System.Diagnostics.Stopwatch.StartNew();
                    while (!pin.IsClosed || Registered(sid)) {
                        if (stop.Wait(10)) return;
                        if (timer.Elapsed > TimeSpan.FromSeconds(15))
                            throw new TimeoutException("Production profile pin release was not observed.");
                    }
                    // Synchronize on actual pin release and userenv unregistration, not startup time.
                    if (stop.Wait(300)) return;
                    stream.Dispose();
                    Released = true;
                });
            }
            public void Dispose() {
                stop.Set();
                try { release.GetAwaiter().GetResult(); }
                finally { stream.Dispose(); stop.Dispose(); }
            }
            public void RequireReleased() {
                release.GetAwaiter().GetResult();
                if (!Released) throw new InvalidOperationException("The delayed holder was not released at the cleanup boundary.");
            }
        }
    }
}
'@
if ($CompileOnly) {
  Write-Host 'Native residual fixture compiled; Windows behavior was not executed.'
  return
}
[OpenCoven.Tests.ProfileResidualNativeFixture]::TestTeardown()
$teardownCalls = [Collections.Generic.List[int]]::new()
$teardownRejected = $false
try {
  [OpenCoven.Tests.ProfileResidualNativeFixture]::RunTeardown([Action[]]@(
    { $teardownCalls.Add(0); throw 'injected-private-powershell-stage' },
    { $teardownCalls.Add(1) },
    { $teardownCalls.Add(2) }
  ))
} catch {
  $teardownRejected = $_.Exception.Message.Contains('stages=0.')
}
if (-not $teardownRejected -or ($teardownCalls -join ',') -cne '0,1,2') {
  throw 'PowerShell teardown delegates did not continue after a failed stage.'
}
Write-Host 'Portable residual fixture teardown regression passed.'

$static = [Reflection.BindingFlags]'NonPublic,Static'
$instance = [Reflection.BindingFlags]'NonPublic,Instance'
$register = [OpenCoven.WindowsIsolatedUser].GetMethod('RegisterTerminalQuarantine', $instance)
$applicationField = [OpenCoven.WindowsIsolatedUser].GetField('ownedApplication', $instance)
$quotaField = [OpenCoven.WindowsIsolatedUser].GetField('quotaToken', $instance)
$unloadProfile = [OpenCoven.WindowsIsolatedUser].GetMethod('UnloadOwnedProfile', $instance)
$deleteTree = [OpenCoven.WindowsJobSupervisor].GetMethod('DeleteDirectoryTree', $static)
$residual = [OpenCoven.WindowsJobSupervisor].GetMethod('DeleteOwnedProfileResidual', $static)
$deleteCore = [OpenCoven.WindowsJobSupervisor].GetMethod('DeleteOperatingSystemProfileCore', $static)
$classify = [OpenCoven.WindowsIsolatedUser].GetMethod('ClassifyCleanupError', $static)
foreach ($seam in @($register, $applicationField, $quotaField, $unloadProfile, $deleteTree, $residual, $deleteCore, $classify)) {
  if ($null -eq $seam) { throw 'Native residual cleanup regression seam is missing.' }
}
function Test-ResidualPath([string]$Path) {
  try { [IO.File]::GetAttributes($Path) | Out-Null; return $true }
  catch {
    $cause = $_.Exception.GetBaseException()
    if ($cause -is [IO.FileNotFoundException] -or $cause -is [IO.DirectoryNotFoundException]) { return $false }
    throw
  }
}
function Assert-ResidualFailure([Exception]$Failure, [string]$Expected) {
  if ($null -eq $Failure) { throw "Expected native residual failure was absent: $Expected." }
  $queue = [Collections.Generic.Queue[Exception]]::new()
  $queue.Enqueue($Failure)
  $found = $false
  $categories = [Collections.Generic.List[string]]::new()
  while ($queue.Count -gt 0) {
    if ($categories.Count -ge 32) { throw 'Native residual exception graph exceeded its bound.' }
    $item = $queue.Dequeue()
    $category = [string]$classify.Invoke($null, [object[]]@($item))
    $categories.Add($category)
    if ($category.Contains($Expected) -or $item.Message.Contains($Expected)) { $found = $true }
    if ($item -is [AggregateException]) {
      foreach ($inner in $item.InnerExceptions) { $queue.Enqueue($inner) }
    } elseif ($null -ne $item.InnerException) { $queue.Enqueue($item.InnerException) }
  }
  if (-not $found) {
    throw ("Native residual failure had the wrong bounded category: expected=$Expected;observed=" +
      [string]::Join(',', $categories) + '.')
  }
}

$profileFailureType = [OpenCoven.WindowsJobSupervisor].GetNestedType(
  'ProfileCleanupException', [Reflection.BindingFlags]::NonPublic)
$profileFailureConstructor = $profileFailureType.GetConstructor(
  [Reflection.BindingFlags]'Public,NonPublic,Instance', $null,
  [type[]]@([string], [bool], [bool], [bool], [Exception]), $null)
$categorizedFailure = $profileFailureConstructor.Invoke([object[]]@(
  'not-found', $false, $true, $false,
  [ComponentModel.Win32Exception]::new(5, 'injected-private-native-message')))
Assert-ResidualFailure $categorizedFailure 'residual=win32-5'
$mismatch = $null
try { Assert-ResidualFailure $categorizedFailure 'residual=win32-32' } catch { $mismatch = $_.Exception }
if ($null -eq $mismatch -or -not $mismatch.Message.Contains('residual=win32-5') -or
    $mismatch.Message.Contains('injected-private-native-message')) {
  throw 'Residual failure classification accepted a wrong status or exposed private exception text.'
}
$openFailure = [OpenCoven.WindowsJobSupervisor].GetMethod(
  'ProfileResidualOpenError', [Reflection.BindingFlags]'NonPublic,Static', $null,
  [type[]]@([int], [int], [string], [int]), $null)
if ($null -eq $openFailure) { throw 'Bounded residual open role classifier is absent.' }
foreach ($role in @('ancestor', 'profile-root', 'child')) {
  $failure = $openFailure.Invoke($null, [object[]]@(-1073741790, 5, $role, 2))
  $category = [string]$classify.Invoke($null, [object[]]@($failure))
  if (-not $category.Contains("op=relative-open") -or
      -not $category.Contains("role=$role") -or
      -not $category.Contains('ntstatus=c0000022')) {
    throw "Residual open failure lost its bounded role: $role."
  }
}
$invalidRole = $null
try { $openFailure.Invoke($null, [object[]]@(-1073741790, 5, 'private-path-canary', 2)) } catch { $invalidRole = $_.Exception }
if ($null -eq $invalidRole -or $invalidRole.ToString().Contains('private-path-canary')) {
  throw 'Residual open classifier accepted or exposed an arbitrary role.'
}
$accessFailure = [OpenCoven.WindowsJobSupervisor].GetMethod(
  'ProfileResidualOpenError', [Reflection.BindingFlags]'NonPublic,Static', $null,
  [type[]]@([int], [int], [string], [int], [string]), $null)
if ($null -eq $accessFailure) { throw 'Bounded residual open access classifier is absent.' }
foreach ($access in @('delete-metadata', 'directory-list')) {
  $failure = $accessFailure.Invoke($null, [object[]]@(-1073741790, 5, 'child', 2, $access))
  $category = [string]$classify.Invoke($null, [object[]]@($failure))
  if (-not $category.Contains("access=$access") -or -not $category.Contains('role=child') -or
      -not $category.Contains('ntstatus=c0000022')) {
    throw 'Residual open failure lost its bounded access category.'
  }
}
$invalidAccess = $null
try { $accessFailure.Invoke($null, [object[]]@(-1073741790, 5, 'child', 2, 'private-access-canary')) } catch { $invalidAccess = $_.Exception }
if ($null -eq $invalidAccess -or $invalidAccess.ToString().Contains('private-access-canary')) {
  throw 'Residual open classifier accepted or exposed arbitrary access.'
}
$scopeStep = [OpenCoven.WindowsJobSupervisor].GetMethod(
  'ProfileResidualScopeStep', [Reflection.BindingFlags]'NonPublic,Static')
$scopeLabel = [OpenCoven.WindowsJobSupervisor].GetMethod(
  'ProfileResidualScopeLabel', [Reflection.BindingFlags]'NonPublic,Static')
if ($null -eq $scopeStep -or $null -eq $scopeLabel) { throw 'Residual scope classifier is absent.' }
foreach ($case in @(
  @(0, '.coven', 1, 'cleanup-grant-ancestor'),
  @(1, 'chat', 2, 'cleanup-grant-ancestor'),
  @(2, 'phase1-cleanup-grants-v1', 3, 'cleanup-grant-subtree'),
  @(3, 'private-name-canary', 3, 'cleanup-grant-subtree'),
  @(0, 'private-name-canary', -1, 'other'),
  @(1, 'unrelated', -1, 'other'),
  @(-1, 'phase1-cleanup-grants-v1', -1, 'other'),
  @(0, '.COVEN', -1, 'other')
)) {
  $state = $scopeStep.Invoke($null, [object[]]@([int]$case[0], [string]$case[1]))
  if ($state -ne $case[2] -or $scopeLabel.Invoke($null, [object[]]@($state)) -cne $case[3]) {
    throw 'Residual scope path classification changed.'
  }
}
$invalidScope = $null
try { $scopeLabel.Invoke($null, [object[]]@(99)) } catch { $invalidScope = $_.Exception }
if ($null -eq $invalidScope) { throw 'Residual scope accepted an invalid state.' }
$relativeOpen = [OpenCoven.WindowsJobSupervisor].GetMethod(
  'OpenProfileResidualRelative', [Reflection.BindingFlags]'NonPublic,Static')
$invalidSharing = $null
try {
  $relativeOpen.Invoke($null, [object[]]@($null, 'entry', $true, 0, 'child', $true))
} catch { $invalidSharing = $_.Exception.GetBaseException() }
if ($invalidSharing -isnot [InvalidOperationException] -or
    $invalidSharing.Message -cne 'Residual deletion handles must deny delete sharing.') {
  throw 'Residual deletion admitted delete sharing or reached native code before rejecting it.'
}
Write-Host 'Portable residual failure classification passed.'
if ($PortableOnly) { return }

$aclComparisonRoot = Join-Path ([IO.Path]::GetTempPath()) ('opencoven-acl-comparison-' + [Guid]::NewGuid().ToString('N'))
[OpenCoven.Tests.ProfileResidualNativeFixture]::CompareReadDenialControls($aclComparisonRoot)

$aclProbeRoot = Join-Path ([IO.Path]::GetTempPath()) ('opencoven-residual-acl-' + [Guid]::NewGuid().ToString('N'))
$aclProbeFile = Join-Path $aclProbeRoot 'marker.bin'
[IO.Directory]::CreateDirectory($aclProbeRoot) | Out-Null
[IO.File]::WriteAllText($aclProbeFile, 'owned')
try {
  [OpenCoven.Tests.ProfileResidualNativeFixture]::SetReadDenial($aclProbeFile, $true)
  if ([OpenCoven.Tests.ProfileResidualNativeFixture]::ReadAccess($aclProbeFile) -ne 5) {
    throw 'The native fixture did not establish file-data denial.'
  }
  [OpenCoven.Tests.ProfileResidualNativeFixture]::SetReadDenial($aclProbeFile, $false)
  if ([OpenCoven.Tests.ProfileResidualNativeFixture]::ReadAccess($aclProbeFile) -ne 0) {
    throw 'The native fixture did not restore file-data access.'
  }
  Write-Host 'Native residual read-denial fixture preflight passed.'
} catch {
  Write-Host ('Native residual fixture preflight failed: cause=' +
    [OpenCoven.Tests.ProfileResidualNativeFixture]::FailureCategory($_.Exception) + '.')
  throw
} finally {
  [IO.File]::Delete($aclProbeFile)
  [IO.Directory]::Delete($aclProbeRoot)
}

foreach ($case in @('delayed', 'persistent', 'denied', 'readonly', 'junction', 'hardlink',
    'readonly-hardlink', 'registration-mismatch', 'root-swap', 'root-junction', 'depth',
    'inplace-junction', 'read-denied-file', 'read-denied-junction', 'list-denied-directory',
    'unauthorized', 'disabled-unregistered', 'incomplete')) {
  $root = Join-Path ([IO.Path]::GetTempPath()) ('opencoven-residual-native-' + [Guid]::NewGuid().ToString('N'))
  $external = $null
  $canary = $null
  $user = $null
  $profileLifecycle = @{ Unloaded = $false }
  $job = $null
  $application = $null
  $held = $null
  $delayed = $null
  $originalParentAcl = $null
  $originalFileAcl = $null
  $readDeniedPath = $null
  $moved = $null
  try {
    $user = [OpenCoven.WindowsIsolatedUser]::Create($root)
    $profile = $user.OperatingSystemProfilePath
    # A sibling directory is outside the deletion scope but on the same volume for hard links.
    $external = Join-Path ([IO.Path]::GetDirectoryName($profile)) ('ocv-residual-sentinel-' + [Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($external) | Out-Null
    $canary = Join-Path $external 'keep.bin'
    [IO.File]::WriteAllText($canary, 'external-canary')
    $application = $applicationField.GetValue($user)
    $app = Join-Path $profile '.coven'
    $control = Join-Path $app 'residual-control'
    [IO.Directory]::CreateDirectory($control) | Out-Null
    $marker = Join-Path $control 'marker.bin'
    [IO.File]::WriteAllText($marker, 'owned')
    $job = [OpenCoven.WindowsJobSupervisor]::Create(
      ('Local\OpenCoven.Chat.Conformance.' + [Guid]::NewGuid().ToString('N')), $user)
    if ($case -eq 'incomplete') {
      $register.Invoke($user, [object[]]@(
        [Delegate]::CreateDelegate([Action], [OpenCoven.Tests.ProfileResidualNativeFixture].GetMethod('FailQuarantine')),
        [Delegate]::CreateDelegate([Func[bool]], [OpenCoven.Tests.ProfileResidualNativeFixture].GetMethod('Incomplete'))
      )) | Out-Null
      $failure = $null
      try { $user.Dispose() } catch { $failure = $_.Exception }
      Assert-ResidualFailure $failure 'cleanup deferred'
      $pin = $application.GetType().GetField('profile', $instance).GetValue($application)
      if ($pin.IsClosed -or -not (Test-ResidualPath $marker) -or
          -not [OpenCoven.Tests.ProfileResidualNativeFixture]::Registered($user.Sid)) {
        throw 'Incomplete quarantine released ownership or deleted profile state.'
      }
      Write-Host 'Native residual guard passed: incomplete quarantine.'
      continue
    }
    if ($case -notin @('unauthorized', 'disabled-unregistered')) {
      $register.Invoke($user, [object[]]@(
        [Delegate]::CreateDelegate([Action], $job, $job.GetType().GetMethod('QuarantineIsolatedIdentity')),
        [Delegate]::CreateDelegate([Func[bool]], $job, $job.GetType().GetProperty('IsQuarantineComplete').GetMethod)
      )) | Out-Null
      $job.QuarantineIsolatedIdentity()
    } elseif ($case -eq 'disabled-unregistered') {
      $user.DisableAndVerify()
    }
    $capture = $application.GetType().GetMethod('CaptureCleanupIdentity', $instance)
    $identity = $capture.Invoke($application, @())
    $useCore = $case -in @('denied', 'readonly', 'junction', 'hardlink', 'readonly-hardlink',
      'depth', 'root-swap', 'root-junction', 'inplace-junction', 'read-denied-file',
      'read-denied-junction', 'list-denied-directory')
    if ($case -eq 'registration-mismatch') {
      $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey(
        "SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$($user.Sid)", $true)
      try { $key.SetValue('ProfileImagePath', $external) } finally { $key.Dispose() }
    } else {
      $held = [IO.File]::Open($marker, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
      if ([OpenCoven.Tests.ProfileResidualNativeFixture]::DeleteAccess($marker) -ne 32) {
        throw 'The held residual control did not establish a sharing violation.'
      }
      if ($useCore) {
        # Seed adversarial residuals through real userenv after successful quarantine and
        # actual pin/token release. Reuse the genuine captured identity in the production core.
        $application.Dispose()
        $unloadProfile.Invoke($user, @()) | Out-Null
        $profileLifecycle.Unloaded = $true
        $quotaField.GetValue($user).Dispose()
        [OpenCoven.Tests.ProfileResidualNativeFixture]::Unregister($user.Sid, $profile)
        if (-not (Test-ResidualPath $marker)) { throw 'Held residual seed unexpectedly disappeared.' }
      }
      if ($case -eq 'delayed') {
        $delayed = [OpenCoven.Tests.ProfileResidualNativeFixture+DelayedHolder]::new($application, $held, $user.Sid)
      } elseif ($case -notin @('persistent', 'unauthorized', 'disabled-unregistered')) {
        $held.Dispose()
        $held = $null
      }
      if ($case -eq 'denied') {
        $originalParentAcl = Get-Acl -LiteralPath $control
        $originalFileAcl = Get-Acl -LiteralPath $marker
        foreach ($path in @($control, $marker)) {
          $acl = Get-Acl -LiteralPath $path
          $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new('S-1-1-0'),
            [Security.AccessControl.FileSystemRights]'Delete,DeleteSubdirectoriesAndFiles',
            [Security.AccessControl.AccessControlType]::Deny))
          Set-Acl -LiteralPath $path -AclObject $acl
        }
        if ([OpenCoven.Tests.ProfileResidualNativeFixture]::DeleteAccess($marker) -ne 5) {
          throw 'The explicit file-and-parent ACL control did not establish DELETE denial.'
        }
      }
      if ($case -in @('hardlink', 'readonly-hardlink')) {
        [IO.File]::Delete($marker)
        [OpenCoven.Tests.ProfileResidualNativeFixture]::Link($marker, $canary)
      }
      if ($case -in @('readonly', 'readonly-hardlink')) {
        [IO.File]::SetAttributes($marker, [IO.FileAttributes]::ReadOnly)
      }
      if ($case -eq 'junction') {
        New-Item -ItemType Junction -Path (Join-Path $control 'outside-link') -Target $external | Out-Null
      }
      if ($case -in @('read-denied-file', 'read-denied-junction', 'list-denied-directory')) {
        $readDeniedPath = if ($case -eq 'read-denied-file') { $marker } else { $control }
        if ($case -eq 'read-denied-junction') {
          $readDeniedPath = Join-Path $control 'outside-link'
          New-Item -ItemType Junction -Path $readDeniedPath -Target $external | Out-Null
        }
        [OpenCoven.Tests.ProfileResidualNativeFixture]::SetReadDenial($readDeniedPath, $true)
        if ([OpenCoven.Tests.ProfileResidualNativeFixture]::ReadAccess($readDeniedPath) -ne 5 -or
            [OpenCoven.Tests.ProfileResidualNativeFixture]::ReadAccess($external) -ne 0) {
          throw 'The entry-only read-denial control did not preserve the external target.'
        }
      }
      if ($case -eq 'inplace-junction') {
        [IO.File]::Delete($marker)
        [OpenCoven.Tests.ProfileResidualNativeFixture]::RequireInPlaceConfinement(
          [OpenCoven.WindowsJobSupervisor], $control, $external)
        Write-Host 'Native retained-directory in-place junction confinement passed.'
        continue
      }
      if ($case -eq 'depth') {
        $deep = $control
        foreach ($level in 1..65) { $deep = Join-Path $deep 'd' }
        [IO.Directory]::CreateDirectory($deep) | Out-Null
        [IO.File]::Move($marker, (Join-Path $deep 'deep-marker'))
      }
      if ($case -in @('root-swap', 'root-junction')) {
        $application.Dispose()
        $moveTarget = $profile + '-fixture-owned'
        [IO.Directory]::Move($profile, $moveTarget)
        $moved = $moveTarget
        if ($case -eq 'root-swap') {
          [IO.Directory]::CreateDirectory($profile) | Out-Null
          [IO.File]::WriteAllText((Join-Path $profile 'replacement'), 'foreign')
        } else {
          New-Item -ItemType Junction -Path $profile -Target $external | Out-Null
        }
        $failure = $null
        try {
          $residual.Invoke($null, [object[]]@($identity, [Diagnostics.Stopwatch]::StartNew(), 0)) | Out-Null
        } catch { $failure = $_.Exception }
        Assert-ResidualFailure $failure 'identity changed'
        if ($case -eq 'root-swap' -and -not (Test-ResidualPath (Join-Path $profile 'replacement'))) {
          throw 'A replacement root was modified.'
        }
        if ([IO.File]::ReadAllText($canary) -cne 'external-canary') { throw 'A root guard modified its external sentinel.' }
        Write-Host "Native residual guard passed: $case."
        continue
      }
    }
    $failure = $null
    $elapsed = [Diagnostics.Stopwatch]::StartNew()
    try {
      if ($useCore) {
        $deleteCore.Invoke($null, [object[]]@([string]$user.Sid, [string]$profile, $identity)) | Out-Null
      } else { $user.Dispose() }
    } catch { $failure = $_.Exception }
    switch ($case) {
      'persistent' { Assert-ResidualFailure $failure 'residual=win32-32' }
      'denied' { Assert-ResidualFailure $failure 'residual=win32-5' }
      'list-denied-directory' { Assert-ResidualFailure $failure 'residual=win32-5' }
      'readonly' { Assert-ResidualFailure $failure 'read-only file' }
      'readonly-hardlink' { Assert-ResidualFailure $failure 'read-only file' }
      'registration-mismatch' { Assert-ResidualFailure $failure 'registration is not bound' }
      'depth' { Assert-ResidualFailure $failure 'traversal exceeded its bounds' }
      { $_ -in @('unauthorized', 'disabled-unregistered') } {
        Assert-ResidualFailure $failure 'profile-remained[delete=accepted;registry=0;expected=1;actual=1]'
        if (-not (Test-ResidualPath $marker)) { throw 'An unregistered caller removed residual state.' }
      }
      default {
        if ($null -ne $failure) { throw $failure }
        if (Test-ResidualPath $profile) { throw 'Authorized residual cleanup did not remove the profile.' }
        if ($case -eq 'delayed') { $delayed.RequireReleased() }
      }
    }
    if ($elapsed.Elapsed -gt [TimeSpan]::FromSeconds(20)) { throw 'Residual cleanup reset or exceeded its finite budget.' }
    if ([IO.File]::ReadAllText($canary) -cne 'external-canary') { throw 'An external sentinel was modified.' }
    if ($case -eq 'readonly-hardlink' -and
        ([IO.File]::GetAttributes($canary) -band [IO.FileAttributes]::ReadOnly) -eq 0) {
      throw 'Cleanup changed shared hard-link attributes.'
    }
    Write-Host "Native authorized residual case passed: $case."
  } catch {
    Write-Host ("Native residual case failed: case=$case;cause=" +
      [OpenCoven.Tests.ProfileResidualNativeFixture]::FailureCategory($_.Exception) + '.')
    throw
  } finally {
    # Each independently owned resource gets a teardown stage, including after polling faults.
    [OpenCoven.Tests.ProfileResidualNativeFixture]::RunTeardown([Action[]]@(
      { if ($null -ne $delayed) { $delayed.Dispose() } },
      { if ($null -ne $held) { $held.Dispose() } },
      { if ($null -ne $job) { $job.Dispose() } },
      { if ($null -ne $application) { $application.Dispose() } },
      {
        if ($null -ne $user) {
          $unloadProfile.Invoke($user, @()) | Out-Null
          $profileLifecycle.Unloaded = $true
          $token = $quotaField.GetValue($user)
          if ($null -ne $token) { $token.Dispose() }
        }
      },
      {
        if ($profileLifecycle.Unloaded -and $null -ne $moved -and (Test-ResidualPath $profile)) {
          if ($case -eq 'root-junction') { [IO.Directory]::Delete($profile) }
          else { [IO.Directory]::Delete($profile, $true) }
        }
      },
      { if ($profileLifecycle.Unloaded -and $null -ne $moved) { [IO.Directory]::Move($moved, $profile) } },
      {
        if ($null -ne $originalParentAcl -and (Test-ResidualPath $control)) {
          Set-Acl -LiteralPath $control -AclObject $originalParentAcl
        }
      },
      {
        if ($null -ne $originalFileAcl -and (Test-ResidualPath $marker)) {
          Set-Acl -LiteralPath $marker -AclObject $originalFileAcl
        }
      },
      {
        if ($null -ne $readDeniedPath -and (Test-ResidualPath $readDeniedPath)) {
          [OpenCoven.Tests.ProfileResidualNativeFixture]::SetReadDenial($readDeniedPath, $false)
        }
      },
      {
        if ($null -ne $user -and $case -in @('readonly', 'readonly-hardlink') -and (Test-ResidualPath $marker)) {
          [IO.File]::SetAttributes($marker, [IO.FileAttributes]::Normal)
        }
      },
      # These identities never launch a producer. Manual teardown is fixture-only,
      # after closing its real pins and releasing/restoring every injected blocker.
      { if ($profileLifecycle.Unloaded -and $null -ne $user) { [OpenCoven.Tests.ProfileResidualNativeFixture]::Unregister($user.Sid, $user.OperatingSystemProfilePath) } },
      { if ($profileLifecycle.Unloaded -and $null -ne $user) { $deleteTree.Invoke($null, [object[]]@([string]$user.OperatingSystemProfilePath)) | Out-Null } },
      { if ($profileLifecycle.Unloaded -and $null -ne $moved -and (Test-ResidualPath $moved)) { $deleteTree.Invoke($null, [object[]]@([string]$moved)) | Out-Null } },
      { if ($profileLifecycle.Unloaded -and $null -ne $user) { $deleteTree.Invoke($null, [object[]]@([string]$user.RootPath)) | Out-Null } },
      { if ($profileLifecycle.Unloaded -and $null -ne $user) { [OpenCoven.Tests.ProfileResidualNativeFixture]::RemoveAccount($user.UserName) } },
      { if ($null -ne $canary -and (Test-ResidualPath $canary)) { [IO.File]::SetAttributes($canary, [IO.FileAttributes]::Normal) } },
      { if ($null -ne $external -and (Test-ResidualPath $external)) { [IO.Directory]::Delete($external, $true) } }
    ))
  }
}
Write-Host 'Native authorized residual cleanup regressions passed.'
