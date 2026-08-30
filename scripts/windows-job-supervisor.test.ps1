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
$isolatedUser = [OpenCoven.WindowsIsolatedUser]::Create($root)
$ephemeralUserName = $isolatedUser.UserName
$ephemeralProfilePath = $isolatedUser.OperatingSystemProfilePath
$operatorPrivateRoot = Join-Path (
  [IO.Path]::GetTempPath()
) "opencoven-supervisor-private-$PID-$([Guid]::NewGuid().ToString('N'))"
$childEnvironment = @{
  SystemRoot = $env:SystemRoot
  WINDIR = $env:WINDIR
  COMSPEC = $env:COMSPEC
  PATH = "$([IO.Path]::GetDirectoryName($trustedPwsh));$($env:SystemRoot)\System32"
  HOME = $isolatedUser.ProfilePath
  USERPROFILE = $isolatedUser.ProfilePath
  APPDATA = (Join-Path $isolatedUser.ProfilePath 'AppData\Roaming')
  LOCALAPPDATA = (Join-Path $isolatedUser.ProfilePath 'AppData\Local')
  TEMP = $isolatedUser.TempPath
  TMP = $isolatedUser.TempPath
  GITHUB_WORKSPACE = $isolatedUser.WorkspacePath
  OPENCOVEN_WINDOWS_BOOTSTRAP_ROOT = $isolatedUser.RootPath
  OPENCOVEN_WINDOWS_JOB_SUPERVISOR_SOURCE = $sourcePath
}
try {
  [IO.Directory]::CreateDirectory($operatorPrivateRoot) | Out-Null
  [OpenCoven.WindowsJobSupervisor]::ProtectSupervisorDirectory($operatorPrivateRoot)
  [IO.File]::WriteAllText(
    (Join-Path $operatorPrivateRoot 'credential-marker.txt'),
    'operator-private',
    [Text.UTF8Encoding]::new($false)
  )
  $childEnvironment.OPENCOVEN_OPERATOR_PRIVATE_ROOT = $operatorPrivateRoot
  $accessProbeSource = Join-Path $root 'job-access-probe.cs'
  [IO.File]::WriteAllText(
    $accessProbeSource,
    @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class JobAccessProbe
{
    private const uint JOB_OBJECT_ASSIGN_PROCESS = 0x0001;
    private const uint JOB_OBJECT_SET_ATTRIBUTES = 0x0002;
    private const uint JOB_OBJECT_QUERY = 0x0004;
    private const uint JOB_OBJECT_TERMINATE = 0x0008;
    private const uint JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK = 0x00001000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const int ERROR_ACCESS_DENIED = 5;

    public static void Run(string name)
    {
        IntPtr query = OpenJobObjectW(JOB_OBJECT_QUERY, false, name);
        if (query == IntPtr.Zero)
        {
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                "Query-only Job Object reopen was denied.");
        }
        try
        {
            RequireDenied(
                name,
                JOB_OBJECT_SET_ATTRIBUTES,
                "JOB_OBJECT_SET_ATTRIBUTES reopen unexpectedly succeeded.");
            RequireDenied(
                name,
                JOB_OBJECT_ASSIGN_PROCESS,
                "JOB_OBJECT_ASSIGN_PROCESS reopen unexpectedly succeeded.");
            RequireDenied(
                name,
                JOB_OBJECT_TERMINATE,
                "JOB_OBJECT_TERMINATE reopen unexpectedly succeeded.");

            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits =
                new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
            int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr buffer = Marshal.AllocHGlobal(length);
            try
            {
                Marshal.StructureToPtr(limits, buffer, false);
                if (SetInformationJobObject(
                        query,
                        JobObjectExtendedLimitInformation,
                        buffer,
                        (uint)length))
                {
                    throw new InvalidOperationException(
                        "Enabling silent breakaway unexpectedly succeeded.");
                }
                if (Marshal.GetLastWin32Error() != ERROR_ACCESS_DENIED)
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "Silent breakaway failed for an unexpected reason.");
                }
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
        finally
        {
            CloseHandle(query);
        }
    }

    private static void RequireDenied(string name, uint access, string message)
    {
        IntPtr handle = OpenJobObjectW(access, false, name);
        if (handle != IntPtr.Zero)
        {
            CloseHandle(handle);
            throw new InvalidOperationException(message);
        }
        if (Marshal.GetLastWin32Error() != ERROR_ACCESS_DENIED)
        {
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                "Dangerous Job Object reopen failed for an unexpected reason.");
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        internal long PerProcessUserTimeLimit;
        internal long PerJobUserTimeLimit;
        internal uint LimitFlags;
        internal UIntPtr MinimumWorkingSetSize;
        internal UIntPtr MaximumWorkingSetSize;
        internal uint ActiveProcessLimit;
        internal UIntPtr Affinity;
        internal uint PriorityClass;
        internal uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        internal ulong ReadOperationCount;
        internal ulong WriteOperationCount;
        internal ulong OtherOperationCount;
        internal ulong ReadTransferCount;
        internal ulong WriteTransferCount;
        internal ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        internal JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        internal IO_COUNTERS IoInfo;
        internal UIntPtr ProcessMemoryLimit;
        internal UIntPtr JobMemoryLimit;
        internal UIntPtr PeakProcessMemoryUsed;
        internal UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenJobObjectW(uint desiredAccess, bool inherit, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
}
'@,
    [Text.UTF8Encoding]::new($false)
  )
  $accessProbeScript = Join-Path $root 'job-access-probe.ps1'
  [IO.File]::WriteAllText(
    $accessProbeScript,
    @"
Add-Type -TypeDefinition ([IO.File]::ReadAllText(`$env:OPENCOVEN_WINDOWS_JOB_SUPERVISOR_SOURCE)) -Language CSharp
Add-Type -TypeDefinition ([IO.File]::ReadAllText('$($accessProbeSource.Replace("'", "''"))')) -Language CSharp
[OpenCoven.WindowsJobSupervisor]::RequireRestrictedSupervisorBoundary(
  [int]`$env:OPENCOVEN_WINDOWS_SUPERVISOR_PID,
  [long]`$env:OPENCOVEN_WINDOWS_SUPERVISOR_JOB_HANDLE
)
[JobAccessProbe]::Run(`$env:OPENCOVEN_ACCESS_PROBE_JOB)
`$root = [IO.Path]::GetFullPath(`$env:OPENCOVEN_WINDOWS_BOOTSTRAP_ROOT)
`$profile = [IO.Path]::GetFullPath(`$env:USERPROFILE)
`$temp = [IO.Path]::GetFullPath(`$env:TEMP)
`$workspace = [IO.Path]::GetFullPath(`$env:GITHUB_WORKSPACE)
if (-not `$profile.StartsWith("`$root\", [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Restricted user profile is outside the isolated root.'
}
if (-not `$temp.StartsWith("`$root\", [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Restricted user temporary directory is outside the isolated root.'
}
if (-not `$workspace.StartsWith("`$root\", [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Restricted user workspace is outside the isolated root.'
}
foreach (`$directory in @(`$root, `$profile, `$temp, `$workspace)) {
  [OpenCoven.WindowsJobSupervisor]::RequireCurrentIdentityOwnsIsolatedDirectory(`$directory)
}
`$operatorDenied = `$false
try {
  [IO.File]::ReadAllText(
    (Join-Path `$env:OPENCOVEN_OPERATOR_PRIVATE_ROOT 'credential-marker.txt')
  ) | Out-Null
} catch {
  if (
    `$_.Exception -is [UnauthorizedAccessException] -or
    `$_.Exception.InnerException -is [UnauthorizedAccessException]
  ) {
    `$operatorDenied = `$true
  } else {
    throw
  }
}
if (-not `$operatorDenied) {
  throw 'Restricted identity accessed supervisor-private credential root.'
}
"@,
    [Text.UTF8Encoding]::new($false)
  )
  $accessJobName =
    "Local\OpenCoven.Chat.SupervisorTest.$([Guid]::NewGuid().ToString('N'))"
  $accessEnvironment = $childEnvironment.Clone()
  $accessEnvironment.OPENCOVEN_ACCESS_PROBE_JOB = $accessJobName
  $accessJob = [OpenCoven.WindowsJobSupervisor]::Create($accessJobName, $isolatedUser)
  try {
    $accessResult = $accessJob.RunAsUser(
      $isolatedUser,
      $trustedPwsh,
      "-NoLogo -NoProfile -NonInteractive -File `"$accessProbeScript`"",
      $isolatedUser.RootPath,
      $accessEnvironment,
      [TimeSpan]::FromSeconds(30),
      1MB,
      1MB
    )
    if ($accessResult.ExitCode -ne 0) {
      throw "Protected Job Object DACL runtime probe failed: $($accessResult.Stderr)"
    }
  } finally {
    $accessJob.Dispose()
  }

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
    "Local\OpenCoven.Chat.SupervisorTest.$([Guid]::NewGuid().ToString('N'))",
    $isolatedUser
  )
  try {
    $result = $timeoutJob.RunAsUser(
      $isolatedUser,
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
    "Local\OpenCoven.Chat.SupervisorTest.$([Guid]::NewGuid().ToString('N'))",
    $isolatedUser
  )
  $closeResult = $closeJob.RunAsUser(
    $isolatedUser,
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

  $retainedJobName =
    "Local\OpenCoven.Chat.SupervisorTest.$([Guid]::NewGuid().ToString('N'))"
  $retainedPidPath = Join-Path $root 'retained-handle-pid.txt'
  $retainedHandleSource = Join-Path $root 'retained-handle.cs'
  [IO.File]::WriteAllText(
    $retainedHandleSource,
    @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class RetainedJobHandle
{
    private const uint JOB_OBJECT_QUERY = 0x0004;

    public static void Hold(string name, string pidPath)
    {
        IntPtr handle = OpenJobObjectW(JOB_OBJECT_QUERY, false, name);
        if (handle == IntPtr.Zero)
        {
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                "Retained Job Object query handle could not be opened.");
        }
        try
        {
            File.WriteAllText(
                pidPath,
                Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture));
            Thread.Sleep(TimeSpan.FromMinutes(5));
        }
        finally
        {
            CloseHandle(handle);
        }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenJobObjectW(uint desiredAccess, bool inherit, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
}
'@,
    [Text.UTF8Encoding]::new($false)
  )
  $retainedHandleScript = Join-Path $root 'retained-handle.ps1'
  [IO.File]::WriteAllText(
    $retainedHandleScript,
    @"
Add-Type -TypeDefinition ([IO.File]::ReadAllText('$($retainedHandleSource.Replace("'", "''"))')) -Language CSharp
[RetainedJobHandle]::Hold(`$env:RETAINED_JOB_NAME, '$($retainedPidPath.Replace("'", "''"))')
"@,
    [Text.UTF8Encoding]::new($false)
  )
  $retainedRootScript = Join-Path $root 'retained-root.ps1'
  [IO.File]::WriteAllText(
    $retainedRootScript,
    @"
`$descendant = Start-Process -FilePath '$($trustedPwsh.Replace("'", "''"))' -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-File','$($retainedHandleScript.Replace("'", "''"))') -RedirectStandardOutput '$((Join-Path $root 'retained-stdout.txt').Replace("'", "''"))' -RedirectStandardError '$((Join-Path $root 'retained-stderr.txt').Replace("'", "''"))' -PassThru
`$deadline = [DateTime]::UtcNow.AddSeconds(10)
while (-not [IO.File]::Exists('$($retainedPidPath.Replace("'", "''"))')) {
  if (`$descendant.HasExited) {
    throw 'Retained Job handle descendant exited before reporting readiness.'
  }
  if ([DateTime]::UtcNow -ge `$deadline) {
    throw 'Retained Job handle descendant did not report readiness.'
  }
  Start-Sleep -Milliseconds 50
}
"@,
    [Text.UTF8Encoding]::new($false)
  )
  $retainedEnvironment = $childEnvironment.Clone()
  $retainedEnvironment.RETAINED_JOB_NAME = $retainedJobName
  $retainedJob = [OpenCoven.WindowsJobSupervisor]::Create(
    $retainedJobName,
    $isolatedUser
  )
  $retainedPid = 0
  try {
    $retainedTimer = [Diagnostics.Stopwatch]::StartNew()
    $retainedResult = $retainedJob.RunAsUser(
      $isolatedUser,
      $trustedPwsh,
      "-NoLogo -NoProfile -NonInteractive -File `"$retainedRootScript`"",
      $root,
      $retainedEnvironment,
      [TimeSpan]::FromSeconds(30),
      1MB,
      1MB
    )
    $retainedTimer.Stop()
    if ($retainedResult.ExitCode -ne 0) {
      throw 'Successful root result changed during retained Job handle teardown.'
    }
    if ($retainedTimer.Elapsed -ge [TimeSpan]::FromSeconds(20)) {
      throw 'Retained Job handle teardown did not finish within the runtime bound.'
    }
    $retainedPid = [int]([IO.File]::ReadAllText($retainedPidPath).Trim())
    try {
      Assert-ProcessExited -ProcessId $retainedPid
    } catch {
      throw 'Successful root teardown did not terminate the retained Job handle descendant.'
    }
  } finally {
    $retainedJob.Dispose()
    if ($retainedPid -eq 0 -and [IO.File]::Exists($retainedPidPath)) {
      $retainedPid = [int]([IO.File]::ReadAllText($retainedPidPath).Trim())
    }
    if ($retainedPid -ne 0) {
      try {
        $remaining = [Diagnostics.Process]::GetProcessById($retainedPid)
        try {
          $remaining.Kill($true)
          $remaining.WaitForExit()
        } finally {
          $remaining.Dispose()
        }
      } catch [ArgumentException] {
      }
    }
  }

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
    "Local\OpenCoven.Chat.SupervisorTest.$([Guid]::NewGuid().ToString('N'))",
    $isolatedUser
  )
  try {
    $mismatch = $mismatchJob.RunAsUser(
      $isolatedUser,
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

  $quotaDirectory = Join-Path $root 'quota'
  [IO.Directory]::CreateDirectory($quotaDirectory) | Out-Null
  $quotaPids = Join-Path $root 'quota-pids.txt'
  $quotaScript = Join-Path $root 'quota.ps1'
  [IO.File]::WriteAllText(
    $quotaScript,
    @"
`$grandchild = Start-Process -FilePath '$($trustedPwsh.Replace("'", "''"))' -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 300') -PassThru
[IO.File]::WriteAllText('$($quotaPids.Replace("'", "''"))', "`$PID`n`$(`$grandchild.Id)`n")
[IO.File]::WriteAllBytes('$((Join-Path $quotaDirectory 'overflow.bin').Replace("'", "''"))', [byte[]]::new(2MB))
Start-Sleep -Seconds 300
"@,
    [Text.UTF8Encoding]::new($false)
  )
  $quotaJob = [OpenCoven.WindowsJobSupervisor]::Create(
    "Local\OpenCoven.Chat.SupervisorTest.$([Guid]::NewGuid().ToString('N'))",
    $isolatedUser
  )
  try {
    $quotaResult = $quotaJob.RunAsUser(
      $isolatedUser,
      $trustedPwsh,
      "-NoLogo -NoProfile -NonInteractive -File `"$quotaScript`"",
      $root,
      $childEnvironment,
      [TimeSpan]::FromSeconds(30),
      1MB,
      1MB,
      @([OpenCoven.WindowsDirectoryQuota]::new('quota-test', $quotaDirectory, 1MB))
    )
    if (-not $quotaResult.ResourceQuotaExceeded -or $quotaResult.ExitCode -eq 0) {
      throw 'Directory quota excess did not fail closed.'
    }
  } finally {
    $quotaJob.Dispose()
  }
  [IO.File]::ReadAllLines($quotaPids) | ForEach-Object {
    Assert-ProcessExited -ProcessId ([int]$_)
  }

  $membershipAName = "Local\OpenCoven.Chat.SupervisorTest.$([Guid]::NewGuid().ToString('N'))"
  $membershipBName = "Local\OpenCoven.Chat.SupervisorTest.$([Guid]::NewGuid().ToString('N'))"
  $membershipA = [OpenCoven.WindowsJobSupervisor]::Create(
    $membershipAName,
    $isolatedUser
  )
  $membershipB = [OpenCoven.WindowsJobSupervisor]::Create(
    $membershipBName,
    $isolatedUser
  )
  $membershipScript = Join-Path $root 'membership.ps1'
  [IO.File]::WriteAllText(
    $membershipScript,
    @"
Add-Type -TypeDefinition ([IO.File]::ReadAllText('$($sourcePath.Replace("'", "''"))')) -Language CSharp
[OpenCoven.WindowsJobSupervisor]::RequireCurrentProcessInJob(`$env:EXPECTED_JOB)
"@,
    [Text.UTF8Encoding]::new($false)
  )
  try {
    $positiveEnvironment = $childEnvironment.Clone()
    $positiveEnvironment.EXPECTED_JOB = $membershipAName
    $positive = $membershipA.RunAsUser(
      $isolatedUser,
      $trustedPwsh,
      "-NoLogo -NoProfile -NonInteractive -File `"$membershipScript`"",
      $root,
      $positiveEnvironment,
      [TimeSpan]::FromSeconds(30),
      1MB,
      1MB
    )
    if ($positive.ExitCode -ne 0) {
      throw 'Positive Job Object membership failed.'
    }

    $wrongEnvironment = $childEnvironment.Clone()
    $wrongEnvironment.EXPECTED_JOB = $membershipAName
    $wrong = $membershipB.RunAsUser(
      $isolatedUser,
      $trustedPwsh,
      "-NoLogo -NoProfile -NonInteractive -File `"$membershipScript`"",
      $root,
      $wrongEnvironment,
      [TimeSpan]::FromSeconds(30),
      1MB,
      1MB
    )
    if ($wrong.ExitCode -eq 0) {
      throw 'A process in Job B was accepted as a member of existing Job A.'
    }

    $unsupervised = Start-Process `
      -FilePath $trustedPwsh `
      -ArgumentList @(
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        $membershipScript
      ) `
      -Environment @{ EXPECTED_JOB = $membershipAName } `
      -Wait `
      -PassThru
    if ($unsupervised.ExitCode -eq 0) {
      throw 'An unsupervised process was accepted as a member of an existing Job.'
    }

    if ($env:OPENCOVEN_PHASE1_NATIVE_RPC_PATH) {
      $nativeRpc = [IO.Path]::GetFullPath($env:OPENCOVEN_PHASE1_NATIVE_RPC_PATH)
      if (-not [IO.File]::Exists($nativeRpc)) {
        throw 'Compiled phase1-native-rpc binary is missing.'
      }
      function Invoke-NativeRpcUnsupervised {
        param([Parameter(Mandatory)][Collections.IDictionary]$Environment)
        $start = [Diagnostics.ProcessStartInfo]::new($nativeRpc)
        $start.UseShellExecute = $false
        $start.RedirectStandardInput = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $start.CreateNoWindow = $true
        $start.Environment.Clear()
        foreach ($entry in $Environment.GetEnumerator()) {
          $start.Environment[[string]$entry.Key] = [string]$entry.Value
        }
        $process = [Diagnostics.Process]::Start($start)
        $process.StandardInput.Close()
        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        return [pscustomobject]@{
          ExitCode = $process.ExitCode
          Stdout = $stdout
          Stderr = $stderr
        }
      }
      function Assert-NativeBindingRejected {
        param(
          [Parameter(Mandatory)]$Result,
          [Parameter(Mandatory)][string]$Label
        )
        if (
          $Result.ExitCode -ne 0 -or
          $Result.Stderr -ne '' -or
          $Result.Stdout -notmatch '"code":"invalid_native_input"'
        ) {
          throw "$Label did not fail closed before native RPC startup."
        }
      }

      $ordinaryNative = Invoke-NativeRpcUnsupervised -Environment $childEnvironment
      if (
        $ordinaryNative.ExitCode -ne 0 -or
        $ordinaryNative.Stdout -ne '' -or
        $ordinaryNative.Stderr -ne ''
      ) {
        throw 'Ordinary non-evidence native RPC execution changed.'
      }
      Assert-NativeBindingRejected `
        -Label 'Missing native Job binding' `
        -Result (Invoke-NativeRpcUnsupervised -Environment (
          $childEnvironment + @{ OPENCOVEN_PHASE1_SCHEMA_V2_EVIDENCE = '1' }
        ))
      $malformedModeEnvironment = $childEnvironment.Clone()
      $malformedModeEnvironment.OPENCOVEN_PHASE1_SCHEMA_V2_EVIDENCE = 'malformed'
      Assert-NativeBindingRejected `
        -Label 'Malformed native evidence mode' `
        -Result (Invoke-NativeRpcUnsupervised -Environment $malformedModeEnvironment)
      $malformedEnvironment = $childEnvironment.Clone()
      $malformedEnvironment.OPENCOVEN_PHASE1_SCHEMA_V2_EVIDENCE = '1'
      $malformedEnvironment.OPENCOVEN_WINDOWS_JOB_REQUIRED = '1'
      $malformedEnvironment.OPENCOVEN_WINDOWS_JOB_NONCE = 'not-a-nonce'
      $malformedEnvironment.OPENCOVEN_WINDOWS_JOB_NAME = $membershipAName
      Assert-NativeBindingRejected `
        -Label 'Malformed native Job binding' `
        -Result (Invoke-NativeRpcUnsupervised -Environment $malformedEnvironment)

      $nonexistentEnvironment = $childEnvironment.Clone()
      $nonexistentEnvironment.OPENCOVEN_PHASE1_SCHEMA_V2_EVIDENCE = '1'
      $nonexistentNonce = '0123456789abcdef0123456789abcdef'
      $nonexistentEnvironment.OPENCOVEN_WINDOWS_JOB_REQUIRED = '1'
      $nonexistentEnvironment.OPENCOVEN_WINDOWS_JOB_NONCE = $nonexistentNonce
      $nonexistentEnvironment.OPENCOVEN_WINDOWS_JOB_NAME =
        "Local\OpenCoven.Chat.Conformance.$nonexistentNonce"
      Assert-NativeBindingRejected `
        -Label 'Nonexistent native Job binding' `
        -Result (Invoke-NativeRpcUnsupervised -Environment $nonexistentEnvironment)

      $jobANonce = '11111111111111111111111111111111'
      $jobAName = "Local\OpenCoven.Chat.Conformance.$jobANonce"
      $jobBNonce = '22222222222222222222222222222222'
      $jobBName = "Local\OpenCoven.Chat.Conformance.$jobBNonce"
      $jobA = [OpenCoven.WindowsJobSupervisor]::Create($jobAName, $isolatedUser)
      $jobB = [OpenCoven.WindowsJobSupervisor]::Create($jobBName, $isolatedUser)
      try {
        $unsupervisedNativeEnvironment = $childEnvironment.Clone()
        $unsupervisedNativeEnvironment.OPENCOVEN_PHASE1_SCHEMA_V2_EVIDENCE = '1'
        $unsupervisedNativeEnvironment.OPENCOVEN_WINDOWS_JOB_REQUIRED = '1'
        $unsupervisedNativeEnvironment.OPENCOVEN_WINDOWS_JOB_NONCE = $jobANonce
        $unsupervisedNativeEnvironment.OPENCOVEN_WINDOWS_JOB_NAME = $jobAName
        Assert-NativeBindingRejected `
          -Label 'Unsupervised native process with valid existing Job A binding' `
          -Result (Invoke-NativeRpcUnsupervised -Environment $unsupervisedNativeEnvironment)

        $wrongNativeEnvironment = $childEnvironment.Clone()
        $wrongNativeEnvironment.OPENCOVEN_PHASE1_SCHEMA_V2_EVIDENCE = '1'
        $wrongNativeEnvironment.OPENCOVEN_WINDOWS_JOB_REQUIRED = '1'
        $wrongNativeEnvironment.OPENCOVEN_WINDOWS_JOB_NONCE = $jobANonce
        $wrongNativeEnvironment.OPENCOVEN_WINDOWS_JOB_NAME = $jobAName
        Assert-NativeBindingRejected `
          -Label 'Wrong existing native Job binding' `
          -Result ($jobB.RunAsUser(
            $isolatedUser,
            $nativeRpc,
            '',
            $root,
            $wrongNativeEnvironment,
            [TimeSpan]::FromSeconds(30),
            1MB,
            1MB
          ))

        $validNativeEnvironment = $childEnvironment.Clone()
        $validNativeEnvironment.OPENCOVEN_PHASE1_SCHEMA_V2_EVIDENCE = '1'
        $validNativeEnvironment.OPENCOVEN_WINDOWS_JOB_REQUIRED = '1'
        $validNativeEnvironment.OPENCOVEN_WINDOWS_JOB_NONCE = $jobANonce
        $validNativeEnvironment.OPENCOVEN_WINDOWS_JOB_NAME = $jobAName
        $validNative = $jobA.RunAsUser(
          $isolatedUser,
          $nativeRpc,
          '',
          $root,
          $validNativeEnvironment,
          [TimeSpan]::FromSeconds(30),
          1MB,
          1MB
        )
        if ($validNative.ExitCode -ne 0 -or $validNative.Stdout -ne '' -or $validNative.Stderr -ne '') {
          throw 'Valid native Job binding did not reach native RPC startup.'
        }
      } finally {
        $jobB.Dispose()
        $jobA.Dispose()
      }
    }
  } finally {
    $membershipB.Dispose()
    $membershipA.Dispose()
  }
} finally {
  $cleanupErrors = [Collections.Generic.List[Exception]]::new()
  try {
    $isolatedUser.Dispose()
  } catch {
    $cleanupErrors.Add($_.Exception)
  }
  if ([IO.Directory]::Exists($operatorPrivateRoot)) {
    try {
      [IO.Directory]::Delete($operatorPrivateRoot, $true)
    } catch {
      $cleanupErrors.Add($_.Exception)
    }
  }
  if ($cleanupErrors.Count -ne 0) {
    throw [AggregateException]::new('Windows supervisor test cleanup failed.', $cleanupErrors)
  }
}
if ($null -ne (Get-LocalUser -Name $ephemeralUserName -ErrorAction SilentlyContinue)) {
  throw 'Ephemeral local user survived cleanup.'
}
if ([IO.Directory]::Exists($ephemeralProfilePath)) {
  throw 'Ephemeral Windows profile survived cleanup.'
}
if ([IO.Directory]::Exists($root)) {
  throw 'Ephemeral bootstrap root survived cleanup.'
}
