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
