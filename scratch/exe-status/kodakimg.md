# Kodak Imaging (test/binaries/win98-apps/kodakimg.exe)

## Status: FAIL (crash)

## Crash Point
Crashes on API #439: ?UpdateVersion@@YGJH@Z(0x00000000)
- This is a C++ mangled name from a DLL (OICOM400.dll or similar Kodak/Wang imaging DLL)
- Demangles to: `long __stdcall UpdateVersion(int)`
- Returns 0x0000ffff but then crashes at EIP=0x0042d488
- Crashes at batch 1 (very early)

## API Call Sequence Leading to Crash
1. Enter/LeaveCriticalSection (MFC init)
2. lstrcatA -- string concatenation (building "Imaging" path)
3. TlsGetValue calls
4. GetCurrentThreadId
5. SetWindowsHookExA(WH_MSGFILTER, 0x00483d34, NULL, thread_id=1)
6. EnterCriticalSection + LocalAlloc (allocating MFC state)
7. LeaveCriticalSection
8. LocalAlloc, LocalReAlloc, TlsSetValue (more MFC thread state)
9. **?UpdateVersion@@YGJH@Z(0)** -- calls into Wang Imaging DLL
10. Return value 0xFFFF triggers a crash path at 0x0042d488 (jmp through import table)

## What Needs to Be Implemented
1. The Wang/Kodak Imaging OCX DLLs (OICOM400.dll, OIUI400.dll, etc.) -- these are COM/OLE controls
2. The `UpdateVersion` function likely checks/updates registry version info for the imaging components
3. The crash after UpdateVersion returns suggests the next call through the import table (0x441014) hits an unimplemented API

## Difficulty: Hard
Kodak Imaging depends on Wang Imaging OCX COM components (OICOM400.dll, OIMG400.dll, etc.). These are complex COM/OLE ActiveX controls for image viewing/annotation. Would require either:
- Loading and emulating the actual Wang DLLs
- Stubbing the entire COM interface chain
Both approaches are extremely complex.
