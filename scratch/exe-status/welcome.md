# Welcome (welcome.exe) — Win98

**Status:** WARN (91 APIs, no window)

## Behavior
Loads resources (LoadStringA), calls FindWindowA to check if already running, opens registry key (HKLM\...), then stalls. Doesn't create a window.

## Last APIs
LoadStringA(0x400000, 2006, ...) → FindWindowA("WelcomeApp", ...) → RegOpenKeyExA(HKLM, ...)

## Blocking Issue
Likely blocked by registry query returning no data for its expected key, or by a subsequent API that's a crash stub. The app checks registry settings before deciding to show its window.

## What's Needed
- Investigate what registry key it reads and what value it expects
- May need RegQueryValueExA to return specific data for the Welcome app's configuration

## Difficulty: Easy-Medium (registry value setup)
