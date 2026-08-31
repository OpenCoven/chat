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

$quarantineSequence = [OpenCoven.WindowsJobSupervisor].GetMethod(
  'ExecuteQuarantineSecuritySequence',
  [Reflection.BindingFlags]'NonPublic,Static'
)
if ($null -eq $quarantineSequence) {
  throw 'The fail-closed terminal quarantine sequence is missing.'
}

$revalidateFailedProcessOpen = [OpenCoven.WindowsJobSupervisor].GetMethod(
  'RevalidateFailedProcessOpen',
  [Reflection.BindingFlags]'NonPublic,Static'
)
if ($null -eq $revalidateFailedProcessOpen) {
  throw 'The stale process-open revalidation hook is missing.'
}
function Assert-ExpectedReflectionFailure {
  param(
    [Parameter(Mandatory)][scriptblock]$Operation,
    [Parameter(Mandatory)][type]$ExpectedType,
    [Parameter(Mandatory)][string]$ExpectedMessage,
    [Parameter(Mandatory)][string]$Failure
  )

  try {
    & $Operation
  } catch [Management.Automation.MethodInvocationException] {
    $underlying = $_.Exception.InnerException
    if ($underlying -is [Reflection.TargetInvocationException]) {
      $underlying = $underlying.InnerException
    }
    if (
      $null -eq $underlying -or
      $underlying.GetType() -ne $ExpectedType -or
      $underlying.Message -cne $ExpectedMessage
    ) {
      throw $Failure
    }
    return
  } catch {
    throw $Failure
  }
  throw $Failure
}

$validateStandardUserSnapshot = [OpenCoven.WindowsIsolatedUser].GetMethod(
  'ValidateStandardUserSnapshot',
  [Reflection.BindingFlags]'NonPublic,Static'
)
if ($null -eq $validateStandardUserSnapshot) {
  throw 'The exact standard-user account and token validator is missing.'
}
function New-StandardUserSnapshotArguments {
  param(
    [uint32]$LegacyPrivilege = 1,
    [uint32]$Flags = 0x00010201,
    [string[]]$Groups = @('S-1-5-32-545'),
    [bool]$Administrator = $false,
    [bool]$Elevated = $false,
    [uint32]$ElevationType = 1,
    [uint32]$Integrity = 0x2000,
    [string[]]$Privileges = @('SeChangeNotifyPrivilege')
  )
  $arguments = [object[]]::new(8)
  $arguments[0] = $LegacyPrivilege
  $arguments[1] = $Flags
  $arguments[2] = $Groups
  $arguments[3] = $Administrator
  $arguments[4] = $Elevated
  $arguments[5] = $ElevationType
  $arguments[6] = $Integrity
  $arguments[7] = $Privileges
  return ,$arguments
}
$validAccountSnapshot = New-StandardUserSnapshotArguments -LegacyPrivilege 2
$validateStandardUserSnapshot.Invoke($null, $validAccountSnapshot)
$validateStandardUserSnapshot.Invoke(
  $null,
  (New-StandardUserSnapshotArguments -LegacyPrivilege 0)
)

foreach ($invalidSnapshot in @(
  (New-StandardUserSnapshotArguments -Flags 0x00010203),
  (New-StandardUserSnapshotArguments `
      -Groups @('S-1-5-32-544', 'S-1-5-32-545') `
      -Administrator $true),
  (New-StandardUserSnapshotArguments `
      -Elevated $true `
      -ElevationType 2 `
      -Integrity 0x3000 `
      -Privileges @('SeDebugPrivilege'))
)) {
  Assert-ExpectedReflectionFailure `
    -Operation {
      $validateStandardUserSnapshot.Invoke($null, $invalidSnapshot)
    } `
    -ExpectedType ([InvalidOperationException]) `
    -ExpectedMessage 'Ephemeral account is not a restricted standard local user.' `
    -Failure 'Unsafe Windows account or token snapshot was accepted.'
}

$revalidationSteps = [Collections.Generic.List[string]]::new()
$missingProcessSnapshot =
  [Collections.Generic.Dictionary[uint32, string]]::new()
$missingProcessAccepted = [bool]$revalidateFailedProcessOpen.Invoke(
  $null,
  [object[]]@(
    [uint32]424242,
    'S-1-5-21-1-2-3-1001',
    87,
    [Func[Collections.Generic.Dictionary[uint32, string]]]{
      $revalidationSteps.Add('missing')
      return $missingProcessSnapshot
    }
  )
)
if (
  -not $missingProcessAccepted -or
  [string]::Join(',', $revalidationSteps) -cne 'missing'
) {
  throw 'Matching isolated-SID process disappearance was not revalidated.'
}

$revalidationSteps.Clear()
$reusedProcessSnapshot =
  [Collections.Generic.Dictionary[uint32, string]]::new()
$reusedProcessSnapshot.Add([uint32]424242, 'S-1-5-18')
$reusedProcessAccepted = [bool]$revalidateFailedProcessOpen.Invoke(
  $null,
  [object[]]@(
    [uint32]424242,
    'S-1-5-21-1-2-3-1001',
    1168,
    [Func[Collections.Generic.Dictionary[uint32, string]]]{
      $revalidationSteps.Add('reused')
      return $reusedProcessSnapshot
    }
  )
)
if (
  -not $reusedProcessAccepted -or
  [string]::Join(',', $revalidationSteps) -cne 'reused'
) {
  throw 'Reused PID with a different SID was not accepted after revalidation.'
}

$revalidationSteps.Clear()
$matchingProcessSnapshot =
  [Collections.Generic.Dictionary[uint32, string]]::new()
$matchingProcessSnapshot.Add([uint32]424242, 'S-1-5-21-1-2-3-1001')
Assert-ExpectedReflectionFailure `
  -Operation {
    $revalidateFailedProcessOpen.Invoke(
      $null,
      [object[]]@(
        [uint32]424242,
        'S-1-5-21-1-2-3-1001',
        87,
        [Func[Collections.Generic.Dictionary[uint32, string]]]{
          $revalidationSteps.Add('matching')
          return $matchingProcessSnapshot
        }
      )
    )
  } `
  -ExpectedType ([ComponentModel.Win32Exception]) `
  -ExpectedMessage 'Matching isolated-SID process still matched after failed open revalidation.' `
  -Failure 'Still-matching PID returned an unexpected reflection failure.'
if ([string]::Join(',', $revalidationSteps) -cne 'matching') {
  throw 'Still-matching PID was accepted after failed OpenProcess revalidation.'
}

$revalidationSteps.Clear()
Assert-ExpectedReflectionFailure `
  -Operation {
    $revalidateFailedProcessOpen.Invoke(
      $null,
      [object[]]@(
        [uint32]424242,
        'S-1-5-21-1-2-3-1001',
        5,
        [Func[Collections.Generic.Dictionary[uint32, string]]]{
          $revalidationSteps.Add('access-denied')
          return $missingProcessSnapshot
        }
      )
    )
  } `
  -ExpectedType ([ComponentModel.Win32Exception]) `
  -ExpectedMessage 'Matching isolated-SID process could not be opened.' `
  -Failure 'Access denial returned an unexpected reflection failure.'
if ($revalidationSteps.Count -ne 0) {
  throw 'Matching process access denial did not remain fail closed.'
}

function Invoke-QuarantineSequenceProbe {
  param(
    [Parameter(Mandatory)][AllowEmptyCollection()][Collections.Generic.List[string]]$Steps,
    [Parameter(Mandatory)][Action]$DisableAccount,
    [Parameter(Mandatory)][Func[int]]$CleanupScheduledTasks,
    [Parameter(Mandatory)][Func[int]]$CleanupBitsJobs,
    [Parameter(Mandatory)][Func[int]]$DrainProcesses,
    [Action]$TerminateAndReap = ([Action]{ $Steps.Add('terminate') }),
    [Action]$RequireJobZero = ([Action]{ $Steps.Add('job-zero') }),
    [Action]$RequireFinalIsolation = ([Action]{ $Steps.Add('final-proof') }),
    [int]$MaximumRounds = 4
  )

  $quarantineSequence.Invoke(
    $null,
    [object[]]@(
      $TerminateAndReap,
      $RequireJobZero,
      $DisableAccount,
      $CleanupScheduledTasks,
      $CleanupBitsJobs,
      $DrainProcesses,
      $RequireFinalIsolation,
      $MaximumRounds,
      0,
      0,
      0
    )
  )
}

$orderedSteps = [Collections.Generic.List[string]]::new()
Invoke-QuarantineSequenceProbe `
  -Steps $orderedSteps `
  -DisableAccount ([Action]{ $orderedSteps.Add('disable') }) `
  -CleanupScheduledTasks ([Func[int]]{
    $orderedSteps.Add('scheduler')
    return 0
  }) `
  -CleanupBitsJobs ([Func[int]]{
    $orderedSteps.Add('bits')
    return 0
  }) `
  -DrainProcesses ([Func[int]]{
    $orderedSteps.Add('processes')
    return 0
  })
$expectedOrder = @(
  'terminate',
  'job-zero',
  'disable',
  'scheduler', 'bits', 'processes',
  'scheduler', 'bits', 'processes',
  'scheduler', 'bits', 'processes',
  'final-proof'
)
if ([string]::Join(',', $orderedSteps) -cne [string]::Join(',', $expectedOrder)) {
  throw 'Terminal quarantine ordering guard changed.'
}

function Assert-QuarantineSequenceFailure {
  param(
    [Parameter(Mandatory)][string]$Failure,
    [Parameter(Mandatory)][Action]$DisableAccount,
    [Parameter(Mandatory)][Func[int]]$CleanupScheduledTasks,
    [Parameter(Mandatory)][Func[int]]$CleanupBitsJobs,
    [Parameter(Mandatory)][Func[int]]$DrainProcesses,
    [int]$MaximumRounds = 4
  )

  $steps = [Collections.Generic.List[string]]::new()
  $cleanupScheduledTasksProbe = $CleanupScheduledTasks
  $cleanupBitsJobsProbe = $CleanupBitsJobs
  $drainProcessesProbe = $DrainProcesses
  $failed = $false
  try {
    Invoke-QuarantineSequenceProbe `
      -Steps $steps `
      -DisableAccount $DisableAccount `
      -CleanupScheduledTasks ([Func[int]]{
        $steps.Add('scheduler')
        return $cleanupScheduledTasksProbe.Invoke()
      }) `
      -CleanupBitsJobs ([Func[int]]{
        $steps.Add('bits')
        return $cleanupBitsJobsProbe.Invoke()
      }) `
      -DrainProcesses ([Func[int]]{
        $steps.Add('processes')
        return $drainProcessesProbe.Invoke()
      }) `
      -MaximumRounds $MaximumRounds
  } catch {
    $failed = $true
  }
  if (
    -not $failed -or
    -not $steps.Contains('scheduler') -or
    -not $steps.Contains('bits') -or
    -not $steps.Contains('processes') -or
    -not $steps.Contains('final-proof')
  ) {
    throw $Failure
  }
}

Assert-QuarantineSequenceFailure `
  -Failure 'Account-disable verification failure did not fail closed.' `
  -DisableAccount ([Action]{ throw 'account disable verification failed' }) `
  -CleanupScheduledTasks ([Func[int]]{ 0 }) `
  -CleanupBitsJobs ([Func[int]]{ 0 }) `
  -DrainProcesses ([Func[int]]{ 0 })
Assert-QuarantineSequenceFailure `
  -Failure 'Task Scheduler enumeration failure did not fail closed.' `
  -DisableAccount ([Action]{}) `
  -CleanupScheduledTasks ([Func[int]]{ throw 'scheduler enumeration failed' }) `
  -CleanupBitsJobs ([Func[int]]{ 0 }) `
  -DrainProcesses ([Func[int]]{ 0 })
Assert-QuarantineSequenceFailure `
  -Failure 'BITS enumeration failure did not fail closed.' `
  -DisableAccount ([Action]{}) `
  -CleanupScheduledTasks ([Func[int]]{ 0 }) `
  -CleanupBitsJobs ([Func[int]]{ throw 'BITS enumeration failed' }) `
  -DrainProcesses ([Func[int]]{ 0 })
