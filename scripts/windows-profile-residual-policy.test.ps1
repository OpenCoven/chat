$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not ('OpenCoven.WindowsJobSupervisor' -as [type])) {
  Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'windows-job-supervisor.cs')))
}
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Text;
namespace OpenCoven.Tests {
    public static class ProfileResidualPolicyFixture {
        private static object Invoke(MethodInfo method, params object[] args) {
            try { return method.Invoke(null, args); }
            catch (TargetInvocationException error) {
                ExceptionDispatchInfo.Capture(error.InnerException).Throw();
                throw;
            }
        }
        private static void Require(bool value, string message) {
            if (!value) throw new InvalidOperationException(message);
        }
        private static byte[] Records(params string[] names) {
            int size = 0;
            foreach (string name in names) size += (12 + Encoding.Unicode.GetByteCount(name) + 7) & ~7;
            byte[] result = new byte[size];
            int offset = 0;
            for (int index = 0; index < names.Length; index++) {
                byte[] name = Encoding.Unicode.GetBytes(names[index]);
                int recordSize = (12 + name.Length + 7) & ~7;
                Array.Copy(BitConverter.GetBytes(index == names.Length - 1 ? 0 : recordSize), 0, result, offset, 4);
                Array.Copy(BitConverter.GetBytes(name.Length), 0, result, offset + 8, 4);
                Array.Copy(name, 0, result, offset + 12, name.Length);
                offset += recordSize;
            }
            return result;
        }
        private static void RunDirectoryRecords(Type supervisor) {
            var flags = BindingFlags.NonPublic | BindingFlags.Static;
            var parse = supervisor.GetMethod("ParseProfileResidualNames", flags);
            var validate = supervisor.GetMethod("ValidateProfileResidualName", flags);
            Require(parse != null && validate != null,
                "Retained-directory record parser and single-component name policy are missing.");
            var unicode = supervisor.GetNestedType("PROFILE_UNICODE_STRING", BindingFlags.NonPublic);
            var attributes = supervisor.GetNestedType("PROFILE_OBJECT_ATTRIBUTES", BindingFlags.NonPublic);
            var io = supervisor.GetNestedType("PROFILE_IO_STATUS_BLOCK", BindingFlags.NonPublic);
            Require(unicode != null && attributes != null && io != null &&
                Marshal.SizeOf(unicode) == IntPtr.Size * 2 &&
                Marshal.SizeOf(attributes) == IntPtr.Size * 6 &&
                Marshal.SizeOf(io) == IntPtr.Size * 2 &&
                Marshal.OffsetOf(unicode, "Buffer").ToInt64() == IntPtr.Size &&
                Marshal.OffsetOf(attributes, "RootDirectory").ToInt64() == IntPtr.Size &&
                Marshal.OffsetOf(attributes, "ObjectName").ToInt64() == IntPtr.Size * 2 &&
                Marshal.OffsetOf(io, "Information").ToInt64() == IntPtr.Size,
                "Native profile enumeration ABI layout changed.");
            string[] wanted = { ".", "..", "ordinary", "trailing.", "space ", "CON", "\u00e9" };
            byte[] batch = Records(wanted);
            string[] actual = (string[])Invoke(parse, batch, batch.Length);
            Require(String.Join("|", actual) == String.Join("|", wanted), "Directory names changed during decoding.");
            foreach (string name in new[] { "ordinary", "trailing.", "space ", "CON", "\u00e9" })
                Invoke(validate, name);
            foreach (string name in new[] { null, "", ".", "..", "..\\outside", "C:outside",
                "x/y", "\\outside", "x\0y", "a:b", "*", "?", new string('x', 256) }) {
                bool rejected = false;
                try { Invoke(validate, name); }
                catch (InvalidOperationException) { rejected = true; }
                Require(rejected, "An unsafe relative child name was accepted.");
            }
            for (int scenario = 0; scenario < 13; scenario++) {
                byte[] bad = Records("name");
                int used = bad.Length;
                switch (scenario) {
                    case 0: used = 0; break;
                    case 1: used = 11; break;
                    case 2: used = 13; break;
                    case 3: Array.Copy(BitConverter.GetBytes(3), 0, bad, 8, 4); break;
                    case 4: Array.Copy(BitConverter.GetBytes(512), 0, bad, 8, 4); break;
                    case 5: Array.Copy(BitConverter.GetBytes(8), 0, bad, 0, 4); break;
                    case 6: Array.Copy(BitConverter.GetBytes(UInt32.MaxValue), 0, bad, 0, 4); break;
                    case 7: Array.Copy(BitConverter.GetBytes(20), 0, bad, 0, 4); break;
                    case 8: Array.Copy(BitConverter.GetBytes(14), 0, bad, 0, 4); break;
                    case 9: Array.Resize(ref bad, bad.Length + 8); used = bad.Length; break;
                    case 10:
                        bad = Records("x"); used = bad.Length; bad[12] = 0; bad[13] = 0xd8; break;
                    case 11: bad = Records("..\\outside"); used = bad.Length; break;
                    case 12: bad = new byte[65537]; used = bad.Length; break;
                }
                bool rejected = false;
                try { Invoke(parse, bad, used); }
                catch (InvalidOperationException) { rejected = true; }
                Require(rejected, "Malformed or unbounded directory records were accepted.");
            }
        }
        public static void Run(Type supervisor) {
            var flags = BindingFlags.NonPublic | BindingFlags.Static;
            var access = supervisor.GetMethod("ProfileResidualOpenAccess", flags);
            Require(access != null, "Residual deletion and ancestor enumeration access are not separated.");
            Require((uint)Invoke(access, true) == 0x00130080u,
                "Deleting a residual entry unnecessarily requires list-directory or file-data access.");
            Require((uint)Invoke(access, false) == 0x00120081u,
                "Retained ancestors lost directory enumeration or metadata access.");
            var complete = supervisor.GetMethod("CompleteProfileDeletion", flags);
            var registration = supervisor.GetMethod("ValidateProfileCleanupRegistration", flags);
            var exists = supervisor.GetMethod("ProfileCleanupPathExists", flags);
            var budget = supervisor.GetMethod("RequireProfileResidualBudget", flags);
            Require(complete != null && registration != null && exists != null && budget != null,
                "Production residual completion, ownership, presence, and budget policies are missing.");
            foreach (string scenario in new[] { "accepted", "not-found", "unauthorized",
                "registry", "hive", "not-needed", "sharing", "managed-sharing",
                "denied", "managed-other", "late-sharing", "expired", "already-missing", "no-progress",
                "sharing-deadline-inside" }) {
                string root = Path.Combine(Path.GetTempPath(), "opencoven-residual-policy-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(root);
                File.WriteAllText(Path.Combine(root, "marker"), "owned");
                int attempts = 0, pauses = 0;
                int milliseconds = scenario == "late-sharing" ? 9000 : scenario == "expired" ? 10000 :
                    scenario == "sharing-deadline-inside" ? 8000 : 0;
                bool authorized = scenario != "unauthorized";
                bool registered = scenario == "registry";
                bool hive = scenario == "hive";
                string outcome = scenario == "not-found" ? "not-found" : scenario == "not-needed" ? "not-needed" : "accepted";
                if (scenario == "already-missing") Directory.Delete(root, true);
                Exception failure = null;
                try {
                    Func<bool> present = () => (bool)Invoke(exists, root);
                    Action remove = () => {
                        attempts++;
                        if (scenario == "sharing-deadline-inside") {
                            if (attempts == 1) throw new Win32Exception(32, "private-path");
                            milliseconds = 10000;
                            throw new TimeoutException("Traversal reached its existing deadline.");
                        }
                        if ((scenario == "sharing" || scenario == "late-sharing") && attempts <= 2)
                            throw new Win32Exception(32, "private-path");
                        if (scenario == "managed-sharing" && attempts <= 2)
                            throw new IOException("private-path", unchecked((int)0x80070020));
                        if (scenario == "denied") throw new Win32Exception(5, "private-path");
                        if (scenario == "managed-other") throw new IOException("private-path");
                        if (scenario == "no-progress") return;
                        Directory.Delete(root, true);
                    };
                    try {
                        Invoke(complete, outcome, authorized,
                            (Func<bool>)(() => registered), (Func<bool>)(() => hive),
                            present, present, remove,
                            (Func<TimeSpan>)(() => TimeSpan.FromMilliseconds(milliseconds)),
                            (Action)(() => { milliseconds += 1000; pauses++; }));
                    } catch (InvalidOperationException error) {
                        failure = error;
                    }
                    bool succeeds = scenario == "accepted" || scenario == "not-found" ||
                        scenario == "sharing" || scenario == "managed-sharing" || scenario == "already-missing";
                    Require((failure == null) == succeeds, "Residual policy completion changed: " + scenario);
                    Require(present() != succeeds, "Residual policy did not preserve real filesystem state: " + scenario);
                    int expectedAttempts = scenario == "already-missing" || scenario == "unauthorized" ||
                        scenario == "registry" || scenario == "hive" || scenario == "not-needed" ||
                        scenario == "expired" ? 0 :
                        scenario == "sharing" || scenario == "managed-sharing" ? 3 :
                        scenario == "no-progress" ? 10 : scenario == "sharing-deadline-inside" ? 2 : 1;
                    Require(attempts == expectedAttempts, "Residual policy retried an unauthorized or non-sharing operation: " + scenario);
                    Require(pauses <= 10, "Residual policy reset its observation budget.");
                    if (failure != null) {
                        string diagnostic = (string)failure.GetType().GetProperty("Diagnostic",
                            BindingFlags.Instance | BindingFlags.NonPublic).GetValue(failure);
                        Require(!diagnostic.Contains("private-path") && !diagnostic.Contains(root),
                            "Residual diagnostic disclosed private input.");
                        if (scenario == "denied" || scenario == "managed-other")
                            Require(pauses == 0, "A permanent residual failure was retried.");
                        if (scenario == "late-sharing" || scenario == "sharing-deadline-inside")
                            Require(milliseconds == 10000 && failure.InnerException is Win32Exception,
                                "Sharing retry reset the existing deadline or lost its cause.");
                    }
                } finally { if (Directory.Exists(root)) Directory.Delete(root, true); }
            }
            string scratch = Path.Combine(Path.GetTempPath(), "opencoven-residual-guard-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(scratch);
            try {
                Invoke(registration, false, scratch, null);
                Invoke(registration, true, scratch, scratch);
                foreach (string actual in new[] { null, "", scratch + "-foreign" }) {
                    bool rejected = false;
                    try { Invoke(registration, true, scratch, actual); }
                    catch (InvalidOperationException) { rejected = true; }
                    Require(rejected, "An unbound registered profile path was accepted.");
                }
                string file = Path.Combine(scratch, "file");
                File.WriteAllText(file, "owned");
                Require((bool)Invoke(exists, scratch) && (bool)Invoke(exists, file),
                    "Presence checks hid a file replacing a directory.");
                File.Delete(file);
                Require(!(bool)Invoke(exists, file), "A genuinely missing entry was not accepted.");
                Invoke(budget, TimeSpan.FromSeconds(9), 64, 100000);
                foreach (object[] args in new[] {
                    new object[] { TimeSpan.FromSeconds(10), 1, 1 },
                    new object[] { TimeSpan.Zero, 65, 1 },
                    new object[] { TimeSpan.Zero, 1, 100001 } }) {
                    bool rejected = false;
                    try { Invoke(budget, args); }
                    catch (InvalidOperationException) { rejected = true; }
                    catch (TimeoutException) { rejected = true; }
                    Require(rejected, "An unbounded residual traversal was accepted.");
                }
            } finally { Directory.Delete(scratch, true); }
            RunDirectoryRecords(supervisor);
        }
    }
}
'@
[OpenCoven.Tests.ProfileResidualPolicyFixture]::Run([OpenCoven.WindowsJobSupervisor])
Write-Host 'Portable production residual policy passed: filesystem effects, authorization, sharing-only retries, deadline, registration, presence, bounds, NT directory records, and literal child names.'
