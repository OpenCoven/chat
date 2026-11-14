# The Windows native lane: verify and install the published MSI or setup EXE on
# a fresh runner, record what the runner is, then drive the app with run.mjs.
param(
  [string]$Release = '',
  [Parameter(Mandatory = $true)][string]$Out,
  [ValidateSet('msi', 'exe')][string]$Installer = 'msi'
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding $false
function Log($text) {
  Write-Output $text
  [System.IO.File]::AppendAllText((Join-Path $Out 'environment.txt'), "$text`n", $utf8)
}

$work = Join-Path $env:RUNNER_TEMP 'native-installer'
New-Item -ItemType Directory -Force -Path $work | Out-Null
if ($env:CANDIDATE_INSTALLER) {
  # A candidate: this commit, built on this runner. Not a published release, so
  # there is no SHA256SUMS to check, and the results say so.
  $commit = (git -C (Join-Path $PSScriptRoot '..\..') rev-parse --short HEAD)
  $Release = "candidate $commit"
  # Tauri names the bundle with a space; release assets carry a dot instead.
  $asset = (Split-Path -Leaf $env:CANDIDATE_INSTALLER) -replace ' ', '.'
  Copy-Item $env:CANDIDATE_INSTALLER (Join-Path $work $asset)
  $sha = (Get-FileHash -Algorithm SHA256 (Join-Path $work $asset)).Hash.ToLowerInvariant()
  $sums = 'none (candidate)'
  Log "checksum: candidate build of $commit ($asset $sha); not a published release, so no SHA256SUMS"
  $sourceLabel = "candidate $Installer built from $commit, not a published release"
} else {
  $version = $Release.TrimStart('v')
  $suffix = if ($Installer -eq 'msi') { 'x64_en-US.msi' } else { 'x64-setup.exe' }
  $base = "https://github.com/OpenCoven/chat/releases/download/$Release"
  Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile (Join-Path $work 'SHA256SUMS')
  $asset = & node (Join-Path $PSScriptRoot '../release-installer.mjs') (Join-Path $work 'SHA256SUMS') $version $suffix
  if ($LASTEXITCODE -ne 0) { throw 'Could not identify the published installer.' }
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile (Join-Path $work $asset)
  $expected = (Get-Content (Join-Path $work 'SHA256SUMS') | Where-Object { $_ -match "  $([regex]::Escape($asset))$" }) -replace '\s.*$', ''
  $sha = (Get-FileHash -Algorithm SHA256 (Join-Path $work $asset)).Hash.ToLowerInvariant()
  $sums = (Get-FileHash -Algorithm SHA256 (Join-Path $work 'SHA256SUMS')).Hash.ToLowerInvariant()
  Log "checksum: $asset $sha, SHA256SUMS lists $expected"
  if (-not $expected -or $sha -ne $expected) { throw "$asset does not match SHA256SUMS" }
  $sourceLabel = "published $Installer $Release"
}

Log "prior app data: $(Test-Path "$env:LOCALAPPDATA\ai.opencoven.chat") $(Test-Path "$env:APPDATA\ai.opencoven.chat")"
# A wide desktop for the 1400px rows, and Edge without its first-run pages.
try { Set-DisplayResolution -Width 1920 -Height 1080 -Force | Out-Null; Log 'display: 1920x1080' } catch { Log "display: $($_.Exception.Message)" }
New-Item -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Edge' -Force | Out-Null
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Edge' -Name HideFirstRunExperience -Value 1 -Type DWord
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Edge' -Name DefaultBrowserSettingEnabled -Value 0 -Type DWord

if ($Installer -eq 'msi') {
  $p = Start-Process msiexec.exe -ArgumentList @('/i', (Join-Path $work $asset), '/qn', '/l*v', (Join-Path $Out 'msiexec.log')) -Wait -PassThru
} else {
  $p = Start-Process (Join-Path $work $asset) -ArgumentList '/S' -Wait -PassThru
}
Log "installer exit: $($p.ExitCode)"
$exe = & (Join-Path $PSScriptRoot 'windows\find-installed-exe.ps1')
Log "installed: $exe"
$exeSha = (Get-FileHash -Algorithm SHA256 $exe).Hash.ToLowerInvariant()
$signature = Get-AuthenticodeSignature $exe
$webview = (Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue).pv

# Row 578: the published v0.0.8 MSI, checked against v0.0.8's SHA256SUMS. The
# row installs it over this build after the other rows, then this build over
# it, and looks for what v0.0.8 saved in the web view's autofill.
$upgrade = @()
$upgradeFact = 'not run'
# Releases before v0.1.2 don't clear it, so the row runs on candidates and on
# v0.1.2 or later.
try {
  $clears = if ($env:CANDIDATE_INSTALLER) { $true } else { [version]($Release.TrimStart('v') -replace '[-+].*$', '') -ge [version]'0.1.2' }
} catch { $clears = $true }
if ($Installer -ne 'msi') {
  $upgradeFact = 'not run: the upgrade row drives MSIs only'
} elseif (-not $clears) {
  $upgradeFact = "not run: $Release is older than v0.1.2, the first release that clears it"
} else {
  try {
    $old = 'OpenCoven.Chat_0.0.8_x64_en-US.msi'
    $oldWork = Join-Path $work 'v0.0.8'
    New-Item -ItemType Directory -Force -Path $oldWork | Out-Null
    $oldBase = 'https://github.com/OpenCoven/chat/releases/download/v0.0.8'
    Invoke-WebRequest -UseBasicParsing -Uri "$oldBase/SHA256SUMS" -OutFile (Join-Path $oldWork 'SHA256SUMS')
    Invoke-WebRequest -UseBasicParsing -Uri "$oldBase/$old" -OutFile (Join-Path $oldWork $old)
    $oldExpected = (Get-Content (Join-Path $oldWork 'SHA256SUMS') | Where-Object { $_ -match "  $([regex]::Escape($old))$" }) -replace '\s.*$', ''
    $oldSha = (Get-FileHash -Algorithm SHA256 (Join-Path $oldWork $old)).Hash.ToLowerInvariant()
    Log "upgrade row: $old $oldSha, v0.0.8's SHA256SUMS lists $oldExpected"
    if (-not $oldExpected -or $oldSha -ne $oldExpected) { throw "$old does not match v0.0.8's SHA256SUMS" }
    $upgrade = @('--upgrade-from', (Join-Path $oldWork $old), '--upgrade-to', (Join-Path $work $asset))
    $upgradeFact = "published msi v0.0.8 ($old $oldSha, matches its SHA256SUMS), then $sourceLabel over it"
  } catch {
    # Windows PowerShell passes a double quote inside a native argument badly.
    $upgradeFact = "blocked: $($_.Exception.Message)" -replace '"', "'"
    $upgrade = @('--upgrade-blocked', $upgradeFact)
  }
}
Log "upgrade row: $upgradeFact"

# NVDA, portable, writing what it speaks to a log at IO level.
$nvdaVersion = '2025.3.2'
$nvdaSetup = Join-Path $work "nvda_$nvdaVersion.exe"
Invoke-WebRequest -UseBasicParsing -Uri "https://download.nvaccess.org/releases/$nvdaVersion/nvda_$nvdaVersion.exe" -OutFile $nvdaSetup
$nvdaSha = (Get-FileHash -Algorithm SHA256 $nvdaSetup).Hash.ToLowerInvariant()
$nvdaDir = Join-Path $work 'nvda'
Start-Process $nvdaSetup -ArgumentList @('--create-portable-silent', "--portable-path=$nvdaDir") -Wait
$nvda = Join-Path $nvdaDir 'nvda.exe'
# No welcome dialog or update prompt: either would take focus from the app.
$nvdaConfig = Join-Path $nvdaDir 'userConfig'
New-Item -ItemType Directory -Force -Path $nvdaConfig | Out-Null
@(
  '[general]', 'showWelcomeDialogAtStartup = False',
  '[update]', 'autoCheck = False', 'askedAllowUsageStats = True', 'allowUsageStats = False'
) | Set-Content -Encoding ASCII (Join-Path $nvdaConfig 'nvda.ini')
Log "NVDA $nvdaVersion portable: $(Test-Path $nvda) (installer sha256 $nvdaSha)"

# Japanese: the Microsoft IME, added to the user's languages.
$languages = Get-WinUserLanguageList
if (-not ($languages | Where-Object LanguageTag -eq 'ja')) { $languages.Add('ja-JP'); Set-WinUserLanguageList $languages -Force }
Log "input methods: $((Get-WinUserLanguageList).InputMethodTips -join ', ')"

$facts = [ordered]@{
  release = $Release
  installer = $asset
  installerSha256 = $sha
  sha256sumsSha256 = $sums
  installedExe = $exe
  installedExeSha256 = $exeSha
  authenticode = "$($signature.Status) $($signature.SignerCertificate.Subject)"
  windows = "$((Get-CimInstance Win32_OperatingSystem).Caption) $([Environment]::OSVersion.Version)"
  webview2 = $webview
  nvda = "$nvdaVersion portable, installer sha256 $nvdaSha (recorded, not pinned)"
  profile = 'fresh runner user; no prior ai.opencoven.chat data'
  upgradeFrom = $upgradeFact
}
[System.IO.File]::WriteAllText((Join-Path $Out 'facts.json'), ($facts | ConvertTo-Json), $utf8)

try {
  $ErrorActionPreference = 'Continue'
  $selfTest = '{"cmd":"screens","id":1}' | powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'windows\serve.ps1') 2>&1 | Out-String
} catch { $selfTest = "self-test threw: $($_.Exception.Message)" } finally { $ErrorActionPreference = 'Stop' }
Log "helper self-test: $($selfTest.Trim())"

$label = "$((Get-CimInstance Win32_OperatingSystem).Caption), $sourceLabel"
node (Join-Path $PSScriptRoot 'run.mjs') --app $exe --out $Out --lane $label --facts (Join-Path $Out 'facts.json') `
  --nvda $nvda --japanese 00000411 --latin 00000409 --ime-on imeon --ime-off imeoff @upgrade
exit $LASTEXITCODE
