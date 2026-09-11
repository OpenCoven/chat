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
$unknownResult = [OpenCoven.WindowsJobRunResult]::new()
$terminal.Invoke($null, [object[]]@($unknownResult, $malformed))
if ($unknownResult.ResourceQuotaMonitorRoot -cne 'unknown' -or $unknownResult.ResourceQuotaMonitorOperation -cne 'unknown') { throw 'Unattributed terminal failure did not use fixed unknown context.' }
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

# Terminal rechecks must also preserve an earlier concrete quota breach.
$breachedResult = [OpenCoven.WindowsJobRunResult]::new()
$breachedResult.GetType().GetProperty('ResourceQuotaExceeded').SetValue($breachedResult, $true)
$breachedResult.GetType().GetProperty('ResourceQuotaLabel').SetValue($breachedResult, 'bootstrap aggregate')
$terminal.Invoke($null, [object[]]@($breachedResult, $malformed))
if (-not $breachedResult.ResourceQuotaExceeded -or $breachedResult.ResourceQuotaMonitorError -or
    $breachedResult.ResourceQuotaLabel -cne 'bootstrap aggregate' -or
    $null -ne $breachedResult.ResourceQuotaMonitorCategory -or $breachedResult.ExitCode -eq 0) {
  throw 'Terminal monitor error replaced the first quota-breach result.'
}
Write-Host 'Terminal recheck preserves the first quota breach.'

# Context is an allowlisted diagnostic, never an exception message or caller label.
$contextType = [OpenCoven.WindowsJobSupervisor].GetNestedType('QuotaMonitorContextException', [Reflection.BindingFlags]'NonPublic')
if ($null -eq $contextType) { throw 'Missing bounded quota root and operation context.' }
$constructor = $contextType.GetConstructor($instanceFlags, $null, [type[]]@([string], [string], [Exception]), $null)
$context = $constructor.Invoke([object[]]@('bootstrap aggregate', 'directory-enumeration', [UnauthorizedAccessException]::new('secret-path')))
$contextState = [Activator]::CreateInstance($stateType, $true)
try {
  $record.Invoke($contextState, [object[]]@($context))
  $record.Invoke($contextState, [object[]]@([IO.IOException]::new('later-secret')))
  foreach ($pair in @(@('MonitorErrorCategory', 'access-denied'), @('MonitorErrorRoot', 'bootstrap-aggregate'), @('MonitorErrorOperation', 'directory-enumeration'))) {
    if ($stateType.GetProperty($pair[0], $instanceFlags).GetValue($contextState) -cne $pair[1]) { throw "Lost first context: $($pair[0])" }
  }
  if ($context.ToString().Contains('secret-path')) { throw 'Context exception retained raw exception text.' }
} finally { $contextState.Dispose() }
$unknown = $constructor.Invoke([object[]]@('secret-label', 'secret-operation', [UnauthorizedAccessException]::new('secret-message')))
foreach ($property in @('Root', 'Operation')) {
  if ($contextType.GetProperty($property, $instanceFlags).GetValue($unknown) -cne 'unknown') { throw "Unbounded $property" }
}
foreach ($operation in @('pattern-attributes', 'pattern-enumeration', 'directory-attributes', 'directory-enumeration', 'entry-attributes', 'file-length')) {
  $operationContext = $constructor.Invoke([object[]]@('status staging', $operation, [IO.IOException]::new('secret-message')))
  if ($contextType.GetProperty('Operation', $instanceFlags).GetValue($operationContext) -cne $operation) { throw 'Lost allowed operation.' }
}
foreach ($errorCase in $cases) {
  $classifiedContext = $constructor.Invoke([object[]]@($null, $null, $errorCase[0]))
  if ($classify.Invoke($null, [object[]]@($classifiedContext)) -cne $errorCase[1]) { throw 'Context changed an existing error category.' }
}
Write-Host 'Root and operation sanitization and first-failure preservation passed.'

# A real overlong filesystem name exercises the terminal/background catches on
# every platform, including exact operation context at the attribute read.
$invalidPath = [IO.Path]::Combine($PSScriptRoot, ('q' * 1024))
$invalidQuotas = [OpenCoven.WindowsDirectoryQuota[]]@([OpenCoven.WindowsDirectoryQuota]::new('bootstrap aggregate', $invalidPath, 1MB))
$contextResult = [OpenCoven.WindowsJobRunResult]::new()
$terminal.Invoke($null, [object[]]@($contextResult, $invalidQuotas))
if (-not $contextResult.ResourceQuotaMonitorError -or $contextResult.ResourceQuotaMonitorRoot -cne 'bootstrap-aggregate' -or
    $contextResult.ResourceQuotaMonitorOperation -cne 'pattern-attributes' -or $contextResult.ResourceQuotaMonitorCategory -cne 'io') {
  throw 'Real terminal filesystem failure lost bounded context.'
}
$terminal.Invoke($null, [object[]]@($contextResult, $malformed))
if ($contextResult.ResourceQuotaMonitorRoot -cne 'bootstrap-aggregate' -or $contextResult.ResourceQuotaMonitorOperation -cne 'pattern-attributes') { throw 'Terminal recheck replaced first context.' }
$backgroundContext = [Activator]::CreateInstance($stateType, $true)
try {
  $task = $monitor.Invoke($null, [object[]]@($invalidQuotas, $backgroundContext, [Threading.CancellationToken]::None))
  if (-not $task.Wait(5000) -or $stateType.GetProperty('MonitorErrorRoot', $instanceFlags).GetValue($backgroundContext) -cne 'bootstrap-aggregate' -or
      $stateType.GetProperty('MonitorErrorOperation', $instanceFlags).GetValue($backgroundContext) -cne 'pattern-attributes') { throw 'Background filesystem failure lost bounded context.' }
} finally { $backgroundContext.Dispose() }
Write-Host 'Real filesystem terminal and background context propagation passed.'

