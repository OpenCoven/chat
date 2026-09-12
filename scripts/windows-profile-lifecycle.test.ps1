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
        public static string Create(string sid, string userName) {
            var path = new StringBuilder(ProfilePathCapacity);
            int result = CreateProfile(sid, userName, path, (uint)path.Capacity);
            if (result != 0) throw new COMException("Profile fixture creation failed.", result);
            return path.ToString();
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

$profileDelete = [OpenCoven.WindowsJobSupervisor].GetMethod(
  'DeleteOperatingSystemProfile', [Reflection.BindingFlags]'NonPublic,Static')
if ($null -eq $profileDelete) { throw 'Profile deletion seam is missing.' }
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

foreach ($injectFailure in @($false, $true)) {
  $context = New-IsolatedTestContext -Label 'profile-lifecycle'
  $createdProfile = $null
  $job = $null
  $injectedFailureObserved = $false
  $cleanupFailed = $false
  $stage = 'profile-create'
  try {
    # Record the returned owned path before any verification can throw.
    $createdProfile = [OpenCoven.Tests.ProfileLifecycleFixture]::Create(
      $context.User.Sid, $context.User.UserName)
    if ($injectFailure) { throw 'injected-profile-initialization-failure' }
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
'@, [Text.UTF8Encoding]::new($false))
    $context.Environment.OPENCOVEN_PROFILE_FIXTURE_EXPECTED = $createdProfile
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
    if ($injectFailure -and $_.Exception.GetBaseException().Message -ceq
        'injected-profile-initialization-failure') {
      $injectedFailureObserved = $true
    } else {
      $cause = $_.Exception.GetBaseException()
      if ($cause -is [Runtime.InteropServices.COMException]) {
        throw ('Native profile lifecycle assertion failed: stage={0}; hresult={1:X8}.' -f $stage, $cause.HResult)
      }
      throw "Native profile lifecycle assertion failed: stage=$stage."
    }
  } finally {
    if ($null -ne $job) {
      try { $job.Dispose() } catch { $cleanupFailed = $true }
    }
    if ($null -ne $createdProfile) {
      try {
        $profileDelete.Invoke($null, [object[]]@($context.User.Sid, $createdProfile)) | Out-Null
        Assert-ProfileFixtureMissing $createdProfile
      } catch { $cleanupFailed = $true }
    }
    try { Remove-IsolatedTestContext -Context $context } catch { $cleanupFailed = $true }
    try { Assert-ProfileFixtureMissing $context.User.RootPath } catch { $cleanupFailed = $true }
    if ($cleanupFailed) { throw 'Native profile lifecycle cleanup failed.' }
  }
  if ($injectFailure -and -not $injectedFailureObserved) {
    throw 'Profile initialization failure was not exercised.'
  }
}
Write-Host 'Native profile lifecycle fixture passed: token agreement, child launch, duplicate rejection, and failure cleanup.'
