# mIRC Installer (mirc59.exe) — NSIS Installer

**Status:** WARN (0 APIs, no window)

## Behavior
Zero API calls logged — the EXE fails to even start. Likely a PE loading issue (unusual section layout or packing).

## Blocking Issue
PE loader can't handle this executable. May have compressed/packed sections, unusual PE features, or the NSIS stub has non-standard characteristics.

## What's Needed
- Investigate PE structure with pe-sections.js
- Check if sections need special handling (e.g., .ndata section, overlay data)

## Difficulty: Hard (PE loader issues)
