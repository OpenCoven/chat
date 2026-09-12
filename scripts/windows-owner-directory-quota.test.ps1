$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'Owner-directory quota reproduction requires native Windows.' }
if (-not ('OpenCoven.WindowsJobSupervisor' -as [type])) {
  Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'windows-job-supervisor.cs'))) -Language CSharp
}

# Characterize the access boundary without changing production accounting.
# This is a controlled owner-only directory, not proof of the protected run's
# denied descendant. All filesystem reads below use the real quota methods.
$staticFlags = [Reflection.BindingFlags]'NonPublic,Static'
$instanceFlags = [Reflection.BindingFlags]'NonPublic,Instance'
$terminal = [OpenCoven.WindowsJobSupervisor].GetMethod('ApplyTerminalDirectoryQuotaCheck', $staticFlags)
$monitor = [OpenCoven.WindowsJobSupervisor].GetMethod('MonitorDirectoryQuotasAsync', $staticFlags)
$stateType = [OpenCoven.WindowsJobSupervisor].GetNestedType('DirectoryQuotaFailureState', [Reflection.BindingFlags]'NonPublic')
$enablePrivilege = [OpenCoven.WindowsJobSupervisor].GetMethod('EnablePrivilege', $staticFlags)
foreach ($method in @($terminal, $monitor, $stateType, $enablePrivilege)) {
  if ($null -eq $method) { throw 'Native owner-directory fixture contract is missing.' }
}
if (-not ('OpenCoven.Tests.OwnerDirectoryQuotaFixture' -as [type])) {
  Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
namespace OpenCoven.Tests
{
    public sealed class OwnerDirectoryQuotaFixture : IDisposable
    {
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetFileSecurityW(string path, uint information, byte[] descriptor);

        // Retain access before revoking the supervisor's directory permissions.
        // A null SECURITY_ATTRIBUTES pointer makes this handle noninheritable.
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateFileW(string path, uint access, uint share,
            IntPtr attributes, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr memory);
        [DllImport("advapi32.dll")]
        private static extern uint GetSecurityInfo(IntPtr handle, uint type, uint information,
            out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetSecurityDescriptorControl(IntPtr descriptor, out ushort control, out uint revision);
        [DllImport("advapi32.dll")]
        private static extern uint SetSecurityInfo(IntPtr handle, uint type, uint information,
            IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);

        private IntPtr handle;
        private IntPtr descriptor;
        private IntPtr owner;
        private IntPtr dacl;
        private uint restoreInformation;
        private bool restored;
        private bool disposed;

        public OwnerDirectoryQuotaFixture(string path)
        {
            // READ_CONTROL | WRITE_DAC | WRITE_OWNER; share read/write/delete;
            // OPEN_EXISTING; BACKUP_SEMANTICS | OPEN_REPARSE_POINT.
            handle = CreateFileW(path, 0x000E0000u, 7, IntPtr.Zero, 3, 0x02200000u, IntPtr.Zero);
            if (handle == new IntPtr(-1))
            {
                handle = IntPtr.Zero;
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Fixture restoration handle could not be opened.");
            }
            try
            {
                IntPtr group, sacl;
                uint error = GetSecurityInfo(handle, 1, 5, out owner, out group, out dacl, out sacl, out descriptor);
                if (error != 0) throw new Win32Exception((int)error, "Fixture security could not be captured.");
                ushort control;
                uint revision;
                if (!GetSecurityDescriptorControl(descriptor, out control, out revision))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Fixture security control could not be read.");
                // OWNER | DACL and the original DACL inheritance protection.
                restoreInformation = 5u | ((control & 0x1000) != 0 ? 0x80000000u : 0x20000000u);
            }
            catch
            {
                Release();
                throw;
            }
        }

        public void Restore()
        {
            if (disposed) throw new ObjectDisposedException(nameof(OwnerDirectoryQuotaFixture));
            if (restored) return;
            uint error = SetSecurityInfo(handle, 1, restoreInformation, owner, IntPtr.Zero, dacl, IntPtr.Zero);
            if (error != 0) throw new Win32Exception((int)error, "Fixture security restoration failed.");
            restored = true;
        }

        private void Release()
        {
            if (descriptor != IntPtr.Zero) { LocalFree(descriptor); descriptor = IntPtr.Zero; }
            if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; }
        }

        public void Dispose()
        {
            if (disposed) return;
            try { Restore(); }
            finally { disposed = true; Release(); }
        }

        public static void Protect(string path, string ownerSid)
        {
            // Match Coven's owner-only directory DACL, with the fixture owner
            // explicitly bound to the real isolated account provisioned below.
            var descriptor = new RawSecurityDescriptor("O:" + ownerSid + "D:P(A;OICI;GA;;;OW)");
            var bytes = new byte[descriptor.BinaryLength];
            descriptor.GetBinaryForm(bytes, 0);
            if (!SetFileSecurityW(path, 0x80000005u, bytes))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Fixture owner-only directory setup failed.");
        }
    }
}
'@
}

