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
$boundedConstructor = $contextType.GetConstructor(
  $instanceFlags,
  $null,
  [type[]]@([string], [string], [string], [string], [Exception]),
  $null
)
if ($null -eq $boundedConstructor) { throw 'Missing bounded quota scope/repeat context overload.' }
$boundedContext = $boundedConstructor.Invoke([object[]]@(
  'bootstrap aggregate',
  'directory-enumeration-depth-3-plus',
  'workspace',
  'persistent',
  [UnauthorizedAccessException]::new('private-nonce')
))
$boundedState = [Activator]::CreateInstance($stateType, $true)
try {
  $record.Invoke($boundedState, [object[]]@($boundedContext))
  foreach ($pair in @(
      @('MonitorErrorRoot', 'bootstrap-aggregate'),
      @('MonitorErrorScope', 'workspace'),
      @('MonitorErrorOperation', 'directory-enumeration-depth-3-plus'),
      @('MonitorErrorRepeat', 'persistent'))) {
    if ($stateType.GetProperty($pair[0], $instanceFlags).GetValue($boundedState) -cne $pair[1]) {
      throw "Lost bounded quota context: $($pair[0])"
    }
  }
  if ($boundedContext.ToString().Contains('private-nonce')) {
    throw 'Bounded quota context retained private exception text.'
  }
} finally { $boundedState.Dispose() }
$unknown = $constructor.Invoke([object[]]@('secret-label', 'secret-operation', [UnauthorizedAccessException]::new('secret-message')))
foreach ($property in @('Root', 'Operation')) {
  if ($contextType.GetProperty($property, $instanceFlags).GetValue($unknown) -cne 'unknown') { throw "Unbounded $property" }
}
foreach ($operation in @('pattern-attributes', 'pattern-enumeration', 'directory-attributes', 'directory-enumeration', 'directory-enumeration-root', 'directory-enumeration-depth-1', 'directory-enumeration-depth-2', 'directory-enumeration-depth-3-plus', 'entry-attributes', 'file-length')) {
  $operationContext = $constructor.Invoke([object[]]@('status staging', $operation, [IO.IOException]::new('secret-message')))
  if ($contextType.GetProperty('Operation', $instanceFlags).GetValue($operationContext) -cne $operation) { throw 'Lost allowed operation.' }
}
foreach ($errorCase in $cases) {
  $classifiedContext = $constructor.Invoke([object[]]@($null, $null, $errorCase[0]))
  if ($classify.Invoke($null, [object[]]@($classifiedContext)) -cne $errorCase[1]) { throw 'Context changed an existing error category.' }
}
Write-Host 'Root and operation sanitization and first-failure preservation passed.'

$classifyScope = [OpenCoven.WindowsJobSupervisor].GetMethod('ClassifyBootstrapQuotaScope', $flags)
if ($null -eq $classifyScope) { throw 'Missing bounded bootstrap quota scope classifier.' }
$scopeRoot = 'C:\quota-root'
$scopeCases = @(
  @($scopeRoot, 'root'),
  @("$scopeRoot\profile\AppData\private-nonce", 'profile'),
  @("$scopeRoot\temp\private-nonce", 'temp'),
  @("$scopeRoot\status-staging\private-nonce", 'status-staging'),
  @("$scopeRoot\workspace\node_modules\private-nonce", 'workspace'),
  @("$scopeRoot\downloads\private-nonce", 'downloads'),
  @("$scopeRoot\tools\git\private-nonce", 'tools-git'),
  @("$scopeRoot\tools\node\private-nonce", 'tools-node'),
  @("$scopeRoot\tools\pnpm\private-nonce", 'tools-pnpm'),
  @("$scopeRoot\tools\private-nonce", 'tools-other'),
  @("$scopeRoot\rustup\private-nonce", 'rustup'),
  @("$scopeRoot\cargo\registry\private-nonce", 'cargo-registry'),
  @("$scopeRoot\cargo\git\private-nonce", 'cargo-git'),
  @("$scopeRoot\cargo\private-nonce", 'cargo-other'),
  @("$scopeRoot\pnpm-store\private-nonce", 'pnpm-store'),
  @("$scopeRoot\npm-cache\private-nonce", 'npm-cache'),
  @("$scopeRoot\counterparts\private-nonce", 'counterparts'),
  @("$scopeRoot\private-nonce", 'other')
)
foreach ($scopeCase in $scopeCases) {
  $actualScope = $classifyScope.Invoke($null, [object[]]@(
    'bootstrap aggregate',
    $scopeRoot,
    $scopeCase[0]
  ))
  if ($actualScope -cne $scopeCase[1] -or $actualScope.Contains('private-nonce')) {
    throw "Bootstrap scope was not bounded: $actualScope"
  }
}
foreach ($unscoped in @(
    @('workspace aggregate', $scopeRoot, "$scopeRoot\workspace"),
    @('bootstrap aggregate', $scopeRoot, 'C:\quota-root-sibling\private-nonce'))) {
  if ($classifyScope.Invoke($null, [object[]]@($unscoped[0], $unscoped[1], $unscoped[2])) -cne 'none') {
    throw 'Non-bootstrap or out-of-root quota path gained a scope.'
  }
}
Write-Host 'Bootstrap quota scope classification is fixed and path-free.'

