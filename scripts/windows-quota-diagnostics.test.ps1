$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not ('OpenCoven.WindowsJobSupervisor' -as [type])) { Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'windows-job-supervisor.cs'))) -Language CSharp }
$flags = [Reflection.BindingFlags]'NonPublic,Static'
$classify = [OpenCoven.WindowsJobSupervisor].GetMethod('ClassifyQuotaMonitorError', $flags)
if ($null -eq $classify) { throw 'Missing quota monitor classifier.' }
$boundType = [OpenCoven.WindowsJobSupervisor].GetNestedType('QuotaEntryBoundException', [Reflection.BindingFlags]'NonPublic')
$bound = [Activator]::CreateInstance($boundType, $true)
$cases = @(
  @($bound, 'entry-bound'),
  @([UnauthorizedAccessException]::new('secret-path'), 'access-denied'),
  @([IO.IOException]::new('secret-path'), 'io'),
  @([OverflowException]::new('secret-path'), 'arithmetic-overflow'),
  @([InvalidOperationException]::new('secret-path'), 'unexpected')
)
foreach ($case in $cases) {
  $actual = $classify.Invoke($null, [object[]]@($case[0]))
  if ($actual -cne $case[1]) { throw "Wrong bounded category: $actual" }
}
$stateType = [OpenCoven.WindowsJobSupervisor].GetNestedType('DirectoryQuotaFailureState', [Reflection.BindingFlags]'NonPublic')
$state = [Activator]::CreateInstance($stateType, $true)
$instanceFlags = [Reflection.BindingFlags]'NonPublic,Instance'
try {
  $record = $stateType.GetMethod('RecordMonitorError', $instanceFlags)
  $record.Invoke($state, [object[]]@([UnauthorizedAccessException]::new('secret-path')))
  $record.Invoke($state, [object[]]@([IO.IOException]::new('secret-path')))
  if ($stateType.GetProperty('MonitorErrorCategory', $instanceFlags).GetValue($state) -cne 'access-denied' -or
      -not $stateType.GetProperty('MonitorError', $instanceFlags).GetValue($state) -or
      -not $stateType.GetProperty('IsSet', $instanceFlags).GetValue($state)) {
    throw 'First monitor failure category or fail-closed state was lost.'
  }
} finally { $state.Dispose() }
Write-Host 'Bounded quota diagnostic classification and first-failure state passed.'
# Exercise the actual terminal catch with a malformed quota entry. It must
# fail closed and retain a previously classified monitor failure.
$terminal = [OpenCoven.WindowsJobSupervisor].GetMethod('ApplyTerminalDirectoryQuotaCheck', $flags)
$malformed = [OpenCoven.WindowsDirectoryQuota[]]@($null)
foreach ($prior in @($false, $true)) {
  $result = [OpenCoven.WindowsJobRunResult]::new()
  if ($prior) {
    $result.GetType().GetProperty('ResourceQuotaMonitorError').SetValue($result, $true)
    $result.GetType().GetProperty('ResourceQuotaMonitorCategory').SetValue($result, 'access-denied')
  }
  $terminal.Invoke($null, [object[]]@($result, $malformed))
  $expected = if ($prior) { 'access-denied' } else { 'unexpected' }
  if (-not $result.ResourceQuotaExceeded -or -not $result.ResourceQuotaMonitorError -or
      $result.ExitCode -eq 0 -or $result.ResourceQuotaMonitorCategory -cne $expected) {
    throw 'Terminal quota failure lost its category or fail-closed outcome.'
  }
}
Write-Host 'Terminal quota failure propagation passed.'
# Exercise the background monitor's real catch and signal path.
$asyncState = [Activator]::CreateInstance($stateType, $true)
try {
  $monitor = [OpenCoven.WindowsJobSupervisor].GetMethod('MonitorDirectoryQuotasAsync', $flags)
  $task = $monitor.Invoke($null, [object[]]@($malformed, $asyncState, [Threading.CancellationToken]::None))
  if (-not $task.Wait(5000) -or
      -not $stateType.GetProperty('IsSet', $instanceFlags).GetValue($asyncState) -or
      $stateType.GetProperty('MonitorErrorCategory', $instanceFlags).GetValue($asyncState) -cne 'unexpected') {
    throw 'Background monitor failed to retain its bounded failure category.'
  }
} finally { $asyncState.Dispose() }
Write-Host 'Background quota monitor failure propagation passed.'
# A later monitor exception must not relabel an already recorded quota breach.
$quotaState = [Activator]::CreateInstance($stateType, $true)
try {
  $stateType.GetMethod('RecordQuotaExceeded', $instanceFlags).Invoke($quotaState, [object[]]@('bootstrap aggregate'))
  $stateType.GetMethod('RecordMonitorError', $instanceFlags).Invoke($quotaState, [object[]]@([IO.IOException]::new('secret-path')))
  if (-not $stateType.GetProperty('IsSet', $instanceFlags).GetValue($quotaState) -or
      $stateType.GetProperty('QuotaLabel', $instanceFlags).GetValue($quotaState) -cne 'bootstrap aggregate' -or
      $stateType.GetProperty('MonitorError', $instanceFlags).GetValue($quotaState) -or
      $null -ne $stateType.GetProperty('MonitorErrorCategory', $instanceFlags).GetValue($quotaState)) {
    throw 'Later monitor error replaced the first quota-breach result.'
  }
} finally { $quotaState.Dispose() }
Write-Host 'First quota breach remains distinct from later monitor errors.'
