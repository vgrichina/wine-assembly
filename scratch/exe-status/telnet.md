# telnet.exe (Telnet Client) - Win98

**Status:** FAIL
**Crashes on:** WSOCK32.dll ordinal 115 (WSAStartup)
**Batch reached:** 0

## Crash Details

Telnet has a complex init: it loads msvcrt.dll (CRT runtime), does full CRT initialization (heap, locale, environment), creates a console screen buffer, reads registry settings (telnet preferences, terminal config), then tries to initialize Winsock via `WSAStartup(0x0101, &wsaData)`. The import is by ordinal 115 from WSOCK32.dll.

Since WSOCK32.dll is not loaded/emulated and ordinal imports have no name resolution, the API shows as unnamed in the trace: `(0x00000101, 0x02bff978, ...)`.

EIP at crash: `0x0100bdf4` -- calling `[0x10011dc]` which is the IAT entry for WSOCK32 ordinal 115.

The first arg `0x00000101` is the requested Winsock version (1.1).

## API Call Sequence (117 calls before crash)

Key APIs (complex CRT + app init):
- msvcrt CRT: HeapCreate, HeapAlloc, GetVersionExA, InitializeCriticalSection x many
- EnterCriticalSection/LeaveCriticalSection (CRT locks)
- GetSystemTimeAsFileTime, GetCurrentProcessId, GetTickCount, QueryPerformanceCounter (RNG seed)
- SetUnhandledExceptionFilter
- GetModuleFileNameW, GetModuleHandleW
- GetUserDefaultLCID, GetLocaleInfoA (locale setup)
- GetStdHandle x2 (stdout, stderr)
- GetConsoleScreenBufferInfo, GetConsoleOutputCP
- CreateConsoleScreenBuffer, SetConsoleScreenBufferSize(0x30001, 80x25)
- RegOpenKeyExW, RegCreateKeyExW (HKCU telnet settings)
- RegQueryValueExW x8 (terminal prefs: columns, rows, fonts, etc.)
- SetEnvironmentVariableW, RegCloseKey
- LoadStringW, GetThreadLocale
- **WSOCK32 ordinal 115 (WSAStartup)** -- CRASH

## DLL/Import Analysis

Telnet imports from 9 DLLs:
- msvcrt.dll (loaded as DLL, working)
- ADVAPI32.dll, KERNEL32.dll, USER32.dll (built-in, working)
- **WSOCK32.dll** -- not loaded, ordinal 115 = WSAStartup
- **Security.dll** -- not loaded (SSPI for authentication)
- IMM32.dll, ole32.dll, GDI32.dll (partially working)

## What Needs to Be Implemented

1. WSOCK32.dll ordinal-to-name mapping (or a DLL stub)
2. `WSAStartup` -- Winsock initialization. Needs to fill WSADATA struct and return 0.
3. Eventually: full Winsock API (socket, connect, send, recv, select, etc.) for actual telnet functionality
4. Security.dll SSPI APIs (for authentication, lower priority)

## Difficulty: Hard

WSAStartup itself is easy (fill struct, return 0), but telnet will immediately use socket/connect/send/recv which require a full networking layer. The emulator has no network I/O support. Getting past WSAStartup only to crash on the next Winsock call provides minimal value without a network abstraction layer.