if (-not ('OpenCoven.Tests.QuotaRepeatProbe' -as [type])) {
  Add-Type -Language CSharp -TypeDefinition @'
using System;
namespace OpenCoven.Tests
{
    public static class QuotaRepeatProbe
    {
        public static int TransientCalls;
        public static int PersistentCalls;
        public static Func<string> TransientRead { get { return Transient; } }
        public static Func<string> PersistentRead { get { return Persistent; } }

        public static string Transient()
        {
            TransientCalls++;
            if (TransientCalls == 1) throw new UnauthorizedAccessException("private-transient");
            return "ok";
        }

        public static string Persistent()
        {
            PersistentCalls++;
            throw new UnauthorizedAccessException("private-persistent");
        }
    }
}
'@
}
$readQuota = [OpenCoven.WindowsJobSupervisor].GetMethod('ReadQuotaOperation', $flags).MakeGenericMethod([string])
foreach ($repeatCase in @(
    @([OpenCoven.Tests.QuotaRepeatProbe]::TransientRead, 'transient', 'TransientCalls'),
    @([OpenCoven.Tests.QuotaRepeatProbe]::PersistentRead, 'persistent', 'PersistentCalls'))) {
  $caught = $null
  try {
    $readQuota.Invoke($null, [object[]]@('entry-attributes', $repeatCase[0])) | Out-Null
  } catch {
    $caught = $_.Exception.GetBaseException()
  }
  if ($null -eq $caught -or
      $contextType.GetProperty('Category', $instanceFlags).GetValue($caught) -cne 'access-denied' -or
      $contextType.GetProperty('Scope', $instanceFlags).GetValue($caught) -cne 'none' -or
      $contextType.GetProperty('Operation', $instanceFlags).GetValue($caught) -cne 'entry-attributes' -or
      $contextType.GetProperty('Repeat', $instanceFlags).GetValue($caught) -cne $repeatCase[1] -or
      [OpenCoven.Tests.QuotaRepeatProbe].GetField($repeatCase[2]).GetValue($null) -ne 2 -or
      $caught.ToString().Contains('private-')) {
    throw "Quota repeat classification changed: $($repeatCase[1])"
  }
}
Write-Host 'Quota read repeat classification is bounded and remains fail-closed.'

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
foreach ($depth in @(0, 1, 2, 3, 5)) {
  $fixtureRoot = Join-Path $PSScriptRoot ('.quota-denied-' + [guid]::NewGuid().ToString('N'))
  $deniedPath = $fixtureRoot
  for ($level = 0; $level -lt $depth; $level++) { $deniedPath = Join-Path $deniedPath ('private-child-' + $level) }
  $expectedOperation = switch ($depth) {
    0 { 'directory-enumeration-root' }
    1 { 'directory-enumeration-depth-1' }
    2 { 'directory-enumeration-depth-2' }
    default { 'directory-enumeration-depth-3-plus' }
  }
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
    foreach ($pathPattern in @($fixtureRoot, ($fixtureRoot + '*'))) {
      $deniedQuotas = [OpenCoven.WindowsDirectoryQuota[]]@([OpenCoven.WindowsDirectoryQuota]::new('status staging', $pathPattern, 1MB))
      $deniedResult = [OpenCoven.WindowsJobRunResult]::new()
      $terminal.Invoke($null, [object[]]@($deniedResult, $deniedQuotas))
      if (-not $deniedResult.ResourceQuotaExceeded -or -not $deniedResult.ResourceQuotaMonitorError -or $deniedResult.ExitCode -eq 0 -or
          $deniedResult.ResourceQuotaMonitorCategory -cne 'access-denied' -or $deniedResult.ResourceQuotaMonitorRoot -cne 'status-staging' -or
          $deniedResult.ResourceQuotaMonitorScope -cne 'none' -or $deniedResult.ResourceQuotaMonitorOperation -cne $expectedOperation -or
          $deniedResult.ResourceQuotaMonitorRepeat -cne 'persistent') { throw 'Native access-denied fixture lost its bounded context.' }
      $terminal.Invoke($null, [object[]]@($deniedResult, $malformed))
      if ($deniedResult.ResourceQuotaMonitorOperation -cne $expectedOperation) { throw 'Terminal recheck replaced first depth context.' }
      # Wildcard discovery has a distinct enumeration seam; a caller label that
      # happens to be valid quota grammar still must not enter diagnostics.
      $wildcardQuotas = [OpenCoven.WindowsDirectoryQuota[]]@([OpenCoven.WindowsDirectoryQuota]::new('private-user-label', (Join-Path $deniedPath '*'), 1MB))
      $wildcardResult = [OpenCoven.WindowsJobRunResult]::new()
      $terminal.Invoke($null, [object[]]@($wildcardResult, $wildcardQuotas))
      if ($wildcardResult.ResourceQuotaMonitorCategory -cne 'access-denied' -or $wildcardResult.ResourceQuotaMonitorRoot -cne 'unknown' -or
          $wildcardResult.ResourceQuotaMonitorScope -cne 'none' -or $wildcardResult.ResourceQuotaMonitorOperation -cne 'pattern-enumeration' -or
          $wildcardResult.ResourceQuotaMonitorRepeat -cne 'persistent') { throw 'Wildcard enumeration failed to preserve sanitized context.' }
      $deniedState = [Activator]::CreateInstance($stateType, $true)
      try {
        $task = $monitor.Invoke($null, [object[]]@($deniedQuotas, $deniedState, [Threading.CancellationToken]::None))
        if (-not $task.Wait(5000)) { throw 'Native access-denied background check did not terminate.' }
        foreach ($pair in @(@('MonitorErrorCategory', 'access-denied'), @('MonitorErrorRoot', 'status-staging'), @('MonitorErrorOperation', $expectedOperation))) {
          if ($stateType.GetProperty($pair[0], $instanceFlags).GetValue($deniedState) -cne $pair[1]) { throw "Native background check lost $($pair[0])." }
        }
        if ($stateType.GetProperty('MonitorErrorScope', $instanceFlags).GetValue($deniedState) -cne 'none' -or
            $stateType.GetProperty('MonitorErrorRepeat', $instanceFlags).GetValue($deniedState) -cne 'persistent') {
          throw 'Native background check lost scope/repeat context.'
        }
      } finally { $deniedState.Dispose() }
    }
  } finally {
    if ($IsWindows) {
      if ($null -ne $originalAcl) { Set-Acl -LiteralPath $deniedPath -AclObject $originalAcl }
    } else {
      & chmod 700 $deniedPath
      if ($LASTEXITCODE -ne 0) { throw 'Could not restore quota fixture access.' }
    }
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
  }
  Write-Host 'Native access-denied terminal and background quota context passed.'

}
