$ErrorActionPreference = 'Stop'

$lock = Get-Content -LiteralPath 'phase1-conformance.lock.json' -Raw | ConvertFrom-Json
$artifact = $lock.tools.windowsSupervisor.artifact
$source = Join-Path 'windows-supervisor-artifact' $artifact.fileName
$destination = $artifact.fleetPath
$reparsePoint = [IO.FileAttributes]::ReparsePoint
$sourceItem = Get-Item -LiteralPath $source

if (
  $sourceItem.PSIsContainer -or
  (($sourceItem.Attributes -band $reparsePoint) -ne 0) -or
  $sourceItem.Length -ne $artifact.size
) {
  throw 'unexpected Windows supervisor size'
}
if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $artifact.sha256) {
  throw 'unexpected Windows supervisor digest'
}

$destinationDirectory = Split-Path -Parent $destination
New-Item -ItemType Directory -Force $destinationDirectory | Out-Null
$destinationDirectoryItem = Get-Item -LiteralPath $destinationDirectory
if (
  -not $destinationDirectoryItem.PSIsContainer -or
  (($destinationDirectoryItem.Attributes -band $reparsePoint) -ne 0)
) {
  throw 'unsafe Windows supervisor destination directory'
}
if (Test-Path -LiteralPath $destination) {
  throw 'Windows supervisor destination already exists'
}
Copy-Item -LiteralPath $source -Destination $destination
$installedItem = Get-Item -LiteralPath $destination
if (
  $installedItem.PSIsContainer -or
  (($installedItem.Attributes -band $reparsePoint) -ne 0) -or
  $installedItem.Length -ne $artifact.size -or
  (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $artifact.sha256
) {
  throw 'installed Windows supervisor digest mismatch'
}

"OPENCOVEN_PHASE1_WINDOWS_SUPERVISOR_PATH=$destination" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
