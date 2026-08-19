#include <windows.h>

// The probe links without a CRT so it remains compatible with Windows 98.
unsigned long _tls_index = 0;

void WINAPI WinMainCRTStartup(void) {
    if (WinExec("D:\\WINHLP32.EXE D:\\FREECELL.HLP", SW_SHOW) <= 31) {
        MessageBoxA(NULL, "Launching the archived WinHelp viewer failed", "WinHelp reference probe",
                    MB_OK | MB_ICONERROR);
        ExitProcess(1);
    }
    // Keep the launcher alive while the harness captures the independent
    // WinHelp process. The VM is discarded after the screenshot.
    Sleep(30000);
    ExitProcess(0);
}
