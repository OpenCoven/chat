$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'Isolated quota reader regression requires native Windows.' }
# The preceding owner-directory characterization loads the production types and
# retained fixture restoration helper. Standalone execution loads it as well.
if (-not ('OpenCoven.Tests.OwnerDirectoryQuotaFixture' -as [type])) {
  & (Join-Path $PSScriptRoot 'windows-owner-directory-quota.test.ps1')
}
$staticFlags = [Reflection.BindingFlags]'NonPublic,Static'
$instanceFlags = [Reflection.BindingFlags]'NonPublic,Instance'
$terminal = [OpenCoven.WindowsJobSupervisor].GetMethod('ApplyTerminalDirectoryQuotaCheckAsUser', $staticFlags)
$monitor = [OpenCoven.WindowsJobSupervisor].GetMethod('MonitorDirectoryQuotasAsUserAsync', $staticFlags)
$read = [OpenCoven.WindowsIsolatedUser].GetMethod('RunQuotaRead', $instanceFlags)
$stateType = [OpenCoven.WindowsJobSupervisor].GetNestedType('DirectoryQuotaFailureState', [Reflection.BindingFlags]'NonPublic')
foreach ($contract in @($terminal, $monitor, $read, $stateType)) {
  if ($null -eq $contract) { throw 'Isolated quota reader contract is missing.' }
}
$readString = $read.MakeGenericMethod([type[]]@([string]))
if (-not ('OpenCoven.Tests.QuotaReadDisposalProbe' -as [type])) {
  Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Reflection;
using System.Security.Principal;
using System.Threading;
using System.Threading.Tasks;
namespace OpenCoven.Tests {
    public sealed class QuotaReadDisposalProbe : IDisposable {
        private readonly ManualResetEventSlim entered = new ManualResetEventSlim(false);
        private readonly ManualResetEventSlim release = new ManualResetEventSlim(false);
        private readonly Task<string> read;
        public QuotaReadDisposalProbe(object identity, MethodInfo method) {
            read = Task.Run(() => (string)method.Invoke(identity, new object[] {
                new Func<string>(() => {
                    entered.Set();
                    if (!release.Wait(TimeSpan.FromSeconds(60))) throw new TimeoutException("Quota callback release timed out.");
                    using (WindowsIdentity current = WindowsIdentity.GetCurrent()) {
                        return current.User.Value;
                    }
                })
            }));
        }
        public void WaitForEntry() {
            if (!entered.Wait(5000)) throw new TimeoutException("Quota callback did not start.");
        }
        public string Complete() {
            release.Set();
            if (!read.Wait(5000)) throw new TimeoutException("Quota callback did not finish.");
            return read.Result;
        }
        public void Dispose() {
            release.Set();
            try {
                if (!read.Wait(5000)) throw new TimeoutException("Quota callback survived teardown.");
            } finally {
                if (read.IsCompleted) { entered.Dispose(); release.Dispose(); }
            }
        }
    }
}
'@
}
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('opencoven-quota-reader-' + [Guid]::NewGuid().ToString('N'))
$identity = $null
$lease = $null
$job = $null
$state = $null
$cancel = $null
$task = $null
$disposalProbe = $null
$failures = [Collections.Generic.List[Exception]]::new()
try {
  $identity = [OpenCoven.WindowsIsolatedUser]::Create($fixtureRoot)
  $supervisorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $directory = Join-Path $identity.TempPath 'phase1-conformance-run-reader'
  [IO.Directory]::CreateDirectory($directory) | Out-Null
  $lease = [OpenCoven.Tests.OwnerDirectoryQuotaFixture]::new($directory)
  [IO.File]::WriteAllBytes((Join-Path $directory 'payload.bin'), [byte[]]::new(1024))
  [OpenCoven.Tests.OwnerDirectoryQuotaFixture]::Protect($directory, $identity.Sid)
  $under = [OpenCoven.WindowsDirectoryQuota[]]@(
    [OpenCoven.WindowsDirectoryQuota]::new('harness execution aggregate', $directory, 2048)
  )
  $over = [OpenCoven.WindowsDirectoryQuota[]]@(
    [OpenCoven.WindowsDirectoryQuota]::new('harness execution aggregate', $directory, 512)
  )
  $sidRead = [Func[string]]{ [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
  if ($readString.Invoke($identity, [object[]]@($sidRead)) -cne $identity.Sid) {
    throw 'Quota callback did not use the validated isolated identity.'
  }
  $expectedThrow = $false
  try {
    $readString.Invoke($identity, [object[]]@([Func[string]]{
      throw [InvalidOperationException]::new('quota-reader-expected')
    })) | Out-Null
  } catch {
    $expectedThrow = $_.Exception.ToString().Contains('quota-reader-expected')
    if (-not $expectedThrow) { throw }
  }
  if (-not $expectedThrow -or [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne $supervisorSid) {
    throw 'Throwing quota callback did not restore supervisor identity.'
  }
  foreach ($quota in @($under, $over)) {
    $result = [OpenCoven.WindowsJobRunResult]::new()
    $terminal.Invoke($null, [object[]]@($identity, $result, $quota))
    $expectOverflow = $quota[0].MaxBytes -eq 512
    if ($result.ResourceQuotaMonitorError -or $result.ResourceQuotaExceeded -ne $expectOverflow) {
      throw 'Isolated terminal accounting confused owner-only access with byte overflow.'
    }
    if ($expectOverflow -and ($result.ExitCode -eq 0 -or $result.ResourceQuotaLabel -cne 'harness execution aggregate')) {
      throw 'Isolated terminal accounting lost the actual overflow outcome.'
    }
  }
  $unexpected = Join-Path $identity.TempPath 'phase1-conformance-run-unexpected'
  [IO.Directory]::CreateDirectory($unexpected) | Out-Null
  [OpenCoven.WindowsJobSupervisor]::ProtectSupervisorDirectory($unexpected)
  $inaccessible = [OpenCoven.WindowsJobRunResult]::new()
  $terminal.Invoke($null, [object[]]@($identity, $inaccessible, [OpenCoven.WindowsDirectoryQuota[]]@(
    [OpenCoven.WindowsDirectoryQuota]::new('harness execution aggregate', $unexpected, 2048)
  )))
  if (-not $inaccessible.ResourceQuotaExceeded -or -not $inaccessible.ResourceQuotaMonitorError -or
      $inaccessible.ExitCode -eq 0 -or $inaccessible.ResourceQuotaMonitorCategory -cne 'access-denied') {
    throw 'Unexpected unreadable quota directory did not fail closed.'
  }
  $state = [Activator]::CreateInstance($stateType, $true)
  $cancel = [Threading.CancellationTokenSource]::new(5000)
  $task = $monitor.Invoke($null, [object[]]@($identity, $over, $state, $cancel.Token))
  if (-not $task.Wait(6000) -or
      $stateType.GetProperty('MonitorError', $instanceFlags).GetValue($state) -or
      $stateType.GetProperty('QuotaLabel', $instanceFlags).GetValue($state) -cne 'harness execution aggregate') {
    throw 'Isolated background accounting failed to detect owner-only byte overflow.'
  }

  $state.Dispose()
  $cancel.Dispose()
  $state = [Activator]::CreateInstance($stateType, $true)
  $cancel = [Threading.CancellationTokenSource]::new(1200)
  $task = $monitor.Invoke($null, [object[]]@($identity, $under, $state, $cancel.Token))
  if (-not $task.Wait(6000) -or $stateType.GetProperty('IsSet', $instanceFlags).GetValue($state)) {
    throw 'Isolated background accounting rejected an owner-only directory below quota.'
  }

  # Exercise the real process path, including its intermediate scan and the
  # terminal scan after verified quarantine disables the account.
  $job = [OpenCoven.WindowsJobSupervisor]::Create(
    "Local\OpenCoven.Chat.QuotaReader.$([Guid]::NewGuid().ToString('N'))", $identity
  )
  $environment = @{
    SystemRoot = $env:SystemRoot
    TEMP = $identity.TempPath
    TMP = $identity.TempPath
    USERPROFILE = $identity.ProfilePath
  }
  $processResult = $job.RunProducerAsUserAndQuarantine(
    $identity, (Join-Path $env:SystemRoot 'System32\cmd.exe'), '/d /c exit 0',
    $identity.RootPath, $environment, [TimeSpan]::FromSeconds(30), 4096, 4096, $under
  )
  if ($processResult.ExitCode -ne 0 -or $processResult.ResourceQuotaExceeded -or -not $identity.IsDisabled) {
    throw 'Actual producer accounting or post-producer account disablement failed.'
  }
  $postDisable = [OpenCoven.WindowsJobRunResult]::new()
  $terminal.Invoke($null, [object[]]@($identity, $postDisable, $over))
  if (-not $postDisable.ResourceQuotaExceeded -or $postDisable.ResourceQuotaMonitorError) {
    throw 'Retained quota identity did not enforce bytes after account disablement.'
  }
  # The private ACL must still deny the supervisor after all impersonated reads.
  $denied = [OpenCoven.WindowsJobRunResult]::new()
  [OpenCoven.WindowsJobSupervisor].GetMethod('ApplyTerminalDirectoryQuotaCheck', $staticFlags).Invoke(
    $null, [object[]]@($denied, $under)
  )
  if (-not $denied.ResourceQuotaMonitorError -or $denied.ResourceQuotaMonitorCategory -cne 'access-denied') {
    throw 'Quota accounting weakened the private owner-only ACL.'
  }
  if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne $supervisorSid) {
    throw 'Quota accounting did not restore supervisor identity.'
  }
  # Hold an actual impersonated read across identity disposal. The worker is C#
  # so its thread does not depend on a PowerShell runspace or scriptblock.
  $disposalProbe = [OpenCoven.Tests.QuotaReadDisposalProbe]::new($identity, $readString)
  $disposalProbe.WaitForEntry()
  $job.Dispose()
  $lease.Restore()
  $identity.Dispose()
  if ($disposalProbe.Complete() -cne $identity.Sid -or
      [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne $supervisorSid) {
    throw 'In-flight quota read lost its identity during disposal.'
  }

} catch { $failures.Add($_.Exception) }
finally {
  try { if ($null -ne $disposalProbe) { $disposalProbe.Dispose() } } catch { $failures.Add($_.Exception) }
  try { if ($null -ne $cancel) { $cancel.Cancel() } } catch { $failures.Add($_.Exception) }
  try {
    if ($null -ne $task -and -not $task.Wait(6000)) { throw 'Quota reader monitor survived cancellation.' }
  } catch { $failures.Add($_.Exception) }
  if ($null -eq $task -or $task.IsCompleted) {
    try { if ($null -ne $state) { $state.Dispose() } } catch { $failures.Add($_.Exception) }
    try { if ($null -ne $cancel) { $cancel.Dispose() } } catch { $failures.Add($_.Exception) }
  }
  try { if ($null -ne $job) { $job.Dispose() } } catch { $failures.Add($_.Exception) }
  try { if ($null -ne $lease) { $lease.Dispose() } } catch { $failures.Add($_.Exception) }
  try { if ($null -ne $identity) { $identity.Dispose() } } catch { $failures.Add($_.Exception) }
}
if ($failures.Count -eq 0) {
  $disposedReadRejected = $false
  try { $readString.Invoke($identity, [object[]]@($sidRead)) | Out-Null }
  catch { $disposedReadRejected = $_.Exception.GetBaseException() -is [ObjectDisposedException] }
  if (-not $disposedReadRejected) { $failures.Add([InvalidOperationException]::new('Disposed quota identity admitted a new read.')) }
}
if ([IO.Directory]::Exists($fixtureRoot)) { $failures.Add([IO.IOException]::new('Quota reader fixture survived cleanup.')) }
if ($failures.Count -gt 0) { throw [AggregateException]::new('Isolated quota reader regression failed.', $failures.ToArray()) }
Write-Host 'Native isolated quota reads, byte enforcement, post-disable accounting and private ACL preservation passed.'
