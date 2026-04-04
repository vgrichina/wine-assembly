# Welcome (welcome.exe) -- Win98

**Status:** FAIL
**Crashes on:** Thread cache overflow (memory OOB at batch 4)
**API calls:** 90

## Crash Details

Welcome.exe crashes early -- only 90 API calls before OOB at batch 4. The crash is NOT related to FindWindowA or registry. It's a **thread cache overflow** identical to the regedit crash.

**Root cause:** `thread_alloc` reaches `0x03fffffc` (maximum). The threaded code cache fills up during CRT init. Once full, decoded instructions overflow into adjacent memory, corrupting the stack and return addresses.

**Crash symptoms:**
- EIP=0x8bfc5557 (garbage -- raw x86 bytes interpreted as an address)
- ESP=0x01ffffec, stack contains 0xffffffff (not a valid return)
- Stack at 0x01fffff0 has 0x00405a40 and 0x00401138 (valid code addresses from before corruption)
- The function at 0x004087a3 (CRT __sbh_heap_init or similar) does stack arithmetic, pops, and rets to corrupted address

**API sequence before crash:**
- Standard CRT init: GetVersion, HeapCreate, VirtualAlloc x2
- InitializeCriticalSection x4, TlsAlloc, TlsSetValue
- GetCurrentThreadId, HeapAlloc, GetStartupInfoA
- GetStdHandle/GetFileType x3 (stdin/stdout/stderr)
- Environment processing: GetEnvironmentStringsW, WideCharToMultiByte, FreeEnvironmentStringsW
- GetModuleFileNameA, GetModuleHandleA, HeapAlloc, GetStartupInfoA
- GetSystemMetrics, LoadStringA, FindWindowA -- last API calls
- Then CRT continues with CPU-only code that fills the cache

**Key insight:** This is the same thread cache overflow bug as regedit. The CRT init has many unique code blocks (heap init, environment parsing, locale setup) that each get decoded into the threaded code cache. Even with only 90 API calls, the CRT touches enough unique code paths to fill the 1MB cache.

## What Needs to Be Fixed

Same as regedit: **thread cache size increase or cache eviction**. The 1MB cache is insufficient for apps with complex CRT init. Welcome.exe hits this even earlier than regedit because its CRT has more unique initialization code paths.

## Difficulty: Medium (same fix as regedit -- increase cache or add eviction)
