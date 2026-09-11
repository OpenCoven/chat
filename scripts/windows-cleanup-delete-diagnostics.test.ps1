$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not ('OpenCoven.WindowsJobSupervisor' -as [type])) { Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'windows-job-supervisor.cs'))) -Language CSharp }
$supervisorType = [OpenCoven.WindowsJobSupervisor]
$staticFlags = [Reflection.BindingFlags]'NonPublic,Static'
$toExtended = $supervisorType.GetMethod('ToExtendedPath', $staticFlags)
$describe = $supervisorType.GetMethod('DescribeCleanupDeleteContext', $staticFlags)
$throwUnlessDeleted = $supervisorType.GetMethod('ThrowUnlessDeleted', $staticFlags)
$deleteTree = $supervisorType.GetMethod('DeleteDirectoryTree', $staticFlags)
$classify = [OpenCoven.WindowsIsolatedUser].GetMethod('ClassifyCleanupError', $staticFlags)
$exceptionType = $supervisorType.GetNestedType('CleanupDeleteException', [Reflection.BindingFlags]'NonPublic')
foreach ($required in @($toExtended, $describe, $throwUnlessDeleted, $deleteTree, $classify, $exceptionType)) {
  if ($null -eq $required) { throw 'Missing cleanup delete diagnostics member.' }
}

# Extended-length forms: drive-rooted, UNC and already-extended paths.
$extendedCases = @(
  @('C:\a\b.txt', '\\?\C:\a\b.txt'),
  @('\\server\share\dir', '\\?\UNC\server\share\dir'),
  @('\\?\C:\already', '\\?\C:\already'),
  @('C:\trailing.', '\\?\C:\trailing.')
)
foreach ($case in $extendedCases) {
  $actual = $toExtended.Invoke($null, [object[]]@($case[0]))
  if ($actual -cne $case[1]) { throw "Wrong extended path: $actual" }
}
Write-Host 'Extended-length cleanup paths passed.'

# Bounded context: fixed operation/kind labels, depth and length buckets and
# post-failure existence flags. Nothing derived from names or paths.
$contextCases = @(
  @(@('delete-file', 'file', 1, 10, $false, $true), 'op=delete-file;kind=file;depth=le4;len=lt260;entry=gone;parent=present'),
  @(@('remove-directory', 'directory', 9, 259, $true, $true), 'op=remove-directory;kind=directory;depth=le16;len=lt260;entry=present;parent=present'),
  @(@('remove-reparse-file', 'reparse-file', 40, 260, $true, $false), 'op=remove-reparse-file;kind=reparse-file;depth=le64;len=lt1024;entry=present;parent=gone'),
  @(@('delete-read-only-file', 'file', 65, 4096, $false, $false), 'op=delete-read-only-file;kind=file;depth=gt64;len=ge1024;entry=gone;parent=gone')
)
foreach ($case in $contextCases) {
  $actual = $describe.Invoke($null, [object[]]$case[0])
  if ($actual -cne $case[1]) { throw "Wrong cleanup delete context: $actual" }
  if ($actual -notmatch '^[a-z0-9=;-]+$') { throw "Unbounded cleanup delete context: $actual" }
}
Write-Host 'Bounded cleanup delete context passed.'

# The classifier appends the bounded context to the native status and never
# the message or path.
$secret = 'ocv-secret-' + [Guid]::NewGuid().ToString('N')
$contextual = $exceptionType.GetConstructors([Reflection.BindingFlags]'NonPublic,Instance')[0].Invoke(
  @(3, $secret, 'op=delete-file;kind=file;depth=le4;len=lt260;entry=present;parent=present'))
$category = $classify.Invoke($null, [object[]]@($contextual))
if ($category -cne 'win32-3[op=delete-file;kind=file;depth=le4;len=lt260;entry=present;parent=present]') { throw "Wrong contextual cleanup category: $category" }
if ($category.Contains($secret)) { throw 'Contextual cleanup category leaked exception text.' }
$plain = $classify.Invoke($null, [object[]]@([ComponentModel.Win32Exception]::new(3, $secret)))
if ($plain -cne 'win32-3') { throw "Plain native category changed: $plain" }
Write-Host 'Contextual cleanup classification passed.'

