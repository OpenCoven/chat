$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'Profile lifecycle fixture requires native Windows.' }

Add-Type -TypeDefinition @'
using System;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
namespace OpenCoven.Tests {
    public static class ProfileLifecycleFixture {
        private const int ProfilePathCapacity = 260;
        [DllImport("userenv.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern int CreateProfile(string sid, string userName,
            [Out] StringBuilder profilePath, uint capacity);
        [DllImport("userenv.dll", CharSet = CharSet.Unicode, ExactSpelling = true,
            SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetUserProfileDirectoryW(IntPtr token,
            StringBuilder path, ref uint capacity);
        [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
        private static extern int NetUserGetInfo(string server, string user, int level, out IntPtr info);
        [DllImport("netapi32.dll")]
        private static extern int NetApiBufferFree(IntPtr info);
        public static void RequireAccountMissing(string userName) {
            IntPtr info;
            int result = NetUserGetInfo(null, userName, 0, out info);
            try {
                if (result != 2221) throw new InvalidOperationException("Owned account removal was not verified.");
            } finally { if (info != IntPtr.Zero) NetApiBufferFree(info); }
        }
        public static void RequireAlreadyExists(string sid, string userName) {
            var path = new StringBuilder(ProfilePathCapacity);
            int result = CreateProfile(sid, userName, path, (uint)path.Capacity);
            if (result != unchecked((int)0x800700B7))
                throw new InvalidOperationException("Profile fixture duplicate creation was not rejected.");
        }
        public static string ReadTokenProfile(object isolatedUser) {
            var field = isolatedUser.GetType().GetField("quotaToken",
                BindingFlags.NonPublic | BindingFlags.Instance);
            if (field == null) throw new InvalidOperationException("Validated token seam is missing.");
            var token = (SafeAccessTokenHandle)field.GetValue(isolatedUser);
            bool retained = false;
            try {
                token.DangerousAddRef(ref retained);
                uint capacity = 0;
                GetUserProfileDirectoryW(token.DangerousGetHandle(), null, ref capacity);
                if (capacity == 0 || capacity > 32768)
                    throw new InvalidOperationException("Token profile capacity is invalid.");
                var path = new StringBuilder((int)capacity);
                if (!GetUserProfileDirectoryW(token.DangerousGetHandle(), path, ref capacity))
                    throw new InvalidOperationException("Token profile query failed.");
                return path.ToString();
            } finally {
                if (retained) token.DangerousRelease();
            }
        }
    }
}
'@

function Assert-ProfileFixtureMissing([string]$Path) {
  try {
    [IO.File]::GetAttributes($Path) | Out-Null
  } catch {
    $cause = $_.Exception.GetBaseException()
    if ($cause -is [IO.FileNotFoundException] -or $cause -is [IO.DirectoryNotFoundException]) { return }
    throw 'Profile fixture removal could not be verified.'
  }
  throw 'Profile fixture survived cleanup.'
}

& {
  $context = New-IsolatedTestContext -Label 'profile-lifecycle'
  $createdProfile = $null
  $job = $null
  $cleanupFailed = $false
  $stage = 'profile-create'
  try {
    $createdProfile = $context.User.OperatingSystemProfilePath
    $stage = 'token-agreement'
    $tokenProfile = [OpenCoven.Tests.ProfileLifecycleFixture]::ReadTokenProfile($context.User)
    if (-not [IO.Path]::IsPathFullyQualified($createdProfile) -or
        -not [string]::Equals($createdProfile, $tokenProfile, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Created and token-derived profile paths disagree.'
    }
    if ([string]::Equals($createdProfile, $context.Environment.HOME, [StringComparison]::OrdinalIgnoreCase) -or
        [string]::Equals($createdProfile, $context.Environment.USERPROFILE, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Redirected environment did not differ from the token profile.'
    }
    $stage = 'duplicate-rejection'
    [OpenCoven.Tests.ProfileLifecycleFixture]::RequireAlreadyExists(
      $context.User.Sid, $context.User.UserName)
    $stage = 'child-profile-agreement'
    $childProbe = Join-Path $context.User.RootPath 'profile-agreement.ps1'
    [IO.File]::WriteAllText($childProbe, @'
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
public static class ChildProfileFixture {
    [DllImport("userenv.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern bool GetUserProfileDirectoryW(IntPtr token, StringBuilder path, ref uint size);
    public static string Read() {
        using (var identity = WindowsIdentity.GetCurrent()) {
            uint size = 0;
            GetUserProfileDirectoryW(identity.Token, null, ref size);
            if (size == 0 || size > 32768) throw new Exception("Profile size invalid.");
            var path = new StringBuilder((int)size);
            if (!GetUserProfileDirectoryW(identity.Token, path, ref size))
                throw new Exception("Profile query failed.");
            return path.ToString();
        }
    }
}
"@
if (-not [string]::Equals([ChildProfileFixture]::Read(),
    $env:OPENCOVEN_PROFILE_FIXTURE_EXPECTED, [StringComparison]::OrdinalIgnoreCase)) { exit 1 }
if (-not [string]::Equals([ChildProfileFixture]::Read(),
    $env:OPENCOVEN_WINDOWS_PROFILE_ROOT, [StringComparison]::OrdinalIgnoreCase)) { exit 1 }
'@, [Text.UTF8Encoding]::new($false))
    $context.Environment.OPENCOVEN_PROFILE_FIXTURE_EXPECTED = $createdProfile
    $context.Environment.OPENCOVEN_WINDOWS_PROFILE_ROOT = 'C:\forged-profile'
    $nonce = [Guid]::NewGuid().ToString('N')
    $jobName = "Local\OpenCoven.Chat.Conformance.$nonce"
    $context.Environment.OPENCOVEN_WINDOWS_JOB_NONCE = $nonce
    $context.Environment.OPENCOVEN_WINDOWS_JOB_NAME = $jobName
    $job = [OpenCoven.WindowsJobSupervisor]::Create($jobName, $context.User)
    $result = $job.RunAsUser(
      $context.User, $trustedPwsh,
      "-NoLogo -NoProfile -NonInteractive -File `"$childProbe`"",
      $context.User.RootPath, $context.Environment, [TimeSpan]::FromSeconds(30), 1MB, 1MB)
    if ($result.ExitCode -ne 0 -or $result.Stdout -ne '' -or $result.Stderr -ne '') {
      throw 'Child launch after explicit profile creation failed.'
    }
  } catch {
    $cause = $_.Exception.GetBaseException()
    if ($cause -is [Runtime.InteropServices.COMException]) {
      throw ('Native profile lifecycle assertion failed: stage={0}; hresult={1:X8}.' -f $stage, $cause.HResult)
    }
    throw "Native profile lifecycle assertion failed: stage=$stage."
  } finally {
    if ($null -ne $job) {
      try { $job.Dispose() } catch { $cleanupFailed = $true }
    }
    try { Remove-IsolatedTestContext -Context $context } catch { $cleanupFailed = $true }
    try {
      Assert-ProfileFixtureMissing $createdProfile
      Assert-ProfileFixtureMissing $context.User.RootPath
      if (Test-Path "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$($context.User.Sid)") {
        throw 'Owned profile registry entry survived cleanup.'
      }
      [OpenCoven.Tests.ProfileLifecycleFixture]::RequireAccountMissing($context.User.UserName)
    } catch { $cleanupFailed = $true }
    if ($cleanupFailed) { throw 'Native profile lifecycle cleanup failed.' }
  }
}

# Exercise the production initialization catch after successful profile ownership.
$createCore = [OpenCoven.WindowsIsolatedUser].GetMethod(
  'CreateCore', [Reflection.BindingFlags]'NonPublic,Static')
if ($null -eq $createCore) { throw 'Owned profile initialization seam is missing.' }
$failureRoot = Join-Path ([IO.Path]::GetTempPath()) "opencoven-profile-failure-$PID-$([Guid]::NewGuid().ToString('N'))"
$owned = @{ Sid = $null; Path = $null; UserName = $null }
$failAfterCreation = [Action[string,string]] {
  param($sid, $path)
  $owned.Sid = $sid
  $owned.Path = $path
  $identity = [Security.Principal.SecurityIdentifier]::new($sid)
  $owned.UserName = $identity.Translate([Security.Principal.NTAccount]).Value.Split('\')[-1]
  throw 'injected-profile-initialization-failure'
}
$injectedFailureObserved = $false
$cleanupFailureObserved = $false
$failureKind = 'none'
$failureHresult = 'none'
$failureNativeCode = 'none'
try {
  $unexpectedUser = $createCore.Invoke($null, [object[]]@($failureRoot, $failAfterCreation))
  if ($null -ne $unexpectedUser) { $unexpectedUser.Dispose() }
} catch {
  $failure = $_.Exception.GetBaseException()
  $failureHresult = '{0:X8}' -f $failure.HResult
  if ($failure -is [ComponentModel.Win32Exception]) { $failureNativeCode = $failure.NativeErrorCode }
  $failureKind = switch ($failure) {
    { $_ -is [Security.Principal.IdentityNotMappedException] } { 'sid-translation'; break }
    { $_ -is [Runtime.InteropServices.COMException] } { 'com'; break }
    { $_ -is [ComponentModel.Win32Exception] } { 'win32'; break }
    { $_ -is [Reflection.TargetParameterCountException] } { 'reflection-arity'; break }
    { $_ -is [ArgumentException] } { 'argument'; break }
    { $_ -is [Management.Automation.RuntimeException] } { 'powershell'; break }
    default { 'unexpected' }
  }
  $cause = $_.Exception
  while ($null -ne $cause) {
    if ($cause -is [AggregateException]) { $cleanupFailureObserved = $true }
    if ($cause.Message -ceq 'injected-profile-initialization-failure') { $injectedFailureObserved = $true }
    $cause = $cause.InnerException
  }
}
if ($cleanupFailureObserved -or -not $injectedFailureObserved -or
    $null -eq $owned.Path -or $null -eq $owned.UserName) {
  throw ('Profile initialization fixture rejected: sid={0}; path={1}; username={2}; injected={3}; cleanupFailure={4}; kind={5}; hresult={6}; nativeCode={7}.' -f
    ($null -ne $owned.Sid), ($null -ne $owned.Path), ($null -ne $owned.UserName),
    $injectedFailureObserved, $cleanupFailureObserved, $failureKind, $failureHresult, $failureNativeCode)
}
Assert-ProfileFixtureMissing $owned.Path
Assert-ProfileFixtureMissing $failureRoot
if (Test-Path "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$($owned.Sid)") {
  throw 'Failed initialization left an owned profile registry entry.'
}
[OpenCoven.Tests.ProfileLifecycleFixture]::RequireAccountMissing($owned.UserName)
Write-Host 'Native profile lifecycle fixture passed: token agreement, child launch, duplicate rejection, and production failure cleanup.'
