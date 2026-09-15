$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$tokens = $null
$errors = $null
$tree = [Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $PSScriptRoot 'windows-job-supervisor.test.ps1'), [ref]$tokens, [ref]$errors
)
if ($errors.Count) { throw 'Supervisor syntax invalid.' }
$function = @($tree.FindAll({ param($node)
  $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
  $node.Name -ceq 'Get-NativeInstallationFailureCategory'
}, $false))
if ($function.Count -ne 1) { throw 'Bounded installation classifier missing.' }
Invoke-Expression $function[0].Extent.Text
foreach ($name in @('Get-NativeInstallationFailureReport', 'Read-NativeInstallationEnvironment')) {
  $definition = @($tree.FindAll({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name
  }, $false))
  if ($definition.Count -ne 1) { throw "Missing bounded probe function: $name" }
  Invoke-Expression $definition[0].Extent.Text
}
$primaryLine = 'installation-roundtrip: app_installation_id-installation_write_unavailable'
foreach ($hive in @('present', 'absent', 'unavailable')) {
  foreach ($persistence in @('none', 'session', 'local', 'enterprise', 'no-logon-session', 'unavailable', 'unrecognized')) {
    $environment = "hive=$hive;persistence=$persistence"
    $report = Get-NativeInstallationFailureReport "$primaryLine`ninstallation-environment: $environment"
    if ($report.Category -cne 'app_installation_id-installation_write_unavailable' -or $report.Environment -cne $environment) {
      throw 'Bounded environment report lost the primary failure.'
    }
  }
}
foreach ($outputText in @(
  "$primaryLine`ninstallation-environment: hive=private;persistence=session",
  "$primaryLine`ninstallation-environment: hive=absent;persistence=session`nprivate data",
  "$primaryLine`nprivate data"
)) {
  $report = Get-NativeInstallationFailureReport $outputText
  if ($report.Category -cne 'unclassified' -or $report.Environment -cne 'unavailable') {
    throw 'Untrusted probe output accepted.'
  }
}
$environment = Read-NativeInstallationEnvironment
if ($environment -cnotmatch '^hive=(present|absent|unavailable);persistence=(none|session|local|enterprise|no-logon-session|unavailable|unrecognized)$') {
  throw 'Environment probe emitted unbounded output.'
}
foreach ($pair in @(@(0, 'none'), @(1, 'session'), @(2, 'local'), @(3, 'enterprise'), @(99, 'unrecognized'))) {
  if ([NativeInstallationEnvironmentProbe]::PersistenceCategory([uint32]$pair[0]) -cne $pair[1]) {
    throw 'Native generic-credential persistence mapping changed.'
  }
}
# Run the fixture's actual home selection with distinct redirected and OS profiles.
$homeAssignment = @($tree.FindAll({ param($node)
  $node -is [Management.Automation.Language.AssignmentStatementAst] -and
  $node.Left.Extent.Text -ceq '$installationEnvironment.OPENCOVEN_PHASE1_CONFORMANCE_CLEANUP_HOME'
}, $true))
if ($homeAssignment.Count -ne 1) { throw 'Cleanup home assignment missing or ambiguous.' }
$installationEnvironment = @{}
$isolatedUser = [pscustomobject]@{
  ProfilePath = 'C:\fixture\redirected-profile'
  OperatingSystemProfilePath = 'C:\Users\fixture-native-profile'
}
Invoke-Expression $homeAssignment[0].Extent.Text
if ($installationEnvironment.OPENCOVEN_PHASE1_CONFORMANCE_CLEANUP_HOME -cne $isolatedUser.OperatingSystemProfilePath) {
  throw 'Cleanup grant fixture must use the authoritative OS profile.'
}

