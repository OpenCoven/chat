$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not ('OpenCoven.WindowsJobSupervisor' -as [type])) {
  Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'windows-job-supervisor.cs'))) -Language CSharp
}
$staticFlags = [Reflection.BindingFlags]'NonPublic,Static'
$instanceFlags = [Reflection.BindingFlags]'NonPublic,Instance'
$dispose = [OpenCoven.WindowsJobSupervisor].GetMethod('DisposeDirectoryQuotaResources', $staticFlags)
if ($null -eq $dispose) { throw 'Quota resource lifetime helper is missing.' }
$stateType = [OpenCoven.WindowsJobSupervisor].GetNestedType('DirectoryQuotaFailureState', [Reflection.BindingFlags]'NonPublic')
foreach ($completedFirst in @($false, $true)) {
  $state = [Activator]::CreateInstance($stateType, $true)
  $signal = $stateType.GetField('signal', $instanceFlags).GetValue($state)
  $cancel = [Threading.CancellationTokenSource]::new()
  $completion = [Threading.Tasks.TaskCompletionSource[bool]]::new()
  try {
    if ($completedFirst) { $completion.SetResult($true) }
    $disposalTask = $dispose.Invoke($null, [object[]]@($completion.Task, $cancel, $state))
    if (-not $completedFirst) {
      # Model a worker that survived the existing bounded wait and still owns
      # these resources. Cleanup must not dispose them until it finishes.
      $cancel.Cancel()
      $cancel.Token | Out-Null
      $stateType.GetMethod('RecordMonitorError', $instanceFlags).Invoke(
        $state, [object[]]@([IO.IOException]::new('controlled-monitor-failure'))
      )
      if (-not $signal.IsSet) { throw 'Live monitor could not record its failure.' }
      $signal.WaitHandle | Out-Null
      $completion.SetResult($true)
    }
    if (-not $disposalTask.Wait(5000)) { throw 'Monitor resource disposal did not complete.' }
    $cancelDisposed = $false
    try { $cancel.GetType().GetProperty('Token').GetValue($cancel) | Out-Null }
    catch { $cancelDisposed = $_.Exception.GetBaseException() -is [ObjectDisposedException] }
    $signalDisposed = $false
    try { $signal.GetType().GetProperty('WaitHandle').GetValue($signal) | Out-Null }
    catch { $signalDisposed = $_.Exception.GetBaseException() -is [ObjectDisposedException] }
    if (-not $cancelDisposed -or -not $signalDisposed) { throw 'Completed monitor resources were not disposed.' }
  } finally {
    $completion.TrySetResult($true) | Out-Null
    $cancel.Dispose()
    $state.Dispose()
  }
}
Write-Host 'Completed and still-running quota monitor resource lifetimes passed.'
