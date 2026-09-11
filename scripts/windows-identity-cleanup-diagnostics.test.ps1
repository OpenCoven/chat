$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not ('OpenCoven.WindowsJobSupervisor' -as [type])) { Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'windows-job-supervisor.cs'))) -Language CSharp }
$identityType = [OpenCoven.WindowsIsolatedUser]
$classify = $identityType.GetMethod('ClassifyCleanupError', [Reflection.BindingFlags]'NonPublic,Static')
if ($null -eq $classify) { throw 'Missing identity cleanup classifier.' }
$cases = @(
  @([ComponentModel.Win32Exception]::new(32, 'secret-path'), 'win32-32'),
  @([ComponentModel.Win32Exception]::new(2221, 'secret-path'), 'win32-2221'),
  @([UnauthorizedAccessException]::new('secret-path'), 'access-denied'),
  @([IO.DirectoryNotFoundException]::new('secret-path'), 'not-found'),
  @([IO.IOException]::new('secret-path'), 'io'),
  @([InvalidOperationException]::new('secret-path'), 'invalid-operation'),
  @([TimeoutException]::new('secret-path'), 'timeout'),
  @([ArgumentException]::new('secret-path'), 'unexpected')
)
foreach ($case in $cases) {
  $actual = $classify.Invoke($null, [object[]]@($case[0]))
  if ($actual -cne $case[1]) { throw "Wrong bounded cleanup category: $actual" }
  if ($actual.Contains('secret-path')) { throw 'Cleanup category leaked exception text.' }
}
Write-Host 'Bounded identity cleanup classification passed.'

# Drive the real Dispose path on an identity that was never provisioned. No
# local account, profile or directory is created; the quarantine callbacks are
# the only forced failures, so the first two categories are deterministic on
# every platform. Native lookups of the unprovisioned name may add trailing
# categories; each must still pair with exactly one retained inner exception.
$instanceFlags = [Reflection.BindingFlags]'NonPublic,Instance'
$identity = [Runtime.Serialization.FormatterServices]::GetUninitializedObject($identityType)
$secret = 'ocv-secret-' + [Guid]::NewGuid().ToString('N')
$missingRoot = Join-Path ([IO.Path]::GetTempPath()) ('opencoven-missing-' + [Guid]::NewGuid().ToString('N'))
foreach ($assignment in @(
    @('UserName', $secret),
    @('Sid', 'S-1-5-21-0-0-0-4294967295'),
    @('RootPath', $missingRoot),
    @('OperatingSystemProfilePath', (Join-Path $missingRoot 'profile')))) {
  $identityType.GetProperty($assignment[0]).SetValue($identity, $assignment[1])
}
# PowerShell script blocks surface wrapped runtime exceptions, so the forced
# quarantine failures are raised by compiled delegates exactly as production
# callbacks would raise them.
if (-not ('OpenCoven.Tests.IdentityCleanupProbe' -as [type])) {
  Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.IO;
namespace OpenCoven.Tests
{
    public static class IdentityCleanupProbe
    {
        public static Action Quarantine(string secret)
        {
            return () => { throw new UnauthorizedAccessException(secret); };
        }
        public static Func<bool> Check(string secret)
        {
            return () => { throw new IOException(secret); };
        }
    }
}
'@
}
$identityType.GetField('quarantineIsolatedIdentity', $instanceFlags).SetValue(
  $identity, [OpenCoven.Tests.IdentityCleanupProbe]::Quarantine($secret))
$identityType.GetField('isQuarantineComplete', $instanceFlags).SetValue(
  $identity, [OpenCoven.Tests.IdentityCleanupProbe]::Check($secret))
$failure = $null
try { $identity.Dispose() } catch { $failure = $_.Exception }
while ($null -ne $failure -and $failure -is [Management.Automation.MethodInvocationException]) { $failure = $failure.InnerException }
if ($null -eq $failure) { throw 'Identity cleanup did not fail closed.' }
$prefix = 'Ephemeral Windows identity cleanup failed: quarantine-check:io,quarantine:access-denied'
if (-not $failure.Message.StartsWith($prefix, [StringComparison]::Ordinal)) { throw "Unexpected cleanup diagnostic: $($failure.Message)" }
if (-not $failure.Message.EndsWith('.', [StringComparison]::Ordinal)) { throw 'Cleanup diagnostic is unterminated.' }
if ($failure.Message.Contains($secret) -or $failure.Message.Contains($missingRoot)) { throw 'Cleanup diagnostic leaked identity or path text.' }
$aggregate = $failure.InnerException -as [AggregateException]
if ($null -eq $aggregate) { throw 'Original cleanup failures were not retained.' }
$categories = $failure.Message.Substring($prefix.Length - 'quarantine-check:io,quarantine:access-denied'.Length).TrimEnd('.').Split(',')
if ($categories.Count -ne $aggregate.InnerExceptions.Count) { throw 'Cleanup categories do not pair with retained failures.' }
if ($aggregate.InnerExceptions[0] -isnot [IO.IOException] -or $aggregate.InnerExceptions[1] -isnot [UnauthorizedAccessException]) { throw 'Cleanup failure order was not preserved.' }
foreach ($category in $categories) {
  if ($category -notmatch '^[a-z-]+:(win32-\d+(\[[a-z0-9=;-]+\])?|access-denied|not-found|io|invalid-operation|timeout|unexpected)$') { throw "Unbounded cleanup category: $category" }
}
if (-not $identityType.GetField('disposed', $instanceFlags).GetValue($identity)) { throw 'Identity was not marked disposed after cleanup failure.' }
try { $identity.Dispose() } catch { throw 'Repeated Dispose must be idempotent.' }
if (Test-Path -LiteralPath $missingRoot) { throw 'Cleanup diagnostics created the missing root.' }
Write-Host 'Bounded identity cleanup Dispose diagnostics passed.'
