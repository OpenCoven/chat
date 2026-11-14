# One JSON command per stdin line, one JSON answer per stdout line: the same
# protocol as the macOS and Linux helpers, over NativeDriver.ps1.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'NativeDriver.ps1')
# Explicit UTF-8 streams: the console encodings cannot be set on piped handles.
$utf8 = New-Object System.Text.UTF8Encoding $false
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$writer = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$writer.AutoFlush = $true

$keys = @{
  'tab' = 0x09; 'return' = 0x0D; 'enter' = 0x0D; 'escape' = 0x1B; 'space' = 0x20; 'delete' = 0x08
  'forwarddelete' = 0x2E; 'home' = 0x24; 'end' = 0x23; 'pageup' = 0x21; 'pagedown' = 0x22; 'left' = 0x25
  'up' = 0x26; 'right' = 0x27; 'down' = 0x28; 'f4' = 0x73; 'f5' = 0x74; 'f10' = 0x79
  'apps' = 0x5D; '[' = 0xDB; ']' = 0xDD; 'imeon' = 0x16; 'imeoff' = 0x1A; 'kanji' = 0x19
}
$mods = @{ 'ctrl' = 0x11; 'shift' = 0x10; 'alt' = 0x12; 'win' = 0x5B; 'cmd' = 0x11 }
$target = 0

function Answer($object) { $writer.WriteLine(($object | ConvertTo-Json -Compress -Depth 4)) }

