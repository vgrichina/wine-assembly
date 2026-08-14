#include <windows.h>

// The CRT normally provides this TLS slot. The probe has no TLS and links
// without a CRT so it remains compatible with Windows 98.
unsigned long _tls_index = 0;

static int run_probe(void) {
    STARTUPINFOA startup = { sizeof(startup) };
    PROCESS_INFORMATION process = {0};
    RECT window = {0};
    RECT client = {0};
    POINT origin = {0, 0};
    HWND hwnd;
    char message[256];
    BOOL launched = FALSE;

    hwnd = FindWindowA("Minesweeper", "Minesweeper");
    if (!hwnd) {
        launched = CreateProcessA("D:\\WINMINE.EXE", NULL, NULL, NULL, FALSE, 0,
                                  NULL, NULL, &startup, &process);
        if (!launched) {
            wsprintfA(message, "Could not launch D:\\WINMINE.EXE (%lu)", GetLastError());
            MessageBoxA(NULL, message, "Minesweeper geometry probe", MB_OK | MB_ICONERROR);
            return 1;
        }
        WaitForInputIdle(process.hProcess, 5000);
        Sleep(1000);
        hwnd = FindWindowA("Minesweeper", "Minesweeper");
    }
    if (!hwnd) {
        MessageBoxA(NULL, "Could not find the Minesweeper window", "Minesweeper geometry probe",
                    MB_OK | MB_ICONERROR);
        return 2;
    }

    GetWindowRect(hwnd, &window);
    GetClientRect(hwnd, &client);
    ClientToScreen(hwnd, &origin);
    wsprintfA(message,
              "window=%ldx%ld\r\nclient=%ldx%ld\r\nclient origin=(%ld,%ld)",
              window.right - window.left, window.bottom - window.top,
              client.right - client.left, client.bottom - client.top,
              origin.x - window.left, origin.y - window.top);
    MessageBoxA(hwnd, message, "Minesweeper geometry probe", MB_OK);

    if (launched) {
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
    }
    return 0;
}

void WINAPI WinMainCRTStartup(void) {
    ExitProcess(run_probe());
}
