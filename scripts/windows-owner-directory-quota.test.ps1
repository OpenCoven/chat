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
$secureDirectory = [OpenCoven.WindowsJobSupervisor].GetMethod(
  'SecureIsolatedDirectory', $staticFlags, $null,
  [type[]]@([string], [string], [string]), $null
)
$enablePrivilege = [OpenCoven.WindowsJobSupervisor].GetMethod('EnablePrivilege', $staticFlags)
foreach ($method in @($terminal, $monitor, $stateType, $secureDirectory, $enablePrivilege)) {
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
    public static class OwnerDirectoryQuotaFixture
    {
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetFileSecurityW(string path, uint information, byte[] descriptor);

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
$directoryCreated = $false
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
  $directoryCreated = $true
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
      $denied.ResourceQuotaMonitorOperation -cne 'directory-enumeration') {
    throw 'Owner-only directory did not reproduce the protected terminal quota signature.'
  }
  $state = [Activator]::CreateInstance($stateType, $true)
  $cancellation = [Threading.CancellationTokenSource]::new(5000)
  $monitorTask = $monitor.Invoke($null, [object[]]@($quota, $state, $cancellation.Token))
  if (-not $monitorTask.Wait(6000)) { throw 'Owner-directory monitor did not terminate.' }
  foreach ($pair in @(
      @('MonitorErrorCategory', 'access-denied'),
      @('MonitorErrorRoot', 'harness-execution-aggregate'),
      @('MonitorErrorOperation', 'directory-enumeration'))) {
    if ($stateType.GetProperty($pair[0], $instanceFlags).GetValue($state) -cne $pair[1]) {
      throw 'Owner-only directory did not reproduce the protected background quota signature.'
    }
  }
  if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne $supervisorSid) {
    throw 'Quota fixture changed supervisor identity.'
  }

  # Restore only this test fixture. Production private ACLs remain untouched.
  $secureDirectory.Invoke($null, [object[]]@($directory, $identity.Sid, $supervisorSid))
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
      # Existence queries can hide access denial; creation state owns teardown.
      if ($directoryCreated) {
        $secureDirectory.Invoke($null, [object[]]@($directory, $identity.Sid, $supervisorSid))
      }
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
