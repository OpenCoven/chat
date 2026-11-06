# What a fresh Windows runner offers the native lane, against the published MSI.
# Usage: probe-windows.ps1 -Release v0.0.8 -Out <dir>
param([string]$Release, [string]$Out)
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$log = Join-Path $Out 'probe.txt'
function Log($text) { $text | Tee-Object -FilePath $log -Append }

$version = $Release.TrimStart('v')
$work = Join-Path $env:RUNNER_TEMP 'probe'
New-Item -ItemType Directory -Force -Path $work | Out-Null
$base = "https://github.com/OpenCoven/chat/releases/download/$Release"
$msi = "OpenCoven.Chat_${version}_x64_en-US.msi"
Invoke-WebRequest "$base/SHA256SUMS" -OutFile "$work\SHA256SUMS"
Invoke-WebRequest "$base/$msi" -OutFile "$work\$msi"
$expected = (Select-String -Path "$work\SHA256SUMS" -SimpleMatch "  $msi").Line.Split(' ')[0]
$actual = (Get-FileHash -Algorithm SHA256 "$work\$msi").Hash.ToLower()
Log "checksum: $msi expected $expected actual $actual match $($expected -eq $actual)"
Log "Windows: $((Get-CimInstance Win32_OperatingSystem).Caption) $((Get-CimInstance Win32_OperatingSystem).Version)"
$wv = Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue
Log "WebView2: $($wv.pv)"
$install = Start-Process msiexec.exe -ArgumentList "/i `"$work\$msi`" /qn /norestart /l*v `"$Out\msi.log`"" -Wait -PassThru
Log "msiexec exit: $($install.ExitCode)"
$exe = Get-ChildItem -Path "$env:ProgramFiles", "$env:LOCALAPPDATA\Programs" -Recurse -Filter 'opencoven-chat.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
Log "installed: $($exe.FullName)"
Log "prior app data: $(Test-Path "$env:LOCALAPPDATA\ai.opencoven.chat")"

$app = Start-Process $exe.FullName -PassThru
Start-Sleep -Seconds 15
Log "app pid: $($app.Id)"

. (Join-Path $PSScriptRoot 'windows\NativeDriver.ps1')
$tree = Get-NativeTree -ProcessId $app.Id -Depth 40
$tree | ConvertTo-Json -Depth 100 -Compress | Set-Content -Path (Join-Path $Out 'uia.json')
Log "uia names: $((Get-Content (Join-Path $Out 'uia.json') -Raw).Length) bytes"
Select-String -Path (Join-Path $Out 'uia.json') -Pattern '"name":"[^"]+"' -AllMatches | ForEach-Object { $_.Matches.Value } | Sort-Object -Unique | Select-Object -First 60 | Add-Content $log

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
[System.Drawing.Graphics]::FromImage($bitmap).CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bitmap.Save((Join-Path $Out 'screen.png'))
Log "screen: $($bounds.Width)x$($bounds.Height)"

# NVDA, portable, with speech written to its log.
$nvda = Join-Path $work 'nvda.exe'
try {
  Invoke-WebRequest 'https://download.nvaccess.org/releases/2025.3.2/nvda_2025.3.2.exe' -OutFile $nvda
  $portable = Join-Path $work 'nvda-portable'
  $p = Start-Process $nvda -ArgumentList "--create-portable-silent --portable-path=`"$portable`"" -Wait -PassThru
  Log "nvda portable exit: $($p.ExitCode); files: $((Get-ChildItem $portable -ErrorAction SilentlyContinue).Count)"
  $nvdaLog = Join-Path $Out 'nvda.log'
  Start-Process (Join-Path $portable 'nvda.exe') -ArgumentList "--log-file=`"$nvdaLog`" --log-level=12 --minimal" | Out-Null
  Start-Sleep -Seconds 20
  Log "nvda speech lines: $((Select-String -Path $nvdaLog -Pattern 'Speaking' -ErrorAction SilentlyContinue).Count)"
} catch { Log "nvda: $($_.Exception.Message)" }

# A Japanese input method.
try {
  $capability = Get-WindowsCapability -Online -Name 'Language.Basic~~~ja-JP*' -ErrorAction Stop
  Log "ja-JP capability: $($capability.Name) $($capability.State)"
} catch { Log "ja-JP capability query: $($_.Exception.Message)" }
Log "input languages: $((Get-WinUserLanguageList | ForEach-Object { $_.LanguageTag + ':' + ($_.InputMethodTips -join ',') }) -join '; ')"
Stop-Process -Id $app.Id -ErrorAction SilentlyContinue
exit 0
