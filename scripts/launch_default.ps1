param(
    [string]$Desktop = "WinSta0\Default",
    [string]$Args = "--enable-logging",
    [string]$LogPath = "d:\Projects\Eukolia\desktop_launch.log"
)

$code = @"
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public class LogStarter {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct SECURITY_ATTRIBUTES {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public bool bInheritHandle;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcess(
        string lpApplicationName,
        string lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation
    );

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern SafeFileHandle CreateFile(
        string lpFileName,
        uint dwDesiredAccess,
        uint dwShareMode,
        ref SECURITY_ATTRIBUTES lpSecurityAttributes,
        uint dwCreationDisposition,
        uint dwFlagsAndAttributes,
        IntPtr hTemplateFile
    );

    public static int StartWithLog(string exePath, string arguments, string desktop, string logPath) {
        SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
        sa.nLength = Marshal.SizeOf(sa);
        sa.bInheritHandle = true;

        SafeFileHandle hLog = CreateFile(logPath, 0x40000000, 3, ref sa, 2, 0x80, IntPtr.Zero);
        if (hLog.IsInvalid) {
            throw new Exception("CreateFile failed: " + Marshal.GetLastWin32Error());
        }

        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(si);
        si.lpDesktop = desktop;
        si.dwFlags = 0x00000100; // STARTF_USESTDHANDLES
        si.hStdOutput = hLog.DangerousGetHandle();
        si.hStdError = hLog.DangerousGetHandle();
        si.hStdInput = IntPtr.Zero;

        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
        string cmd = "\"" + exePath + "\" " + arguments;
        string workDir = Path.GetDirectoryName(exePath);

        bool res = CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, true, 0, IntPtr.Zero, workDir, ref si, out pi);
        hLog.Close();
        if (!res) {
            throw new Exception("CreateProcess failed: " + Marshal.GetLastWin32Error());
        }
        return pi.dwProcessId;
    }
}
"@

Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue

$exe = "d:\Projects\Eukolia\release\win-unpacked\Eukolia.exe"
if (Test-Path $LogPath) { Remove-Item $LogPath -Force }

$procId = [LogStarter]::StartWithLog($exe, $Args, $Desktop, $LogPath)
Write-Output "Launched process PID: $procId"
Start-Sleep -Seconds 3
if (Test-Path $LogPath) {
    Get-Content $LogPath -Raw
} else {
    Write-Output "Log file not created."
}