foreach ($stage in @('lock', 'entry', 'read', 'write', 'persistence')) {
  $code = "app_installation_id-installation_${stage}_unavailable"
  if ((Get-NativeInstallationFailureCategory "installation-roundtrip: $code`r`n") -cne $code) {
    throw 'Installation boundary lost.'
  }
}
foreach ($inputText in @(
  'private credential material',
  'installation-roundtrip: private-secret',
  "installation-roundtrip: response-invalid`nprivate credential material",
  'installation-roundtrip: passed'
)) {
  if ((Get-NativeInstallationFailureCategory $inputText) -cne 'unclassified') {
    throw 'Untrusted diagnostic accepted.'
  }
}
foreach ($code in @('response-invalid', 'response-timeout', 'native-exit-failed',
  'conformance_native_custody_state-failed', 'conformance_issue_native_custody_cleanup-failed',
  'conformance_cleanup_native_custody-failed')) {
  if ((Get-NativeInstallationFailureCategory "installation-roundtrip: $code") -cne $code) {
    throw 'Roundtrip boundary lost.'
  }
}
# Execute the actual child try/catch/finally and reporting tail in a subprocess.
$children = @($tree.FindAll({ param($node)
  $node -is [Management.Automation.Language.StringConstantExpressionAst] -and
  $node.Value.Contains("$" + "before = Invoke-InstallationRpc")
}, $true))
if ($children.Count -ne 1) { throw 'Installation child missing or ambiguous.' }
$child = $children[0].Value
$start = $child.IndexOf("try {`n  $" + "before = Invoke-InstallationRpc")
if ($start -lt 0) { throw 'Installation exception pipeline missing.' }
$pipeline = $child.Substring($start)
# Exercise the real response decoder, including command binding and unknown-code rejection.
$childTree = [Management.Automation.Language.Parser]::ParseInput($child, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Installation child syntax invalid.' }
$rpc = @($childTree.FindAll({ param($node)
  $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
  $node.Name -ceq 'Invoke-InstallationRpc'
}, $false))
if ($rpc.Count -ne 1) { throw 'Installation RPC decoder missing.' }
Invoke-Expression $rpc[0].Extent.Text
$process = [pscustomobject]@{
  StandardInput = [IO.StringWriter]::new()
  StandardOutput = [pscustomobject]@{}
}
$process.StandardOutput | Add-Member ScriptMethod ReadLineAsync {
  return [Threading.Tasks.Task]::FromResult([string]$script:responseJson)
}
$grantCodes = @('cleanup_grant_rejected', 'cleanup_grant_service_unavailable',
  'cleanup_grant_process_secret_unavailable', 'cleanup_grant_random_unavailable',
  'cleanup_grant_marker_home_unavailable', 'cleanup_grant_marker_directory_create_unavailable',
  'cleanup_grant_marker_directory_open_unavailable', 'cleanup_grant_marker_directory_metadata_unavailable',
  'cleanup_grant_marker_directory_trust_unavailable', 'cleanup_grant_marker_sync_unavailable',
  'cleanup_grant_marker_identity_unavailable', 'cleanup_grant_marker_publish_unavailable',
  'cleanup_grant_collision_exhausted', 'secure_store_unavailable', 'keychain_failure')
$rpcCases = @($grantCodes | ForEach-Object {
  @{ command = 'conformance_issue_native_custody_cleanup'; code = $_ }
}) + @(@('lock', 'entry', 'read', 'write', 'persistence') | ForEach-Object {
  @{ command = 'app_installation_id'; code = "installation_${_}_unavailable" }
})
foreach ($case in $rpcCases) {
  $command = $case.command
  $code = $case.code
  $script:responseJson = @{ id = $command; ok = $false; error = @{ code = $code } } | ConvertTo-Json -Compress
  $caught = $null
  try { $null = Invoke-InstallationRpc $command } catch { $caught = $_.Exception.Message }
  if ($caught -cne "installation-roundtrip: $command-$code") { throw 'Native RPC subtype lost.' }
  if ((Get-NativeInstallationFailureCategory $caught) -cne "$command-$code") {
    throw 'Parent rejected bounded native subtype.'
  }
}
$command = 'conformance_issue_native_custody_cleanup'
foreach ($case in @(
  @{ id = $command; code = 'private credential material' },
  @{ id = $command; code = 'installation_write_unavailable' },
  @{ id = 'app_installation_id'; code = 'cleanup_grant_marker_home_unavailable' }
)) {
  $script:responseJson = @{ id = $case.id; ok = $false; error = @{ code = $case.code } } | ConvertTo-Json -Compress
  $caught = $null
  try { $null = Invoke-InstallationRpc $command } catch { $caught = $_.Exception.Message }
  if ($caught -cne "installation-roundtrip: $command-failed") { throw 'Untrusted or mismatched RPC category accepted.' }
}
$process.StandardInput.Dispose()

$fixture = @'
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$grant = $null
$terminalSuccess = $false
$primaryFailure = $null
$secondaryFailure = $null
$process = [pscustomobject]@{ HasExited = $false; ExitCode = 0; StandardInput = [pscustomobject]@{} }
$process.StandardInput | Add-Member ScriptMethod Close { }
$process | Add-Member ScriptMethod WaitForExit { param($milliseconds) return $true }
$process | Add-Member ScriptMethod Dispose { [IO.File]::WriteAllText($env:INSTALLATION_TEST_RECEIPT, 'disposed') }
$stderr = [pscustomobject]@{ Result = '' }
$stderr | Add-Member ScriptMethod Wait { param($milliseconds) return $true }
function Assert-EmptyCustody($proof) { }
$installationEnvironmentSnapshot = 'hive=absent;persistence=session'
function Invoke-InstallationRpc([string]$command, [hashtable]$arguments = @{}) {
  switch ($command) {
    'conformance_native_custody_state' { return @{} }
    'conformance_issue_native_custody_cleanup' { return @{ grant = ('a' * 43) } }
    'app_installation_id' { throw 'installation-roundtrip: app_installation_id-installation_write_unavailable' }
    'conformance_cleanup_native_custody' { throw 'installation-roundtrip: conformance_cleanup_native_custody-failed' }
    default { throw 'Unexpected command.' }
  }
}
'@
$temp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory $temp
try {
  $path = Join-Path $temp 'pipeline.ps1'
  [IO.File]::WriteAllText($path, $function[0].Extent.Text + "`n" + $fixture + "`n" + $pipeline)
  $startInfo = [Diagnostics.ProcessStartInfo]::new((Get-Process -Id $PID).Path)
  foreach ($argument in @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $path)) {
    $startInfo.ArgumentList.Add($argument)
  }
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $receipt = Join-Path $temp 'disposed.txt'
  $startInfo.Environment['INSTALLATION_TEST_RECEIPT'] = $receipt
  $probe = [Diagnostics.Process]::Start($startInfo)
  try {
    $stdout = $probe.StandardOutput.ReadToEndAsync()
    $stderr = $probe.StandardError.ReadToEndAsync()
    if (-not $probe.WaitForExit(10000)) { $probe.Kill($true); throw 'Pipeline probe timed out.' }
    $report = Get-NativeInstallationFailureReport $stdout.Result
    if ($probe.ExitCode -ne 1 -or
        $report.Category -cne 'app_installation_id-installation_write_unavailable' -or
        $report.Environment -cne 'hive=absent;persistence=session' -or
        $stderr.Result.Trim() -cne 'installation-roundtrip: conformance_cleanup_native_custody-failed') {
      throw 'Primary installation failure was lost or secondary failure was not bounded.'
    }
    if (-not (Test-Path $receipt)) { throw 'Native shutdown was not attempted after cleanup failure.' }
  } finally { $probe.Dispose() }
} finally { Remove-Item -Recurse -Force $temp }
# Execute actual cleanup clauses with simultaneous primary and disposal failures.
foreach ($boundary in @('outer', 'installation')) {
$outer = @($tree.FindAll({ param($node)
  $node -is [Management.Automation.Language.TryStatementAst] -and
  $null -ne $node.Finally -and
  $(if ($boundary -eq 'outer') {
    $node.Finally.Extent.Text.Contains('Windows supervisor test cleanup failed:')
  } else {
    $node.Finally.Extent.Text.Contains('Windows installation test and disposal failed.') -and
    $node.Body.Extent.Text.Contains('$installationResult =')
  })
}, $true))
if ($outer.Count -ne 1) { throw 'Outer cleanup boundary missing or ambiguous.' }
$isolatedUser = [pscustomobject]@{}
$isolatedUser | Add-Member ScriptMethod Dispose { throw [IO.IOException]::new('synthetic cleanup failure') }
$operatorPrivateRoot = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N'))
$primarySupervisorFailure = $null
$primaryInstallationFailure = $null
$installationJob = $isolatedUser
$outerCaught = $null
$clauses = (@($outer[0].CatchClauses | ForEach-Object { $_.Extent.Text }) -join "`n") +
  "`nfinally " + $outer[0].Finally.Extent.Text
try {
  Invoke-Expression ("try { throw [InvalidOperationException]::new('synthetic primary failure') }`n" + $clauses)
} catch { $outerCaught = $_.Exception }
$pending = [Collections.Generic.Queue[Exception]]::new()
if ($null -ne $outerCaught) { $pending.Enqueue($outerCaught) }
$messages = [Collections.Generic.List[string]]::new()
while ($pending.Count -gt 0 -and $messages.Count -lt 12) {
  $exception = $pending.Dequeue()
  $messages.Add($exception.Message)
  if ($exception -is [AggregateException]) {
    foreach ($inner in $exception.InnerExceptions) { $pending.Enqueue($inner) }
  } elseif ($null -ne $exception.InnerException) { $pending.Enqueue($exception.InnerException) }
}
if ('synthetic primary failure' -cnotin $messages -or 'synthetic cleanup failure' -cnotin $messages) {
  throw 'Outer cleanup replaced the primary test failure.'
}
}
Write-Output 'Bounded installation diagnostics passed.' 
