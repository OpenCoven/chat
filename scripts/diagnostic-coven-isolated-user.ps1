$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
Set-StrictMode -Version Latest

if (-not $IsWindows) {
  throw 'This diagnostic requires Windows.'
}
Write-Host 'Diagnostic only: no native authority, publication credentials, or conformance acceptance.'
Write-Host "ImageVersion=$env:ImageVersion"
$trustedPwsh = (Get-Process -Id $PID).Path
$node = (Get-Command node).Source
$gitBin = Split-Path (Get-Command git).Source
Add-Type -TypeDefinition ([IO.File]::ReadAllText(
  (Join-Path $PSScriptRoot 'windows-job-supervisor.cs')
)) -Language CSharp

$root = Join-Path $env:RUNNER_TEMP "opencoven-win32-$([Guid]::NewGuid().ToString('N'))"
$user = [OpenCoven.WindowsIsolatedUser]::Create($root)
$job = $null
try {
  $env:CARGO_HOME = Join-Path $root 'cargo'
  $env:RUSTUP_HOME = Join-Path $root 'rustup'
  rustup toolchain install 1.95.0 --profile minimal --no-self-update
  $cargo = & rustup which --toolchain 1.95.0 cargo
  Copy-Item -LiteralPath $PSScriptRoot -Destination (Join-Path $user.WorkspacePath 'scripts') -Recurse
  $probePath = Join-Path $user.WorkspacePath 'compiler-probe.mjs'
  [IO.File]::WriteAllText($probePath, @'
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { safeEnvironment, schemaV2NativeBuildEnvironment } from './scripts/phase1-schema-v2-producer.mjs';
import { createProcessOwnedArtifactRoot } from './scripts/process-owned-artifact-root.mjs';

const artifactRoot = createProcessOwnedArtifactRoot({ prefix: 'phase1-conformance-run' });
const source = resolve(artifactRoot.rootPath, 'checkouts/coven');
const revision = '721437b84026c042e431b0882dcd14fdb29ac07d';
execFileSync('git', ['init', source], { stdio: 'inherit' });
execFileSync('git', ['-C', source, 'fetch', '--depth=1', 'https://github.com/OpenCoven/coven.git', revision], {
  stdio: 'inherit',
});
execFileSync('git', ['-C', source, 'checkout', '--detach', 'FETCH_HEAD'], { stdio: 'inherit' });
assert.equal(execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), revision);
const cargo = process.env.OPENCOVEN_DIAGNOSTIC_CARGO;
const env = schemaV2NativeBuildEnvironment(safeEnvironment(artifactRoot.rootPath, {
  LIB: process.env.LIB,
  INCLUDE: process.env.INCLUDE,
}, cargo));
env.CARGO_TARGET_DIR = resolve(artifactRoot.rootPath, 'build/coven-target');
const result = spawnSync(cargo, ['build', '--locked', '--package', 'coven-cli', '--bin', 'coven'], {
  cwd: source,
  env,
  stdio: 'inherit',
  timeout: 20 * 60_000,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
'@, [Text.UTF8Encoding]::new($false))

  $msvc = 'C:\Program Files\Microsoft Visual Studio\18\Enterprise\VC\Tools\MSVC\14.44.35207'
  $sdk = 'C:\Program Files (x86)\Windows Kits\10'
  $environment = @{
    SystemRoot = 'C:\Windows'
    WINDIR = 'C:\Windows'
    COMSPEC = 'C:\Windows\System32\cmd.exe'
    PATHEXT = '.COM;.EXE;.BAT;.CMD'
    PATH = @(
      (Split-Path $cargo), $gitBin, (Split-Path $node),
      "$msvc\bin\Hostx64\x64", "$sdk\bin\10.0.26100.0\x64",
      'C:\Windows\System32', 'C:\Windows', (Split-Path $trustedPwsh)
    ) -join ';'
    HOME = $user.ProfilePath
    USERPROFILE = $user.ProfilePath
    APPDATA = (Join-Path $user.ProfilePath 'AppData\Roaming')
    LOCALAPPDATA = (Join-Path $user.ProfilePath 'AppData\Local')
    TEMP = $user.TempPath
    TMP = $user.TempPath
    GITHUB_WORKSPACE = $user.WorkspacePath
    OPENCOVEN_DIAGNOSTIC_CARGO = $cargo
    LIB = "$msvc\lib\x64;$sdk\Lib\10.0.26100.0\um\x64;$sdk\Lib\10.0.26100.0\ucrt\x64"
    INCLUDE = "$msvc\include;$sdk\Include\10.0.26100.0\ucrt;$sdk\Include\10.0.26100.0\shared;$sdk\Include\10.0.26100.0\um;$sdk\Include\10.0.26100.0\winrt;$sdk\Include\10.0.26100.0\cppwinrt"
    GIT_CONFIG_GLOBAL = 'NUL'
    GIT_CONFIG_NOSYSTEM = '1'
    GIT_TERMINAL_PROMPT = '0'
    GIT_NO_REPLACE_OBJECTS = '1'
    GIT_NO_LAZY_FETCH = '1'
  }
  $job = [OpenCoven.WindowsJobSupervisor]::Create(
    "Local\OpenCoven.Chat.CompilerDiagnostic.$([Guid]::NewGuid().ToString('N'))",
    $user
  )
  $result = $job.RunProducerAsUserAndQuarantine(
    $user, $node, "`"$probePath`"", $user.WorkspacePath, $environment,
    [TimeSpan]::FromMinutes(25), 8MB, 8MB,
    @([OpenCoven.WindowsDirectoryQuota]::new('diagnostic bootstrap', $root, 12GB))
  )
  [Console]::Out.Write($result.Stdout)
  [Console]::Error.Write($result.Stderr)
  if ($result.ExitCode -ne 0) {
    throw "Isolated compiler diagnostic failed with exit code $($result.ExitCode)."
  }
  Write-Host 'The isolated compiler diagnostic completed; this is not accepted conformance evidence.'
} finally {
  try {
    if ($null -ne $job) {
      $job.Dispose()
    }
  } finally {
    $user.Dispose()
  }
}