foreach ($processFailure in @(
  'WTS process enumeration failure did not fail closed.',
  'Matching process access failure did not fail closed.',
  'Matching process termination failure did not fail closed.'
)) {
  Assert-QuarantineSequenceFailure `
    -Failure $processFailure `
    -DisableAccount ([Action]{}) `
    -CleanupScheduledTasks ([Func[int]]{ 0 }) `
    -CleanupBitsJobs ([Func[int]]{ 0 }) `
    -DrainProcesses ([Func[int]]{ throw $processFailure })
}
Assert-QuarantineSequenceFailure `
  -Failure 'Unstable SID-wide process drain did not fail closed.' `
  -DisableAccount ([Action]{}) `
  -CleanupScheduledTasks ([Func[int]]{ 0 }) `
  -CleanupBitsJobs ([Func[int]]{ 0 }) `
  -DrainProcesses ([Func[int]]{ 1 }) `
  -MaximumRounds 3

$artifactSequence = [OpenCoven.WindowsJobSupervisor].GetMethod(
  'ExecuteArtifactSecuritySequence',
  [Reflection.BindingFlags]'NonPublic,Static'
)
if ($null -eq $artifactSequence) {
  throw 'The fail-closed artifact security sequence is missing.'
}
$artifactSteps = [Collections.Generic.List[string]]::new()
$artifactSequence.Invoke(
  $null,
  [object[]]@(
    [Action]{ $artifactSteps.Add('quarantine-proof') },
    [Action]{ $artifactSteps.Add('seal') },
    [Action]{ $artifactSteps.Add('post-seal') },
    [Action]{ $artifactSteps.Add('capture') }
  )
)
$expectedArtifactOrder = @(
  'quarantine-proof',
  'seal',
  'post-seal',
  'capture',
  'post-seal'
)
if (
  [string]::Join(',', $artifactSteps) -cne
    [string]::Join(',', $expectedArtifactOrder)
) {
  throw 'Artifact security ordering guard changed.'
}
$artifactFailureSteps = [Collections.Generic.List[string]]::new()
try {
  $artifactSequence.Invoke(
    $null,
    [object[]]@(
      [Action]{ $artifactFailureSteps.Add('quarantine-proof') },
      [Action]{
        $artifactFailureSteps.Add('seal')
        throw 'ACL sealing failed'
      },
      [Action]{ $artifactFailureSteps.Add('post-seal') },
      [Action]{ $artifactFailureSteps.Add('capture') }
    )
  )
} catch {
}
if (
  [string]::Join(',', $artifactFailureSteps) -cne 'quarantine-proof,seal'
) {
  throw 'Artifact ACL sealing failure did not fail closed.'
}

$aggregateSteps = [Collections.Generic.List[string]]::new()
$aggregateFailed = $false
try {
  Invoke-QuarantineSequenceProbe `
    -Steps $aggregateSteps `
    -TerminateAndReap ([Action]{
      $aggregateSteps.Add('terminate-failed')
      throw 'terminate failed'
    }) `
    -RequireJobZero ([Action]{
      $aggregateSteps.Add('job-zero-failed')
      throw 'job zero failed'
    }) `
    -DisableAccount ([Action]{
      $aggregateSteps.Add('disable-failed')
      throw 'disable failed'
    }) `
    -CleanupScheduledTasks ([Func[int]]{
      $aggregateSteps.Add('scheduler-failed')
      throw 'scheduler failed'
    }) `
    -CleanupBitsJobs ([Func[int]]{
      $aggregateSteps.Add('bits-failed')
      throw 'bits failed'
    }) `
    -DrainProcesses ([Func[int]]{
      $aggregateSteps.Add('processes-failed')
      throw 'processes failed'
    }) `
    -RequireFinalIsolation ([Action]{
      $aggregateSteps.Add('final-proof-failed')
      throw 'final proof failed'
    })
} catch {
  $aggregateFailed = $_.Exception.ToString().Contains('AggregateException')
}
if (
  -not $aggregateFailed -or
  -not $aggregateSteps.Contains('terminate-failed') -or
  -not $aggregateSteps.Contains('job-zero-failed') -or
  -not $aggregateSteps.Contains('disable-failed') -or
  -not $aggregateSteps.Contains('scheduler-failed') -or
  -not $aggregateSteps.Contains('bits-failed') -or
  -not $aggregateSteps.Contains('processes-failed') -or
  -not $aggregateSteps.Contains('final-proof-failed')
) {
  throw 'Terminal quarantine cleanup failures were swallowed or short-circuited.'
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

function Assert-BoundedTextMarker {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Expected
  )

  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  do {
    try {
      if ([IO.File]::Exists($Path)) {
        if ([IO.File]::ReadAllText($Path).Trim() -cne $Expected) {
          throw 'Readiness marker content was invalid.'
        }
        return
      }
    } catch [IO.IOException] {
    }
    Start-Sleep -Milliseconds 20
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Readiness marker could not be read within its bound.'
}

function Assert-ScheduledTaskAbsent {
  param(
    [Parameter(Mandatory)][string]$TaskPath,
    [Parameter(Mandatory)][string]$Failure
  )

  & (Join-Path $env:SystemRoot 'System32\schtasks.exe') `
    /Query `
    /TN $TaskPath *>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) {
    throw "$Failure registration survived."
  }
  $service = New-Object -ComObject 'Schedule.Service'
  $service.Connect()
  $runningTasks = $service.GetRunningTasks(1)
  for ($index = 1; $index -le $runningTasks.Count; $index++) {
    if ($runningTasks.Item($index).Path -ceq $TaskPath) {
      throw "$Failure running instance survived."
    }
  }
}

$scheduledActionIsolationProbeSource = @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading.Tasks;

public static class ScheduledActionIsolationProbe
{
    private const uint JOB_OBJECT_QUERY = 0x0004;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const uint TOKEN_QUERY = 0x0008;
    private const uint STILL_ACTIVE = 259;
    private const uint WTS_ANY_SESSION = 0xffffffff;
    private const int TokenUser = 1;
    private const int WTSTypeProcessInfoLevel1 = 1;
    private const int MaximumBitsClientOutputCharacters = 65536;

    public static void AssertAliveOutsideJobWithPrimaryTokenSid(
        string label,
        string jobName,
        uint processId,
        string expectedSid)
    {
        if (String.IsNullOrWhiteSpace(label) ||
            String.IsNullOrWhiteSpace(jobName) ||
            processId == 0 ||
            String.IsNullOrWhiteSpace(expectedSid))
        {
            throw new ArgumentException(
                "Scheduled action isolation probe input was invalid.");
        }

        IntPtr job = OpenJobObjectW(JOB_OBJECT_QUERY, false, jobName);
        if (job == IntPtr.Zero)
        {
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                label + " could not open the supervised Job Object.");
        }
        try
        {
            AssertAliveOutsideJobWithPrimaryTokenSid(
                label,
                job,
                processId,
                expectedSid);
        }
        finally
        {
            CloseHandle(job);
        }
    }

    public static void AssertAliveOutsideAuthoritativeJobWithPrimaryTokenSid(
        string label,
        long authoritativeJobHandle,
        uint processId,
        string expectedSid)
    {
        if (String.IsNullOrWhiteSpace(label) ||
            authoritativeJobHandle == 0 ||
            processId == 0 ||
            String.IsNullOrWhiteSpace(expectedSid))
        {
            throw new ArgumentException(
                "Authoritative Job isolation probe input was invalid.");
        }
        AssertAliveOutsideJobWithPrimaryTokenSid(
            label,
            new IntPtr(authoritativeJobHandle),
            processId,
            expectedSid);
    }

    public static void CreateBitsJob(
        string bitsAdminPath,
        string displayName)
    {
        if (String.IsNullOrWhiteSpace(bitsAdminPath) ||
            !Path.IsPathRooted(bitsAdminPath) ||
            !File.Exists(bitsAdminPath) ||
            String.IsNullOrWhiteSpace(displayName) ||
            displayName.Length > 128)
        {
            throw new ArgumentException(
                "BITS client invocation input was invalid.");
        }

        ProcessStartInfo startInfo = new ProcessStartInfo();
        startInfo.FileName = bitsAdminPath;
        startInfo.WorkingDirectory =
            Path.GetDirectoryName(bitsAdminPath);
        startInfo.UseShellExecute = false;
        startInfo.CreateNoWindow = true;
        startInfo.RedirectStandardOutput = true;
        startInfo.RedirectStandardError = true;
        startInfo.ArgumentList.Add("/create");
        startInfo.ArgumentList.Add(displayName);

        using (Process process = new Process())
        {
            process.StartInfo = startInfo;
            if (!process.Start())
            {
                throw new InvalidOperationException(
                    "BITS client process did not start.");
            }
            Task stdoutTask =
                DrainBoundedOutputAsync(process.StandardOutput);
            Task stderrTask =
                DrainBoundedOutputAsync(process.StandardError);
            if (!process.WaitForExit(10000))
            {
                process.Kill(true);
                if (!process.WaitForExit(5000))
                {
                    throw new TimeoutException(
                        "BITS client process could not be reaped.");
                }
                throw new TimeoutException(
                    "BITS client process exceeded its timeout.");
            }
            if (!Task.WaitAll(
                    new Task[] { stdoutTask, stderrTask },
                    5000))
            {
                throw new TimeoutException(
                    "BITS client output could not be drained.");
            }
            if (process.ExitCode != 0)
            {
                throw new InvalidOperationException(
                    "BITS client returned a nonzero exit code.");
            }
        }
    }

    private static Task DrainBoundedOutputAsync(StreamReader reader)
    {
        return Task.Run(delegate
        {
            char[] buffer = new char[4096];
            int total = 0;
            while (true)
            {
                int read = reader.Read(buffer, 0, buffer.Length);
                if (read == 0)
                {
                    return;
                }
                total = checked(total + read);
                if (total > MaximumBitsClientOutputCharacters)
                {
                    throw new InvalidOperationException(
                        "BITS client output exceeded its bound.");
                }
            }
        });
    }

    private static void AssertAliveOutsideJobWithPrimaryTokenSid(
        string label,
        IntPtr job,
        uint processId,
        string expectedSid)
    {
        IntPtr process = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION,
            false,
            processId);
        if (process == IntPtr.Zero)
        {
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                label + " could not open its process.");
        }
        try
        {
            RequireAlive(process, label);
            bool member;
            if (!IsProcessInJob(process, job, out member))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    label + " Job Object membership could not be queried.");
            }
            if (member)
            {
                throw new InvalidOperationException(
                    label + " was inside the supervised Job Object.");
            }
            string actualSid = QueryPrimaryTokenSid(process, label);
            if (!String.Equals(
                    actualSid,
                    expectedSid,
                    StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    label + " primary token SID was not the isolated SID.");
            }
            RequireAlive(process, label);
        }
        finally
        {
            CloseHandle(process);
        }
    }

    public static int CountProcessesByPrimaryTokenSid(string expectedSid)
    {
        if (String.IsNullOrWhiteSpace(expectedSid))
        {
            throw new ArgumentException(
                "Expected process SID was empty.",
                "expectedSid");
        }
        uint level = 1;
        IntPtr buffer;
        uint count;
        if (!WTSEnumerateProcessesExW(
                IntPtr.Zero,
                ref level,
                WTS_ANY_SESSION,
                out buffer,
                out count))
        {
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                "Exact-SID process enumeration failed.");
        }
        try
        {
            if (level != 1 || (count != 0 && buffer == IntPtr.Zero))
            {
                throw new InvalidOperationException(
                    "Exact-SID process enumeration was ambiguous.");
            }
            int matches = 0;
            int size = Marshal.SizeOf(typeof(WTS_PROCESS_INFO_EXW));
            for (uint index = 0; index < count; index++)
            {
                IntPtr entry = new IntPtr(
                    buffer.ToInt64() + checked((long)index * size));
                WTS_PROCESS_INFO_EXW information =
                    (WTS_PROCESS_INFO_EXW)Marshal.PtrToStructure(
                        entry,
                        typeof(WTS_PROCESS_INFO_EXW));
                if (information.pUserSid == IntPtr.Zero)
                {
                    if (information.ProcessId == 0)
                    {
                        continue;
                    }
                    throw new InvalidOperationException(
                        "Exact-SID process entry had no primary token SID.");
                }
                string actualSid =
                    new SecurityIdentifier(information.pUserSid).Value;
                if (String.Equals(
                        actualSid,
                        expectedSid,
                        StringComparison.Ordinal))
                {
                    matches++;
                }
            }
            return matches;
        }
        finally
        {
            if (buffer != IntPtr.Zero &&
                !WTSFreeMemoryExW(
                    WTSTypeProcessInfoLevel1,
                    buffer,
                    count))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Exact-SID process enumeration buffer could not be released.");
            }
        }
    }

    private static void RequireAlive(IntPtr process, string label)
    {
        uint exitCode;
        if (!GetExitCodeProcess(process, out exitCode))
        {
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                label + " liveness could not be queried.");
        }
        if (exitCode != STILL_ACTIVE)
        {
            throw new InvalidOperationException(
                label + " was not demonstrably alive.");
        }
    }

    private static string QueryPrimaryTokenSid(
        IntPtr process,
        string label)
    {
        IntPtr token;
        if (!OpenProcessToken(process, TOKEN_QUERY, out token))
        {
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                label + " primary token could not be opened.");
        }
        try
        {
            uint length = 0;
            GetTokenInformation(
                token,
                TokenUser,
                IntPtr.Zero,
                0,
                out length);
            if (length == 0 || Marshal.GetLastWin32Error() != 122)
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    label + " primary token SID length could not be queried.");
            }
            IntPtr buffer = Marshal.AllocHGlobal(checked((int)length));
            try
            {
                if (!GetTokenInformation(
                        token,
                        TokenUser,
                        buffer,
                        length,
                        out length))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        label + " primary token SID could not be queried.");
                }
                TOKEN_USER user = (TOKEN_USER)Marshal.PtrToStructure(
                    buffer,
                    typeof(TOKEN_USER));
                if (user.User.Sid == IntPtr.Zero)
                {
                    throw new InvalidOperationException(
                        label + " primary token SID was ambiguous.");
                }
                return new SecurityIdentifier(user.User.Sid).Value;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
        finally
        {
            CloseHandle(token);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SID_AND_ATTRIBUTES
    {
        internal IntPtr Sid;
        internal uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TOKEN_USER
    {
        internal SID_AND_ATTRIBUTES User;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WTS_PROCESS_INFO_EXW
    {
        internal uint SessionId;
        internal uint ProcessId;
        internal IntPtr pProcessName;
        internal IntPtr pUserSid;
        internal uint NumberOfThreads;
        internal uint HandleCount;
        internal uint PagefileUsage;
        internal uint PeakPagefileUsage;
        internal uint WorkingSetSize;
        internal uint PeakWorkingSetSize;
        internal long UserTime;
        internal long KernelTime;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenJobObjectW(
        uint desiredAccess,
        bool inherit,
        string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(
        uint desiredAccess,
        bool inherit,
        uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJob(
        IntPtr process,
        IntPtr job,
        out bool member);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(
        IntPtr process,
        out uint exitCode);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(
        IntPtr process,
        uint desiredAccess,
        out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenInformation(
        IntPtr token,
        int tokenInformationClass,
        IntPtr tokenInformation,
        uint tokenInformationLength,
        out uint returnLength);

    [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WTSEnumerateProcessesExW(
        IntPtr server,
        ref uint level,
        uint sessionId,
        out IntPtr processInfo,
        out uint count);

    [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WTSFreeMemoryExW(
        int typeClass,
        IntPtr memory,
        uint count);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
}
'@
Add-Type -TypeDefinition $scheduledActionIsolationProbeSource -Language CSharp

function Resolve-ExactAccountSid {
  param([Parameter(Mandatory)][string]$Account)

  if ($Account.StartsWith('S-1-', [StringComparison]::Ordinal)) {
    return ([Security.Principal.SecurityIdentifier]::new($Account)).Value
  }
  return (
    [Security.Principal.NTAccount]::new($Account).Translate(
      [Security.Principal.SecurityIdentifier]
    )
  ).Value
}

function Get-ExactSidScheduledTaskCount {
  param([Parameter(Mandatory)][string]$Sid)

  $service = New-Object -ComObject 'Schedule.Service'
  $service.Connect()
  $pending = [Collections.Generic.Stack[object]]::new()
  $pending.Push($service.GetFolder('\'))
  $matches = 0
  while ($pending.Count -ne 0) {
    $folder = $pending.Pop()
    $tasks = $folder.GetTasks(1)
    for ($index = 1; $index -le $tasks.Count; $index++) {
      $principal = $tasks.Item($index).Definition.Principal
      foreach ($account in @(
        [string]$principal.UserId,
        [string]$principal.GroupId
      )) {
        if ([string]::IsNullOrWhiteSpace($account)) {
          continue
        }
        try {
          $ownerSid = Resolve-ExactAccountSid -Account $account
        } catch {
          continue
        }
        if ($ownerSid -ceq $Sid) {
          $matches++
          break
        }
      }
    }
    $folders = $folder.GetFolders(0)
    for ($index = 1; $index -le $folders.Count; $index++) {
      $pending.Push($folders.Item($index))
    }
  }
  return $matches
}

function Get-ExactSidBitsJobCount {
  param([Parameter(Mandatory)][string]$Sid)

  Import-Module BitsTransfer -ErrorAction Stop
  $matches = 0
  foreach ($job in @(Get-BitsTransfer -AllUsers -ErrorAction Stop)) {
    $owner = [string]$job.OwnerAccount
    if ([string]::IsNullOrWhiteSpace($owner)) {
      continue
    }
    try {
      $ownerSid = Resolve-ExactAccountSid -Account $owner
    } catch {
      continue
    }
    if ($ownerSid -ceq $Sid) {
      $matches++
    }
  }
  return $matches
}

function Assert-NoExactSidPersistence {
  param([Parameter(Mandatory)][string]$Sid)

  $processes =
    [ScheduledActionIsolationProbe]::CountProcessesByPrimaryTokenSid($Sid)
  $tasks = Get-ExactSidScheduledTaskCount -Sid $Sid
  $bitsJobs = Get-ExactSidBitsJobCount -Sid $Sid
  if ($processes -ne 0 -or $tasks -ne 0 -or $bitsJobs -ne 0) {
    throw 'Terminal failure left an exact-SID process, task, or BITS job.'
  }
}

$trustedPwsh = (Get-Process -Id $PID).Path
$root = Join-Path ([IO.Path]::GetTempPath()) "opencoven-job-runtime-$PID-$([Guid]::NewGuid().ToString('N'))"
$isolatedUser = [OpenCoven.WindowsIsolatedUser]::Create($root)
if (
  [string]::IsNullOrWhiteSpace($isolatedUser.ValidationSummary) -or
  $isolatedUser.ValidationSummary -notmatch
    '^legacyPriv=[0-9]+;flags=0x[0-9a-f]{8};groups=S-1-5-32-545;elevated=false;elevationType=1;integrity=0x00002000;tokenPrivileges=(?:none|[A-Za-z0-9,]+);dangerousPrivileges=none$'
) {
  throw 'Hosted Windows isolated account validation summary was not exact.'
}
Write-Host "Windows isolated account validation: $($isolatedUser.ValidationSummary)"
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
  OPENCOVEN_WINDOWS_SYSTEM_PWSH = $trustedPwsh
  OPENCOVEN_WINDOWS_JOB_SUPERVISOR_SOURCE = $sourcePath
}

function New-IsolatedTestContext {
  param([Parameter(Mandatory)][string]$Label)

  $contextRoot = Join-Path (
    [IO.Path]::GetTempPath()
  ) "opencoven-$Label-$PID-$([Guid]::NewGuid().ToString('N'))"
  $contextUser = [OpenCoven.WindowsIsolatedUser]::Create($contextRoot)
  $contextEnvironment = $childEnvironment.Clone()
  $contextEnvironment.HOME = $contextUser.ProfilePath
  $contextEnvironment.USERPROFILE = $contextUser.ProfilePath
  $contextEnvironment.APPDATA = Join-Path $contextUser.ProfilePath 'AppData\Roaming'
  $contextEnvironment.LOCALAPPDATA = Join-Path $contextUser.ProfilePath 'AppData\Local'
  $contextEnvironment.TEMP = $contextUser.TempPath
  $contextEnvironment.TMP = $contextUser.TempPath
  $contextEnvironment.GITHUB_WORKSPACE = $contextUser.WorkspacePath
  $contextEnvironment.OPENCOVEN_WINDOWS_BOOTSTRAP_ROOT = $contextUser.RootPath
  return [pscustomobject]@{
    User = $contextUser
    Environment = $contextEnvironment
  }
}

function Remove-IsolatedTestContext {
  param([Parameter(Mandatory)]$Context)

  if ($null -ne $Context.User) {
    $Context.User.Dispose()
  }
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

public static class ScmDenialProbe
{
    private const uint SC_MANAGER_CONNECT = 0x0001;
    private const uint SC_MANAGER_CREATE_SERVICE = 0x0002;
    private const uint SERVICE_QUERY_STATUS = 0x0004;
    private const uint DELETE = 0x00010000;
    private const uint SERVICE_WIN32_OWN_PROCESS = 0x00000010;
    private const uint SERVICE_DEMAND_START = 0x00000003;
    private const uint SERVICE_ERROR_NORMAL = 0x00000001;
    private const int ERROR_ACCESS_DENIED = 5;
    private const int ERROR_SERVICE_DOES_NOT_EXIST = 1060;

    public static void Run(string serviceName, string binaryPath)
    {
        IntPtr createManager = OpenSCManagerW(
            null,
            null,
            SC_MANAGER_CREATE_SERVICE);
        if (createManager != IntPtr.Zero)
        {
            CloseServiceHandle(createManager);
            throw new InvalidOperationException(
                "SC_MANAGER_CREATE_SERVICE unexpectedly succeeded.");
        }
        int managerError = Marshal.GetLastWin32Error();
        if (managerError != ERROR_ACCESS_DENIED)
        {
            throw new Win32Exception(
                managerError,
                "SC_MANAGER_CREATE_SERVICE was not denied with ERROR_ACCESS_DENIED.");
        }

        IntPtr manager = OpenSCManagerW(null, null, SC_MANAGER_CONNECT);
        if (manager == IntPtr.Zero)
        {
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                "SC_MANAGER_CONNECT could not be opened for the denial probe.");
        }
        try
        {
            IntPtr service = CreateServiceW(
                manager,
                serviceName,
                serviceName,
                SERVICE_QUERY_STATUS | DELETE,
                SERVICE_WIN32_OWN_PROCESS,
                SERVICE_DEMAND_START,
                SERVICE_ERROR_NORMAL,
                binaryPath,
                null,
                IntPtr.Zero,
                null,
                null,
                null);
            bool unexpectedlyCreated = service != IntPtr.Zero;
            int createError = unexpectedlyCreated
                ? 0
                : Marshal.GetLastWin32Error();
            if (unexpectedlyCreated)
            {
                try
                {
                    DeleteService(service);
                }
                finally
                {
                    CloseServiceHandle(service);
                }
            }

            IntPtr remaining = OpenServiceW(
                manager,
                serviceName,
                SERVICE_QUERY_STATUS);
            if (remaining != IntPtr.Zero)
            {
                CloseServiceHandle(remaining);
                throw new InvalidOperationException(
                    "Denied native service creation left a registered service.");
            }
            int absenceError = Marshal.GetLastWin32Error();
            if (absenceError != ERROR_SERVICE_DOES_NOT_EXIST)
            {
                throw new Win32Exception(
                    absenceError,
                    "Native service absence could not be proved.");
            }
            if (unexpectedlyCreated)
            {
                throw new InvalidOperationException(
                    "Service creation unexpectedly succeeded for the restricted identity.");
            }
            if (createError != ERROR_ACCESS_DENIED)
            {
                throw new Win32Exception(
                    createError,
                    "CreateServiceW was not denied with ERROR_ACCESS_DENIED.");
            }
        }
        finally
        {
            CloseServiceHandle(manager);
        }
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenSCManagerW(
        string machineName,
        string databaseName,
        uint desiredAccess);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateServiceW(
        IntPtr manager,
        string serviceName,
        string displayName,
        uint desiredAccess,
        uint serviceType,
        uint startType,
        uint errorControl,
        string binaryPathName,
        string loadOrderGroup,
        IntPtr tagId,
        string dependencies,
        string serviceStartName,
        string password);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenServiceW(
        IntPtr manager,
        string serviceName,
        uint desiredAccess);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeleteService(IntPtr service);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseServiceHandle(IntPtr handle);
}
'@,
    [Text.UTF8Encoding]::new($false)
  )
  $accessProbeScript = Join-Path $root 'job-access-probe.ps1'
  [IO.File]::WriteAllText(
    $accessProbeScript,
    @"
`$ErrorActionPreference = 'Stop'
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
`$serviceName = `$env:OPENCOVEN_DENIAL_SERVICE_NAME
[ScmDenialProbe]::Run(
  `$serviceName,
  "`$env:COMSPEC /d /c exit 0"
)

`$filterName = `$env:OPENCOVEN_DENIAL_WMI_FILTER_NAME
`$wmiDenied = `$false
`$createdFilter = `$null
try {
  `$createdFilter = New-CimInstance -Namespace 'root/subscription' -ClassName '__EventFilter' -Property @{
      Name = `$filterName
      EventNamespace = 'root/cimv2'
      QueryLanguage = 'WQL'
      Query = 'SELECT * FROM Win32_ProcessStartTrace'
    }
} catch {
  `$cimDenied = `$false
  `$candidateError = `$_.Exception
  for (`$depth = 0; `$depth -lt 8 -and `$null -ne `$candidateError; `$depth++) {
    if (
      `$candidateError -is [Microsoft.Management.Infrastructure.CimException] -and
      `$candidateError.StatusCode.ToString() -ceq 'AccessDenied'
    ) {
      `$cimDenied = `$true
      break
    }
    `$candidateError = `$candidateError.InnerException
  }
  if (
    `$_.CategoryInfo.Category -eq
      [Management.Automation.ErrorCategory]::PermissionDenied -or
    `$_.Exception -is [UnauthorizedAccessException] -or
    `$_.Exception.InnerException -is [UnauthorizedAccessException] -or
    `$cimDenied -or
    `$_.FullyQualifiedErrorId -ceq
      'HRESULT 0x80041003,Microsoft.Management.Infrastructure.CimCmdlets.NewCimInstanceCommand'
  ) {
    `$wmiDenied = `$true
  } else {
    throw
  }
}
if (`$null -ne `$createdFilter) {
  `$createdFilter | Remove-CimInstance
  throw 'Permanent WMI subscription creation unexpectedly succeeded.'
}
if (-not `$wmiDenied) {
  throw 'Permanent WMI subscription denial was ambiguous.'
}
"@,
    [Text.UTF8Encoding]::new($false)
  )
  $accessJobName =
    "Local\OpenCoven.Chat.SupervisorTest.$([Guid]::NewGuid().ToString('N'))"
  $accessEnvironment = $childEnvironment.Clone()
  $accessEnvironment.OPENCOVEN_ACCESS_PROBE_JOB = $accessJobName
  $accessEnvironment.OPENCOVEN_DENIAL_SERVICE_NAME =
    "OpenCovenSupervisorTest$([Guid]::NewGuid().ToString('N'))"
  $accessEnvironment.OPENCOVEN_DENIAL_WMI_FILTER_NAME =
    "OpenCovenSupervisorTest$([Guid]::NewGuid().ToString('N'))"
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

    $context = New-IsolatedTestContext -Label "live-root-$Label"
    $caseRoot = Join-Path (
      $context.User.WorkspacePath
    ) "live-root-$Label-$([Guid]::NewGuid().ToString('N'))"
    $recordPath = Join-Path $caseRoot '.artifacts\record.json'
    $completePath = Join-Path $caseRoot 'attack-complete.txt'
    $contextAttackSource = Join-Path $context.User.RootPath 'root-process-attack.cs'
    $contextAttackScript = Join-Path $context.User.RootPath 'root-process-attack.ps1'
    $contextLiveRootScript = Join-Path $context.User.RootPath 'live-root.ps1'
    [IO.File]::Copy($rootProcessAttackSource, $contextAttackSource)
    [IO.File]::Copy($rootProcessAttackScript, $contextAttackScript)
    [IO.File]::Copy($liveRootScript, $contextLiveRootScript)
    $environment = $context.Environment.Clone()
    $environment.OPENCOVEN_ROOT_PROCESS_ATTACK_SOURCE = $contextAttackSource
    $environment.OPENCOVEN_ROOT_PROCESS_ATTACK_SCRIPT = $contextAttackScript
    $environment.OPENCOVEN_ROOT_ARTIFACT_PATH = $recordPath
    $environment.OPENCOVEN_ROOT_ARTIFACT_ATTACK = $Attack
    $environment.OPENCOVEN_ROOT_TRUSTED_TEXT = $liveRootTrustedText
    $environment.OPENCOVEN_ROOT_FORGED_TEXT = $liveRootForgedText
    $environment.OPENCOVEN_ROOT_ATTACK_COMPLETE = $completePath
    $environment.OPENCOVEN_ROOT_ATTACK_STDOUT = Join-Path $caseRoot 'attack.stdout'
    $environment.OPENCOVEN_ROOT_ATTACK_STDERR = Join-Path $caseRoot 'attack.stderr'
    $job = [OpenCoven.WindowsJobSupervisor]::Create(
      "Local\OpenCoven.Chat.SupervisorTest.$([Guid]::NewGuid().ToString('N'))",
      $context.User
    )
    try {
      try {
        $result = $job.RunProducerAsUserAndQuarantine(
          $context.User,
          $trustedPwsh,
          "-NoLogo -NoProfile -NonInteractive -File `"$contextLiveRootScript`"",
          $context.User.RootPath,
          $environment,
          [TimeSpan]::FromSeconds(30),
          1MB,
          1MB
        )
      } catch {
        throw "Live root '$Label' terminal quarantine failed: $($_.Exception.ToString())"
      }
      if ($result.ExitCode -ne 0) {
        throw "Protected root process did not execute normally: $($result.Stderr)"
      }
      $artifact = $job.CaptureIsolatedArtifact(
        $context.User,
        $context.User.WorkspacePath,
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
      Remove-IsolatedTestContext -Context $context
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

  $freshValidationEnvironment = $childEnvironment.Clone()
  $freshValidationEnvironment.OPENCOVEN_EXPECTED_RECORD_SHA256 =
    $expectedHandoffDigest
  $freshValidationJob = [OpenCoven.WindowsJobSupervisor]::Create(
    "Local\OpenCoven.Chat.SupervisorTest.$([Guid]::NewGuid().ToString('N'))",
    $isolatedUser
  )
  try {
    $freshValidationResult = $freshValidationJob.RunAsUserWithStandardInput(
      $isolatedUser,
      $trustedPwsh,
      "-NoLogo -NoProfile -NonInteractive -File `"$handoffValidatorScript`"",
      $isolatedUser.RootPath,
      $freshValidationEnvironment,
      [TimeSpan]::FromSeconds(30),
      1MB,
      1MB,
      $expectedHandoffBytes
    )
    if (
      $freshValidationResult.ExitCode -ne 0 -or
      $freshValidationResult.Stdout.Length -ne 0 -or
      $freshValidationResult.Stderr.Length -ne 0
    ) {
      throw 'Fresh unprivileged handle-captured record validation failed.'
    }
  } finally {
    $freshValidationJob.Dispose()
  }

  function Invoke-HandoffProducer {
    param(
      [Parameter(Mandatory)][string]$Label,
      [Parameter(Mandatory)][string]$Attack
    )

    $context = New-IsolatedTestContext -Label "handoff-$Label"
    $caseRoot = Join-Path (
      $context.User.WorkspacePath
    ) "handoff-$Label-$([Guid]::NewGuid().ToString('N'))"
    $recordPath = Join-Path $caseRoot '.artifacts\record.json'
    $contextAttackSource = Join-Path $context.User.RootPath 'artifact-handoff-attack.cs'
    $contextReplacementScript =
      Join-Path $context.User.RootPath 'artifact-handoff-replacement.ps1'
    $scriptPath = Join-Path $context.User.RootPath "handoff-$Label.ps1"
    [IO.File]::Copy($handoffAttackSource, $contextAttackSource)
    [IO.File]::Copy($handoffReplacementScript, $contextReplacementScript)
    [IO.File]::WriteAllText(
      $scriptPath,
      $handoffProducerTemplate,
      [Text.UTF8Encoding]::new($false)
    )
    $environment = $context.Environment.Clone()
    $environment.OPENCOVEN_HANDOFF_ATTACK = $Attack
    $environment.OPENCOVEN_HANDOFF_ATTACK_SOURCE = $contextAttackSource
    $environment.OPENCOVEN_HANDOFF_CANARY = $handoffCanary
    $environment.OPENCOVEN_HANDOFF_RECORD = $recordPath
    $environment.OPENCOVEN_HANDOFF_REPLACEMENT_SCRIPT = $contextReplacementScript
    $job = [OpenCoven.WindowsJobSupervisor]::Create(
      "Local\OpenCoven.Chat.SupervisorTest.$([Guid]::NewGuid().ToString('N'))",
      $context.User
    )
    try {
      $result = $job.RunProducerAsUserAndQuarantine(
        $context.User,
        $trustedPwsh,
        "-NoLogo -NoProfile -NonInteractive -File `"$scriptPath`"",
        $context.User.RootPath,
        $environment,
        [TimeSpan]::FromSeconds(30),
        1MB,
        1MB
      )
      if ($result.ExitCode -ne 0) {
        throw "Artifact handoff producer '$Label' failed: $($result.Stderr)"
      }
      return [pscustomobject]@{
        Context = $context
        Job = $job
        RecordPath = $recordPath
        AttackSource = $contextAttackSource
      }
    } catch {
      $job.Dispose()
      Remove-IsolatedTestContext -Context $context
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
        $Case.Context.User,
        $Case.Context.User.WorkspacePath,
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
      Remove-IsolatedTestContext -Context $Case.Context
    }
    if (-not $rejected) {
      throw $Failure
    }
  }

  $successCase = Invoke-HandoffProducer -Label 'success' -Attack 'none'
  try {
    $validatedArtifact = $successCase.Job.CaptureIsolatedArtifact(
      $successCase.Context.User,
      $successCase.Context.User.WorkspacePath,
      $successCase.RecordPath,
      1MB
    )
    if (
      $validatedArtifact.Size -ne $expectedHandoffBytes.Length -or
      $validatedArtifact.Sha256 -cne $expectedHandoffDigest
    ) {
      throw 'Valid artifact handoff changed captured bytes.'
    }
    [OpenCoven.WindowsJobSupervisor]::RequireCanonicalSchemaV2Artifact(
      $validatedArtifact.Bytes,
      $validatedArtifact.Sha256,
      'win32-x64'
    )
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
    Remove-IsolatedTestContext -Context $successCase.Context
  }

  Assert-HandoffRejected `
    -Case (Invoke-HandoffProducer -Label 'symlink' -Attack 'symlink') `
    -Failure 'Symlink replacement artifact handoff unexpectedly succeeded.'
  Assert-HandoffRejected `
    -Case (Invoke-HandoffProducer -Label 'hardlink' -Attack 'hardlink') `
    -Failure 'Hardlink artifact handoff unexpectedly succeeded.'
  $junctionCase = Invoke-HandoffProducer -Label 'junction' -Attack 'none'
  try {
    $junctionParent =
      [IO.Directory]::GetParent($junctionCase.RecordPath).FullName
    $junctionTarget = "$junctionParent-real"
    [IO.Directory]::Move($junctionParent, $junctionTarget)
    & $env:COMSPEC /d /c "mklink /J `"$junctionParent`" `"$junctionTarget`""
    if ($LASTEXITCODE -ne 0) {
      throw 'Trusted parent junction fixture creation failed.'
    }
  } catch {
    $junctionCase.Job.Dispose()
    Remove-IsolatedTestContext -Context $junctionCase.Context
    throw
  }
  Assert-HandoffRejected `
    -Case $junctionCase `
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
        $raceCase.Context.User,
        $raceCase.Context.User.WorkspacePath,
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
    Remove-IsolatedTestContext -Context $raceCase.Context
  }

  $serviceEscapeContext = New-IsolatedTestContext -Label 'service-escape'
  $serviceEscapeJob = $null
  $lateRegistrarPid = 0
  try {
    $serviceEscapeNonce = [Guid]::NewGuid().ToString('N')
    $serviceEscapeJobName =
      "Local\OpenCoven.Chat.SupervisorTest.$serviceEscapeNonce"
    $taskFolderRoot =
      "OpenCoven-SchedulerEscape-$([Guid]::NewGuid().ToString('N'))"
    $taskFolderPath = "\$taskFolderRoot\Hidden\Nested"
    $lateTaskFolderPath = "\$taskFolderRoot\Hidden\Late"
    $principalOnlyNonce = [Guid]::NewGuid().ToString('N')
    $principalOnlyFolderRoot = "OpenCoven-PrincipalOnly-$principalOnlyNonce"
    $principalOnlyFolderPath =
      "\$principalOnlyFolderRoot\Neutral\Blocking"
    $principalOnlyTaskName = 'IdentityMatchOnly'
    $principalOnlyTaskPath =
      "$principalOnlyFolderPath\$principalOnlyTaskName"
    $preExistingSharedFolderRoot =
      "OpenCoven-Shared-$([Guid]::NewGuid().ToString('N'))"
    $preExistingSharedFolderPath = "\$preExistingSharedFolderRoot"
    $preExistingTaskFolderPath =
      "$preExistingSharedFolderPath\Existing"
    $runCreatedSharedChildPath =
      "$preExistingSharedFolderPath\CreatedDuringRun"
    $sharedChildTaskName = 'NewChildIdentityMatch'
    $preExistingFolderTaskName = 'ExistingFolderIdentityMatch'
    $sharedChildTaskPath =
      "$runCreatedSharedChildPath\$sharedChildTaskName"
    $preExistingFolderTaskPath =
      "$preExistingTaskFolderPath\$preExistingFolderTaskName"
    $serviceEscapeName = 'PrimaryEscape'
    $lateTaskName = 'LateEscape'
    $bitsName =
      "OpenCoven-BitsEscape-$([Guid]::NewGuid().ToString('N'))"
    $serviceEscapeUserName = $serviceEscapeContext.User.UserName
    $serviceEscapeProfilePath =
      $serviceEscapeContext.User.OperatingSystemProfilePath
    $serviceEscapeRootPath = $serviceEscapeContext.User.RootPath
    $serviceEscapeCaseRoot = Join-Path `
      $serviceEscapeContext.User.WorkspacePath `
      'service-escape'
    $serviceEscapeRecord = Join-Path `
      $serviceEscapeCaseRoot `
      '.artifacts\record.json'
    $serviceEscapeActionMarker = Join-Path `
      $serviceEscapeContext.User.TempPath `
      'task-action-started.txt'
    $serviceEscapeActionPid = Join-Path `
      $serviceEscapeContext.User.TempPath `
      'task-action-pid.txt'
    $serviceEscapeActionSid = Join-Path `
      $serviceEscapeContext.User.TempPath `
      'task-action-sid.txt'
    $serviceEscapeReady = Join-Path `
      $serviceEscapeContext.User.TempPath `
      'producer-observed-running-task.txt'
    $lateRegistrarReady = Join-Path `
      $serviceEscapeContext.User.TempPath `
      'late-registrar-ready.txt'
    $lateRegistrationMarker = Join-Path `
      $serviceEscapeContext.User.TempPath `
      'late-task-registered.txt'
    $lateActionMarker = Join-Path `
      $serviceEscapeContext.User.TempPath `
      'late-task-action-started.txt'
    $lateActionPid = Join-Path `
      $serviceEscapeContext.User.TempPath `
      'late-task-action-pid.txt'
    $lateActionSid = Join-Path `
      $serviceEscapeContext.User.TempPath `
      'late-task-action-sid.txt'
    $serviceEscapeTrustedText =
      '{' + "`n" +
        '  "platform": "win32-x64",' + "`n" +
        '  "schemaVersion": 2,' + "`n" +
        '  "serviceEscape": "blocked"' + "`n" +
      '}' + "`n"
    $serviceEscapeForgedText =
      '{' + "`n" +
        '  "platform": "win32-x64",' + "`n" +
        '  "schemaVersion": 2,' + "`n" +
        '  "serviceEscape": "rewritten"' + "`n" +
      '}' + "`n"
    $serviceEscapeTrustedBytes =
      [Text.UTF8Encoding]::new($false).GetBytes($serviceEscapeTrustedText)
    $serviceEscapeTrustedBase64 =
      [Convert]::ToBase64String($serviceEscapeTrustedBytes)
    $serviceEscapeForgedBase64 = [Convert]::ToBase64String(
      [Text.UTF8Encoding]::new($false).GetBytes($serviceEscapeForgedText)
    )
    $serviceEscapeTrustedDigest = [Convert]::ToHexString(
      [Security.Cryptography.SHA256]::HashData($serviceEscapeTrustedBytes)
    ).ToLowerInvariant()
    $serviceEscapeProbeSource = Join-Path `
      $serviceEscapeContext.User.RootPath `
      'scheduled-action-isolation-probe.cs'
    [IO.File]::WriteAllText(
      $serviceEscapeProbeSource,
      $scheduledActionIsolationProbeSource,
      [Text.UTF8Encoding]::new($false)
    )

    $taskActionScript = Join-Path `
      $serviceEscapeContext.User.RootPath `
      'task-action.ps1'
    [IO.File]::WriteAllText(
      $taskActionScript,
      @'
param(
  [Parameter(Mandatory)][string]$Record,
  [Parameter(Mandatory)][string]$Marker,
  [Parameter(Mandatory)][string]$PidMarker,
  [Parameter(Mandatory)][string]$SidMarker,
  [Parameter(Mandatory)][string]$ForgedBase64
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[IO.File]::WriteAllText(
  $SidMarker,
  [Security.Principal.WindowsIdentity]::GetCurrent().User.Value,
  [Text.UTF8Encoding]::new($false)
)
[IO.File]::WriteAllText(
  $PidMarker,
  [string]$PID,
  [Text.UTF8Encoding]::new($false)
)
[IO.File]::WriteAllText($Marker, 'started', [Text.UTF8Encoding]::new($false))
Start-Sleep -Seconds 20
[IO.File]::WriteAllBytes($Record, [Convert]::FromBase64String($ForgedBase64))
'@,
      [Text.UTF8Encoding]::new($false)
    )
    $taskActionTemplate = [IO.File]::ReadAllText($taskActionScript)

    function Assert-OptionalScheduledActionDrained {
      param(
        [Parameter(Mandatory)][string]$Marker,
        [Parameter(Mandatory)][string]$PidMarker,
        [Parameter(Mandatory)][string]$SidMarker,
        [Parameter(Mandatory)][string]$ExpectedSid
      )

      $hasMarker = [IO.File]::Exists($Marker)
      $hasPid = [IO.File]::Exists($PidMarker)
      $hasSid = [IO.File]::Exists($SidMarker)
      if ($hasMarker -and (-not $hasPid -or -not $hasSid)) {
        throw 'Task Scheduler action markers were only partially present after quarantine.'
      }
      if ($hasPid -and -not $hasSid) {
        throw 'Task Scheduler action markers were only partially present after quarantine.'
      }
      if (-not $hasMarker -and -not $hasPid -and -not $hasSid) {
        return
      }

      $actualSid = [IO.File]::ReadAllText($SidMarker).Trim()
      if ($actualSid -cne $ExpectedSid) {
        throw 'Task Scheduler action process did not run as the exact isolated SID.'
      }
      if ($hasMarker -and [IO.File]::ReadAllText($Marker).Trim() -cne 'started') {
        throw 'Task Scheduler action started marker was invalid.'
      }
      if ($hasPid) {
        [uint32]$actionPid = 0
        if (
          -not [uint32]::TryParse(
            [IO.File]::ReadAllText($PidMarker).Trim(),
            [ref]$actionPid
          ) -or
          $actionPid -eq 0
        ) {
          throw 'Task Scheduler action process identifier was invalid.'
        }
        Assert-ProcessExited -ProcessId $actionPid
      }
    }

    $taskHelperScript = Join-Path `
      $serviceEscapeContext.User.RootPath `
      'register-task.ps1'
    [IO.File]::WriteAllText(
      $taskHelperScript,
      @'
function Register-IsolatedInteractiveTask {
  param(
    [Parameter(Mandatory)][string]$FolderPath,
    [Parameter(Mandatory)][string]$TaskName,
    [Parameter(Mandatory)][string]$PowerShellPath,
    [Parameter(Mandatory)][string]$ActionScript,
    [Parameter(Mandatory)][string]$Record,
    [Parameter(Mandatory)][string]$Marker,
    [Parameter(Mandatory)][string]$PidMarker,
    [Parameter(Mandatory)][string]$SidMarker,
    [Parameter(Mandatory)][string]$ForgedBase64,
    [Parameter(Mandatory)][string]$UserId
  )

  $service = New-Object -ComObject 'Schedule.Service'
  $service.Connect()
  $folder = $service.GetFolder('\')
  $currentPath = ''
  foreach ($segment in $FolderPath.Trim('\').Split('\')) {
    $currentPath = "$currentPath\$segment"
    try {
      $folder = $service.GetFolder($currentPath)
    } catch {
      $folder = $folder.CreateFolder($segment, $null)
    }
  }
  $definition = $service.NewTask(0)
  $definition.RegistrationInfo.URI = "$FolderPath\$TaskName"
  $definition.RegistrationInfo.Source =
    "OpenCoven Windows supervisor runtime test $FolderPath"
  $definition.Principal.UserId = $UserId
  $definition.Principal.LogonType = 3
  $definition.Principal.RunLevel = 0
  $definition.Settings.Enabled = $true
  $definition.Settings.Hidden = $true
  $definition.Settings.StartWhenAvailable = $true
  $definition.Settings.ExecutionTimeLimit = 'PT2M'
  $action = $definition.Actions.Create(0)
  $action.Path = $PowerShellPath
  $action.Arguments = @(
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-File',
    "`"$ActionScript`"",
    '-Record',
    "`"$Record`"",
    '-Marker',
    "`"$Marker`"",
    '-PidMarker',
    "`"$PidMarker`"",
    '-SidMarker',
    "`"$SidMarker`"",
    '-ForgedBase64',
    $ForgedBase64
  ) -join ' '
  $action.WorkingDirectory = [IO.Directory]::GetParent($ActionScript).FullName
  $registeredTask = $folder.RegisterTaskDefinition(
    $TaskName,
    $definition,
    6,
    $null,
    $null,
    3,
    $null
  )
  $runningTask = $null
  $runErrorHResult = 0
  try {
    $runningTask = $registeredTask.Run($null)
  } catch [Runtime.InteropServices.COMException] {
    $runErrorHResult = $_.Exception.HResult
  }
  return [pscustomobject]@{
    TaskPath = "$FolderPath\$TaskName"
    RegisteredTask = $registeredTask
    RunningTask = $runningTask
    RunAttempted = $true
    RunErrorHResult = $runErrorHResult
  }
}

function Assert-SchedulerRunAttemptResult {
  param(
    [Parameter(Mandatory)][pscustomobject]$Probe,
    [Parameter(Mandatory)][string]$StartedMarker,
    [Parameter(Mandatory)][string]$PidMarker,
    [Parameter(Mandatory)][string]$SidMarker
  )

  if (-not $Probe.RunAttempted) {
    throw 'Task Scheduler run was not attempted.'
  }
  if ($null -eq $Probe.RunningTask) {
    if (
      $Probe.RunErrorHResult -eq 0 -or
      $Probe.RegisteredTask.GetInstances(0).Count -ne 0 -or
      [IO.File]::Exists($StartedMarker) -or
      [IO.File]::Exists($PidMarker) -or
      [IO.File]::Exists($SidMarker)
    ) {
      throw 'Task Scheduler run attempt failed without a fail-closed non-running state.'
    }
  }
}

function Assert-ScheduledActionRunIsolation {
  param(
    [Parameter(Mandatory)][pscustomobject]$Probe,
    [Parameter(Mandatory)][string]$StartedMarker,
    [Parameter(Mandatory)][string]$PidMarker,
    [Parameter(Mandatory)][string]$SidMarker,
    [Parameter(Mandatory)][string]$ExpectedSid,
    [Parameter(Mandatory)][string]$JobName,
    [Parameter(Mandatory)][string]$ProcessLabel,
    [Parameter(Mandatory)][string]$EngineLabel
  )

  Assert-SchedulerRunAttemptResult `
    -Probe $Probe `
    -StartedMarker $StartedMarker `
    -PidMarker $PidMarker `
    -SidMarker $SidMarker

  $deadline = [DateTime]::UtcNow.AddSeconds(2)
  [uint32]$enginePid = 0
  do {
    try {
      $enginePid = [uint32]$Probe.RunningTask.EnginePID
    } catch {
      $enginePid = [uint32]0
    }
    $hasStartedMarker = [IO.File]::Exists($StartedMarker)
    $hasPidMarker = [IO.File]::Exists($PidMarker)
    $hasSidMarker = [IO.File]::Exists($SidMarker)
    if (
      $enginePid -ne 0 -or
      ($hasPidMarker -and $hasSidMarker)
    ) {
      break
    }
    if (
      -not (
        $hasStartedMarker -or $hasPidMarker -or $hasSidMarker -or
        $enginePid -ne 0
      )
    ) {
      Start-Sleep -Milliseconds 20
      continue
    }
    Start-Sleep -Milliseconds 20
  } while ([DateTime]::UtcNow -lt $deadline)

  if ($enginePid -ne 0) {
    [ScheduledActionIsolationProbe]::AssertAliveOutsideJobWithPrimaryTokenSid(
      $EngineLabel,
      $JobName,
      $enginePid,
      $ExpectedSid
    )
  }

  $hasStartedMarker = [IO.File]::Exists($StartedMarker)
  $hasPidMarker = [IO.File]::Exists($PidMarker)
  $hasSidMarker = [IO.File]::Exists($SidMarker)
  if (-not ($hasStartedMarker -or $hasPidMarker -or $hasSidMarker)) {
    return
  }
  if (-not $hasPidMarker -or -not $hasSidMarker) {
    throw 'Task Scheduler action process readiness was incomplete.'
  }
  if (
    $hasStartedMarker -and
    [IO.File]::ReadAllText($StartedMarker).Trim() -cne 'started'
  ) {
    throw 'Task Scheduler action started marker was invalid.'
  }
  $actualSid = [IO.File]::ReadAllText($SidMarker).Trim()
  if ($actualSid -cne $ExpectedSid) {
    throw 'Task Scheduler action process did not run as the exact isolated SID.'
  }
  [uint32]$actionPid = 0
  if (
    -not [uint32]::TryParse(
      [IO.File]::ReadAllText($PidMarker).Trim(),
      [ref]$actionPid
    ) -or
    $actionPid -eq 0
  ) {
    throw 'Task Scheduler action process identifier was invalid.'
  }
  [ScheduledActionIsolationProbe]::AssertAliveOutsideJobWithPrimaryTokenSid(
    $ProcessLabel,
    $JobName,
    $actionPid,
    $ExpectedSid
  )
}
'@,
      [Text.UTF8Encoding]::new($false)
    )
    $taskHelperTemplate = [IO.File]::ReadAllText($taskHelperScript)

    $principalOnlyTaskHelperScript = Join-Path `
      $serviceEscapeContext.User.RootPath `
      'register-principal-only-task.ps1'
    [IO.File]::WriteAllText(
      $principalOnlyTaskHelperScript,
      @'
function Register-PrincipalOnlyInteractiveTask {
  param(
    [Parameter(Mandatory)][string]$UserSid,
    [string]$TaskNonce,
    [string]$FolderPath,
    [string]$TaskName = 'IdentityMatchOnly',
    [switch]$Start,
    [Parameter(Mandatory)][string[]]$ForbiddenFragments
  )

  if ([string]::IsNullOrWhiteSpace($FolderPath)) {
    if ([string]::IsNullOrWhiteSpace($TaskNonce)) {
      throw 'Principal-only task folder identity is missing.'
    }
    $FolderPath = "\OpenCoven-PrincipalOnly-$TaskNonce\Neutral\Blocking"
  }
  $description = 'Neutral interactive-token blocking regression'
  $source = 'Neutral scheduler runtime regression'
  $actionPath = Join-Path $env:SystemRoot 'System32\ping.exe'
  $actionArguments = '-t 127.0.0.1'
  $workingDirectory = Join-Path $env:SystemRoot 'System32'
  $metadataValues = @(
    $FolderPath,
    "$FolderPath\$TaskName",
    $TaskName,
    $description,
    $source,
    $actionPath,
    $actionArguments,
    $workingDirectory
  )
  foreach ($fragment in $ForbiddenFragments) {
    if ([string]::IsNullOrWhiteSpace($fragment)) {
      throw 'Principal-only task forbidden metadata fragment was empty.'
    }
    foreach ($value in $metadataValues) {
      if ($value.IndexOf($fragment, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        throw 'Principal-only task metadata contained an attributable identity.'
      }
    }
  }

  $service = New-Object -ComObject 'Schedule.Service'
  $service.Connect()
  $folder = $service.GetFolder('\')
  $currentPath = ''
  foreach ($segment in $FolderPath.Trim('\').Split('\')) {
    $currentPath = "$currentPath\$segment"
    try {
      $folder = $service.GetFolder($currentPath)
    } catch {
      $folder = $folder.CreateFolder($segment, $null)
    }
  }
  $definition = $service.NewTask(0)
  $definition.RegistrationInfo.URI = "$FolderPath\$TaskName"
  $definition.RegistrationInfo.Description = $description
  $definition.RegistrationInfo.Source = $source
  $definition.Principal.UserId = $UserSid
  $definition.Principal.LogonType = 3
  $definition.Principal.RunLevel = 0
  $definition.Settings.Enabled = $true
  $definition.Settings.Hidden = $true
  $definition.Settings.StartWhenAvailable = $true
  $definition.Settings.ExecutionTimeLimit = 'PT2M'
  $action = $definition.Actions.Create(0)
  $action.Path = $actionPath
  $action.Arguments = '-t 127.0.0.1'
  $action.WorkingDirectory = $workingDirectory
  $registeredTask = $folder.RegisterTaskDefinition(
    $TaskName,
    $definition,
    6,
    $null,
    $null,
    3,
    $null
  )
  $runningTask = $null
  $runAttempted = $false
  $runErrorHResult = 0
  if ($Start) {
    $runAttempted = $true
    try {
      $runningTask = $registeredTask.Run($null)
    } catch [Runtime.InteropServices.COMException] {
      $runErrorHResult = $_.Exception.HResult
    }
  }
  return [pscustomobject]@{
    TaskPath = "$FolderPath\$TaskName"
    RegisteredTask = $registeredTask
    RunningTask = $runningTask
    RunAttempted = $runAttempted
    RunErrorHResult = $runErrorHResult
  }
}

function Assert-PrincipalOnlySchedulerRunAttemptResult {
  param([Parameter(Mandatory)][pscustomobject]$Probe)

  if (-not $Probe.RunAttempted) {
    throw 'Principal-only Task Scheduler run was not attempted.'
  }
  if (
    $null -eq $Probe.RunningTask -and
    (
      $Probe.RunErrorHResult -eq 0 -or
      $Probe.RegisteredTask.GetInstances(0).Count -ne 0
    )
  ) {
    throw 'Principal-only Task Scheduler run failed without a fail-closed non-running state.'
  }
}
'@,
      [Text.UTF8Encoding]::new($false)
    )
    $principalOnlyTaskHelperTemplate =
      [IO.File]::ReadAllText($principalOnlyTaskHelperScript)

    $lateRegistrarScript = Join-Path `
      $serviceEscapeContext.User.RootPath `
      'late-task-registrar.ps1'
    [IO.File]::WriteAllText(
      $lateRegistrarScript,
      @"
param([Parameter(Mandatory)][string]`$UserName)
`$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. '$($taskHelperScript.Replace("'", "''"))'
Add-Type -TypeDefinition (
  [IO.File]::ReadAllText('$($serviceEscapeProbeSource.Replace("'", "''"))')
) -Language CSharp
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class DisabledAccountProbe
{
    private const uint NERR_SUCCESS = 0;
    private const uint UF_ACCOUNTDISABLE = 0x0002;

    public static bool IsDisabled(string name)
    {
        IntPtr information;
        uint status = NetUserGetInfo(null, name, 1, out information);
        if (status != NERR_SUCCESS || information == IntPtr.Zero)
        {
            throw new Win32Exception(
                unchecked((int)status),
                "Account disable state could not be queried.");
        }
        try
        {
            USER_INFO_1 value = (USER_INFO_1)Marshal.PtrToStructure(
                information,
                typeof(USER_INFO_1));
            return (value.usri1_flags & UF_ACCOUNTDISABLE) != 0;
        }
        finally
        {
            NetApiBufferFree(information);
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct USER_INFO_1
    {
        internal string usri1_name;
        internal string usri1_password;
        internal uint usri1_password_age;
        internal uint usri1_priv;
        internal string usri1_home_dir;
        internal string usri1_comment;
        internal uint usri1_flags;
        internal string usri1_script_path;
    }

    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
    private static extern uint NetUserGetInfo(
        string serverName,
        string userName,
        uint level,
        out IntPtr buffer);

    [DllImport("netapi32.dll")]
    private static extern uint NetApiBufferFree(IntPtr buffer);
}
'@
[IO.File]::WriteAllText(
  '$($lateRegistrarReady.Replace("'", "''"))',
  'ready',
  [Text.UTF8Encoding]::new(`$false)
)
while (-not [DisabledAccountProbe]::IsDisabled(`$UserName)) {
  Start-Sleep -Milliseconds 1
}
`$taskParameters = @{
  FolderPath = '$lateTaskFolderPath'
  TaskName = '$lateTaskName'
  PowerShellPath = '$($trustedPwsh.Replace("'", "''"))'
  ActionScript = '$($taskActionScript.Replace("'", "''"))'
  Record = '$($serviceEscapeRecord.Replace("'", "''"))'
  Marker = '$($lateActionMarker.Replace("'", "''"))'
  PidMarker = '$($lateActionPid.Replace("'", "''"))'
  SidMarker = '$($lateActionSid.Replace("'", "''"))'
  ForgedBase64 = '$serviceEscapeForgedBase64'
  UserId = '$([Environment]::MachineName)\$($serviceEscapeContext.User.UserName)'
}
`$lateTask = Register-IsolatedInteractiveTask @taskParameters
`$lateRunIsolationParameters = @{
  Probe = `$lateTask
  StartedMarker = '$($lateActionMarker.Replace("'", "''"))'
  PidMarker = '$($lateActionPid.Replace("'", "''"))'
  SidMarker = '$($lateActionSid.Replace("'", "''"))'
  ExpectedSid = '$($serviceEscapeContext.User.Sid)'
  JobName = '$serviceEscapeJobName'
  ProcessLabel = 'Post-disable scheduled action process PID'
  EngineLabel = 'Post-disable scheduled action EnginePID'
}
Assert-ScheduledActionRunIsolation @lateRunIsolationParameters
`$registeredLateUserId =
  [string]`$lateTask.RegisteredTask.Definition.Principal.UserId
`$registeredLateSid = if (
  `$registeredLateUserId.StartsWith(
    'S-1-',
    [StringComparison]::OrdinalIgnoreCase
  )
) {
  [Security.Principal.SecurityIdentifier]::new(`$registeredLateUserId).Value
} else {
  [Security.Principal.NTAccount]::new(`$registeredLateUserId).Translate(
    [Security.Principal.SecurityIdentifier]
  ).Value
}
if (
  `$lateTask.TaskPath -cne '$lateTaskFolderPath\$lateTaskName' -or
  `$lateTask.RegisteredTask.Path -cne '$lateTaskFolderPath\$lateTaskName' -or
  `$registeredLateSid -cne '$($serviceEscapeContext.User.Sid)'
) {
  throw 'Post-disable exact-SID task registration changed.'
}
[IO.File]::WriteAllText(
  '$($lateRegistrationMarker.Replace("'", "''"))',
  'registered-after-disable-run-attempted',
  [Text.UTF8Encoding]::new(`$false)
)
Start-Sleep -Seconds 300
"@,
      [Text.UTF8Encoding]::new($false)
    )

    $unsupervisedLauncherSource = Join-Path `
      $serviceEscapeContext.User.RootPath `
      'unsupervised-logon-process.cs'
    [IO.File]::WriteAllText(
      $unsupervisedLauncherSource,
      @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class UnsupervisedLogonProcess
{
    private const uint LOGON_WITH_PROFILE = 0x00000001;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_NO_WINDOW = 0x08000000;

    public static uint Start(
        string userName,
        string domain,
        string password,
        string application,
        string arguments,
        string workingDirectory)
    {
        STARTUPINFO startup = new STARTUPINFO();
        startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        PROCESS_INFORMATION process;
        StringBuilder command = new StringBuilder();
        command.Append('"').Append(application).Append('"');
        if (!String.IsNullOrWhiteSpace(arguments))
        {
            command.Append(' ').Append(arguments);
        }
        if (!CreateProcessWithLogonW(
                userName,
                domain,
                password,
                LOGON_WITH_PROFILE,
                application,
                command,
                CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                IntPtr.Zero,
                workingDirectory,
                ref startup,
                out process))
        {
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                "Unsupervised test process could not be launched.");
        }
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        return process.dwProcessId;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        internal int cb;
        internal string lpReserved;
        internal string lpDesktop;
        internal string lpTitle;
        internal uint dwX;
        internal uint dwY;
        internal uint dwXSize;
        internal uint dwYSize;
        internal uint dwXCountChars;
        internal uint dwYCountChars;
        internal uint dwFillAttribute;
        internal uint dwFlags;
        internal ushort wShowWindow;
        internal ushort cbReserved2;
        internal IntPtr lpReserved2;
        internal IntPtr hStdInput;
        internal IntPtr hStdOutput;
        internal IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        internal IntPtr hProcess;
        internal IntPtr hThread;
        internal uint dwProcessId;
        internal uint dwThreadId;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessWithLogonW(
        string userName,
        string domain,
        string password,
        uint logonFlags,
        string applicationName,
        StringBuilder commandLine,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
}
'@,
      [Text.UTF8Encoding]::new($false)
    )
    Add-Type -TypeDefinition (
      [IO.File]::ReadAllText($unsupervisedLauncherSource)
    ) -Language CSharp
    $passwordProperty = [OpenCoven.WindowsIsolatedUser].GetProperty(
      'Password',
      [Reflection.BindingFlags]'NonPublic,Instance'
    )
    $serviceEscapePassword =
      [string]$passwordProperty.GetValue($serviceEscapeContext.User)
    $preExistingScheduler = New-Object -ComObject 'Schedule.Service'
    $preExistingScheduler.Connect()
    $preExistingFolder = $preExistingScheduler.GetFolder('\')
    $preExistingCurrentPath = ''
    foreach ($segment in $preExistingTaskFolderPath.Trim('\').Split('\')) {
      $preExistingCurrentPath = "$preExistingCurrentPath\$segment"
      try {
        $preExistingFolder =
          $preExistingScheduler.GetFolder($preExistingCurrentPath)
      } catch {
        $preExistingFolder = $preExistingFolder.CreateFolder($segment, $null)
      }
    }
    $serviceEscapeJob = [OpenCoven.WindowsJobSupervisor]::Create(
      $serviceEscapeJobName,
      $serviceEscapeContext.User
    )
    $lateRegistrarPid = [int][UnsupervisedLogonProcess]::Start(
      $serviceEscapeContext.User.UserName,
      [Environment]::MachineName,
      $serviceEscapePassword,
      $trustedPwsh,
      "-NoLogo -NoProfile -NonInteractive -File `"$lateRegistrarScript`" -UserName `"$($serviceEscapeContext.User.UserName)`"",
      $serviceEscapeContext.User.RootPath
    )
    $lateReadyDeadline = [DateTime]::UtcNow.AddSeconds(20)
    while (-not [IO.File]::Exists($lateRegistrarReady)) {
      try {
        $lateRegistrar = [Diagnostics.Process]::GetProcessById($lateRegistrarPid)
        $lateRegistrar.Dispose()
      } catch [ArgumentException] {
        throw 'Late task registrar exited before observing account disablement.'
      }
      if ([DateTime]::UtcNow -ge $lateReadyDeadline) {
        throw 'Late task registrar did not become ready.'
      }
      Start-Sleep -Milliseconds 20
    }
    Assert-BoundedTextMarker `
      -Path $lateRegistrarReady `
      -Expected 'ready'
    [ScheduledActionIsolationProbe]::AssertAliveOutsideAuthoritativeJobWithPrimaryTokenSid(
      'Deterministic service-equivalent exact-SID process',
      $serviceEscapeJob.AuthoritativeHandleValue,
      [uint32]$lateRegistrarPid,
      $serviceEscapeContext.User.Sid
    )

    $serviceEscapeProducer = Join-Path `
      $serviceEscapeContext.User.RootPath `
      'service-escape-producer.ps1'
    [IO.File]::WriteAllText(
      $serviceEscapeProducer,
      @"
`$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. '$($taskHelperScript.Replace("'", "''"))'
. '$($principalOnlyTaskHelperScript.Replace("'", "''"))'
Add-Type -TypeDefinition (
  [IO.File]::ReadAllText('$($serviceEscapeProbeSource.Replace("'", "''"))')
) -Language CSharp
function Resolve-RegisteredPrincipalSid {
  param([Parameter(Mandatory)][string]`$UserId)

  try {
    if (`$UserId.StartsWith('S-1-', [StringComparison]::OrdinalIgnoreCase)) {
      return [Security.Principal.SecurityIdentifier]::new(`$UserId).Value
    }
    return [Security.Principal.NTAccount]::new(`$UserId).Translate(
      [Security.Principal.SecurityIdentifier]
    ).Value
  } catch {
    throw 'Exact-SID task principal could not be resolved.'
  }
}
[IO.Directory]::CreateDirectory(
  '$([IO.Directory]::GetParent($serviceEscapeRecord).FullName.Replace("'", "''"))'
) | Out-Null
[IO.File]::WriteAllBytes(
  '$($serviceEscapeRecord.Replace("'", "''"))',
  [Convert]::FromBase64String('$serviceEscapeTrustedBase64')
)
`$taskParameters = @{
  FolderPath = '$taskFolderPath'
  TaskName = '$serviceEscapeName'
  PowerShellPath = '$($trustedPwsh.Replace("'", "''"))'
  ActionScript = '$($taskActionScript.Replace("'", "''"))'
  Record = '$($serviceEscapeRecord.Replace("'", "''"))'
  Marker = '$($serviceEscapeActionMarker.Replace("'", "''"))'
  PidMarker = '$($serviceEscapeActionPid.Replace("'", "''"))'
  SidMarker = '$($serviceEscapeActionSid.Replace("'", "''"))'
  ForgedBase64 = '$serviceEscapeForgedBase64'
  UserId = "`$env:COMPUTERNAME\`$env:USERNAME"
}
`$taskProbe = Register-IsolatedInteractiveTask @taskParameters
if (
  `$taskProbe.TaskPath -cne '$taskFolderPath\$serviceEscapeName' -or
  `$taskProbe.RegisteredTask.Path -cne '$taskFolderPath\$serviceEscapeName' -or
  (Resolve-RegisteredPrincipalSid -UserId (
    [string]`$taskProbe.RegisteredTask.Definition.Principal.UserId
  )) -cne '$($serviceEscapeContext.User.Sid)'
) {
  throw 'Primary exact-SID task registration changed.'
}
`$primaryRunIsolationParameters = @{
  Probe = `$taskProbe
  StartedMarker = '$($serviceEscapeActionMarker.Replace("'", "''"))'
  PidMarker = '$($serviceEscapeActionPid.Replace("'", "''"))'
  SidMarker = '$($serviceEscapeActionSid.Replace("'", "''"))'
  ExpectedSid = '$($serviceEscapeContext.User.Sid)'
  JobName = '$serviceEscapeJobName'
  ProcessLabel = 'Primary scheduled action process PID'
  EngineLabel = 'Primary scheduled action EnginePID'
}
Assert-ScheduledActionRunIsolation @primaryRunIsolationParameters
`$forbiddenTaskFragments = @(
  '$serviceEscapeJobName',
  '$serviceEscapeNonce',
  '$($serviceEscapeContext.User.UserName)',
  '$([Environment]::MachineName)\$($serviceEscapeContext.User.UserName)',
  '$($serviceEscapeContext.User.RootPath.Replace("'", "''"))',
  '$($serviceEscapeContext.User.WorkspacePath.Replace("'", "''"))'
)
`$principalOnlyTask = Register-PrincipalOnlyInteractiveTask -UserSid '$($serviceEscapeContext.User.Sid)' -TaskNonce '$principalOnlyNonce' -ForbiddenFragments `$forbiddenTaskFragments
`$sharedChildTask = Register-PrincipalOnlyInteractiveTask -UserSid '$($serviceEscapeContext.User.Sid)' -FolderPath '$runCreatedSharedChildPath' -TaskName '$sharedChildTaskName' -ForbiddenFragments `$forbiddenTaskFragments
`$preExistingFolderTask = Register-PrincipalOnlyInteractiveTask -UserSid '$($serviceEscapeContext.User.Sid)' -FolderPath '$preExistingTaskFolderPath' -TaskName '$preExistingFolderTaskName' -ForbiddenFragments `$forbiddenTaskFragments
foreach (`$exactSidRegistration in @(
  [pscustomobject]@{
    Probe = `$principalOnlyTask
    ExpectedPath = '$principalOnlyTaskPath'
  },
  [pscustomobject]@{
    Probe = `$sharedChildTask
    ExpectedPath = '$sharedChildTaskPath'
  },
  [pscustomobject]@{
    Probe = `$preExistingFolderTask
    ExpectedPath = '$preExistingFolderTaskPath'
  }
)) {
  if (
    `$exactSidRegistration.Probe.TaskPath -cne `$exactSidRegistration.ExpectedPath -or
    `$exactSidRegistration.Probe.RegisteredTask.Path -cne
      `$exactSidRegistration.ExpectedPath
  ) {
    throw 'Exact-SID task path changed.'
  }
  if (
    (Resolve-RegisteredPrincipalSid -UserId (
      [string]`$exactSidRegistration.Probe.RegisteredTask.Definition.Principal.UserId
    )) -cne
      '$($serviceEscapeContext.User.Sid)'
  ) {
    throw 'Task was not registered for the exact isolated SID.'
  }
}
[ScheduledActionIsolationProbe]::CreateBitsJob(
  (Join-Path `$env:SystemRoot 'System32\bitsadmin.exe'),
  '$bitsName'
)
[IO.File]::WriteAllText(
  '$($serviceEscapeReady.Replace("'", "''"))',
  'task-run-attempted-bits-created',
  [Text.UTF8Encoding]::new(`$false)
)
exit 0
"@,
      [Text.UTF8Encoding]::new($false)
    )
    $serviceEscapeResult =
      $serviceEscapeJob.RunProducerAsUserAndQuarantine(
      $serviceEscapeContext.User,
      $trustedPwsh,
      "-NoLogo -NoProfile -NonInteractive -File `"$serviceEscapeProducer`"",
      $serviceEscapeContext.User.RootPath,
      $serviceEscapeContext.Environment,
      [TimeSpan]::FromSeconds(30),
      1MB,
      1MB
    )
    if ($serviceEscapeResult.ExitCode -ne 0) {
      throw "Service escape setup failed: $($serviceEscapeResult.Stderr)"
    }
    if (-not $serviceEscapeJob.IsQuarantineComplete) {
      throw 'Successful producer terminal quarantine did not complete.'
    }
    $serviceEscapeArtifact = $serviceEscapeJob.CaptureIsolatedArtifact(
      $serviceEscapeContext.User,
      $serviceEscapeContext.User.WorkspacePath,
      $serviceEscapeRecord,
      1MB
    )
    if (
      -not $serviceEscapeContext.User.IsDisabled -or
      (Get-LocalUser -Name $serviceEscapeContext.User.UserName).Enabled
    ) {
      throw 'Ephemeral account was not disabled by terminal quarantine.'
    }
    if (
      -not [IO.File]::Exists($serviceEscapeReady) -or
      [IO.File]::ReadAllText($serviceEscapeReady).Trim() -cne
        'task-run-attempted-bits-created'
    ) {
      throw 'Primary Task Scheduler registration/run attempt was not completed.'
    }
    if (
      -not [IO.File]::Exists($lateRegistrationMarker) -or
      [IO.File]::ReadAllText($lateRegistrationMarker).Trim() -cne
        'registered-after-disable-run-attempted'
    ) {
      throw 'A task registration/run attempt after account disablement was not exercised.'
    }
    Assert-OptionalScheduledActionDrained `
      -Marker $serviceEscapeActionMarker `
      -PidMarker $serviceEscapeActionPid `
      -SidMarker $serviceEscapeActionSid `
      -ExpectedSid $serviceEscapeContext.User.Sid
    Assert-OptionalScheduledActionDrained `
      -Marker $lateActionMarker `
      -PidMarker $lateActionPid `
      -SidMarker $lateActionSid `
      -ExpectedSid $serviceEscapeContext.User.Sid
    Assert-ProcessExited -ProcessId $lateRegistrarPid
    $lateRegistrarPid = 0
    Assert-NoExactSidPersistence -Sid $serviceEscapeContext.User.Sid
    Assert-ScheduledTaskAbsent `
      -TaskPath "$taskFolderPath\$serviceEscapeName" `
      -Failure 'Task Scheduler escape registration survived broker cleanup.'
    Assert-ScheduledTaskAbsent `
      -TaskPath "$lateTaskFolderPath\$lateTaskName" `
      -Failure 'A task registered after account disablement survived repeated cleanup.'
    Assert-ScheduledTaskAbsent `
      -TaskPath $principalOnlyTaskPath `
      -Failure 'Principal-only exact-SID Task Scheduler registration survived cleanup.'
    Assert-ScheduledTaskAbsent `
      -TaskPath $sharedChildTaskPath `
      -Failure 'Task in a run-created shared child survived quarantine.'
    Assert-ScheduledTaskAbsent `
      -TaskPath $preExistingFolderTaskPath `
      -Failure 'Matching task registration in a pre-existing folder survived quarantine.'
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    foreach ($folderRoot in @($taskFolderRoot, $principalOnlyFolderRoot)) {
      $folderSurvived = $false
      try {
        $scheduler.GetFolder("\$folderRoot") | Out-Null
        $folderSurvived = $true
      } catch {
      }
      if ($folderSurvived) {
        throw 'Nested Task Scheduler escape folder survived broker cleanup.'
      }
    }
    try {
      $scheduler.GetFolder($preExistingSharedFolderPath) | Out-Null
    } catch {
      throw 'Pre-existing shared Task Scheduler parent was removed by quarantine.'
    }
    try {
      $scheduler.GetFolder($preExistingTaskFolderPath) | Out-Null
    } catch {
      throw 'Pre-existing Task Scheduler folder was removed by quarantine.'
    }
    $runCreatedSharedChildSurvived = $false
    try {
      $scheduler.GetFolder($runCreatedSharedChildPath) | Out-Null
      $runCreatedSharedChildSurvived = $true
    } catch {
    }
    if ($runCreatedSharedChildSurvived) {
      throw 'Run-created Task Scheduler child survived quarantine.'
    }
    $bitsListing = & (Join-Path $env:SystemRoot 'System32\bitsadmin.exe') `
      /list `
      /allusers `
      /verbose 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or $bitsListing.Contains($bitsName)) {
      throw 'BITS service-mediated job survived broker cleanup.'
    }
    if (
      $serviceEscapeArtifact.Sha256 -cne $serviceEscapeTrustedDigest -or
      [Text.UTF8Encoding]::new($false).GetString(
        $serviceEscapeArtifact.Bytes
      ) -cne $serviceEscapeTrustedText
    ) {
      throw 'Service-mediated persistence rewrote the sealed artifact.'
    }
  } finally {
    if ($lateRegistrarPid -ne 0) {
      try {
        $lateRegistrar = [Diagnostics.Process]::GetProcessById($lateRegistrarPid)
        try {
          $lateRegistrar.Kill($true)
          $lateRegistrar.WaitForExit()
        } finally {
          $lateRegistrar.Dispose()
        }
      } catch [ArgumentException] {
      }
    }
    foreach ($taskPath in @(
      "$taskFolderPath\$serviceEscapeName",
      "$lateTaskFolderPath\$lateTaskName",
      $principalOnlyTaskPath,
      $sharedChildTaskPath,
      $preExistingFolderTaskPath
    )) {
      & (Join-Path $env:SystemRoot 'System32\schtasks.exe') `
        /End `
        /TN $taskPath *>&1 | Out-Null
      & (Join-Path $env:SystemRoot 'System32\schtasks.exe') `
        /Delete `
        /F `
        /TN $taskPath *>&1 | Out-Null
    }
    try {
      $cleanupScheduler = New-Object -ComObject 'Schedule.Service'
      $cleanupScheduler.Connect()
      foreach ($folderPath in @(
        $runCreatedSharedChildPath,
        $preExistingTaskFolderPath,
        $preExistingSharedFolderPath
      )) {
        $separator = $folderPath.LastIndexOf('\')
        $parentPath = if ($separator -eq 0) {
          '\'
        } else {
          $folderPath.Substring(0, $separator)
        }
        $folderName = $folderPath.Substring($separator + 1)
        try {
          $cleanupScheduler.GetFolder($parentPath).DeleteFolder(
            $folderName,
            0
          )
        } catch {
        }
      }
    } catch {
    }
    try {
      Import-Module BitsTransfer -ErrorAction Stop
      Get-BitsTransfer -AllUsers |
        Where-Object DisplayName -CEQ $bitsName |
        Remove-BitsTransfer
    } catch {
    }
    $serviceEscapeCleanupErrors =
      [Collections.Generic.List[Exception]]::new()
    try {
      Remove-IsolatedTestContext -Context $serviceEscapeContext
    } catch {
      $serviceEscapeCleanupErrors.Add($_.Exception)
    }
    if ($null -ne $serviceEscapeJob) {
      try {
        $serviceEscapeJob.Dispose()
      } catch {
        $serviceEscapeCleanupErrors.Add($_.Exception)
      }
    }
    if ($serviceEscapeCleanupErrors.Count -ne 0) {
      throw [AggregateException]::new(
        'Scheduler regression cleanup failed.',
        $serviceEscapeCleanupErrors
      )
    }
  }
  if (
    $null -ne (
      Get-LocalUser -Name $serviceEscapeUserName -ErrorAction SilentlyContinue
    )
  ) {
    throw 'Scheduler-regression ephemeral local user survived cleanup.'
  }
  if ([IO.Directory]::Exists($serviceEscapeProfilePath)) {
    throw 'Scheduler-regression ephemeral Windows profile survived cleanup.'
  }
  if ([IO.Directory]::Exists($serviceEscapeRootPath)) {
    throw 'Scheduler-regression ephemeral bootstrap root survived cleanup.'
  }

  $failureEscapeContext =
    New-IsolatedTestContext -Label 'service-escape-nonzero'
  $failureEscapeJob = $null
  $failureSleeperPid = 0
  try {
    $failureEscapeNonce = [Guid]::NewGuid().ToString('N')
    $failureEscapeJobName =
      "Local\OpenCoven.Chat.SupervisorTest.$failureEscapeNonce"
    $failureEscapeFolderRoot = "OpenCoven-$failureEscapeNonce"
    $failureEscapeFolderPath =
      "\$failureEscapeFolderRoot\Hidden\Nested"
    $failureEscapeTaskName = 'NonzeroEscape'
    $failureEscapeBitsName =
      "OpenCoven-BitsNonzero-$([Guid]::NewGuid().ToString('N'))"
    $failureEscapeUserName = $failureEscapeContext.User.UserName
    $failureEscapeProfilePath =
      $failureEscapeContext.User.OperatingSystemProfilePath
    $failureEscapeRootPath = $failureEscapeContext.User.RootPath
    $failureEscapeRecord = Join-Path `
      $failureEscapeContext.User.WorkspacePath `
      '.artifacts\record.json'
    $failureEscapeStarted = Join-Path `
      $failureEscapeContext.User.TempPath `
      'task-started.txt'
    $failureEscapePid = Join-Path `
      $failureEscapeContext.User.TempPath `
      'task-pid.txt'
    $failureEscapeSid = Join-Path `
      $failureEscapeContext.User.TempPath `
      'task-sid.txt'
    $failureEscapeReady = Join-Path `
      $failureEscapeContext.User.TempPath `
      'producer-ready.txt'
    $failureSleeperReady = Join-Path `
      $failureEscapeContext.User.TempPath `
      'persistence-sleeper-ready.txt'
    $failureSleeperScript = Join-Path `
      $failureEscapeContext.User.RootPath `
      'persistence-sleeper.ps1'
    $failureActionScript = Join-Path `
      $failureEscapeContext.User.RootPath `
      'task-action.ps1'
    $failureTaskHelper = Join-Path `
      $failureEscapeContext.User.RootPath `
      'register-task.ps1'
    $failureProducer = Join-Path `
      $failureEscapeContext.User.RootPath `
      'nonzero-producer.ps1'
    $failureEscapeProbeSource = Join-Path `
      $failureEscapeContext.User.RootPath `
      'scheduled-action-isolation-probe.cs'
    [IO.File]::WriteAllText(
      $failureEscapeProbeSource,
      $scheduledActionIsolationProbeSource,
      [Text.UTF8Encoding]::new($false)
    )
    [IO.File]::WriteAllText(
      $failureActionScript,
      $taskActionTemplate,
      [Text.UTF8Encoding]::new($false)
    )
    [IO.File]::WriteAllText(
      $failureTaskHelper,
      $taskHelperTemplate,
      [Text.UTF8Encoding]::new($false)
    )
    [IO.File]::WriteAllText(
      $failureSleeperScript,
      @"
[IO.File]::WriteAllText(
  '$($failureSleeperReady.Replace("'", "''"))',
  'ready',
  [Text.UTF8Encoding]::new(`$false)
)
Start-Sleep -Seconds 300
"@,
      [Text.UTF8Encoding]::new($false)
    )
    [IO.File]::WriteAllText(
      $failureProducer,
      @"
`$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. '$($failureTaskHelper.Replace("'", "''"))'
Add-Type -TypeDefinition (
  [IO.File]::ReadAllText('$($failureEscapeProbeSource.Replace("'", "''"))')
) -Language CSharp
[IO.Directory]::CreateDirectory(
  '$([IO.Directory]::GetParent($failureEscapeRecord).FullName.Replace("'", "''"))'
) | Out-Null
[IO.File]::WriteAllBytes(
  '$($failureEscapeRecord.Replace("'", "''"))',
  [Convert]::FromBase64String('$serviceEscapeTrustedBase64')
)
`$taskParameters = @{
  FolderPath = '$failureEscapeFolderPath'
  TaskName = '$failureEscapeTaskName'
  PowerShellPath = '$($trustedPwsh.Replace("'", "''"))'
  ActionScript = '$($failureActionScript.Replace("'", "''"))'
  Record = '$($failureEscapeRecord.Replace("'", "''"))'
  Marker = '$($failureEscapeStarted.Replace("'", "''"))'
  PidMarker = '$($failureEscapePid.Replace("'", "''"))'
  SidMarker = '$($failureEscapeSid.Replace("'", "''"))'
  ForgedBase64 = '$serviceEscapeForgedBase64'
  UserId = "`$env:COMPUTERNAME\`$env:USERNAME"
}
`$taskProbe = Register-IsolatedInteractiveTask @taskParameters
`$registeredUserId =
  [string]`$taskProbe.RegisteredTask.Definition.Principal.UserId
`$registeredSid = if (
  `$registeredUserId.StartsWith('S-1-', [StringComparison]::OrdinalIgnoreCase)
) {
  [Security.Principal.SecurityIdentifier]::new(`$registeredUserId).Value
} else {
  [Security.Principal.NTAccount]::new(`$registeredUserId).Translate(
    [Security.Principal.SecurityIdentifier]
  ).Value
}
if (
  `$taskProbe.TaskPath -cne '$failureEscapeFolderPath\$failureEscapeTaskName' -or
  `$taskProbe.RegisteredTask.Path -cne
    '$failureEscapeFolderPath\$failureEscapeTaskName' -or
  `$registeredSid -cne '$($failureEscapeContext.User.Sid)'
) {
  throw 'Nonzero producer exact-SID task registration changed.'
}
`$nonzeroRunIsolationParameters = @{
  Probe = `$taskProbe
  StartedMarker = '$($failureEscapeStarted.Replace("'", "''"))'
  PidMarker = '$($failureEscapePid.Replace("'", "''"))'
  SidMarker = '$($failureEscapeSid.Replace("'", "''"))'
  ExpectedSid = '$($failureEscapeContext.User.Sid)'
  JobName = '$failureEscapeJobName'
  ProcessLabel = 'Nonzero producer scheduled action process PID'
  EngineLabel = 'Nonzero producer scheduled action EnginePID'
}
Assert-ScheduledActionRunIsolation @nonzeroRunIsolationParameters
[ScheduledActionIsolationProbe]::CreateBitsJob(
  (Join-Path `$env:SystemRoot 'System32\bitsadmin.exe'),
  '$failureEscapeBitsName'
)
[IO.File]::WriteAllText(
  '$($failureEscapeReady.Replace("'", "''"))',
  'scheduler-run-attempted-and-bits-created',
  [Text.UTF8Encoding]::new(`$false)
)
exit 23
"@,
      [Text.UTF8Encoding]::new($false)
    )
    $failureEscapeJob = [OpenCoven.WindowsJobSupervisor]::Create(
      $failureEscapeJobName,
      $failureEscapeContext.User
    )
    $failureEscapePassword =
      [string]$passwordProperty.GetValue($failureEscapeContext.User)
    $failureSleeperPid = [int][UnsupervisedLogonProcess]::Start(
      $failureEscapeContext.User.UserName,
      [Environment]::MachineName,
      $failureEscapePassword,
      $trustedPwsh,
      "-NoLogo -NoProfile -NonInteractive -File `"$failureSleeperScript`"",
      $failureEscapeContext.User.RootPath
    )
    $failureSleeperDeadline = [DateTime]::UtcNow.AddSeconds(20)
    while (-not [IO.File]::Exists($failureSleeperReady)) {
      try {
        $failureSleeper = [Diagnostics.Process]::GetProcessById(
          $failureSleeperPid
        )
        $failureSleeper.Dispose()
      } catch [ArgumentException] {
        throw 'Nonzero persistence process exited before readiness.'
      }
      if ([DateTime]::UtcNow -ge $failureSleeperDeadline) {
        throw 'Nonzero persistence process did not become ready.'
      }
      Start-Sleep -Milliseconds 20
    }
    Assert-BoundedTextMarker `
      -Path $failureSleeperReady `
      -Expected 'ready'
    [ScheduledActionIsolationProbe]::AssertAliveOutsideAuthoritativeJobWithPrimaryTokenSid(
      'Nonzero persistence process PID',
      $failureEscapeJob.AuthoritativeHandleValue,
      [uint32]$failureSleeperPid,
      $failureEscapeContext.User.Sid
    )
    $failureEscapeResult =
      $failureEscapeJob.RunProducerAsUserAndQuarantine(
        $failureEscapeContext.User,
        $trustedPwsh,
        "-NoLogo -NoProfile -NonInteractive -File `"$failureProducer`"",
        $failureEscapeContext.User.RootPath,
        $failureEscapeContext.Environment,
        [TimeSpan]::FromSeconds(30),
        1MB,
        1MB
      )
    if ($failureEscapeResult.ExitCode -ne 23) {
      throw 'Nonzero producer result changed during terminal quarantine.'
    }
    if (-not $failureEscapeJob.IsQuarantineComplete) {
      throw 'Nonzero producer terminal quarantine did not complete.'
    }
    if (
      -not [IO.File]::Exists($failureEscapeReady) -or
      [IO.File]::ReadAllText($failureEscapeReady).Trim() -cne
        'scheduler-run-attempted-and-bits-created'
    ) {
      throw 'Nonzero producer scheduler/BITS setup was not completed.'
    }
    Assert-OptionalScheduledActionDrained `
      -Marker $failureEscapeStarted `
      -PidMarker $failureEscapePid `
      -SidMarker $failureEscapeSid `
      -ExpectedSid $failureEscapeContext.User.Sid
    Assert-NoExactSidPersistence -Sid $failureEscapeContext.User.Sid
    Assert-ProcessExited -ProcessId $failureSleeperPid
    $failureSleeperPid = 0
    Assert-ScheduledTaskAbsent `
      -TaskPath "$failureEscapeFolderPath\$failureEscapeTaskName" `
      -Failure 'Nonzero producer Task Scheduler escape survived quarantine.'
    $failureBitsListing = & (
      Join-Path $env:SystemRoot 'System32\bitsadmin.exe'
    ) /list /allusers /verbose 2>&1 | Out-String
    if (
      $LASTEXITCODE -ne 0 -or
      $failureBitsListing.Contains($failureEscapeBitsName)
    ) {
      throw 'Nonzero producer BITS job survived terminal quarantine.'
    }
    $nonzeroCaptureRejected = $false
    try {
      $failureEscapeJob.CaptureIsolatedArtifact(
        $failureEscapeContext.User,
        $failureEscapeContext.User.WorkspacePath,
        $failureEscapeRecord,
        1MB
      ) | Out-Null
    } catch {
      $nonzeroCaptureRejected = $_.Exception.ToString().Contains(
        'successful terminal producer attempt'
      )
    }
    if (-not $nonzeroCaptureRejected) {
      throw 'Nonzero producer artifact capture was not rejected.'
    }
  } finally {
    $failureEscapeCleanupErrors =
      [Collections.Generic.List[Exception]]::new()
    if ($failureSleeperPid -ne 0) {
      try {
        $failureSleeper = [Diagnostics.Process]::GetProcessById(
          $failureSleeperPid
        )
        try {
          if (-not $failureSleeper.HasExited) {
            $failureSleeper.Kill($true)
            $failureSleeper.WaitForExit()
          }
        } finally {
          $failureSleeper.Dispose()
        }
      } catch [ArgumentException] {
      } catch {
        $failureEscapeCleanupErrors.Add($_.Exception)
      }
    }
    try {
      Remove-IsolatedTestContext -Context $failureEscapeContext
    } catch {
      $failureEscapeCleanupErrors.Add($_.Exception)
    }
    if ($null -ne $failureEscapeJob) {
      try {
        $failureEscapeJob.Dispose()
      } catch {
        $failureEscapeCleanupErrors.Add($_.Exception)
      }
    }
    if ($failureEscapeCleanupErrors.Count -ne 0) {
      throw [AggregateException]::new(
        'Nonzero producer cleanup failed.',
        $failureEscapeCleanupErrors
      )
    }
  }
  if (
    $null -ne (
      Get-LocalUser -Name $failureEscapeUserName -ErrorAction SilentlyContinue
    )
  ) {
    throw 'Failure-path ephemeral local user survived cleanup.'
  }
  if ([IO.Directory]::Exists($failureEscapeProfilePath)) {
    throw 'Failure-path ephemeral Windows profile survived cleanup.'
  }
  if ([IO.Directory]::Exists($failureEscapeRootPath)) {
    throw 'Failure-path ephemeral bootstrap root survived cleanup.'
  }

  function Start-TerminalFailurePersistence {
    param(
      [Parameter(Mandatory)]$Context,
      [Parameter(Mandatory)]$SupervisorJob,
      [Parameter(Mandatory)][string]$JobName,
      [Parameter(Mandatory)][string]$Label
    )

    $taskNonce = [Guid]::NewGuid().ToString('N')
    $taskPath =
      "\OpenCoven-PrincipalOnly-$taskNonce\Neutral\Blocking\IdentityMatchOnly"
    $bitsName =
      "OpenCoven-TerminalFailure-$Label-$([Guid]::NewGuid().ToString('N'))"
    $helperPath = Join-Path `
      $Context.User.RootPath `
      'register-principal-only-task.ps1'
    $probePath = Join-Path `
      $Context.User.RootPath `
      'scheduled-action-isolation-probe.cs'
    $setupPath = Join-Path `
      $Context.User.RootPath `
      'stage-terminal-persistence.ps1'
    $readyPath = Join-Path `
      $Context.User.TempPath `
      'terminal-persistence-ready.txt'
    [IO.File]::WriteAllText(
      $helperPath,
      $principalOnlyTaskHelperTemplate,
      [Text.UTF8Encoding]::new($false)
    )
    [IO.File]::WriteAllText(
      $probePath,
      $scheduledActionIsolationProbeSource,
      [Text.UTF8Encoding]::new($false)
    )
    [IO.File]::WriteAllText(
      $setupPath,
      @"
`$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. '$($helperPath.Replace("'", "''"))'
Add-Type -TypeDefinition (
  [IO.File]::ReadAllText('$($probePath.Replace("'", "''"))')
) -Language CSharp
`$terminalTaskParameters = @{
  Start = `$true
  UserSid = '$($Context.User.Sid)'
  TaskNonce = '$taskNonce'
  ForbiddenFragments = @(
    '$JobName',
    '$($Context.User.UserName)',
    '$([Environment]::MachineName)\$($Context.User.UserName)',
    '$($Context.User.RootPath.Replace("'", "''"))',
    '$($Context.User.WorkspacePath.Replace("'", "''"))'
  )
}
`$task = Register-PrincipalOnlyInteractiveTask @terminalTaskParameters
if (`$task.TaskPath -cne '$taskPath') {
  throw 'Terminal failure persistence task path changed.'
}
`$registeredPrincipal = [string]`$task.RegisteredTask.Definition.Principal.UserId
`$registeredSid = if (
  `$registeredPrincipal.StartsWith('S-1-', [StringComparison]::OrdinalIgnoreCase)
) {
  [Security.Principal.SecurityIdentifier]::new(`$registeredPrincipal).Value
} else {
  [Security.Principal.NTAccount]::new(`$registeredPrincipal).Translate(
    [Security.Principal.SecurityIdentifier]
  ).Value
}
if (`$registeredSid -cne '$($Context.User.Sid)') {
  throw 'Terminal failure persistence task principal changed.'
}
Assert-PrincipalOnlySchedulerRunAttemptResult -Probe `$task
`$deadline = [DateTime]::UtcNow.AddSeconds(2)
`$enginePid = [uint32]0
do {
  try {
    `$enginePid = [uint32]`$task.RunningTask.EnginePID
  } catch {
    `$enginePid = [uint32]0
  }
  if (`$enginePid -ne 0) {
    break
  }
  Start-Sleep -Milliseconds 20
} while ([DateTime]::UtcNow -lt `$deadline)
if (`$enginePid -ne 0) {
  [ScheduledActionIsolationProbe]::AssertAliveOutsideJobWithPrimaryTokenSid(
    'Terminal failure principal-only scheduled action EnginePID',
    '$JobName',
    `$enginePid,
    '$($Context.User.Sid)'
  )
}
[ScheduledActionIsolationProbe]::CreateBitsJob(
  (Join-Path `$env:SystemRoot 'System32\bitsadmin.exe'),
  '$bitsName'
)
[IO.File]::WriteAllText(
  '$($readyPath.Replace("'", "''"))',
  'exact-sid-task-run-attempt-process-and-bits-ready',
  [Text.UTF8Encoding]::new(`$false)
)
Start-Sleep -Seconds 300
"@,
      [Text.UTF8Encoding]::new($false)
    )

    $password = [string]$passwordProperty.GetValue($Context.User)
    $setupPid = [int][UnsupervisedLogonProcess]::Start(
      $Context.User.UserName,
      [Environment]::MachineName,
      $password,
      $trustedPwsh,
      "-NoLogo -NoProfile -NonInteractive -File `"$setupPath`"",
      $Context.User.RootPath
    )
    $readyDeadline = [DateTime]::UtcNow.AddSeconds(30)
    while (-not [IO.File]::Exists($readyPath)) {
      try {
        $setupProcess = [Diagnostics.Process]::GetProcessById($setupPid)
        try {
          if ($setupProcess.HasExited) {
            throw 'Terminal failure persistence setup exited before readiness.'
          }
        } finally {
          $setupProcess.Dispose()
        }
      } catch [ArgumentException] {
        throw 'Terminal failure persistence setup exited before readiness.'
      }
      if ([DateTime]::UtcNow -ge $readyDeadline) {
        throw 'Terminal failure persistence setup did not become ready.'
      }
      Start-Sleep -Milliseconds 20
    }
    Assert-BoundedTextMarker `
      -Path $readyPath `
      -Expected 'exact-sid-task-run-attempt-process-and-bits-ready'
    [ScheduledActionIsolationProbe]::AssertAliveOutsideAuthoritativeJobWithPrimaryTokenSid(
      'Terminal failure deterministic exact-SID process',
      $SupervisorJob.AuthoritativeHandleValue,
      [uint32]$setupPid,
      $Context.User.Sid
    )
    if (
      (Get-ExactSidScheduledTaskCount -Sid $Context.User.Sid) -eq 0 -or
      (Get-ExactSidBitsJobCount -Sid $Context.User.Sid) -eq 0 -or
      [ScheduledActionIsolationProbe]::CountProcessesByPrimaryTokenSid(
        $Context.User.Sid
      ) -eq 0
    ) {
      throw 'Terminal failure exact-SID persistence was not staged.'
    }
    return [pscustomobject]@{
      TaskPath = $taskPath
      BitsName = $bitsName
      SetupPid = $setupPid
    }
  }

  function Get-TerminalQuarantineState {
    param(
      [Parameter(Mandatory)]$Job,
      [Parameter(Mandatory)]$Context
    )

    return @(
      [string]$Job.IsQuarantineComplete,
      [string]$Context.User.IsDisabled,
      [string](
        [ScheduledActionIsolationProbe]::CountProcessesByPrimaryTokenSid(
          $Context.User.Sid
        )
      ),
      [string](Get-ExactSidScheduledTaskCount -Sid $Context.User.Sid),
      [string](Get-ExactSidBitsJobCount -Sid $Context.User.Sid)
    ) -join '|'
  }

  function Assert-TerminalFailureQuarantine {
    param(
      [Parameter(Mandatory)][string]$Label,
      [Parameter(Mandatory)][ValidateSet(
        'stdout-overflow',
        'stderr-overflow',
        'directory-quota',
        'launch-exception'
      )][string]$Mode
    )

    $Context = New-IsolatedTestContext -Label "terminal-$Label"
    $Job = $null
    $persistence = $null
    $userName = $Context.User.UserName
    $profilePath = $Context.User.OperatingSystemProfilePath
    $rootPath = $Context.User.RootPath
    try {
      $jobName =
        "Local\OpenCoven.Chat.SupervisorTest.$([Guid]::NewGuid().ToString('N'))"
      $Job = [OpenCoven.WindowsJobSupervisor]::Create(
        $jobName,
        $Context.User
      )
      $persistence = Start-TerminalFailurePersistence `
        -Context $Context `
        -SupervisorJob $Job `
        -JobName $jobName `
        -Label $Label
      $recordPath = Join-Path `
        $Context.User.WorkspacePath `
        '.artifacts\record.json'
      [IO.Directory]::CreateDirectory(
        [IO.Directory]::GetParent($recordPath).FullName
      ) | Out-Null
      [IO.File]::WriteAllBytes($recordPath, $expectedHandoffBytes)
      $producerPath = Join-Path $Context.User.RootPath 'terminal-failure.ps1'
      $quotaPath = Join-Path $Context.User.WorkspacePath 'quota.bin'
      if ($Mode -eq 'stdout-overflow') {
        $producerText =
          "[Console]::Out.Write(('O' * 8192)); Start-Sleep -Seconds 300"
      } elseif ($Mode -eq 'stderr-overflow') {
        $producerText =
          "[Console]::Error.Write(('E' * 8192)); Start-Sleep -Seconds 300"
      } elseif ($Mode -eq 'directory-quota') {
        $producerText = @"
[IO.File]::WriteAllBytes(
  '$($quotaPath.Replace("'", "''"))',
  [byte[]]::new(65536)
)
Start-Sleep -Seconds 300
"@
      } else {
        $producerText = "throw 'unreachable launch exception producer'"
      }
      [IO.File]::WriteAllText(
        $producerPath,
        $producerText,
        [Text.UTF8Encoding]::new($false)
      )

      $Result = $null
      $launchExceptionObserved = $false
      if ($Mode -eq 'launch-exception') {
        $missingApplication = Join-Path `
          $env:SystemRoot `
          "System32\OpenCovenMissing-$([Guid]::NewGuid().ToString('N')).exe"
        try {
          $Job.RunProducerAsUserAndQuarantine(
            $Context.User,
            $missingApplication,
            '',
            $Context.User.RootPath,
            $Context.Environment,
            [TimeSpan]::FromSeconds(30),
            256,
            256
          ) | Out-Null
        } catch {
          $launchExceptionObserved = $_.Exception.ToString().Contains(
            'Terminal producer attempt failed.'
          )
        }
        if (-not $launchExceptionObserved) {
          throw 'Terminal producer launch exception was not observed.'
        }
      } else {
        [OpenCoven.WindowsDirectoryQuota[]]$directoryQuotas =
          [OpenCoven.WindowsDirectoryQuota[]]::new(0)
        if ($Mode -eq 'directory-quota') {
          $directoryQuotas = [OpenCoven.WindowsDirectoryQuota[]]@(
            [OpenCoven.WindowsDirectoryQuota]::new(
              'terminal failure workspace',
              $Context.User.WorkspacePath,
              1KB
            )
          )
        }
        try {
          $Result = $Job.RunProducerAsUserAndQuarantine(
            $Context.User,
            $trustedPwsh,
            "-NoLogo -NoProfile -NonInteractive -File `"$producerPath`"",
            $Context.User.RootPath,
            $Context.Environment,
            [TimeSpan]::FromSeconds(30),
            256,
            256,
            $directoryQuotas
          )
        } catch {
          throw "Terminal failure '$Label' producer attempt failed: $($_.Exception.ToString())"
        }
        if (
          $Mode -eq 'stdout-overflow' -and
          (-not $Result.StdoutOverflow -or $Result.ExitCode -eq 0)
        ) {
          throw 'Terminal stdout overflow did not fail closed.'
        }
        if (
          $Mode -eq 'stderr-overflow' -and
          (-not $Result.StderrOverflow -or $Result.ExitCode -eq 0)
        ) {
          throw 'Terminal stderr overflow did not fail closed.'
        }
        if (
          $Mode -eq 'directory-quota' -and
          (-not $Result.ResourceQuotaExceeded -or $Result.ExitCode -eq 0)
        ) {
          throw 'Terminal directory quota failure did not fail closed.'
        }
      }

      if (
        -not $Context.User.IsDisabled -or
        (Get-LocalUser -Name $Context.User.UserName).Enabled
      ) {
        throw 'Terminal failure account was not disabled.'
      }
      if (-not $Job.IsQuarantineComplete) {
        throw 'Terminal failure quarantine did not complete.'
      }
      Assert-ProcessExited -ProcessId $persistence.SetupPid
      Assert-NoExactSidPersistence -Sid $Context.User.Sid
      Assert-ScheduledTaskAbsent `
        -TaskPath $persistence.TaskPath `
        -Failure 'Terminal failure exact-SID scheduled task'
      $bitsListing = & (Join-Path $env:SystemRoot 'System32\bitsadmin.exe') `
        /list `
        /allusers `
        /verbose 2>&1 | Out-String
      if ($LASTEXITCODE -ne 0 -or $bitsListing.Contains($persistence.BitsName)) {
        throw 'Terminal failure exact-SID BITS job survived quarantine.'
      }

      $beforeSecondQuarantine =
        Get-TerminalQuarantineState -Job $Job -Context $Context
      $Job.QuarantineIsolatedIdentity()
      $afterSecondQuarantine =
        Get-TerminalQuarantineState -Job $Job -Context $Context
      if ($afterSecondQuarantine -cne $beforeSecondQuarantine) {
        throw 'Second terminal quarantine invocation changed completed state.'
      }

      $captureRejected = $false
      try {
        $Job.CaptureIsolatedArtifact(
          $Context.User,
          $Context.User.WorkspacePath,
          $recordPath,
          1MB
        ) | Out-Null
      } catch {
        $captureRejected = $_.Exception.ToString().Contains(
          'successful terminal producer attempt'
        )
      }
      if (-not $captureRejected) {
        throw 'Terminal failure artifact capture was not rejected.'
      }
    } finally {
      $cleanupErrors = [Collections.Generic.List[Exception]]::new()
      if ($null -ne $persistence) {
        try {
          $setupProcess = [Diagnostics.Process]::GetProcessById(
            [int]$persistence.SetupPid
          )
          try {
            if (-not $setupProcess.HasExited) {
              $setupProcess.Kill($true)
              $setupProcess.WaitForExit()
            }
          } finally {
            $setupProcess.Dispose()
          }
        } catch [ArgumentException] {
        } catch {
          $cleanupErrors.Add($_.Exception)
        }
      }
      try {
        Remove-IsolatedTestContext -Context $Context
      } catch {
        $cleanupErrors.Add(
          [InvalidOperationException]::new(
            "Terminal failure '$Label' context cleanup failed: $($_.Exception.ToString())",
            $_.Exception
          )
        )
      }
      if ($null -ne $Job) {
        try {
          $Job.Dispose()
        } catch {
          $cleanupErrors.Add($_.Exception)
        }
      }
      if ($cleanupErrors.Count -ne 0) {
        $cleanupDetails = (
          $cleanupErrors |
            ForEach-Object { $_.ToString() }
        ) -join "`n---`n"
        throw "Terminal failure '$Label' cleanup failed:`n$cleanupDetails"
      }
    }
    if (
      $null -ne (
        Get-LocalUser -Name $userName -ErrorAction SilentlyContinue
      )
    ) {
      throw 'Terminal failure ephemeral local user survived cleanup.'
    }
    if ([IO.Directory]::Exists($profilePath)) {
      throw 'Terminal failure ephemeral Windows profile survived cleanup.'
    }
    if ([IO.Directory]::Exists($rootPath)) {
      throw 'Terminal failure ephemeral bootstrap root survived cleanup.'
    }
  }

  Assert-TerminalFailureQuarantine `
    -Label 'stdout-overflow' `
    -Mode 'stdout-overflow'
  Assert-TerminalFailureQuarantine `
    -Label 'stderr-overflow' `
    -Mode 'stderr-overflow'
  Assert-TerminalFailureQuarantine `
    -Label 'directory-quota' `
    -Mode 'directory-quota'
  Assert-TerminalFailureQuarantine `
    -Label 'launch-exception' `
    -Mode 'launch-exception'

  $disableFailureContext = New-IsolatedTestContext -Label 'disable-failure'
  $disableFailureJob = $null
  try {
    $disableFailureRecord = Join-Path `
      $disableFailureContext.User.WorkspacePath `
      '.artifacts\record.json'
    [IO.Directory]::CreateDirectory(
      [IO.Directory]::GetParent($disableFailureRecord).FullName
    ) | Out-Null
    [IO.File]::WriteAllBytes(
      $disableFailureRecord,
      $expectedHandoffBytes
    )
    $disableFailureJob = [OpenCoven.WindowsJobSupervisor]::Create(
      "Local\OpenCoven.Chat.SupervisorTest.$([Guid]::NewGuid().ToString('N'))",
      $disableFailureContext.User
    )
    Remove-LocalUser -Name $disableFailureContext.User.UserName
    $disableFailureClosed = $false
    try {
      $disableFailureJob.QuarantineIsolatedIdentity()
    } catch {
      $disableFailureClosed = $_.Exception.ToString().Contains(
        'disablement preflight could not be queried'
      )
    }
    if (-not $disableFailureClosed) {
      throw 'Account-disable verification failure did not fail closed.'
    }
  } finally {
    if ($null -ne $disableFailureJob) {
      $disableFailureJob.Dispose()
    }
    Remove-IsolatedTestContext -Context $disableFailureContext
  }

  $timeoutContext = New-IsolatedTestContext -Label 'terminal-timeout'
  $timeoutJob = $null
  try {
    $timeoutPids = Join-Path $timeoutContext.User.RootPath 'timeout-pids.txt'
    $timeoutScript = Join-Path $timeoutContext.User.RootPath 'timeout.ps1'
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
      $timeoutContext.User
    )
    $result = $timeoutJob.RunProducerAsUserAndQuarantine(
      $timeoutContext.User,
      $trustedPwsh,
      "-NoLogo -NoProfile -NonInteractive -File `"$timeoutScript`"",
      $timeoutContext.User.RootPath,
      $timeoutContext.Environment,
      [TimeSpan]::FromSeconds(8),
      1MB,
      1MB
    )
    if (-not $result.TimedOut -or $result.ExitCode -eq 0) {
      throw 'Timed-out supervised tree did not fail closed.'
    }
    if (-not $timeoutJob.IsQuarantineComplete) {
      throw 'Timed-out producer terminal quarantine did not complete.'
    }
    $timeoutTree = [IO.File]::ReadAllLines($timeoutPids)
    if ($timeoutTree.Count -ne 2) {
      throw 'Timed-out child/grandchild PID record is incomplete.'
    }
    $timeoutTree | ForEach-Object { Assert-ProcessExited -ProcessId ([int]$_) }
  } finally {
    if ($null -ne $timeoutJob) {
      $timeoutJob.Dispose()
    }
    Remove-IsolatedTestContext -Context $timeoutContext
  }

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
`$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
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
`$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
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
