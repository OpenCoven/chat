$ErrorActionPreference = 'Stop'

$expectedPwsh = 'C:\Program Files\PowerShell\7\pwsh.exe'
$currentPwsh = (Get-Process -Id $PID).Path
if ($PSVersionTable.PSVersion.Major -lt 7 -or
    -not $currentPwsh.Equals($expectedPwsh, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'phase1-conformance-launcher: canonical PowerShell 7 is required'
}

if ($args.Count -lt 2) {
  throw 'phase1-conformance-launcher: helper and Node paths are required'
}

$rawHelper = $args[0]
$rawNode = $args[1]
if (-not [IO.Path]::IsPathFullyQualified($rawHelper) -or
    -not [IO.Path]::IsPathFullyQualified($rawNode)) {
  throw 'phase1-conformance-launcher: trusted inputs must be absolute'
}
$helper = [IO.Path]::GetFullPath($rawHelper)
$node = [IO.Path]::GetFullPath($rawNode)
$runner = Join-Path $PSScriptRoot 'phase1-conformance.mjs'
if (-not $helper.Equals(
      'C:\OpenCoven\conformance\phase1-process-supervisor.exe',
      [StringComparison]::OrdinalIgnoreCase) -or
    -not (Test-Path -LiteralPath $helper -PathType Leaf) -or
    -not (Test-Path -LiteralPath $node -PathType Leaf) -or
    -not (Test-Path -LiteralPath $runner -PathType Leaf)) {
  throw 'phase1-conformance-launcher: trusted inputs are unavailable'
}
$helperItem = Get-Item -LiteralPath $helper -Force
if (($helperItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
    $helperItem.Length -ne 333824 -or
    (Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant() -ne
      '372b3e8b5b860e0759da8fa10ddfb6ec338e26d83616254c816a456ae2e1b7c5') {
  throw 'phase1-conformance-launcher: frozen helper verification failed'
}
$nodeItem = Get-Item -LiteralPath $node -Force
$corepackJs = Join-Path $nodeItem.Directory.FullName 'node_modules\corepack\dist\corepack.js'
if (($nodeItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
    -not $nodeItem.Name.Equals('node.exe', [StringComparison]::OrdinalIgnoreCase) -or
    -not (Test-Path -LiteralPath $corepackJs -PathType Leaf) -or
    ((Get-Item -LiteralPath $corepackJs -Force).Attributes -band
      [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'phase1-conformance-launcher: approved Node installation unavailable'
}

$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $helper
$start.UseShellExecute = $false
$start.Environment.Clear()
foreach ($name in @(
  'PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'TEMP', 'TMP', 'CI', 'RUSTUP_HOME', 'CARGO_HOME',
  'OPENCOVEN_CHAT_ROOT', 'OPENCOVEN_SDK_ROOT', 'OPENCOVEN_SDK_EVIDENCE_ROOT',
  'OPENCOVEN_CAVE_ROOT', 'OPENCOVEN_COVEN_ROOT',
  'OPENCOVEN_PHASE1_WINDOWS_SUPERVISOR_PATH'
)) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ($null -ne $value) {
    $start.Environment[$name] = $value
  }
}
$start.ArgumentList.Add('--')
$start.ArgumentList.Add($node)
$start.ArgumentList.Add($runner)
if ($args.Count -gt 2) {
  foreach ($argument in $args[2..($args.Count - 1)]) {
    $start.ArgumentList.Add($argument)
  }
}
$process = [Diagnostics.Process]::Start($start)
$process.WaitForExit()
exit $process.ExitCode