# Not-found statuses are accepted only when the managed layer agrees the entry
# is gone; every other status fails closed with context.
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('opencoven-cleanup-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
try {
  $missing = [IO.FileInfo]::new((Join-Path $scratch 'missing.bin'))
  foreach ($status in @(2, 3)) {
    $throwUnlessDeleted.Invoke($null, [object[]]@($status, 'delete-file', 'file', $missing, 3, $secret))
  }
  $present = [IO.FileInfo]::new((Join-Path $scratch 'present.bin'))
  [IO.File]::WriteAllBytes($present.FullName, [byte[]](1, 2, 3))
  $present.Refresh()
  foreach ($probe in @(
      @(3, $present, 'entry=present;parent=present'),
      @(5, $present, 'entry=present;parent=present'),
      @(5, $missing, 'entry=gone;parent=present'),
      @(3, [IO.FileInfo]::new((Join-Path $scratch 'gone-parent\missing.bin')), 'entry=gone;parent=gone'))) {
    $failure = $null
    try { $throwUnlessDeleted.Invoke($null, [object[]]@($probe[0], 'delete-file', 'file', $probe[1], 3, $secret)) } catch { $failure = $_.Exception }
    while ($null -ne $failure -and ($failure -is [Reflection.TargetInvocationException] -or $failure -is [Management.Automation.MethodInvocationException])) { $failure = $failure.InnerException }
    if ($null -eq $failure) {
      if ($probe[0] -eq 3 -and $probe[2] -eq 'entry=gone;parent=gone') { continue }
      throw "Cleanup delete status $($probe[0]) did not fail closed."
    }
    if ($failure.GetType() -ne $exceptionType) { throw "Unexpected cleanup delete failure type: $($failure.GetType().FullName)" }
    if ($failure.NativeErrorCode -ne $probe[0]) { throw 'Cleanup delete status was not retained.' }
    $context = $exceptionType.GetProperty('Context', [Reflection.BindingFlags]'NonPublic,Instance').GetValue($failure)
    if (-not $context.EndsWith($probe[2], [StringComparison]::Ordinal)) { throw "Wrong cleanup delete context: $context" }
    if ($context.Contains('present.bin') -or $context.Contains($scratch)) { throw 'Cleanup delete context leaked a path.' }
  }
  Write-Host 'Cleanup delete fail-closed boundary passed.'

  if ($IsWindows) {
    # Real tree removal through the production walker: a >260 character
    # path, a trailing-dot component reachable only via the extended form,
    # a read-only file and a directory junction whose target must survive.
    $root = Join-Path $scratch 'tree'
    $deep = $root
    while ($deep.Length -lt 300) { $deep = Join-Path $deep ('segment-' + ('x' * 40)) }
    New-Item -ItemType Directory -Path ('\\?\' + $deep) | Out-Null
    [IO.File]::WriteAllBytes((Join-Path $deep 'leaf.bin'), [byte[]](7, 7, 7))
    $dotted = Join-Path $root 'dotted.'
    New-Item -ItemType Directory -Path ('\\?\' + $dotted) | Out-Null
    [IO.File]::WriteAllBytes(('\\?\' + (Join-Path $dotted 'trailing .')), [byte[]](1))
    $readOnly = Join-Path $root 'read-only.bin'
    [IO.File]::WriteAllBytes($readOnly, [byte[]](9))
    Set-ItemProperty -LiteralPath $readOnly -Name Attributes -Value ([IO.FileAttributes]::ReadOnly)
    $target = Join-Path $scratch 'junction-target'
    New-Item -ItemType Directory -Path $target | Out-Null
    [IO.File]::WriteAllBytes((Join-Path $target 'keep.bin'), [byte[]](5))
    New-Item -ItemType Junction -Path (Join-Path $root 'link') -Target $target | Out-Null
    $deleteTree.Invoke($null, [object[]]@($root))
    if (Test-Path -LiteralPath ('\\?\' + $root)) { throw 'Cleanup tree survived removal.' }
    if (-not (Test-Path -LiteralPath (Join-Path $target 'keep.bin'))) { throw 'Cleanup followed a junction into its target.' }
    Write-Host 'Native cleanup tree removal passed.'
  } else {
    Write-Host 'Native cleanup tree removal skipped off Windows.'
  }
} finally {
  if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force }
}