$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('opencoven-owner-directory-' + [Guid]::NewGuid().ToString('N'))
$identity = $null
$directory = $null
$securityLease = $null
$state = $null
$cancellation = $null
$monitorTask = $null
$failures = [Collections.Generic.List[Exception]]::new()
try {
  $identity = [OpenCoven.WindowsIsolatedUser]::Create($fixtureRoot)
  $supervisorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if ($identity.Sid -ceq $supervisorSid) { throw 'Fixture identities must differ.' }
  $directory = Join-Path $identity.TempPath 'phase1-conformance-run-fixture'
  [IO.Directory]::CreateDirectory($directory) | Out-Null
  $securityLease = [OpenCoven.Tests.OwnerDirectoryQuotaFixture]::new($directory)
  [IO.File]::WriteAllBytes((Join-Path $directory 'payload.bin'), [byte[]]::new(1024))
  $quota = [OpenCoven.WindowsDirectoryQuota[]]@(
    [OpenCoven.WindowsDirectoryQuota]::new('harness execution aggregate', $directory, 2048)
  )
  $baseline = [OpenCoven.WindowsJobRunResult]::new()
  $terminal.Invoke($null, [object[]]@($baseline, $quota))
  if ($baseline.ResourceQuotaExceeded -or $baseline.ResourceQuotaMonitorError) {
    throw 'Readable owner-directory control failed quota accounting.'
  }

  $enablePrivilege.Invoke($null, [object[]]@('SeRestorePrivilege'))
  [OpenCoven.Tests.OwnerDirectoryQuotaFixture]::Protect($directory, $identity.Sid)
  $denied = [OpenCoven.WindowsJobRunResult]::new()
  $terminal.Invoke($null, [object[]]@($denied, $quota))
  if (-not $denied.ResourceQuotaExceeded -or -not $denied.ResourceQuotaMonitorError -or
      $denied.ExitCode -eq 0 -or $denied.ResourceQuotaMonitorCategory -cne 'access-denied' -or
      $denied.ResourceQuotaMonitorRoot -cne 'harness-execution-aggregate' -or
      $denied.ResourceQuotaMonitorOperation -cne 'directory-enumeration-root') {
    throw 'Owner-only directory did not reproduce the protected terminal quota signature.'
  }
  $state = [Activator]::CreateInstance($stateType, $true)
  $cancellation = [Threading.CancellationTokenSource]::new(5000)
  $monitorTask = $monitor.Invoke($null, [object[]]@($quota, $state, $cancellation.Token))
  if (-not $monitorTask.Wait(6000)) { throw 'Owner-directory monitor did not terminate.' }
  foreach ($pair in @(
      @('MonitorErrorCategory', 'access-denied'),
      @('MonitorErrorRoot', 'harness-execution-aggregate'),
      @('MonitorErrorOperation', 'directory-enumeration-root'))) {
    if ($stateType.GetProperty($pair[0], $instanceFlags).GetValue($state) -cne $pair[1]) {
      throw 'Owner-only directory did not reproduce the protected background quota signature.'
    }
  }
  if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne $supervisorSid) {
    throw 'Quota fixture changed supervisor identity.'
  }

  # Restore only this test fixture. Production private ACLs remain untouched.
  $securityLease.Restore()
  $overflow = [OpenCoven.WindowsJobRunResult]::new()
  $terminal.Invoke($null, [object[]]@($overflow, [OpenCoven.WindowsDirectoryQuota[]]@(
    [OpenCoven.WindowsDirectoryQuota]::new('harness execution aggregate', $directory, 512)
  )))
  if (-not $overflow.ResourceQuotaExceeded -or $overflow.ResourceQuotaMonitorError -or
      $overflow.ResourceQuotaLabel -cne 'harness execution aggregate' -or $overflow.ExitCode -eq 0) {
    throw 'Readable control did not enforce the actual byte quota.'
  }
  Write-Host 'Native isolated-owner directory reproduces bounded terminal/background quota denial; readable and overflow controls passed.'
} catch {
  $failures.Add($_.Exception)
} finally {
  try { if ($null -ne $cancellation) { $cancellation.Cancel() } }
  catch { $failures.Add($_.Exception) }
  try {
    if ($null -ne $monitorTask -and -not $monitorTask.Wait(6000)) {
      throw [TimeoutException]::new('Owner-directory monitor survived cancellation.')
    }
  } catch { $failures.Add($_.Exception) }
  # Do not dispose state underneath a worker that failed to stop. The fixture
  # fails in that case, while still attempting ACL and account cleanup below.
  if ($null -eq $monitorTask -or $monitorTask.IsCompleted) {
    try { if ($null -ne $state) { $state.Dispose() } }
    catch { $failures.Add($_.Exception) }
    try { if ($null -ne $cancellation) { $cancellation.Dispose() } }
    catch { $failures.Add($_.Exception) }
  }
  if ($null -ne $identity) {
    try {
      if ($null -ne $securityLease) { $securityLease.Dispose() }
    } catch { $failures.Add($_.Exception) }
    try { $identity.Dispose() }
    catch { $failures.Add($_.Exception) }
  }
}
if ([IO.Directory]::Exists($fixtureRoot)) {
  $failures.Add([IO.IOException]::new('Owner-directory fixture survived cleanup.'))
}
if ($failures.Count -gt 0) {
  throw [AggregateException]::new('Native owner-directory reproduction failed.', $failures.ToArray())
}
Write-Host 'Native owner-directory fixture cleanup passed.'