while ($null -ne ($line = $reader.ReadLine())) {
  $raw = $null
  try {
    $command = $line | ConvertFrom-Json
    $modifiers = [uint16[]]@($command.mods | Where-Object { $_ } | ForEach-Object { $mods[$_] })
    switch ($command.cmd) {
      'target' { $target = [int]$command.pid; $answer = @{ ok = $null -ne [NativeDriver]::Window($target) } }
      'activate' { $answer = @{ ok = [NativeDriver]::Foreground($target) } }
      'tree' {
        $processId = if ($command.pid) { [int]$command.pid } else { $target }
        $depth = if ($command.depth) { [int]$command.depth } else { 80 }
        $limit = if ($command.budget) { [int]$command.budget } else { 8000 }
        $raw = '{"ok":true,"tree":' + [NativeDriver]::Tree($processId, $depth, $limit) + '}'
      }
      'focused' { $raw = '{"ok":true,"focused":' + [NativeDriver]::Focused() + '}' }
      'selection' { $answer = @{ ok = $true; text = [NativeDriver]::Selection($target) } }
      'click' {
        [NativeDriver]::Hold($modifiers)
        $button = if ($command.button) { $command.button } else { 'left' }
        $count = if ($command.count) { [int]$command.count } else { 1 }
        [NativeDriver]::Click([int]$command.at[0], [int]$command.at[1], $button, $count)
        [NativeDriver]::Release($modifiers)
        $answer = @{ ok = $true }
      }
      'clickLink' {
        $before = [NativeDriver]::Tree($target, 90, 9000)
        try {
          $receipt = [NativeDriver]::ClickLink($target, [int]$command.at[0], [int]$command.at[1], [string]$command.name)
        } catch {
          # An exception is not evidence whether input was delivered. Preserve
          # that uncertainty and the pre-tree; never retry the click.
          $receipt = @{ clicked = $null; error = "$($_.Exception.Message)"; at = $command.at; expectedName = $command.name } | ConvertTo-Json -Compress
        }
        $verified = $receipt | ConvertFrom-Json
        try { $after = [NativeDriver]::Tree($target, 90, 9000) }
        catch { $after = @{ error = "$($_.Exception.Message)" } | ConvertTo-Json -Compress }
        $ok = if ($verified.clicked) { 'true' } else { 'false' }
        $errorJson = @{ error = $verified.error } | ConvertTo-Json -Compress
        $raw = '{"ok":' + $ok + ',"receipt":' + $receipt + ',"before":' + $before + ',"after":' + $after + ',' + $errorJson.Substring(1)
      }
      'move' { [NativeDriver]::Move([int]$command.at[0], [int]$command.at[1]); $answer = @{ ok = $true } }
      'down' { [NativeDriver]::Down([int]$command.at[0], [int]$command.at[1]); $answer = @{ ok = $true } }
      'up' { [NativeDriver]::Up([int]$command.at[0], [int]$command.at[1]); $answer = @{ ok = $true } }
      'menus' { $raw = '{"ok":true,"menus":' + [NativeDriver]::Menus($target) + '}' }
      'menuAt' { $raw = '{"ok":true,"at":' + [NativeDriver]::MenuAt([double]$command.at[0], [double]$command.at[1]) + '}' }
      'topWindows' { $raw = '{"ok":true,"windows":' + [NativeDriver]::TopWindows() + '}' }
      'screens' {
        Add-Type -AssemblyName System.Windows.Forms
        $answer = @{ ok = $true; screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { @{ w = $_.Bounds.Width; h = $_.Bounds.Height } }) }
      }
      'drag' {
        $flat = [int[]]@($command.path | ForEach-Object { [int]$_[0]; [int]$_[1] })
        $hold = if ($null -ne $command.holdMs) { [int]$command.holdMs } else { 150 }
        [NativeDriver]::Drag($flat, $hold)
        $answer = @{ ok = $true }
      }
      'scroll' {
        [NativeDriver]::Wheel([int]$command.at[0], [int]$command.at[1], [int]$command.dy, [int]$command.dx)
        $answer = @{ ok = $true }
      }
      'key' {
        $name = "$($command.key)".ToLowerInvariant()
        $vk = if ($keys.ContainsKey($name)) { $keys[$name] }
        elseif ($name.Length -eq 1) { [NativeDriver]::VirtualKey($name[0]) }
        elseif ($command.code) { [int]$command.code } else { -1 }
        if ($vk -lt 0) { $answer = @{ ok = $false; error = "unknown key $name" }; break }
        $interval = if ($command.intervalMs) { [int]$command.intervalMs } else { 35 }
        [NativeDriver]::Press([uint16]$vk, $modifiers, [int]$command.repeats, $interval)
        $answer = @{ ok = $true }
      }
      'type' { [NativeDriver]::Type("$($command.text)"); $answer = @{ ok = $true } }
      'setFrame' {
        if ($null -ne $command.w) { [NativeDriver]::Resize($target, [double]$command.w, [double]$command.h) }
        if ($null -ne $command.x) { [NativeDriver]::MoveWindow($target, [double]$command.x, [double]$command.y) }
        Start-Sleep -Milliseconds 300
        $raw = '{"ok":true,"frame":' + [NativeDriver]::Summary([NativeDriver]::Window($target)) + '}'
      }
      'windows' {
        $raw = '{"ok":true,"windows":[' + [NativeDriver]::Summary([NativeDriver]::Window($target)) + ']}'
      }
      'hideApp' { $answer = @{ ok = [NativeDriver]::Minimize([int]$command.pid) } }
      'frontmost' { $answer = @{ ok = $true; pid = [NativeDriver]::ForegroundPid() } }
      'running' {
        $apps = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } |
          ForEach-Object { @{ pid = $_.Id; name = $_.ProcessName; title = $_.MainWindowTitle } }
        $answer = @{ ok = $true; apps = @($apps) }
      }
      'inputSources' { $answer = @{ ok = $true; current = [NativeDriver]::Layout(); enabled = @((Get-WinUserLanguageList).InputMethodTips) } }
      'selectInputSource' { $answer = @{ ok = [NativeDriver]::SelectLayout($target, "$($command.source)"); current = [NativeDriver]::Layout() } }
      default { $answer = @{ ok = $false; error = "unknown command $($command.cmd)" } }
    }
  } catch {
    $answer = @{ ok = $false; error = "$($_.Exception.GetType().Name): $($_.Exception.Message)" }
  }
  if ($raw) {
    if ($null -ne $command.id) { $raw = $raw.Substring(0, $raw.Length - 1) + ',"id":' + [int]$command.id + '}' }
    $writer.WriteLine($raw)
  } else {
    if ($null -ne $command.id) { $answer.id = [int]$command.id }
    Answer $answer
  }
}
