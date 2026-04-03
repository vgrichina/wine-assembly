# WinAmp Installer (winamp291.exe) — NSIS Installer

**Status:** WARN (474 APIs, no window)

## Behavior
NSIS installer loop — reads the packed executable data via ReadFile in a tight loop (ReadFile + GetTickCount repeating). It's decompressing/extracting NSIS payload but never gets to the UI creation phase.

## Last APIs
GetTickCount → ReadFile(handle, buf, 512, ...) → GetTickCount → ReadFile (loop)

## Blocking Issue
NSIS installer is stuck reading its own executable to extract the compressed installer payload. May need larger batch count or the ReadFile/file seek implementation may not be advancing the file pointer correctly.

## What's Needed
- Check if SetFilePointer/ReadFile advance correctly for self-extracting EXE reading
- May need more execution batches to finish extraction
- NSIS then needs CreateWindowExA for its wizard UI

## Difficulty: Medium (file I/O correctness + NSIS compatibility)
