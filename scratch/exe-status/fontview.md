# Font Viewer (fontview.exe) — Win98

**Status:** WARN (3 APIs, no window)

## Behavior
Only makes 3 API calls: `__p__fmode`, `__p__commode`, `_controlfp` — then hangs or exits. This is the very start of CRT init from MSVCRT20.dll.

## DLL Dependencies
- **MFC30.DLL** — MFC 3.0 (older version, NOT the same as mfc42.dll)
- **MSVCRT20.dll** — older MSVC runtime (NOT msvcrt.dll)
- **LZ32.dll** — Lempel-Ziv compression
- **VERSION.dll** — version info queries

None of these are currently available.

## Blocking Issue
Missing DLLs — the app can't even start CRT init without MSVCRT20.dll and MFC30.DLL.

## What's Needed
1. Obtain MFC30.DLL (from Win98 install media or VC++ 2.0 redist)
2. Obtain MSVCRT20.dll (from Win98 system files)
3. Obtain LZ32.dll and VERSION.dll (from Win98 system files)

## Difficulty: Medium (DLL acquisition + loading)
