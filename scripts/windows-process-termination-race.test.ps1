$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($null -eq ('OpenCoven.WindowsJobSupervisor' -as [type])) {
  Add-Type -Path (Join-Path $PSScriptRoot 'windows-job-supervisor.cs')
}
$flags = [Reflection.BindingFlags]'NonPublic,Static'
$confirm = [OpenCoven.WindowsJobSupervisor].GetMethod('CanConfirmTerminatedProcess', $flags)
if ($null -eq $confirm) { throw 'Retained-handle termination confirmation is missing.' }
foreach ($case in @(
  @(5, [uint32]0, $true),
  @(5, [uint32]258, $false),
  @(5, [uint32]::MaxValue, $false),
  @(5, [uint32]128, $false),
  @(6, [uint32]0, $false),
  @(87, [uint32]0, $false),
  @(0, [uint32]0, $false)
)) {
  $actual = $confirm.Invoke($null, [object[]]@([int]$case[0], [uint32]$case[1]))
  if ($actual -ne $case[2]) { throw 'Unconfirmed termination error was accepted or confirmed exit rejected.' }
}
Write-Output 'Retained-handle termination classification passed.'

if ($IsWindows) {
  $supervisor = [OpenCoven.WindowsJobSupervisor]
  $reap = $supervisor.GetMethod('TerminateAndReapMatchingProcess', $flags)
  $open = $supervisor.GetMethod('OpenProcess', $flags)
  $close = $supervisor.GetMethod('CloseHandle', $flags)
  foreach ($scenario in @('exited', 'live-denied', 'exit-query-denied', 'still-active-code')) {
    $start = [Diagnostics.ProcessStartInfo]::new((Get-Process -Id $PID).Path)
    $start.UseShellExecute = $false
    foreach ($argument in @('-NoLogo', '-NoProfile', '-NonInteractive', '-Command')) {
      $start.ArgumentList.Add($argument)
    }
    $start.ArgumentList.Add($(switch ($scenario) {
      'exited' { 'exit 7' }
      'still-active-code' { 'exit 259' }
      default { 'Start-Sleep -Seconds 60' }
    }))
    $child = [Diagnostics.Process]::Start($start)
    $restricted = [IntPtr]::Zero
    try {
      # Retain the original handle before the child exits; never reopen by PID after exit.
      $handle = $child.Handle
      if ($scenario -in @('exited', 'still-active-code')) {
        if (-not $child.WaitForExit(30000)) { throw 'Termination fixture did not exit.' }
      } else {
        $rights = if ($scenario -eq 'live-denied') { [uint32]0x101000 } else { [uint32]0x100001 }
        $restricted = $open.Invoke($null, [object[]]@($rights, $false, [uint32]$child.Id))
        if ($restricted -eq [IntPtr]::Zero) { throw 'Could not open restricted fixture handle.' }
        $handle = $restricted
      }
      $failure = $null
      try { $reap.Invoke($null, [object[]]@($handle)) } catch {
        $failure = $_.Exception
        while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
      }
      switch ($scenario) {
        'exited' { if ($null -ne $failure) { throw $failure } }
        'live-denied' {
          if ($failure -isnot [ComponentModel.Win32Exception] -or $failure.NativeErrorCode -ne 5) {
            throw 'Live process access denial was not preserved.'
          }
          if ($child.HasExited) { throw 'Access-denied fixture unexpectedly exited.' }
        }
        default {
          if ($failure -isnot [InvalidOperationException] -or
              $failure.Message -ne 'Matching isolated-SID process could not be reaped.') {
            throw 'Unverified exit code was accepted.'
          }
        }
      }
    } finally {
      if ($restricted -ne [IntPtr]::Zero) { $null = $close.Invoke($null, [object[]]@($restricted)) }
      if (-not $child.HasExited) { $child.Kill($true); $child.WaitForExit() }
      $child.Dispose()
    }
  }
  Write-Output 'Retained-handle Windows termination tests passed.'
}
