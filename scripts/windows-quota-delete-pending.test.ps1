$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'Delete-pending quota reproduction requires native Windows.' }
if (-not ('OpenCoven.Tests.OwnerDirectoryQuotaFixture' -as [type])) {
  throw 'Run the owner-directory fixture before the delete-pending fixture.'
}

# Characterize known fixture causes. An identical managed error would not prove
# that a protected run encountered deletion rather than an ACL rejection.
Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
namespace OpenCoven.Tests
{
    public sealed class DeletePendingDirectoryFixture : IDisposable
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct StandardInfo
        {
            public long AllocationSize;
            public long EndOfFile;
            public uint NumberOfLinks;
            [MarshalAs(UnmanagedType.U1)] public bool DeletePending;
            [MarshalAs(UnmanagedType.U1)] public bool Directory;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateFileW(string path, uint access, uint share,
            IntPtr attributes, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool RemoveDirectoryW(string path);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandleEx(IntPtr handle,
            int informationClass, out StandardInfo info, uint size);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetFileSecurityW(string path, uint information, byte[] descriptor);

        private IntPtr handle;
        public DeletePendingDirectoryFixture(string path)
        {
            // READ_ATTRIBUTES | DELETE; share read/write/delete; noninheritable;
            // OPEN_EXISTING; BACKUP_SEMANTICS | OPEN_REPARSE_POINT.
            handle = CreateFileW(path, 0x00010080u, 7, IntPtr.Zero, 3, 0x02200000u, IntPtr.Zero);
            if (handle == new IntPtr(-1))
            {
                handle = IntPtr.Zero;
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Fixture handle open failed.");
            }
            try
            {
                if (!RemoveDirectoryW(path))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Fixture deletion request failed.");
                StandardInfo info;
                if (!GetFileInformationByHandleEx(handle, 1, out info, (uint)Marshal.SizeOf<StandardInfo>()))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Fixture deletion state query failed.");
                if (!info.Directory || !info.DeletePending)
                    throw new InvalidOperationException("Fixture did not enter directory delete-pending state.");
            }
            catch { Dispose(); throw; }
        }
        public static void DenyAttributes(string path, string sid)
        {
            var descriptor = new RawSecurityDescriptor("D:P(D;;0x80;;;" + sid + ")(A;;FA;;;" + sid + ")");
            var bytes = new byte[descriptor.BinaryLength];
            descriptor.GetBinaryForm(bytes, 0);
            if (!SetFileSecurityW(path, 0x80000004u, bytes))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Fixture attribute denial failed.");
        }
        public void Dispose()
        {
            if (handle == IntPtr.Zero) return;
            if (!CloseHandle(handle))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Fixture handle close failed.");
            handle = IntPtr.Zero;
        }
    }
}
'@

$flags = [Reflection.BindingFlags]'NonPublic,Static'
$measure = [OpenCoven.WindowsJobSupervisor].GetMethod('MeasureDirectoryBytes', $flags)
if ($null -eq $measure) { throw 'Real quota traversal seam is missing.' }
function Get-AttributeObservation([string] $Path) {
  try {
    $attributes = [IO.File]::GetAttributes($Path)
    if (($attributes -band [IO.FileAttributes]::Directory) -eq 0) { throw 'Fixture is not a directory.' }
    return 'readable'
  } catch {
    $cause = $_.Exception.GetBaseException()
    if ($cause -is [UnauthorizedAccessException]) {
      Write-Host ('Attribute observation: category=access-denied; hresult={0:X8}.' -f $cause.HResult)
      return 'access-denied'
    }
    if ($cause -is [IO.FileNotFoundException] -or $cause -is [IO.DirectoryNotFoundException]) { return 'missing' }
    if ($cause -is [IO.IOException]) {
      Write-Host ('Attribute observation: category=io; hresult={0:X8}.' -f $cause.HResult)
      return 'io'
    }
    throw 'Unexpected attribute observation.'
  }
}
function Get-QuotaObservation([string] $Path) {
  try {
    $bytes = $measure.Invoke($null, [object[]]@($Path, [long]1048576, 'bootstrap aggregate', $true))
    if ($bytes -ne 0) { throw 'Empty quota fixture returned nonzero bytes.' }
    return 'readable'
  } catch {
    $cause = $_.Exception.GetBaseException()
    $instanceFlags = [Reflection.BindingFlags]'NonPublic,Instance'
    $values = foreach ($name in @('Category', 'Operation', 'Repeat')) {
      $property = $cause.GetType().GetProperty($name, $instanceFlags)
      if ($null -eq $property) { throw 'Unexpected quota observation.' }
      $property.GetValue($cause)
    }
    $result = $values -join ':'
    if ($result -cnotin @(
        'access-denied:directory-attributes:persistent',
        'access-denied:directory-attributes:transient',
        'access-denied:directory-enumeration-root:persistent',
        'access-denied:directory-enumeration-root:transient',
        'io:directory-attributes:persistent',
        'io:directory-attributes:transient',
        'io:directory-enumeration-root:persistent',
        'io:directory-enumeration-root:transient')) {
      throw 'Unexpected bounded quota classification.'
    }
    return $result
  }
}

$root = Join-Path ([IO.Path]::GetTempPath()) ('opencoven-delete-pending-' + [Guid]::NewGuid().ToString('N'))
$pending = $null
$security = $null
try {
  $readablePath = Join-Path $root 'readable'
  $pendingPath = Join-Path $root 'pending'
  $deniedPath = Join-Path $root 'denied'
  foreach ($path in @($readablePath, $pendingPath, $deniedPath)) {
    [IO.Directory]::CreateDirectory($path) | Out-Null
    if ((Get-AttributeObservation $path) -cne 'readable' -or (Get-QuotaObservation $path) -cne 'readable') {
      throw 'Readable fixture baseline failed.'
    }
  }
  $pending = [OpenCoven.Tests.DeletePendingDirectoryFixture]::new($pendingPath)
  $pendingAttributes = Get-AttributeObservation $pendingPath
  $pendingQuota = Get-QuotaObservation $pendingPath
  Write-Host "Delete-pending fixture: attributes=$pendingAttributes; quota=$pendingQuota."
  if ($pendingAttributes -ceq 'access-denied' -and $pendingQuota -ceq 'access-denied:directory-attributes:persistent') {
    Write-Host 'Delete-pending fixture reproduced the managed quota signature; protected-run cause remains unproven.'
  } else {
    Write-Host 'Delete-pending fixture did not reproduce the protected signature; deletion hypothesis remains inconclusive.'
  }
  $pending.Dispose()
  $pending = $null
  if ((Get-AttributeObservation $pendingPath) -cne 'missing') { throw 'Closed deletion fixture remains accessible.' }

  $security = [OpenCoven.Tests.OwnerDirectoryQuotaFixture]::new($deniedPath)
  [OpenCoven.Tests.DeletePendingDirectoryFixture]::DenyAttributes(
    $deniedPath, [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
  $deniedAttributes = Get-AttributeObservation $deniedPath
  $deniedQuota = Get-QuotaObservation $deniedPath
  Write-Host "ACL-denied fixture: attributes=$deniedAttributes; quota=$deniedQuota."
  if ($deniedAttributes -cne 'access-denied' -or $deniedQuota -cne 'access-denied:directory-attributes:persistent') {
    throw 'Explicit attribute denial did not produce the expected control.'
  }
  $security.Dispose()
  $security = $null
  if ((Get-AttributeObservation $deniedPath) -cne 'readable' -or (Get-QuotaObservation $deniedPath) -cne 'readable') {
    throw 'Fixture ACL restoration failed.'
  }
} finally {
  try { if ($null -ne $pending) { $pending.Dispose() } }
  finally {
    try { if ($null -ne $security) { $security.Dispose() } }
    finally { [IO.Directory]::Delete($root, $true) }
  }
}
if ((Get-AttributeObservation $root) -cne 'missing') { throw 'Quota reproduction root survived cleanup.' }
Write-Host 'Native deletion lifecycle and ACL controls completed; production quota policy is unchanged.'
