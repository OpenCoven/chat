param([switch]$CompileOnly)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $CompileOnly -and -not $IsWindows) {
  throw 'Profile cleanup characterization requires native Windows.'
}
$sourcePath = if ($env:OPENCOVEN_WINDOWS_JOB_SUPERVISOR_SOURCE) {
  $env:OPENCOVEN_WINDOWS_JOB_SUPERVISOR_SOURCE
} else {
  Join-Path $PSScriptRoot 'windows-job-supervisor.cs'
}
if (-not ('OpenCoven.WindowsJobSupervisor' -as [type])) {
  Add-Type -TypeDefinition ([IO.File]::ReadAllText($sourcePath)) -Language CSharp
}
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;
namespace OpenCoven.Tests {
    public static class ProfileCleanupCharacterization {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true,
            SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(string path, uint access,
            uint sharing, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("userenv.dll", CharSet = CharSet.Unicode, ExactSpelling = true,
            SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool DeleteProfileW(string sid, string path, string computer);
        [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
        private static extern int NetUserGetInfo(string server, string user, int level, out IntPtr info);
        [DllImport("netapi32.dll")]
        private static extern int NetApiBufferFree(IntPtr info);

        public static bool Exists(string path) {
            try {
                File.GetAttributes(path);
                return true;
            } catch (FileNotFoundException) {
                return false;
            } catch (DirectoryNotFoundException) {
                return false;
            }
        }
        public static bool Registered(string sid) {
            using (var key = Registry.LocalMachine.OpenSubKey(
                @"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\" + sid))
                return key != null;
        }
        public static int DeleteAccess(string path) {
            return DeleteAccess(path, false);
        }
        private static int DeleteAccess(string path, bool directory) {
            // Request DELETE, but never set a disposition; do not follow the final reparse point.
            // Files omit backup semantics so enabled restore privileges cannot mask the ACL control.
            using (var handle = CreateFileW(path, 0x00010000, 7, IntPtr.Zero, 3,
                directory ? 0x02200000u : 0x00200000u, IntPtr.Zero))
                return handle.IsInvalid ? Marshal.GetLastWin32Error() : 0;
        }
        public static string DeleteExplicit(string sid, string path) {
            if (DeleteProfileW(sid, path, null)) return "accepted";
            return "win32-" + Marshal.GetLastWin32Error();
        }
        public static string Snapshot(string sid, string profile, string marker) {
            bool hive;
            using (var key = Registry.Users.OpenSubKey(sid)) hive = key != null;
            string app = Path.Combine(profile, ".coven");
            return "registry=" + Bit(Registered(sid)) + ";hive=" + Bit(hive) +
                ";profile=" + Bit(Exists(profile)) + ";application=" + Bit(Exists(app)) +
                ";ntuser=" + Bit(Exists(Path.Combine(profile, "NTUSER.DAT"))) +
                ";marker=" + Bit(Exists(marker)) +
                ";profile-delete-access=" + DeleteAccess(profile, true) +
                ";application-delete-access=" + DeleteAccess(app, true) +
                ";marker-delete-access=" + DeleteAccess(marker);
        }
        private static string Bit(bool value) { return value ? "1" : "0"; }
        public static void RequireAccountMissing(string user) {
            IntPtr info;
            int result = NetUserGetInfo(null, user, 0, out info);
            try {
                if (result != 2221)
                    throw new InvalidOperationException("Characterization account survived cleanup.");
            } finally { if (info != IntPtr.Zero) NetApiBufferFree(info); }
        }
    }
}
'@
if ($CompileOnly) {
  Write-Host 'Profile cleanup characterization compiled; no native operations executed.'
  return
}

$flags = [Reflection.BindingFlags]'NonPublic,Static'
$deleteTree = [OpenCoven.WindowsJobSupervisor].GetMethod('DeleteDirectoryTree', $flags)
$deleteProfile = [OpenCoven.WindowsJobSupervisor].GetMethod('DeleteOperatingSystemProfile', $flags)
$classify = [OpenCoven.WindowsIsolatedUser].GetMethod('ClassifyCleanupError', $flags)
foreach ($member in @($deleteTree, $deleteProfile, $classify)) {
  if ($null -eq $member) { throw 'Profile cleanup characterization seam is missing.' }
}

function Get-ProfileCleanupCategories([Exception]$Failure) {
  $pending = [Collections.Generic.Queue[Exception]]::new()
  $pending.Enqueue($Failure)
  $categories = [Collections.Generic.List[string]]::new()
  $visited = 0
  while ($pending.Count -gt 0) {
    if (++$visited -gt 32) { throw 'Profile cleanup exception graph exceeded its bound.' }
    $item = $pending.Dequeue()
    if ($item -is [AggregateException]) {
      foreach ($inner in $item.InnerExceptions) { $pending.Enqueue($inner) }
    } elseif ($null -ne $item.InnerException) {
      $pending.Enqueue($item.InnerException)
    } else {
      $categories.Add($classify.Invoke($null, [object[]]@($item)))
    }
  }
  return [string]::Join(',', $categories)
}

# No producer is launched: each blocker belongs exclusively to this fixture.
# Separate identities prevent one partial userenv deletion from contaminating another case.
foreach ($case in @('empty', 'ordinary-child', 'held-file', 'deny-delete')) {
  $root = Join-Path ([IO.Path]::GetTempPath()) ('opencoven-profile-cleanup-' + [Guid]::NewGuid().ToString('N'))
  $user = [OpenCoven.WindowsIsolatedUser]::Create($root)
  $profile = $user.OperatingSystemProfilePath
  $child = Join-Path $profile '.coven\cleanup-control'
  $marker = Join-Path $child 'marker.bin'
  $held = $null
  $originalAcl = $null
  $failure = $null
  try {
    if ($case -ne 'empty') {
      [IO.Directory]::CreateDirectory($child) | Out-Null
      [IO.File]::WriteAllBytes($marker, [byte[]]@(1, 2, 3))
    }
    if ($case -eq 'held-file') {
      $held = [IO.File]::Open($marker, [IO.FileMode]::Open,
        [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
      if ([OpenCoven.Tests.ProfileCleanupCharacterization]::DeleteAccess($marker) -ne 32) {
        throw 'Held-file control did not deny delete sharing.'
      }
    } elseif ($case -eq 'deny-delete') {
      $originalAcl = Get-Acl -LiteralPath $child
      $blockedAcl = Get-Acl -LiteralPath $child
      $blockedAcl.SetAccessRuleProtection($true, $true)
      $blockedAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new('S-1-1-0'),
        [Security.AccessControl.FileSystemRights]'Delete,DeleteSubdirectoriesAndFiles',
        [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Deny))
      Set-Acl -LiteralPath $child -AclObject $blockedAcl
      if ([OpenCoven.Tests.ProfileCleanupCharacterization]::DeleteAccess($marker) -ne 5) {
        throw 'ACL control did not deny DELETE access.'
      }
    }
    try { $user.Dispose() } catch { $failure = $_.Exception }
    $outcome = if ($null -eq $failure) { 'removed' } else { Get-ProfileCleanupCategories $failure }
    Write-Host ("profile-cleanup-characterization: case=$case;phase=production;outcome=$outcome;" +
      [OpenCoven.Tests.ProfileCleanupCharacterization]::Snapshot($user.Sid, $profile, $marker))
    if ($case -in @('empty', 'ordinary-child') -and $null -ne $failure) {
      throw 'Unblocked production profile cleanup failed.'
    }
    if ($null -ne $held) { $held.Dispose(); $held = $null }
    if ($null -ne $originalAcl -and [OpenCoven.Tests.ProfileCleanupCharacterization]::Exists($child)) {
      Set-Acl -LiteralPath $child -AclObject $originalAcl
    }
    if ([OpenCoven.Tests.ProfileCleanupCharacterization]::Exists($marker) -and
        [OpenCoven.Tests.ProfileCleanupCharacterization]::DeleteAccess($marker) -ne 0) {
      throw 'Fixture blocker remained after release.'
    }
    Write-Host ("profile-cleanup-characterization: case=$case;phase=released;" +
      [OpenCoven.Tests.ProfileCleanupCharacterization]::Snapshot($user.Sid, $profile, $marker))
    if ([OpenCoven.Tests.ProfileCleanupCharacterization]::Exists($profile)) {
      # Characterize an explicit-path call after partial deletion, not a production fallback.
      $explicit = [OpenCoven.Tests.ProfileCleanupCharacterization]::DeleteExplicit($user.Sid, $profile)
      $settle = [Diagnostics.Stopwatch]::StartNew()
      while ($settle.Elapsed -lt [TimeSpan]::FromSeconds(10) -and
          [OpenCoven.Tests.ProfileCleanupCharacterization]::Exists($profile)) {
        Start-Sleep -Milliseconds 100
      }
      Write-Host ("profile-cleanup-characterization: case=$case;phase=explicit-path;outcome=$explicit;" +
        [OpenCoven.Tests.ProfileCleanupCharacterization]::Snapshot($user.Sid, $profile, $marker))
    }
  } finally {
    if ($null -ne $held) { $held.Dispose() }
    if ($null -ne $originalAcl -and [OpenCoven.Tests.ProfileCleanupCharacterization]::Exists($child)) {
      Set-Acl -LiteralPath $child -AclObject $originalAcl
    }
    # Only this fixture's known, never-launched identity is eligible for manual teardown.
    # Production disposal deliberately remains fail-closed and has no such fallback.
    try { $user.Dispose() } finally {
      $deleteTree.Invoke($null, [object[]]@([string]$profile)) | Out-Null
      $deleteProfile.Invoke($null, [object[]]@([string]$user.Sid, [string]$profile)) | Out-Null
    }
    if ([OpenCoven.Tests.ProfileCleanupCharacterization]::Exists($profile) -or
        [OpenCoven.Tests.ProfileCleanupCharacterization]::Registered($user.Sid) -or
        [OpenCoven.Tests.ProfileCleanupCharacterization]::Exists($root)) {
      throw 'Profile characterization left owned state behind.'
    }
    [OpenCoven.Tests.ProfileCleanupCharacterization]::RequireAccountMissing($user.UserName)
  }
}
Write-Host 'Native profile cleanup characterization completed.'
