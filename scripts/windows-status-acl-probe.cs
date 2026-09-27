using System;
using System.IO;
using System.Security.AccessControl;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Principal;

// Run only inside a disposable directory supplied by the existing supervisor
// test context. No ACL or token privilege changes are made to that directory.
public static class StatusAclProbe
{
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
        string text, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetSecurityDescriptorDacl(IntPtr descriptor,
        out bool present, out IntPtr dacl, out bool defaulted);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    private static extern uint SetNamedSecurityInfoW(string name, uint type,
        uint information, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFileW(string name, uint access, uint share,
        IntPtr security, uint creation, uint attributes, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static string ProbeDirectoryWriteDacl(string path)
    {
        IntPtr handle = CreateFileW(
            path,
            0x00040000,
            0x00000001 | 0x00000002 | 0x00000004,
            IntPtr.Zero,
            3,
            0x02000000,
            IntPtr.Zero);
        if (handle == new IntPtr(-1))
            return Classify((uint)Marshal.GetLastWin32Error());
        CloseHandle(handle);
        return "success";
    }

    private static string Classify(uint status)
    {
        if (status == 0) return "success";
        if (status == 5) return "access-denied";
        if (status == 1307) return "invalid-owner";
        if (status == 1314) return "privilege-not-held";
        return "unclassified";
    }

    private static void VerifyInheritedSecurity(
        string path,
        string supervisorSid,
        int isolatedAccess)
    {
        using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
        {
            if (identity.User == null) throw new InvalidOperationException("token-user-missing");
            FileSecurity security = new FileInfo(path).GetAccessControl();
            if (!identity.User.Equals(security.GetOwner(typeof(SecurityIdentifier))))
                throw new InvalidOperationException("created-file-owner-mismatch");
            var descriptor = new RawSecurityDescriptor(security.GetSecurityDescriptorBinaryForm(), 0);
            var entries = new List<InheritedAce>();
            if (descriptor.DiscretionaryAcl == null)
                throw new InvalidOperationException("created-file-acl-count-mismatch");
            foreach (GenericAce entry in descriptor.DiscretionaryAcl)
            {
                var ace = entry as CommonAce;
                if (ace == null) throw new InvalidOperationException("created-file-acl-mismatch");
                entries.Add(new InheritedAce(ace.SecurityIdentifier.Value, ace.AccessMask,
                    ace.AceFlags, !ace.IsCallback && ace.AceQualifier == AceQualifier.AccessAllowed));
            }
            VerifyInheritedAcl(supervisorSid, identity.User.Value, isolatedAccess, entries);
        }
    }

    // Project native ACEs into primitive values so the exact-shape check can also
    // run on non-Windows hosts. Native owner and ACL reads remain above.
    internal sealed class InheritedAce
    {
        internal readonly string Sid;
        internal readonly int AccessMask;
        internal readonly AceFlags Flags;
        internal readonly bool IsAllow;
        internal InheritedAce(string sid, int mask, AceFlags flags, bool isAllow = true)
        {
            Sid = sid; AccessMask = mask; Flags = flags; IsAllow = isAllow;
        }
    }

    internal static void VerifyInheritedAcl(string supervisorSid, string ownerSid,
        int isolatedAccess, IReadOnlyList<InheritedAce> entries)
    {
        var expected = new Dictionary<string, int> {
            { "S-1-5-18", 0x001f01ff },
            { "S-1-5-32-544", 0x001f01ff },
            { supervisorSid, 0x001f01ff },
            { ownerSid, isolatedAccess },
            { "S-1-3-4", 0x00020000 }
        };
        // Staging inherits both the directory's owner MODIFY ACE and its
        // file-only owner FULL ACE. Every other trustee must appear once.
        bool ownerModifyRequired = isolatedAccess == 0x001f01ff;
        if (entries == null || entries.Count != expected.Count + (ownerModifyRequired ? 1 : 0))
            throw new InvalidOperationException("created-file-acl-count-mismatch");
        foreach (InheritedAce ace in entries)
        {
            if (ace == null || !ace.IsAllow || ace.Flags != AceFlags.Inherited)
                throw new InvalidOperationException("created-file-acl-mismatch");
            if (ownerModifyRequired && ace.Sid == ownerSid && ace.AccessMask == 0x001301bf)
            {
                ownerModifyRequired = false;
                continue;
            }
            int mask;
            if (!expected.TryGetValue(ace.Sid, out mask) || ace.AccessMask != mask)
                throw new InvalidOperationException("created-file-acl-mismatch");
            expected.Remove(ace.Sid);
        }
        if (ownerModifyRequired || expected.Count != 0)
            throw new InvalidOperationException("created-file-acl-mismatch");
    }

    public static string RunControl(string scratchDirectory)
    {
        return RunInternal(scratchDirectory, null);
    }

    public static string Run(string scratchDirectory, string supervisorSid)
    {
        if (string.IsNullOrWhiteSpace(supervisorSid))
            throw new InvalidOperationException("supervisor-identity-required");
        return RunInternal(scratchDirectory, supervisorSid, 0x001301bf);
    }

    public static string RunStaging(string scratchDirectory, string supervisorSid)
    {
        if (string.IsNullOrWhiteSpace(supervisorSid))
            throw new InvalidOperationException("supervisor-identity-required");
        ValidateScratchDirectory(scratchDirectory);
        return "directory-write-dac:" + ProbeDirectoryWriteDacl(scratchDirectory) +
            "\n" + RunInternal(scratchDirectory, supervisorSid, 0x001f01ff, true);
    }

    private static void ValidateScratchDirectory(string scratchDirectory)
    {
        if (!OperatingSystem.IsWindows()) throw new InvalidOperationException("windows-required");
        if (!Directory.Exists(scratchDirectory)) throw new InvalidOperationException("scratch-required");
    }

    private static string RunInternal(
        string scratchDirectory,
        string supervisorSid,
        int isolatedAccess = 0,
        bool directFiles = false)
    {
        ValidateScratchDirectory(scratchDirectory);
        IntPtr descriptor = IntPtr.Zero;
        IntPtr owner = IntPtr.Zero;
        string prefix = "status-acl-" + Guid.NewGuid().ToString("N");
        string root = directFiles ? scratchDirectory : Path.Combine(scratchDirectory, prefix);
        var ownedFiles = new List<string>();
        if (!directFiles) Directory.CreateDirectory(root);
        try
        {
            uint size;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
                "D:P(A;;GA;;;OW)", 1, out descriptor, out size))
                throw new InvalidOperationException("descriptor-conversion-failed");
            bool present, defaulted;
            IntPtr dacl;
            if (!GetSecurityDescriptorDacl(descriptor, out present, out dacl, out defaulted)
                || !present || dacl == IntPtr.Zero)
                throw new InvalidOperationException("descriptor-dacl-failed");
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
            {
                if (identity.User == null) throw new InvalidOperationException("token-user-missing");
                byte[] sid = new byte[identity.User.BinaryLength];
                identity.User.GetBinaryForm(sid, 0);
                owner = Marshal.AllocHGlobal(sid.Length);
                Marshal.Copy(sid, 0, owner, sid.Length);
            }
            string[] labels = { "combined", "owner-only", "dacl-only" };
            uint[] flags = { 0x80000005u, 1u, 0x80000004u };
            string[] results = new string[3];
            for (int i = 0; i < labels.Length; i++)
            {
                string path = Path.Combine(root, directFiles ? prefix + "-" + labels[i] : labels[i]);
                // Exclusive creation, write, sync, and close mirror the writer.
                using (FileStream file = new FileStream(path, FileMode.CreateNew, FileAccess.Write))
                {
                    ownedFiles.Add(path);
                    file.WriteByte(10);
                    file.Flush(true);
                }
                if (supervisorSid != null)
                    VerifyInheritedSecurity(path, supervisorSid, isolatedAccess);
                uint status = SetNamedSecurityInfoW(path, 1, flags[i],
                    i == 2 ? IntPtr.Zero : owner, IntPtr.Zero,
                    i == 1 ? IntPtr.Zero : dacl, IntPtr.Zero);
                results[i] = labels[i] + ":" + Classify(status);
            }
            return string.Join("\n", results);
        }
        finally
        {
            if (owner != IntPtr.Zero) Marshal.FreeHGlobal(owner);
            if (descriptor != IntPtr.Zero) LocalFree(descriptor);
            // File deletion uses existing modify rights, never an ACL override.
            if (directFiles)
            {
                foreach (string path in ownedFiles) File.Delete(path);
            }
            else
            {
                Directory.Delete(root, true);
            }
        }
    }
}
