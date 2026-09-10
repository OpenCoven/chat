$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not ('OpenCoven.WindowsProcessSidDiagnostics' -as [type])) {
  Add-Type -TypeDefinition ([IO.File]::ReadAllText(
    (Join-Path $PSScriptRoot 'windows-process-sid-diagnostics.cs')
  )) -Language CSharp
}
$observe = [OpenCoven.WindowsProcessSidDiagnostics].GetMethod(
  'ObserveAmbiguousProcessSid',
  [Reflection.BindingFlags]'NonPublic,Static'
)
if ($null -eq $observe) {
  throw 'Bounded null-SID observation is missing.'
}

# Throw from a managed delegate directly: a PowerShell scriptblock wraps native
# exceptions and would test PowerShell's adapter instead of the C# boundary.
Add-Type -TypeDefinition @'
public sealed class SidDiagnosticDeniedQuery
{
    public int Calls;
    public bool Unexpected;
    public string Query(System.IntPtr handle)
    {
        if (handle != new System.IntPtr(1)) throw new System.Exception("Wrong query handle.");
        Calls++;
        if (Unexpected) throw new System.Exception("untrusted diagnostic detail");
        throw new System.ComponentModel.Win32Exception(5);
    }
}
'@

foreach ($case in @(
  @{ Name = 'missing'; Open = 0; Error = 87; Wait = 258; Token = 'readable'; Expected = 'open-not-found:87'; Queries = 0; Waits = 0 },
  @{ Name = 'denied'; Open = 0; Error = 5; Wait = 258; Token = 'readable'; Expected = 'open-failed:5'; Queries = 0; Waits = 0 },
  @{ Name = 'exited'; Open = 1; Error = 0; Wait = 0; Token = 'readable'; Expected = 'exited'; Queries = 0; Waits = 1 },
  @{ Name = 'live-readable'; Open = 1; Error = 0; Wait = 258; Token = 'S-1-5-21-private'; Expected = 'live-token-readable'; Queries = 1; Waits = 2 },
  @{ Name = 'live-unreadable'; Open = 1; Error = 5; Wait = 258; Token = 'throw'; Expected = 'live-token-unreadable:5'; Queries = 1; Waits = 2 },
  @{ Name = 'live-empty'; Open = 1; Error = 0; Wait = 258; Token = ''; Expected = 'live-token-invalid'; Queries = 1; Waits = 2 },
  @{ Name = 'wait-failed'; Open = 1; Error = 6; Wait = [uint32]::MaxValue; Token = 'readable'; Expected = 'wait-failed:6'; Queries = 0; Waits = 1 },
  @{ Name = 'second-wait-failed'; Open = 1; Error = 6; Wait = 258; SecondWait = [uint32]::MaxValue; Token = 'readable'; Expected = 'wait-failed:6'; Queries = 1; Waits = 2 },
  @{ Name = 'exit-during-query'; Open = 1; Error = 5; Wait = 258; Token = 'throw'; SecondWait = 0; Expected = 'exited-during-query'; Queries = 1; Waits = 2 }
)) {
  $calls = @{ Open = 0; Wait = 0; Query = 0; Close = 0 }
  $arguments = [object[]]::new(6)
  $arguments[0] = [uint32]123
  $arguments[1] = [Func[uint32, IntPtr]]{
    param($processId)
    if ($processId -ne 123) { throw 'Wrong diagnostic PID.' }
    $calls.Open++
    return [IntPtr]$case.Open
  }
  $arguments[2] = [Func[int]]{ return [int]$case.Error }
  $arguments[3] = [Func[IntPtr, uint32]]{
    param($handle)
    if ($handle -ne [IntPtr]1) { throw 'Wrong wait handle.' }
    $calls.Wait++
    if ($calls.Wait -eq 2 -and $case.ContainsKey('SecondWait')) {
      return [uint32]$case.SecondWait
    }
    return [uint32]$case.Wait
  }
  $arguments[4] = [Func[IntPtr, string]]{
    param($handle)
    if ($handle -ne [IntPtr]1) { throw 'Wrong token handle.' }
    $calls.Query++
    if ($case.Token -ceq 'throw') {
      throw [ComponentModel.Win32Exception]::new([int]$case.Error)
    }
    return [string]$case.Token
  }
  $arguments[5] = [Action[IntPtr]]{
    param($handle)
    if ($handle -ne [IntPtr]1) { throw 'Wrong close handle.' }
    $calls.Close++
  }
  $deniedQuery = [SidDiagnosticDeniedQuery]::new()
  if ($case.Token -ceq 'throw') {
    $arguments[4] = [Delegate]::CreateDelegate(
      [Func[IntPtr, string]], $deniedQuery, 'Query'
    )
  }
  $actual = $observe.Invoke($null, $arguments)
  $calls.Query += $deniedQuery.Calls
  if ($actual -cne $case.Expected -or $calls.Open -ne 1 -or
      $calls.Wait -ne $case.Waits -or $calls.Query -ne $case.Queries -or
      $calls.Close -ne $case.Open) {
    throw "Bounded SID diagnostic case $($case.Name) failed: $actual; $($calls | ConvertTo-Json -Compress)"
  }
}
# Unexpected query failures propagate to the native call site's fixed fallback,
# but must still release the only opened handle.
$calls = @{ Open = 0; Wait = 0; Query = 0; Close = 0 }
$deniedQuery = [SidDiagnosticDeniedQuery]::new()
$deniedQuery.Unexpected = $true
$arguments[4] = [Delegate]::CreateDelegate(
  [Func[IntPtr, string]], $deniedQuery, 'Query'
)
$unexpectedFailed = $false
try {
  $null = $observe.Invoke($null, $arguments)
} catch [Management.Automation.MethodInvocationException] {
  $underlying = $_.Exception.InnerException
  if ($underlying -is [Reflection.TargetInvocationException]) {
    $underlying = $underlying.InnerException
  }
  $unexpectedFailed = $underlying.GetType() -eq [Exception]
}
if (-not $unexpectedFailed -or $calls.Open -ne 1 -or $calls.Wait -ne 1 -or
    $deniedQuery.Calls -ne 1 -or $calls.Close -ne 1) {
  throw 'Unexpected query failure did not preserve bounded cleanup.'
}
# Execute only the checked-in reporter function, without starting the native
# suite. This verifies aggregate traversal and its shared probe budget on any OS.
$parseTokens = $null
$parseErrors = $null
$reporterFile = [Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $PSScriptRoot 'windows-job-supervisor.test.ps1'),
  [ref]$parseTokens, [ref]$parseErrors
)
if ($parseErrors.Count -ne 0) { throw 'Native suite parse failed.' }
$reporter = $reporterFile.Find({
  param($node)
  $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -ceq 'Write-ExceptionChain'
}, $false)
if ($null -eq $reporter) { throw 'Failure reporter definition is missing.' }
Invoke-Expression $reporter.Extent.Text
$children = [Collections.Generic.List[Exception]]::new()
$children.Add([Exception]::new('Synthetic producer failure.'))
foreach ($index in 1..2) {
  $children.Add([Exception]::new(
    "WTS process primary token SID query was ambiguous for process $PID in session 1."
  ))
}
foreach ($index in 3..20) { $children.Add([Exception]::new('Synthetic extra failure.')) }
$report = @(Write-ExceptionChain -Failure ([AggregateException]::new($children)) 6>&1 |
  ForEach-Object { $_.ToString() })
if (@($report | Where-Object { $_.StartsWith('cause[') }).Count -ne 12 -or
    @($report | Where-Object { $_.StartsWith('wts-null-sid-observation:') }).Count -ne 1) {
  throw 'Aggregate reporting exceeded its bounds or missed the sibling ambiguity.'
}
Write-Host 'Bounded null-SID diagnostic cases passed.'
