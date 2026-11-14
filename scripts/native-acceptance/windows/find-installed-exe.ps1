$ErrorActionPreference = 'Stop'

$exe = @(
  "$env:LOCALAPPDATA\Programs\Coven Chat\opencoven-chat.exe",
  "$env:LOCALAPPDATA\Coven Chat\opencoven-chat.exe",
  "$env:ProgramFiles\Coven Chat\opencoven-chat.exe",
  "$env:LOCALAPPDATA\Programs\OpenCoven Chat\opencoven-chat.exe",
  "$env:LOCALAPPDATA\OpenCoven Chat\opencoven-chat.exe",
  "$env:ProgramFiles\OpenCoven Chat\opencoven-chat.exe"
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1

if (-not $exe) {
  $exe = Get-ChildItem -Path $env:LOCALAPPDATA, $env:ProgramFiles -Filter opencoven-chat.exe `
    -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $exe) { throw 'The installed opencoven-chat.exe was not found.' }

Write-Output $exe
