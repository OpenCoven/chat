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
    if ($probe.ExitCode -ne 1 -or
        $stdout.Result.Trim() -cne 'installation-roundtrip: app_installation_id-installation_write_unavailable' -or
        $stderr.Result.Trim() -cne 'installation-roundtrip: conformance_cleanup_native_custody-failed') {
      throw 'Primary installation failure was lost or secondary failure was not bounded.'
    }
    if (-not (Test-Path $receipt)) { throw 'Native shutdown was not attempted after cleanup failure.' }
  } finally { $probe.Dispose() }
} finally { Remove-Item -Recurse -Force $temp }
Write-Output 'Bounded installation diagnostics passed.' 
