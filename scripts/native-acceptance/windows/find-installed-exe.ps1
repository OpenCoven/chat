$ErrorActionPreference = 'Stop'

# Node is already required by the lane. Share its bounded file resolver with
# the upgrade row instead of recursively accepting a binary from another folder.
$exe = & node (Join-Path $PSScriptRoot 'installed-exe.mjs')
if ($LASTEXITCODE -ne 0) { throw 'The installed opencoven-chat.exe was not found.' }
Write-Output $exe
