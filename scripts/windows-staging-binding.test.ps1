$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not ('OpenCoven.WindowsJobSupervisor' -as [type])) {
  Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'windows-job-supervisor.cs'))) -Language CSharp
}
foreach ($sid in @($null, '', ' ')) {
  $rejected = $false
  try {
    [OpenCoven.WindowsJobSupervisor]::RequireCurrentIdentityOwnsStatusStagingDirectory('unused', $sid)
  } catch {
    $failure = $_.Exception
    while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
    $rejected = $failure -is [InvalidOperationException] -and
      $failure.Message -ceq 'Status staging supervisor identity is required.'
  }
  if (-not $rejected) { throw 'Missing staging supervisor identity was not rejected before identity lookup.' }
}
Write-Host 'Missing staging supervisor identity fails closed before identity lookup.'