# Deny enumeration on a fresh fixture only; restore its original access before
# deleting it. This exercises real access-denied on Windows and Unix hosts.
$deniedPath = Join-Path $PSScriptRoot ('.quota-denied-' + [guid]::NewGuid().ToString('N'))
$null = [IO.Directory]::CreateDirectory($deniedPath)
$originalAcl = $null
try {
  [IO.File]::WriteAllText((Join-Path $deniedPath 'payload'), 'quota')
  if ($IsWindows) {
    $originalAcl = Get-Acl -LiteralPath $deniedPath
    $deniedAcl = Get-Acl -LiteralPath $deniedPath
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::ListDirectory, [Security.AccessControl.AccessControlType]::Deny)
    $deniedAcl.AddAccessRule($rule)
    Set-Acl -LiteralPath $deniedPath -AclObject $deniedAcl
  } else {
    & chmod 000 $deniedPath
    if ($LASTEXITCODE -ne 0) { throw 'Could not deny quota fixture access.' }
  }
  $deniedQuotas = [OpenCoven.WindowsDirectoryQuota[]]@([OpenCoven.WindowsDirectoryQuota]::new('status staging', $deniedPath, 1MB))
  $deniedResult = [OpenCoven.WindowsJobRunResult]::new()
  $terminal.Invoke($null, [object[]]@($deniedResult, $deniedQuotas))
  if (-not $deniedResult.ResourceQuotaExceeded -or -not $deniedResult.ResourceQuotaMonitorError -or $deniedResult.ExitCode -eq 0 -or
      $deniedResult.ResourceQuotaMonitorCategory -cne 'access-denied' -or $deniedResult.ResourceQuotaMonitorRoot -cne 'status-staging' -or
      $deniedResult.ResourceQuotaMonitorOperation -cne 'directory-enumeration') { throw 'Native access-denied fixture lost its category/root/operation.' }
  # Wildcard discovery has a distinct enumeration seam; a caller label that
  # happens to be valid quota grammar still must not enter diagnostics.
  $wildcardQuotas = [OpenCoven.WindowsDirectoryQuota[]]@([OpenCoven.WindowsDirectoryQuota]::new('private-user-label', (Join-Path $deniedPath '*'), 1MB))
  $wildcardResult = [OpenCoven.WindowsJobRunResult]::new()
  $terminal.Invoke($null, [object[]]@($wildcardResult, $wildcardQuotas))
  if ($wildcardResult.ResourceQuotaMonitorCategory -cne 'access-denied' -or $wildcardResult.ResourceQuotaMonitorRoot -cne 'unknown' -or
      $wildcardResult.ResourceQuotaMonitorOperation -cne 'pattern-enumeration') { throw 'Wildcard enumeration failed to preserve sanitized context.' }
  $deniedState = [Activator]::CreateInstance($stateType, $true)
  try {
    $task = $monitor.Invoke($null, [object[]]@($deniedQuotas, $deniedState, [Threading.CancellationToken]::None))
    if (-not $task.Wait(5000)) { throw 'Native access-denied background check did not terminate.' }
    foreach ($pair in @(@('MonitorErrorCategory', 'access-denied'), @('MonitorErrorRoot', 'status-staging'), @('MonitorErrorOperation', 'directory-enumeration'))) {
      if ($stateType.GetProperty($pair[0], $instanceFlags).GetValue($deniedState) -cne $pair[1]) { throw "Native background check lost $($pair[0])." }
    }
  } finally { $deniedState.Dispose() }
} finally {
  if ($IsWindows) {
    if ($null -ne $originalAcl) { Set-Acl -LiteralPath $deniedPath -AclObject $originalAcl }
  } else {
    & chmod 700 $deniedPath
    if ($LASTEXITCODE -ne 0) { throw 'Could not restore quota fixture access.' }
  }
  Remove-Item -LiteralPath $deniedPath -Recurse -Force
}
Write-Host 'Native access-denied terminal and background quota context passed.'
