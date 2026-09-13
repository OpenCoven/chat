$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'Owned profile application tests require native Windows.' }
$flags = [Reflection.BindingFlags]'NonPublic,Static'
$terminal = [OpenCoven.WindowsJobSupervisor].GetMethod('ApplyTerminalDirectoryQuotaCheckAsUser', $flags)
$monitor = [OpenCoven.WindowsJobSupervisor].GetMethod('MonitorDirectoryQuotasAsUserAsync', $flags)
$stateType = [OpenCoven.WindowsJobSupervisor].GetNestedType('DirectoryQuotaFailureState', [Reflection.BindingFlags]'NonPublic')
$quarantineState = $null
$context = New-IsolatedTestContext -Label 'profile-application'
$app = Join-Path $context.User.OperatingSystemProfilePath '.coven'
$quota = [OpenCoven.WindowsDirectoryQuota[]]@(
  [OpenCoven.WindowsDirectoryQuota]::new('bootstrap aggregate', $context.User.RootPath, 1000, $true)
)
function Read-ApplicationQuota {
  $result = [OpenCoven.WindowsJobRunResult]::new()
  $terminal.Invoke($null, [object[]]@($context.User, $result, $quota)) | Out-Null
  return $result
}
try {
  [IO.File]::WriteAllBytes((Join-Path $context.User.RootPath 'artifact.bin'), [byte[]]::new(600))
  [IO.File]::WriteAllBytes((Join-Path $app 'application.bin'), [byte[]]::new(600))
  $result = Read-ApplicationQuota
  if (-not $result.ResourceQuotaExceeded -or $result.ResourceQuotaMonitorError) {
    throw 'Combined terminal profile application overflow was not measured.'
  }
  $state = [Activator]::CreateInstance($stateType, $true)
  $task = $null
  $cancel = [Threading.CancellationTokenSource]::new(5000)
  try {
    $task = $monitor.Invoke($null, [object[]]@($context.User, $quota, $state, $cancel.Token))
    if (-not $task.Wait(6000) -or
        $stateType.GetProperty('MonitorError', [Reflection.BindingFlags]'NonPublic,Instance').GetValue($state) -or
        $stateType.GetProperty('QuotaLabel', [Reflection.BindingFlags]'NonPublic,Instance').GetValue($state) -cne 'bootstrap aggregate') {
      throw 'Combined periodic profile application overflow was not measured.'
    }
  } finally {
    $cancel.Cancel()
    if ($null -ne $task) { $task.Wait(6000) | Out-Null }
    $state.Dispose()
    $cancel.Dispose()
  }
  [IO.File]::WriteAllBytes((Join-Path $app 'application.bin'), [byte[]]::new(400))
  $result = Read-ApplicationQuota
  if ($result.ResourceQuotaExceeded -or $result.ResourceQuotaMonitorError) { throw 'Exact combined maximum failed.' }

  foreach ($path in @($context.User.OperatingSystemProfilePath, $app)) {
    $replacement = $path + '-replacement-' + [Guid]::NewGuid().ToString('N')
    $moved = $false
    try { [IO.Directory]::Move($path, $replacement); $moved = $true }
    catch {
      if ($_.Exception.GetBaseException() -isnot [IO.IOException]) { throw }
    }
    if ($moved) {
      [IO.Directory]::Move($replacement, $path)
      throw 'Retained owned directory allowed replacement.'
    }
  }

  foreach ($path in @($context.User.OperatingSystemProfilePath, $app)) {
    $original = Get-Acl -LiteralPath $path
    try {
      $changed = Get-Acl -LiteralPath $path
      $changed.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new('S-1-1-0'),
        [Security.AccessControl.FileSystemRights]::Write,
        [Security.AccessControl.AccessControlType]::Allow))
      Set-Acl -LiteralPath $path -AclObject $changed
      $result = Read-ApplicationQuota
      if (-not $result.ResourceQuotaMonitorError -or -not $result.ResourceQuotaExceeded) {
        throw 'Untrusted profile writer mutation was accepted.'
      }
    } finally { Set-Acl -LiteralPath $path -AclObject $original }
  }
  $original = Get-Acl -LiteralPath $app
  try {
    $changed = Get-Acl -LiteralPath $app
    $changed.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User)
    Set-Acl -LiteralPath $app -AclObject $changed
    $result = Read-ApplicationQuota
    if (-not $result.ResourceQuotaMonitorError) { throw 'Foreign application owner was accepted.' }
  } finally { Set-Acl -LiteralPath $app -AclObject $original }

  # Child fixtures must retain their own ACL-editing rights; the pinned root must not.
  $read = [OpenCoven.WindowsIsolatedUser].GetMethod('RunQuotaRead', [Reflection.BindingFlags]'NonPublic,Instance').MakeGenericMethod([type[]]@([bool]))
  $child = Join-Path $app 'child-acl'
  $callback = [Func[bool]] {
    [IO.Directory]::CreateDirectory($child) | Out-Null
    $acl = Get-Acl -LiteralPath $child
    Set-Acl -LiteralPath $child -AclObject $acl
    return $true
  }
  if (-not $read.Invoke($context.User, [object[]]@($callback))) { throw 'Inherited child ACL rights failed.' }
  $result = Read-ApplicationQuota
  if ($result.ResourceQuotaExceeded -or $result.ResourceQuotaMonitorError) { throw 'Restored owned application failed validation.' }
  $originalQuota = $quota
  $harnessRoot = [IO.Directory]::CreateDirectory((Join-Path $context.User.TempPath 'phase1-conformance-run-shared')).FullName
  [IO.File]::Move((Join-Path $context.User.RootPath 'artifact.bin'), (Join-Path $harnessRoot 'artifact.bin'))
  try {
    $quota = [OpenCoven.WindowsDirectoryQuota[]]@(
      [OpenCoven.WindowsDirectoryQuota]::new('harness execution aggregate',
        (Join-Path $context.User.TempPath 'phase1-conformance-run-*'), 1000, $true)
    )
    [IO.File]::WriteAllBytes((Join-Path $app 'application.bin'), [byte[]]::new(600))
    $result = Read-ApplicationQuota
    if (-not $result.ResourceQuotaExceeded -or $result.ResourceQuotaMonitorError) { throw 'Harness aggregate omitted application bytes.' }
    foreach ($invalid in @(
      [OpenCoven.WindowsDirectoryQuota]::new('component', $context.User.RootPath, 1000, $true),
      [OpenCoven.WindowsDirectoryQuota]::new('bootstrap aggregate', $app, 1000, $true)
    )) {
      $quota = [OpenCoven.WindowsDirectoryQuota[]]@($invalid)
      $result = Read-ApplicationQuota
      if (-not $result.ResourceQuotaMonitorError) { throw 'Unregistered aggregate definition was accepted.' }
    }
  } finally {
    $quota = $originalQuota
    [IO.File]::WriteAllBytes((Join-Path $app 'application.bin'), [byte[]]::new(400))
  }
  $original = Get-Acl -LiteralPath $app
  try {
    $changed = Get-Acl -LiteralPath $app
    $changed.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      [Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
      [Security.AccessControl.FileSystemRights]::Read,
      [Security.AccessControl.AccessControlType]::Allow))
    Set-Acl -LiteralPath $app -AclObject $changed
    $result = Read-ApplicationQuota
    if (-not $result.ResourceQuotaMonitorError) { throw 'Extra application ACE was accepted.' }
  } finally { Set-Acl -LiteralPath $app -AclObject $original }

  $quarantineState = @{ Complete = $false }
  $register = [OpenCoven.WindowsIsolatedUser].GetMethod('RegisterTerminalQuarantine', [Reflection.BindingFlags]'NonPublic,Instance')
  $register.Invoke($context.User, [object[]]@(
    [Action]{ throw 'injected-quarantine-failure' },
    [Func[bool]]{ return $quarantineState.Complete }
  )) | Out-Null
  $deferred = $false
  try { $context.User.Dispose() }
  catch { $deferred = $_.Exception.Message.Contains('cleanup deferred') }
  if (-not $deferred -or -not (Test-Path -LiteralPath $app) -or
      -not (Test-Path -LiteralPath $context.User.RootPath) -or
      $null -eq (Get-LocalUser -Name $context.User.UserName -ErrorAction SilentlyContinue)) {
    throw 'Failed quarantine did not retain profile ownership for retry.'
  }
  $result = Read-ApplicationQuota
  if ($result.ResourceQuotaMonitorError) { throw 'Failed quarantine released the retained quota identity.' }
  $unexpected = $app + '-after-failure'
  $moved = $false
  try { [IO.Directory]::Move($app, $unexpected); $moved = $true }
  catch { if ($_.Exception.GetBaseException() -isnot [IO.IOException]) { throw } }
  if ($moved) {
    [IO.Directory]::Move($unexpected, $app)
    throw 'Failed quarantine released the application pin.'
  }
} finally {
  # This injected context never launched a producer; allow the cleanup retry.
  if ($null -ne $quarantineState) { $quarantineState.Complete = $true }
  Remove-IsolatedTestContext -Context $context
}
foreach ($path in @($app, $context.User.OperatingSystemProfilePath, $context.User.RootPath)) {
  if (Test-Path -LiteralPath $path) { throw 'Owned application survived pin release and cleanup.' }
}
Write-Host 'Owned profile application tests passed: shared accounting, mutation rejection, retained identity, child ACLs, cleanup.'
