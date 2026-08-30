$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $IsWindows -or [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
  throw 'Windows Job Object runtime tests require Windows x64.'
}

$sourcePath = if ($env:OPENCOVEN_WINDOWS_JOB_SUPERVISOR_SOURCE) {
  $env:OPENCOVEN_WINDOWS_JOB_SUPERVISOR_SOURCE
} else {
  Join-Path $PSScriptRoot 'windows-job-supervisor.cs'
}
if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
  throw 'Reviewed Windows Job Object supervisor source is missing.'
}
Add-Type -TypeDefinition ([IO.File]::ReadAllText($sourcePath)) -Language CSharp

function Assert-ProcessExited {
  param([Parameter(Mandatory)][int]$ProcessId)

  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    try {
      $process = [Diagnostics.Process]::GetProcessById($ProcessId)
      $process.Dispose()
    } catch [ArgumentException] {
      return
    }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Process $ProcessId survived Job Object termination."
}

$trustedPwsh = (Get-Process -Id $PID).Path
$root = Join-Path ([IO.Path]::GetTempPath()) "opencoven-job-runtime-$PID-$([Guid]::NewGuid().ToString('N'))"
[IO.Directory]::CreateDirectory($root) | Out-Null
$childEnvironment = @{
  SystemRoot = $env:SystemRoot
  WINDIR = $env:WINDIR
  COMSPEC = $env:COMSPEC
  PATH = "$([IO.Path]::GetDirectoryName($trustedPwsh));$($env:SystemRoot)\System32"
  TEMP = $root
  TMP = $root
}
try {
  $timeoutPids = Join-Path $root 'timeout-pids.txt'
  $timeoutScript = Join-Path $root 'timeout.ps1'
  [IO.File]::WriteAllText(
    $timeoutScript,
    @"
`$grandchild = Start-Process -FilePath '$($trustedPwsh.Replace("'", "''"))' -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 300') -PassThru
[IO.File]::WriteAllText('$($timeoutPids.Replace("'", "''"))', "`$PID`n`$(`$grandchild.Id)`n")
Start-Sleep -Seconds 300
"@,
    [Text.UTF8Encoding]::new($false)
  )
  $timeoutJob = [OpenCoven.WindowsJobSupervisor]::Create(
    "Local\OpenCoven.Chat.SupervisorTest.$([Guid]::NewGuid().ToString('N'))"
  )
  try {
    $result = $timeoutJob.Run(
      $trustedPwsh,
      "-NoLogo -NoProfile -NonInteractive -File `"$timeoutScript`"",
      $root,
      $childEnvironment,
      [TimeSpan]::FromSeconds(8),
      1MB,
      1MB
    )
    if (-not $result.TimedOut -or $result.ExitCode -eq 0) {
      throw 'Timed-out supervised tree did not fail closed.'
    }
  } finally {
    $timeoutJob.Dispose()
  }
  $timeoutTree = [IO.File]::ReadAllLines($timeoutPids)
  if ($timeoutTree.Count -ne 2) {
    throw 'Timed-out child/grandchild PID record is incomplete.'
  }
  $timeoutTree | ForEach-Object { Assert-ProcessExited -ProcessId ([int]$_) }

  $closePid = Join-Path $root 'close-pid.txt'
  $closeScript = Join-Path $root 'close.ps1'
  [IO.File]::WriteAllText(
    $closeScript,
    @"
`$grandchild = Start-Process -FilePath '$($trustedPwsh.Replace("'", "''"))' -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 300') -RedirectStandardOutput '$((Join-Path $root 'close-stdout.txt').Replace("'", "''"))' -RedirectStandardError '$((Join-Path $root 'close-stderr.txt').Replace("'", "''"))' -PassThru
[IO.File]::WriteAllText('$($closePid.Replace("'", "''"))', "`$(`$grandchild.Id)`n")
"@,
    [Text.UTF8Encoding]::new($false)
  )
  $closeJob = [OpenCoven.WindowsJobSupervisor]::Create(
    "Local\OpenCoven.Chat.SupervisorTest.$([Guid]::NewGuid().ToString('N'))"
  )
  $closeResult = $closeJob.Run(
    $trustedPwsh,
    "-NoLogo -NoProfile -NonInteractive -File `"$closeScript`"",
    $root,
    $childEnvironment,
    [TimeSpan]::FromSeconds(30),
    1MB,
    1MB
  )
  if ($closeResult.ExitCode -ne 0) {
    throw 'Kill-on-close setup child failed.'
  }
  $grandchildPid = [int]([IO.File]::ReadAllText($closePid).Trim())
  $closeJob.Dispose()
  Assert-ProcessExited -ProcessId $grandchildPid

  $mismatchScript = Join-Path $root 'mismatch.ps1'
  [IO.File]::WriteAllText(
    $mismatchScript,
    @"
Add-Type -TypeDefinition ([IO.File]::ReadAllText('$($sourcePath.Replace("'", "''"))')) -Language CSharp
[OpenCoven.WindowsJobSupervisor]::RequireCurrentProcessInJob('Local\OpenCoven.Chat.SupervisorTest.mismatch')
"@,
    [Text.UTF8Encoding]::new($false)
  )
  $mismatchJob = [OpenCoven.WindowsJobSupervisor]::Create(
    "Local\OpenCoven.Chat.SupervisorTest.$([Guid]::NewGuid().ToString('N'))"
  )
  try {
    $mismatch = $mismatchJob.Run(
      $trustedPwsh,
      "-NoLogo -NoProfile -NonInteractive -File `"$mismatchScript`"",
      $root,
      $childEnvironment,
      [TimeSpan]::FromSeconds(30),
      1MB,
      1MB
    )
    if ($mismatch.ExitCode -eq 0) {
      throw 'Mismatched Job Object membership did not fail closed.'
    }
  } finally {
    $mismatchJob.Dispose()
  }
} finally {
  [IO.Directory]::Delete($root, $true)
}
