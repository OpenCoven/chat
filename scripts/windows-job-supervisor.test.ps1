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

$createProcessWithLogon = [OpenCoven.WindowsJobSupervisor].GetMethod(
  'CreateProcessWithLogonW',
  [Reflection.BindingFlags]'NonPublic,Static'
)
if ($null -eq $createProcessWithLogon) {
  throw 'CreateProcessWithLogonW declaration is missing.'
}
$createProcessParameters = $createProcessWithLogon.GetParameters()
if ($createProcessParameters.Count -ne 11) {
  throw 'CreateProcessWithLogonW parameter count changed.'
}
$expectedCreateProcessNames = @(
  'userName',
  'domain',
  'password',
  'logonFlags',
  'applicationName',
  'commandLine',
  'creationFlags',
  'environment',
  'currentDirectory',
  'startupInfo',
  'processInformation'
)
$expectedCreateProcessTypes = @(
  [string],
  [string],
  [string],
  [uint32],
  [string],
  [Text.StringBuilder],
  [uint32],
  [IntPtr],
  [string]
)
for ($index = 0; $index -lt $expectedCreateProcessTypes.Count; $index++) {
  if (
    $createProcessParameters[$index].Name -cne $expectedCreateProcessNames[$index] -or
    $createProcessParameters[$index].ParameterType -ne $expectedCreateProcessTypes[$index]
  ) {
    throw 'CreateProcessWithLogonW parameter names or types changed.'
  }
}
if (
  $createProcessParameters[9].Name -cne $expectedCreateProcessNames[9] -or
  -not $createProcessParameters[9].ParameterType.IsByRef -or
  $createProcessParameters[9].IsOut -or
  $createProcessParameters[9].ParameterType.GetElementType().Name -cne 'STARTUPINFO' -or
  $createProcessParameters[10].Name -cne $expectedCreateProcessNames[10] -or
  -not $createProcessParameters[10].ParameterType.IsByRef -or
  -not $createProcessParameters[10].IsOut -or
  $createProcessParameters[10].ParameterType.GetElementType().Name -cne 'PROCESS_INFORMATION'
) {
  throw 'CreateProcessWithLogonW parameter names or types changed.'
}

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
  $handoffCanarySecret =
    "supervisor-only-canary-$([Guid]::NewGuid().ToString('N'))"
  $handoffCanary = Join-Path $operatorPrivateRoot 'handoff-canary.txt'
  [IO.File]::WriteAllText(
    $handoffCanary,
    $handoffCanarySecret,
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

  $rootProcessAttackSource = Join-Path $root 'root-process-attack.cs'
  [IO.File]::WriteAllText(
    $rootProcessAttackSource,
    @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class RootProcessAttack
{
    private const uint PROCESS_TERMINATE = 0x00000001;
    private const uint PROCESS_CREATE_THREAD = 0x00000002;
    private const uint PROCESS_VM_OPERATION = 0x00000008;
    private const uint PROCESS_VM_READ = 0x00000010;
    private const uint PROCESS_VM_WRITE = 0x00000020;
    private const uint PROCESS_DUP_HANDLE = 0x00000040;
    private const uint PROCESS_CREATE_PROCESS = 0x00000080;
    private const uint PROCESS_SET_QUOTA = 0x00000100;
    private const uint PROCESS_SET_INFORMATION = 0x00000200;
    private const uint PROCESS_QUERY_INFORMATION = 0x00000400;
    private const uint PROCESS_SUSPEND_RESUME = 0x00000800;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x00001000;
    private const uint PROCESS_SET_LIMITED_INFORMATION = 0x00002000;
    private const uint DELETE = 0x00010000;
    private const uint WRITE_DAC = 0x00040000;
    private const uint WRITE_OWNER = 0x00080000;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint MOVEFILE_REPLACE_EXISTING = 0x00000001;
    private const uint MOVEFILE_WRITE_THROUGH = 0x00000008;
    private const int ERROR_ACCESS_DENIED = 5;

    public static void Run(
        int rootProcessId,
        string artifactPath,
        string attack,
        string forgedText,
        string completedPath)
    {
        IntPtr query = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
            false,
            checked((uint)rootProcessId));
        if (query == IntPtr.Zero)
        {
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                "Root query-only process open was denied.");
        }
        CloseHandle(query);

        WriteForgery(artifactPath, attack, forgedText);
        RequireDeniedOpen(
            rootProcessId,
            WRITE_DAC,
            "Root WRITE_DAC open unexpectedly succeeded.");
        RequireDeniedOpen(
            rootProcessId,
            WRITE_OWNER,
            "Root WRITE_OWNER open unexpectedly succeeded.");
        RequireDeniedOpen(
            rootProcessId,
            PROCESS_DUP_HANDLE,
            "Root PROCESS_DUP_HANDLE open unexpectedly succeeded.");
        RequireDeniedOpen(
            rootProcessId,
            PROCESS_VM_READ,
            "Root PROCESS_VM_READ open unexpectedly succeeded.");
        RequireDeniedOpen(
            rootProcessId,
            PROCESS_VM_WRITE | PROCESS_VM_OPERATION,
            "Root PROCESS_VM_WRITE or PROCESS_VM_OPERATION open unexpectedly succeeded.");
        RequireDeniedOpen(
            rootProcessId,
            PROCESS_CREATE_THREAD,
            "Root PROCESS_CREATE_THREAD open unexpectedly succeeded.");
        RequireDeniedOpen(
            rootProcessId,
            PROCESS_CREATE_PROCESS,
            "Root PROCESS_CREATE_PROCESS open unexpectedly succeeded.");
        RequireDeniedOpen(
            rootProcessId,
            PROCESS_SET_QUOTA,
            "Root PROCESS_SET_QUOTA open unexpectedly succeeded.");
        RequireDeniedOpen(
            rootProcessId,
            PROCESS_SET_INFORMATION,
            "Root PROCESS_SET_INFORMATION open unexpectedly succeeded.");
        RequireDeniedOpen(
            rootProcessId,
            PROCESS_QUERY_INFORMATION,
            "Root PROCESS_QUERY_INFORMATION open unexpectedly succeeded.");
        RequireDeniedOpen(
            rootProcessId,
            PROCESS_SUSPEND_RESUME,
            "Root PROCESS_SUSPEND_RESUME open unexpectedly succeeded.");
        RequireDeniedOpen(
            rootProcessId,
            PROCESS_SET_LIMITED_INFORMATION,
            "Root PROCESS_SET_LIMITED_INFORMATION open unexpectedly succeeded.");
        RequireDeniedOpen(
            rootProcessId,
            DELETE,
            "Root DELETE open unexpectedly succeeded.");

        IntPtr root = OpenProcess(
            PROCESS_TERMINATE,
            false,
            checked((uint)rootProcessId));
        if (root != IntPtr.Zero)
        {
            try
            {
                if (TerminateProcess(root, 0))
                {
                    throw new InvalidOperationException(
                        "Root TerminateProcess unexpectedly succeeded.");
                }
            }
            finally
            {
                CloseHandle(root);
            }
            throw new InvalidOperationException(
                "Root PROCESS_TERMINATE open unexpectedly succeeded.");
        }
        if (Marshal.GetLastWin32Error() != ERROR_ACCESS_DENIED)
        {
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                "Root PROCESS_TERMINATE open failed for an unexpected reason.");
        }

        File.WriteAllText(
            completedPath,
            "protected",
            new UTF8Encoding(false));
    }

    private static void WriteForgery(string path, string attack, string text)
    {
        if (String.Equals(attack, "in-place", StringComparison.Ordinal))
        {
            File.WriteAllText(path, text, new UTF8Encoding(false));
            return;
        }
        if (String.Equals(attack, "replacement", StringComparison.Ordinal))
        {
            string replacement = path + ".replacement";
            File.WriteAllText(replacement, text, new UTF8Encoding(false));
            if (!MoveFileExW(
                    replacement,
                    path,
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Ordinary one-link artifact replacement failed.");
            }
            return;
        }
        throw new InvalidOperationException("Unknown live-root artifact attack.");
    }

    private static void RequireDeniedOpen(
        int processId,
        uint access,
        string failureMessage)
    {
        IntPtr handle = OpenProcess(
            access,
            false,
            checked((uint)processId));
        if (handle != IntPtr.Zero)
        {
            CloseHandle(handle);
            throw new InvalidOperationException(failureMessage);
        }
        if (Marshal.GetLastWin32Error() != ERROR_ACCESS_DENIED)
        {
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                "Dangerous root process open failed for an unexpected reason.");
        }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(
        uint desiredAccess,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
        uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr root, uint exitCode);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool MoveFileExW(
        string existingFileName,
        string newFileName,
        uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
}
'@,
    [Text.UTF8Encoding]::new($false)
  )
  $rootProcessAttackScript = Join-Path $root 'root-process-attack.ps1'
  [IO.File]::WriteAllText(
    $rootProcessAttackScript,
    @'
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -TypeDefinition (
  [IO.File]::ReadAllText($env:OPENCOVEN_ROOT_PROCESS_ATTACK_SOURCE)
) -Language CSharp
[RootProcessAttack]::Run(
  [int]$env:OPENCOVEN_ROOT_PROCESS_ID,
  $env:OPENCOVEN_ROOT_ARTIFACT_PATH,
  $env:OPENCOVEN_ROOT_ARTIFACT_ATTACK,
  $env:OPENCOVEN_ROOT_FORGED_TEXT,
  $env:OPENCOVEN_ROOT_ATTACK_COMPLETE
)
'@,
    [Text.UTF8Encoding]::new($false)
  )
  $liveRootScript = Join-Path $root 'live-root-handoff.ps1'
  [IO.File]::WriteAllText(
    $liveRootScript,
    @'
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$parent = [IO.Directory]::GetParent($env:OPENCOVEN_ROOT_ARTIFACT_PATH).FullName
[IO.Directory]::CreateDirectory($parent) | Out-Null
[IO.File]::WriteAllText(
  $env:OPENCOVEN_ROOT_ARTIFACT_PATH,
  $env:OPENCOVEN_ROOT_TRUSTED_TEXT,
  [Text.UTF8Encoding]::new($false)
)
$attackEnvironment = @{
  OPENCOVEN_ROOT_PROCESS_ATTACK_SOURCE = $env:OPENCOVEN_ROOT_PROCESS_ATTACK_SOURCE
  OPENCOVEN_ROOT_PROCESS_ID = "$PID"
  OPENCOVEN_ROOT_ARTIFACT_PATH = $env:OPENCOVEN_ROOT_ARTIFACT_PATH
  OPENCOVEN_ROOT_ARTIFACT_ATTACK = $env:OPENCOVEN_ROOT_ARTIFACT_ATTACK
  OPENCOVEN_ROOT_FORGED_TEXT = $env:OPENCOVEN_ROOT_FORGED_TEXT
  OPENCOVEN_ROOT_ATTACK_COMPLETE = $env:OPENCOVEN_ROOT_ATTACK_COMPLETE
}
$attack = Start-Process `
  -FilePath $env:OPENCOVEN_WINDOWS_SYSTEM_PWSH `
  -ArgumentList @(
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-File',
    $env:OPENCOVEN_ROOT_PROCESS_ATTACK_SCRIPT
  ) `
  -Environment $attackEnvironment `
  -RedirectStandardOutput $env:OPENCOVEN_ROOT_ATTACK_STDOUT `
  -RedirectStandardError $env:OPENCOVEN_ROOT_ATTACK_STDERR `
  -PassThru
try {
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (-not [IO.File]::Exists($env:OPENCOVEN_ROOT_ATTACK_COMPLETE)) {
    if ($attack.HasExited) {
      throw "Root process attack failed: $(
        [IO.File]::ReadAllText($env:OPENCOVEN_ROOT_ATTACK_STDERR)
      )"
    }
    if ([DateTime]::UtcNow -ge $deadline) {
      throw 'Root process attack did not finish.'
    }
    Start-Sleep -Milliseconds 20
  }
  $attack.WaitForExit()
  if (
    $attack.ExitCode -ne 0 -or
    [IO.File]::ReadAllText($env:OPENCOVEN_ROOT_ATTACK_COMPLETE) -cne 'protected'
  ) {
    throw 'Root process mutation rights were not denied.'
  }
} finally {
  $attack.Dispose()
}
[IO.File]::WriteAllText(
  $env:OPENCOVEN_ROOT_ARTIFACT_PATH,
  $env:OPENCOVEN_ROOT_TRUSTED_TEXT,
  [Text.UTF8Encoding]::new($false)
)
'@,
    [Text.UTF8Encoding]::new($false)
  )
  $liveRootTrustedText =
    '{' + "`n" +
      '  "platform": "win32-x64",' + "`n" +
      '  "rootProof": "trusted",' + "`n" +
      '  "schemaVersion": 2' + "`n" +
      '}' + "`n"
  $liveRootForgedText =
    '{' + "`n" +
      '  "platform": "win32-x64",' + "`n" +
      '  "rootProof": "forged",' + "`n" +
      '  "schemaVersion": 2' + "`n" +
      '}' + "`n"
  $liveRootTrustedBytes =
    [Text.UTF8Encoding]::new($false).GetBytes($liveRootTrustedText)
  $liveRootTrustedDigest = [Convert]::ToHexString(
    [Security.Cryptography.SHA256]::HashData($liveRootTrustedBytes)
  ).ToLowerInvariant()

  function Assert-LiveRootForgeryRejected {
    param(
      [Parameter(Mandatory)][string]$Label,
      [Parameter(Mandatory)][string]$Attack,
      [Parameter(Mandatory)][string]$Failure
    )

    $caseRoot = Join-Path (
      $isolatedUser.WorkspacePath
    ) "live-root-$Label-$([Guid]::NewGuid().ToString('N'))"
    $recordPath = Join-Path $caseRoot '.artifacts\record.json'
    $completePath = Join-Path $caseRoot 'attack-complete.txt'
    $environment = $childEnvironment.Clone()
    $environment.OPENCOVEN_ROOT_PROCESS_ATTACK_SOURCE = $rootProcessAttackSource
    $environment.OPENCOVEN_ROOT_PROCESS_ATTACK_SCRIPT = $rootProcessAttackScript
    $environment.OPENCOVEN_ROOT_ARTIFACT_PATH = $recordPath
    $environment.OPENCOVEN_ROOT_ARTIFACT_ATTACK = $Attack
    $environment.OPENCOVEN_ROOT_TRUSTED_TEXT = $liveRootTrustedText
    $environment.OPENCOVEN_ROOT_FORGED_TEXT = $liveRootForgedText
    $environment.OPENCOVEN_ROOT_ATTACK_COMPLETE = $completePath
    $environment.OPENCOVEN_ROOT_ATTACK_STDOUT = Join-Path $caseRoot 'attack.stdout'
    $environment.OPENCOVEN_ROOT_ATTACK_STDERR = Join-Path $caseRoot 'attack.stderr'
    $job = [OpenCoven.WindowsJobSupervisor]::Create(
      "Local\OpenCoven.Chat.SupervisorTest.$([Guid]::NewGuid().ToString('N'))",
      $isolatedUser
    )
    try {
      $result = $job.RunAsUser(
        $isolatedUser,
        $trustedPwsh,
        "-NoLogo -NoProfile -NonInteractive -File `"$liveRootScript`"",
        $isolatedUser.RootPath,
        $environment,
        [TimeSpan]::FromSeconds(30),
        1MB,
        1MB
      )
      if ($result.ExitCode -ne 0) {
        throw "Protected root process did not execute normally: $($result.Stderr)"
      }
      $artifact = $job.CaptureIsolatedArtifact(
        $isolatedUser,
        $isolatedUser.WorkspacePath,
        $recordPath,
        1MB
      )
      if (
        $artifact.Size -ne $liveRootTrustedBytes.Length -or
        $artifact.Sha256 -cne $liveRootTrustedDigest
      ) {
        throw $Failure
      }
      [OpenCoven.WindowsJobSupervisor]::RequireCanonicalSchemaV2Artifact(
        $artifact.Bytes,
        $liveRootTrustedDigest,
        'win32-x64'
      )
    } finally {
      $job.Dispose()
    }
  }

  Assert-LiveRootForgeryRejected `
    -Label 'in-place' `
    -Attack 'in-place' `
    -Failure 'Live root in-place artifact forgery was authorized.'
  Assert-LiveRootForgeryRejected `
    -Label 'replacement' `
    -Attack 'replacement' `
    -Failure 'Live root replacement artifact forgery was authorized.'

  $handoffAttackSource = Join-Path $root 'artifact-handoff-attack.cs'
  [IO.File]::WriteAllText(
    $handoffAttackSource,
    @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

public static class ArtifactHandoffAttack
{
    private const uint SYMBOLIC_LINK_FLAG_DIRECTORY = 0x1;
    private const uint SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE = 0x2;

    public static void ReplaceFileWithSymbolicLink(string path, string target)
    {
        File.Delete(path);
        if (!CreateSymbolicLinkW(
                path,
                target,
                SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE))
        {
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                "Test file symbolic link creation failed.");
        }
    }

    public static void CreateHardLink(string path, string existing)
    {
        if (!CreateHardLinkW(path, existing, IntPtr.Zero))
        {
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                "Test hardlink creation failed.");
        }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateSymbolicLinkW(
        string symbolicLink,
        string target,
        uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateHardLinkW(
        string fileName,
        string existingFileName,
        IntPtr securityAttributes);
}
'@,
    [Text.UTF8Encoding]::new($false)
  )
  $handoffReplacementScript = Join-Path $root 'artifact-handoff-replacement.ps1'
  [IO.File]::WriteAllText(
    $handoffReplacementScript,
    @'
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -TypeDefinition (
  [IO.File]::ReadAllText($env:OPENCOVEN_HANDOFF_ATTACK_SOURCE)
) -Language CSharp
if ($env:OPENCOVEN_HANDOFF_ATTACK -eq 'symlink') {
  [ArtifactHandoffAttack]::ReplaceFileWithSymbolicLink(
    $env:OPENCOVEN_HANDOFF_RECORD,
    $env:OPENCOVEN_HANDOFF_CANARY
  )
} elseif ($env:OPENCOVEN_HANDOFF_ATTACK -eq 'junction') {
  $parent = [IO.Directory]::GetParent($env:OPENCOVEN_HANDOFF_RECORD).FullName
  $real = "$parent-real"
  [IO.Directory]::Move($parent, $real)
  & $env:COMSPEC /d /c "mklink /J `"$parent`" `"$real`""
  if ($LASTEXITCODE -ne 0) {
    throw 'Test parent junction creation failed.'
  }
} else {
  throw 'Unknown artifact handoff replacement attack.'
}
'@,
    [Text.UTF8Encoding]::new($false)
  )
  $handoffProducerTemplate = @'
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -TypeDefinition (
  [IO.File]::ReadAllText($env:OPENCOVEN_HANDOFF_ATTACK_SOURCE)
) -Language CSharp
$recordParent = [IO.Directory]::GetParent($env:OPENCOVEN_HANDOFF_RECORD).FullName
[IO.Directory]::CreateDirectory($recordParent) | Out-Null
[IO.File]::WriteAllText(
  $env:OPENCOVEN_HANDOFF_RECORD,
  '{' + "`n" +
    '  "platform": "win32-x64",' + "`n" +
    '  "schemaVersion": 2' + "`n" +
    '}' + "`n",
  [Text.UTF8Encoding]::new($false)
)
$validated = [IO.File]::ReadAllText($env:OPENCOVEN_HANDOFF_RECORD) |
  ConvertFrom-Json
if ($validated.schemaVersion -ne 2 -or $validated.platform -ne 'win32-x64') {
  throw 'Test record validation failed.'
}
if ($env:OPENCOVEN_HANDOFF_ATTACK -eq 'hardlink') {
  [ArtifactHandoffAttack]::CreateHardLink(
    "$($env:OPENCOVEN_HANDOFF_RECORD).link",
    $env:OPENCOVEN_HANDOFF_RECORD
  )
} elseif (
  $env:OPENCOVEN_HANDOFF_ATTACK -eq 'symlink' -or
  $env:OPENCOVEN_HANDOFF_ATTACK -eq 'junction'
) {
  $replacement = Start-Process `
    -FilePath $env:OPENCOVEN_WINDOWS_SYSTEM_PWSH `
    -ArgumentList @(
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      $env:OPENCOVEN_HANDOFF_REPLACEMENT_SCRIPT
    ) `
    -Wait `
    -PassThru
  if ($replacement.ExitCode -ne 0) {
    throw 'Background artifact replacement failed.'
  }
}
'@
  $handoffValidatorScript = Join-Path $root 'artifact-handoff-validator.ps1'
  [IO.File]::WriteAllText(
    $handoffValidatorScript,
    @'
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -TypeDefinition (
  [IO.File]::ReadAllText($env:OPENCOVEN_WINDOWS_JOB_SUPERVISOR_SOURCE)
) -Language CSharp
$inputStream = [Console]::OpenStandardInput()
$memory = [IO.MemoryStream]::new()
try {
  $inputStream.CopyTo($memory)
  $bytes = $memory.ToArray()
} finally {
  $memory.Dispose()
  $inputStream.Dispose()
}
[OpenCoven.WindowsJobSupervisor]::RequireCanonicalSchemaV2Artifact(
  $bytes,
  $env:OPENCOVEN_EXPECTED_RECORD_SHA256,
  'win32-x64'
)
'@,
    [Text.UTF8Encoding]::new($false)
  )
  $expectedHandoffBytes = [Text.UTF8Encoding]::new($false).GetBytes(
    '{' + "`n" +
      '  "platform": "win32-x64",' + "`n" +
      '  "schemaVersion": 2' + "`n" +
      '}' + "`n"
  )
  $expectedHandoffDigest = [Convert]::ToHexString(
    [Security.Cryptography.SHA256]::HashData($expectedHandoffBytes)
  ).ToLowerInvariant()

  function Invoke-HandoffProducer {
    param(
      [Parameter(Mandatory)][string]$Label,
      [Parameter(Mandatory)][string]$Attack
    )

    $caseRoot = Join-Path (
      $isolatedUser.WorkspacePath
    ) "handoff-$Label-$([Guid]::NewGuid().ToString('N'))"
    $recordPath = Join-Path $caseRoot '.artifacts\record.json'
    $scriptPath = Join-Path $root "handoff-$Label.ps1"
    [IO.File]::WriteAllText(
      $scriptPath,
      $handoffProducerTemplate,
      [Text.UTF8Encoding]::new($false)
    )
    $environment = $childEnvironment.Clone()
    $environment.OPENCOVEN_HANDOFF_ATTACK = $Attack
    $environment.OPENCOVEN_HANDOFF_ATTACK_SOURCE = $handoffAttackSource
    $environment.OPENCOVEN_HANDOFF_CANARY = $handoffCanary
    $environment.OPENCOVEN_HANDOFF_RECORD = $recordPath
    $environment.OPENCOVEN_HANDOFF_REPLACEMENT_SCRIPT = $handoffReplacementScript
    $job = [OpenCoven.WindowsJobSupervisor]::Create(
      "Local\OpenCoven.Chat.SupervisorTest.$([Guid]::NewGuid().ToString('N'))",
      $isolatedUser
    )
    try {
      $result = $job.RunAsUser(
        $isolatedUser,
        $trustedPwsh,
        "-NoLogo -NoProfile -NonInteractive -File `"$scriptPath`"",
        $isolatedUser.RootPath,
        $environment,
        [TimeSpan]::FromSeconds(30),
        1MB,
        1MB
      )
      if ($result.ExitCode -ne 0) {
        throw "Artifact handoff producer '$Label' failed."
      }
      return [pscustomobject]@{
        Job = $job
        RecordPath = $recordPath
      }
    } catch {
      $job.Dispose()
      throw
    }
  }

  function Assert-HandoffRejected {
    param(
      [Parameter(Mandatory)]$Case,
      [Parameter(Mandatory)][string]$Failure
    )

    $rejected = $false
    try {
      $Case.Job.CaptureIsolatedArtifact(
        $isolatedUser,
        $isolatedUser.WorkspacePath,
        $Case.RecordPath,
        1MB
      ) | Out-Null
    } catch {
      $rejected = $true
      if ($_.Exception.ToString().Contains($handoffCanarySecret)) {
        throw 'Artifact handoff failure exposed supervisor-only canary bytes.'
      }
    } finally {
      $Case.Job.Dispose()
    }
    if (-not $rejected) {
      throw $Failure
    }
  }

  $successCase = Invoke-HandoffProducer -Label 'success' -Attack 'none'
  try {
    $validatedArtifact = $successCase.Job.CaptureIsolatedArtifact(
      $isolatedUser,
      $isolatedUser.WorkspacePath,
      $successCase.RecordPath,
      1MB
    )
    if (
      $validatedArtifact.Size -ne $expectedHandoffBytes.Length -or
      $validatedArtifact.Sha256 -cne $expectedHandoffDigest
    ) {
      throw 'Valid artifact handoff changed captured bytes.'
    }
    $validationEnvironment = $childEnvironment.Clone()
    $validationEnvironment.OPENCOVEN_EXPECTED_RECORD_SHA256 =
      $validatedArtifact.Sha256
    $validationResult = $successCase.Job.RunAsUserWithStandardInput(
      $isolatedUser,
      $trustedPwsh,
      "-NoLogo -NoProfile -NonInteractive -File `"$handoffValidatorScript`"",
      $isolatedUser.RootPath,
      $validationEnvironment,
      [TimeSpan]::FromSeconds(30),
      1MB,
      1MB,
      $validatedArtifact.Bytes
    )
    if ($validationResult.ExitCode -ne 0) {
      throw 'Fresh unprivileged handle-captured record validation failed.'
    }
    $handoffOutputRoot = Join-Path $operatorPrivateRoot 'handoff-output'
    [IO.Directory]::CreateDirectory($handoffOutputRoot) | Out-Null
    [OpenCoven.WindowsJobSupervisor]::ProtectSupervisorDirectory(
      $handoffOutputRoot
    )
    $publishedPath = Join-Path $handoffOutputRoot 'record.json'
    $successCase.Job.PublishValidatedArtifact(
      $validatedArtifact,
      $handoffOutputRoot,
      $publishedPath
    )
    if (
      [Convert]::ToHexString(
        [Security.Cryptography.SHA256]::HashData(
          [IO.File]::ReadAllBytes($publishedPath)
        )
      ).ToLowerInvariant() -cne $expectedHandoffDigest
    ) {
      throw 'Published artifact bytes differ from the validated handle bytes.'
    }
  } finally {
    $successCase.Job.Dispose()
  }

  Assert-HandoffRejected `
    -Case (Invoke-HandoffProducer -Label 'symlink' -Attack 'symlink') `
    -Failure 'Symlink replacement artifact handoff unexpectedly succeeded.'
  Assert-HandoffRejected `
    -Case (Invoke-HandoffProducer -Label 'hardlink' -Attack 'hardlink') `
    -Failure 'Hardlink artifact handoff unexpectedly succeeded.'
  Assert-HandoffRejected `
    -Case (Invoke-HandoffProducer -Label 'junction' -Attack 'junction') `
    -Failure 'Parent junction artifact handoff unexpectedly succeeded.'

  $ownerCase = Invoke-HandoffProducer -Label 'owner' -Attack 'none'
  $ownerAcl = Get-Acl -LiteralPath $ownerCase.RecordPath
  $ownerAcl.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User)
  Set-Acl -LiteralPath $ownerCase.RecordPath -AclObject $ownerAcl
  Assert-HandoffRejected `
    -Case $ownerCase `
    -Failure 'Wrong-owner artifact handoff unexpectedly succeeded.'

  $daclCase = Invoke-HandoffProducer -Label 'dacl' -Attack 'none'
  & (Join-Path $env:SystemRoot 'System32\icacls.exe') `
    $daclCase.RecordPath `
    '/grant' `
    '*S-1-1-0:(R)' | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw 'Permissive artifact test DACL could not be applied.'
  }
  Assert-HandoffRejected `
    -Case $daclCase `
    -Failure 'Permissive-DACL artifact handoff unexpectedly succeeded.'

  $raceCase = Invoke-HandoffProducer -Label 'race' -Attack 'none'
  $raceStop = Join-Path $operatorPrivateRoot 'handoff-race-stop'
  $raceReady = Join-Path $operatorPrivateRoot 'handoff-race-ready'
  $raceScript = Join-Path $root 'artifact-handoff-race.ps1'
  [IO.File]::WriteAllText(
    $raceScript,
    @'
$ErrorActionPreference = 'Continue'
Set-StrictMode -Version Latest
Add-Type -TypeDefinition (
  [IO.File]::ReadAllText($env:OPENCOVEN_HANDOFF_ATTACK_SOURCE)
) -Language CSharp
$reported = $false
while (-not [IO.File]::Exists($env:OPENCOVEN_HANDOFF_RACE_STOP)) {
  try {
    [ArtifactHandoffAttack]::ReplaceFileWithSymbolicLink(
      $env:OPENCOVEN_HANDOFF_RECORD,
      $env:OPENCOVEN_HANDOFF_CANARY
    )
    if (-not $reported) {
      [IO.File]::WriteAllText($env:OPENCOVEN_HANDOFF_RACE_READY, 'ready')
      $reported = $true
    }
  } catch {
  }
  Start-Sleep -Milliseconds 1
}
'@,
    [Text.UTF8Encoding]::new($false)
  )
  $raceEnvironment = @{
    OPENCOVEN_HANDOFF_ATTACK_SOURCE = $handoffAttackSource
    OPENCOVEN_HANDOFF_CANARY = $handoffCanary
    OPENCOVEN_HANDOFF_RACE_READY = $raceReady
    OPENCOVEN_HANDOFF_RACE_STOP = $raceStop
    OPENCOVEN_HANDOFF_RECORD = $raceCase.RecordPath
  }
  $raceProcess = Start-Process `
    -FilePath $trustedPwsh `
    -ArgumentList @(
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      $raceScript
    ) `
    -Environment $raceEnvironment `
    -RedirectStandardOutput (Join-Path $operatorPrivateRoot 'handoff-race.stdout') `
    -RedirectStandardError (Join-Path $operatorPrivateRoot 'handoff-race.stderr') `
    -PassThru
  try {
    $raceDeadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not [IO.File]::Exists($raceReady)) {
      if ($raceProcess.HasExited) {
        throw 'Artifact replacement race exited before replacing the record.'
      }
      if ([DateTime]::UtcNow -ge $raceDeadline) {
        throw 'Artifact replacement race did not replace the record.'
      }
      Start-Sleep -Milliseconds 10
    }
    try {
      $raceArtifact = $raceCase.Job.CaptureIsolatedArtifact(
        $isolatedUser,
        $isolatedUser.WorkspacePath,
        $raceCase.RecordPath,
        1MB
      )
      if ($raceArtifact.Sha256 -cne $expectedHandoffDigest) {
        throw 'Artifact replacement race exposed supervisor-only canary bytes.'
      }
    } catch {
      if (
        $_.Exception.ToString().Contains($handoffCanarySecret) -or
        $_.Exception.Message -eq
          'Artifact replacement race exposed supervisor-only canary bytes.'
      ) {
        throw 'Artifact replacement race exposed supervisor-only canary bytes.'
      }
    }
  } finally {
    [IO.File]::WriteAllText($raceStop, 'stop')
    if (-not $raceProcess.WaitForExit(10000)) {
      $raceProcess.Kill($true)
      $raceProcess.WaitForExit()
    }
    if ($raceProcess.ExitCode -ne 0) {
      throw 'Artifact replacement race process failed.'
    }
    $raceProcess.Dispose()
    $raceCase.Job.Dispose()
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
