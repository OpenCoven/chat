using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;

namespace OpenCoven
{
    // Test-only observation: never used to decide quarantine acceptance.
    public static class WindowsProcessSidDiagnostics
    {
        private const int ERROR_INVALID_PARAMETER = 87;
        private const int ERROR_NOT_FOUND = 1168;
        private const uint WAIT_OBJECT_0 = 0;
        private const uint WAIT_TIMEOUT = 258;
        private const uint SYNCHRONIZE = 0x00100000;
        private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

        public static string Describe(uint processId, Func<IntPtr, string> querySid)
        {
            try
            {
                return ObserveAmbiguousProcessSid(
                    processId,
                    delegate(uint id)
                    {
                        return OpenProcess(
                            SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, id);
                    },
                    Marshal.GetLastWin32Error,
                    delegate(IntPtr process) { return WaitForSingleObject(process, 0); },
                    querySid,
                    delegate(IntPtr process) { CloseHandle(process); });
            }
            catch (Exception)
            {
                return "probe-failed";
            }
        }

        // Observations describe only the newly opened handle, not identity continuity
        // with the earlier WTS row. They never authorize skipping an ambiguous row.
        private static string ObserveAmbiguousProcessSid(
            uint processId,
            Func<uint, IntPtr> openProcess,
            Func<int> lastError,
            Func<IntPtr, uint> waitProcess,
            Func<IntPtr, string> querySid,
            Action<IntPtr> closeProcess)
        {
            IntPtr process = openProcess(processId);
            if (process == IntPtr.Zero)
            {
                int error = lastError();
                return ((error == ERROR_INVALID_PARAMETER || error == ERROR_NOT_FOUND)
                    ? "open-not-found:" : "open-failed:")
                    + error.ToString(CultureInfo.InvariantCulture);
            }
            try
            {
                uint wait = waitProcess(process);
                if (wait == WAIT_OBJECT_0) return "exited";
                if (wait != WAIT_TIMEOUT)
                {
                    return "wait-failed:"
                        + lastError().ToString(CultureInfo.InvariantCulture);
                }
                string tokenState;
                try
                {
                    tokenState = String.IsNullOrEmpty(querySid(process))
                        ? "live-token-invalid" : "live-token-readable";
                }
                catch (Win32Exception error)
                {
                    tokenState = "live-token-unreadable:"
                        + error.NativeErrorCode.ToString(CultureInfo.InvariantCulture);
                }
                catch (InvalidOperationException)
                {
                    tokenState = "live-token-invalid";
                }
                wait = waitProcess(process);
                if (wait == WAIT_OBJECT_0) return "exited-during-query";
                if (wait != WAIT_TIMEOUT)
                {
                    return "wait-failed:"
                        + lastError().ToString(CultureInfo.InvariantCulture);
                }
                return tokenState;
            }
            finally
            {
                closeProcess(process);
            }
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr process, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr process);
    }
}
