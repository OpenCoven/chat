$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -Path (Join-Path $PSScriptRoot 'windows-job-supervisor.cs')
$measure = [OpenCoven.WindowsJobSupervisor].GetMethod('DirectoryQuotaExceeded', [Reflection.BindingFlags]'NonPublic,Static')
$root = Join-Path ([IO.Path]::GetTempPath()) ('opencoven-shared-budget-' + [Guid]::NewGuid().ToString('N'))
try {
  $artifact = [IO.Directory]::CreateDirectory((Join-Path $root 'artifact')).FullName
  $application = [IO.Directory]::CreateDirectory((Join-Path $root 'application')).FullName
  [IO.File]::WriteAllBytes((Join-Path $artifact 'one'), [byte[]]::new(600))
  [IO.File]::WriteAllBytes((Join-Path $application 'two'), [byte[]]::new(600))
  $aggregate = [OpenCoven.WindowsDirectoryQuota]::new('shared aggregate', $artifact, 1000, $true)
  if (-not $measure.Invoke($null, [object[]]@($aggregate, $artifact, $false, $application))) {
    throw 'Split roots exceeded the shared maximum without rejection.'
  }
  [IO.File]::WriteAllBytes((Join-Path $application 'two'), [byte[]]::new(400))
  if ($measure.Invoke($null, [object[]]@($aggregate, $artifact, $false, $application))) {
    throw 'Exact shared maximum was rejected.'
  }
  $component = [OpenCoven.WindowsDirectoryQuota]::new('component', $artifact, 1000)
  if ($measure.Invoke($null, [object[]]@($component, $artifact, $false, $null))) {
    throw 'Ordinary component accounting changed.'
  }
  foreach ($case in @(@($aggregate, $null), @($component, $application))) {
    $rejected = $false
    try { $measure.Invoke($null, [object[]]@($case[0], $artifact, $false, $case[1])) | Out-Null }
    catch { $rejected = $_.Exception.GetBaseException() -is [ArgumentException] }
    if (-not $rejected) { throw 'Unbound or unsolicited application accounting was accepted.' }
  }
  Write-Output 'Shared quota budget tests passed.'
} finally {
  if ([IO.Directory]::Exists($root)) { [IO.Directory]::Delete($root, $true) }
}
