# regedit.exe (Registry Editor) - Win98

**Status:** FAIL
**Crashes on:** Thread cache overflow (memory OOB at batch 39)
**Batch reached:** 39
**API calls:** 13,202

## Crash Details

Regedit gets very far -- 13,202 API calls, creates 3 windows (hwnd 0x10001, 0x10002, 0x10003), draws treeview/listview with thousands of GDI ops. The crash is NOT GetCurrentObject anymore -- it now crashes with **thread cache overflow**.

**Root cause:** `thread_alloc` reaches `0x03fffffc` (the maximum). The threaded code cache fills up because regedit decodes so many unique code paths (13K+ API calls means extensive code coverage). Once the cache overflows, writes corrupt adjacent memory regions, destroying EBP and return addresses.

**Crash symptoms:**
- EIP=0x458df475 (garbage -- corrupted return address)
- EBP=0x89f04589 (garbage -- corrupted by cache overflow writes)
- Stack contents at ESP are raw x86 code bytes, not valid addresses
- The function at 0x0047508e (MultiByteToWideChar loop) pops corrupted EBP and returns to garbage

**Last APIs before crash:**
- SetScrollRange, LocalFree -- normal operations
- The crash happens DURING execution, not on a specific API call

## What Needs to Be Fixed

**Thread cache size increase.** The threaded code cache (currently 1MB at THREAD_BASE 0x01052000) is too small for apps with large code coverage like regedit. When `thread_alloc` reaches the end, decoded instructions overflow into the block cache index and beyond.

Options:
1. Increase THREAD_BASE region size (requires adjusting memory layout constants)
2. Add cache eviction (flush old entries when cache is full)
3. Add bounds check in the decoder to prevent overflow (crash cleanly instead of corrupting)

## Difficulty: Medium

The GetCurrentObject issue was apparently already fixed. The new blocker is a memory layout/cache sizing issue. A quick fix is increasing the cache size; a proper fix adds eviction or bounds checking.
