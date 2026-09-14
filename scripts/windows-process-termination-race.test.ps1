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

$core = [OpenCoven.WindowsJobSupervisor].GetMethod('ReapMatchingProcessCore', $flags)
if ($null -eq $core) { throw 'Retained-handle failure diagnostics core is missing.' }
foreach ($case in @(
  @(5, [uint32]258, [uint32]259, 'timeout', 'active'),
  @(5, [uint32]258, [uint32]7, 'timeout', 'nonactive'),
  @(5, [uint32]::MaxValue, [uint32]259, 'failed', 'active'),
  @(5, [uint32]128, $null, 'failed', 'failed'),
  @(5, [uint32]258, $null, 'timeout', 'failed'),
  @(6, [uint32]0, [uint32]7, 'signaled', 'nonactive'),
  @(87, [uint32]258, [uint32]259, 'timeout', 'active'),
  @(0, [uint32]0, $null, 'signaled', 'failed')
)) {
  $calls = [Collections.Generic.List[string]]::new()
  $handle = [IntPtr]1234
  $wait = [Func[IntPtr, uint32, uint32]]{
    param($actualHandle, $milliseconds)
    if ($actualHandle -ne $handle -or $milliseconds -ne 0) { throw 'Diagnostic wait changed handle or bound.' }
    $calls.Add('wait')
    return $case[1]
  }
  $query = [Func[IntPtr, Nullable[uint32]]]{
    param($actualHandle)
    if ($actualHandle -ne $handle) { throw 'Diagnostic query changed handle.' }
    $calls.Add('query')
    return $case[2]
  }
  $lastError = [Func[int]]{ throw 'Diagnostic calls must not replace original error.' }
  $failure = $null
  try {
    $core.Invoke($null, [object[]]@($handle, [Nullable[int]]$case[0], $wait, $query, $lastError))
  } catch {
    $failure = $_.Exception
    while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
  }
  if ($failure -isnot [ComponentModel.Win32Exception] -or $failure.NativeErrorCode -ne $case[0]) {
    throw 'Original failed termination or native error was not preserved.'
  }
  $expected = "Matching isolated-SID process termination failed. [termination-error=$($case[0]);wait=$($case[3]);exit=$($case[4])]"
  if ($failure.Message -cne $expected) { throw "Unexpected bounded failure diagnostic: $($failure.Message)" }
  if (($calls -join ',') -ne 'wait,query') { throw 'Diagnostics must observe each retained-handle state exactly once.' }
}

# Confirmed exit remains success; later reap failures retain their original kind.
foreach ($case in @(
  @([uint32]0, [uint32]7, $null, $null),
  @([uint32]0, [uint32]259, [InvalidOperationException], 'active'),
  @([uint32]0, $null, [InvalidOperationException], 'failed'),
  @([uint32]258, [uint32]7, [TimeoutException], 'nonactive'),
  @([uint32]::MaxValue, $null, [ComponentModel.Win32Exception], 'failed')
)) {
  $calls = [Collections.Generic.List[string]]::new()
  $handle = [IntPtr]1234
  $wait = [Func[IntPtr, uint32, uint32]]{
    param($actualHandle, $milliseconds)
    if ($actualHandle -ne $handle) { throw 'Reap changed handle.' }
    $calls.Add("wait-$milliseconds")
    if ($milliseconds -eq 0) { return [uint32]0 }
    if ($milliseconds -ne 30000) { throw 'Reap changed timeout.' }
    return $case[0]
  }
  $query = [Func[IntPtr, Nullable[uint32]]]{
    param($actualHandle)
    if ($actualHandle -ne $handle) { throw 'Reap query changed handle.' }
    $calls.Add('query')
    return $case[1]
  }
  $lastError = [Func[int]]{ $calls.Add('last-error'); return 6 }
  $failure = $null
  try {
    $core.Invoke($null, [object[]]@($handle, [Nullable[int]]5, $wait, $query, $lastError))
  } catch {
    $failure = $_.Exception
    while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
  }
  if ($null -eq $case[2]) {
    if ($null -ne $failure) { throw $failure }
  } else {
    if ($failure -isnot $case[2]) { throw 'Reap failure kind changed.' }
    if ($failure -is [ComponentModel.Win32Exception] -and $failure.NativeErrorCode -ne 6) {
      throw 'Reap wait error was overwritten by diagnostics.'
    }
    if (-not $failure.Message.EndsWith("[termination-error=5;wait=signaled;exit=$($case[3])]")) {
      throw 'Reap failure lost original termination observation.'
    }
  }
  $expectedCalls = if ($case[0] -eq [uint32]::MaxValue) {
    'wait-0,wait-30000,last-error,query'
  } else { 'wait-0,wait-30000,query' }
  if (($calls -join ',') -ne $expectedCalls) { throw 'Reap diagnostics repeated or reordered native observations.' }
}
Write-Output 'Retained-handle failure diagnostic matrix passed.'

if ($IsWindows) {
  $supervisor = [OpenCoven.WindowsJobSupervisor]
  $reap = $supervisor.GetMethod('TerminateAndReapMatchingProcess', $flags)
  $open = $supervisor.GetMethod('OpenProcess', $flags)
  $close = $supervisor.GetMethod('CloseHandle', $flags)
  foreach ($scenario in @('exited', 'live-denied', 'wait-denied', 'exit-query-denied', 'still-active-code')) {
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
        $rights = switch ($scenario) {
          'live-denied' { [uint32]0x101000 }
          'wait-denied' { [uint32]0x1000 }
          default { [uint32]0x100001 }
        }
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
        { $_ -in @('live-denied', 'wait-denied') } {
          if ($failure -isnot [ComponentModel.Win32Exception] -or $failure.NativeErrorCode -ne 5) {
            throw 'Live process access denial was not preserved.'
          }
          if ($child.HasExited) { throw 'Access-denied fixture unexpectedly exited.' }
          $waitCategory = if ($scenario -eq 'live-denied') { 'timeout' } else { 'failed' }
          if (-not $failure.Message.EndsWith("[termination-error=5;wait=$waitCategory;exit=active]")) {
            throw 'Native denied handle lost bounded failure observations.'
          }
        }
        default {
          if ($failure -isnot [InvalidOperationException] -or
              -not $failure.Message.StartsWith('Matching isolated-SID process could not be reaped.')) {
            throw 'Unverified exit code was accepted.'
          }
        }
      }
    } finally {
      if ($restricted -ne [IntPtr]::Zero) { $null = $close.Invoke($null, [object[]]@($restricted)) }
      if (-not $child.HasExited) { $child.Kill($true); $child.WaitForExit() }
      $child.Dispose()
    }
    Write-Output "Retained-handle Windows scenario passed: $scenario"
  }
  Write-Output 'Retained-handle Windows termination tests passed.'
}
