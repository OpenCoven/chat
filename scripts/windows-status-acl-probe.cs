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

    private static string Classify(uint status)
    {
        if (status == 0) return "success";
        if (status == 5) return "access-denied";
        if (status == 1307) return "invalid-owner";
        if (status == 1314) return "privilege-not-held";
        return "unclassified";
    }

    private static void VerifyInheritedSecurity(string path, string supervisorSid)
    {
        using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
        {
            if (identity.User == null) throw new InvalidOperationException("token-user-missing");
            FileSecurity security = new FileInfo(path).GetAccessControl();
            if (!identity.User.Equals(security.GetOwner(typeof(SecurityIdentifier))))
                throw new InvalidOperationException("created-file-owner-mismatch");
            var expected = new Dictionary<string, int> {
                { "S-1-5-18", 0x001f01ff },
                { "S-1-5-32-544", 0x001f01ff },
                { supervisorSid, 0x001f01ff },
                { identity.User.Value, 0x001301bf },
                { "S-1-3-4", 0x00020000 }
            };
            var descriptor = new RawSecurityDescriptor(security.GetSecurityDescriptorBinaryForm(), 0);
            if (descriptor.DiscretionaryAcl == null || descriptor.DiscretionaryAcl.Count != expected.Count)
                throw new InvalidOperationException("created-file-acl-count-mismatch");
            foreach (GenericAce entry in descriptor.DiscretionaryAcl)
            {
                var ace = entry as CommonAce;
                int mask;
                if (ace == null || ace.IsCallback || ace.AceQualifier != AceQualifier.AccessAllowed
                    || (ace.AceFlags & AceFlags.Inherited) == 0
                    || (ace.AceFlags & AceFlags.InheritOnly) != 0
                    || !expected.TryGetValue(ace.SecurityIdentifier.Value, out mask)
                    || ace.AccessMask != mask)
                    throw new InvalidOperationException("created-file-acl-mismatch");
                expected.Remove(ace.SecurityIdentifier.Value);
            }
            if (expected.Count != 0) throw new InvalidOperationException("created-file-acl-missing");
        }
    }

    public static string Run(string scratchDirectory, string supervisorSid)
    {
        if (!OperatingSystem.IsWindows()) throw new InvalidOperationException("windows-required");
        if (!Directory.Exists(scratchDirectory)) throw new InvalidOperationException("scratch-required");
        IntPtr descriptor = IntPtr.Zero;
        IntPtr owner = IntPtr.Zero;
        string root = Path.Combine(scratchDirectory, "status-acl-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
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
                string path = Path.Combine(root, labels[i]);
                // Exclusive creation, write, sync, and close mirror the writer.
                using (FileStream file = new FileStream(path, FileMode.CreateNew, FileAccess.Write))
                {
                    file.WriteByte(10);
                    file.Flush(true);
                }
                if (supervisorSid != null) VerifyInheritedSecurity(path, supervisorSid);
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
            Directory.Delete(root, true);
        }
    }
}
